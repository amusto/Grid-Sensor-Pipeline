/**
 * Alert handler tests — verifies the P8.5 integration:
 *   1. Initial notification → LangGraph runs → enriched SNS payload.
 *   2. LangGraph error → BedrockFallback metric + deterministic payload.
 *   3. Escalation path → skips the graph; uses fallback shape; marks escalated.
 *   4. Invalid event → AlertValidationFailed metric + throws.
 *
 * Strategy: mock `lib/alert-graph` so no real Bedrock calls; mock the
 * SNS client so no real network calls; mock metrics + logger to keep
 * the test output clean.
 */

// Env vars must be set BEFORE the handler module is imported.
process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:us-east-1:111111111111:test';
process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
process.env.POWERTOOLS_SERVICE_NAME = 'grid-sensor-alert-handler-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'GridSensorPipeline';

const mockRunAlertGraph = jest.fn();

jest.mock('../lib/alert-graph', () => ({
  runAlertGraph: mockRunAlertGraph,
}));

const mockSnsSend = jest.fn().mockResolvedValue({ MessageId: 'test-mid' });
const PublishCommandSpy = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => {
    PublishCommandSpy(input);
    return { input };
  }),
}));

const mockAddMetric = jest.fn();
const mockSingleMetric = jest.fn().mockReturnValue({
  addDimension: jest.fn(),
  addMetric: jest.fn(),
});

jest.mock('../lib/metrics', () => ({
  metrics: {
    addMetric: mockAddMetric,
    singleMetric: mockSingleMetric,
    publishStoredMetrics: jest.fn(),
  },
  MetricUnit: {
    Count: 'Count',
    Milliseconds: 'Milliseconds',
  },
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

import { handler } from '../handlers/alert-handler';
import type { Context } from 'aws-lambda';

const ctx = {} as Context;

const buildBreachEvent = () => ({
  sensorId: 'sensor-007',
  timestamp: '2026-05-11T10:00:00Z',
  readingType: 'voltage' as const,
  value: 108,
  unit: 'V',
  gridZone: 'zone-2',
});

const stubGraphResult = {
  event: buildBreachEvent(),
  severity: {
    severity: 'P1' as const,
    confidence: 0.91,
    reasoning: 'voltage=108V is 6V below 114V minimum — P1 band.',
  },
  routing: {
    channels: { slack: true, pagerduty: true, email: true, status_page: false },
    pageOnCall: true,
    overrideApplied: false,
  },
  narratives: {
    narratives: {
      slack: 'P1: sensor-007 voltage 108V. Investigate now.',
      pagerduty: 'P1 — sensor-007 voltage=108V; check substation feed.',
      email: 'Sensor sensor-007 reported voltage=108V at 10:00Z — P1.',
    },
  },
};

beforeEach(() => {
  mockRunAlertGraph.mockReset();
  mockSnsSend.mockClear();
  PublishCommandSpy.mockClear();
  mockAddMetric.mockClear();
  mockSingleMetric.mockClear();
});

describe('handler — initial notification with LangGraph success', () => {
  it('invokes the LangGraph and publishes the enriched payload to SNS', async () => {
    mockRunAlertGraph.mockResolvedValueOnce(stubGraphResult);

    const result = await handler(buildBreachEvent(), ctx);

    expect(result).toEqual({ acknowledged: false, escalated: false });
    expect(mockRunAlertGraph).toHaveBeenCalledTimes(1);
    expect(mockSnsSend).toHaveBeenCalledTimes(1);

    const publishedInput = PublishCommandSpy.mock.calls[0][0];
    const body = JSON.parse(publishedInput.Message);

    // Enriched fields from the LangGraph result
    expect(body.severity).toBe('P1');
    expect(body.severityConfidence).toBe(0.91);
    expect(body.severityReasoning).toMatch(/below 114V minimum/);
    expect(body.narratives.slack).toMatch(/sensor-007/);
    expect(body.routing.pageOnCall).toBe(true);

    // Original breach fields preserved
    expect(body.sensorId).toBe('sensor-007');
    expect(body.value).toBe(108);

    // Subject reflects the LLM-classified tier
    expect(publishedInput.Subject).toMatch(/^\[P1\]/);
  });

  it('does NOT emit BedrockFallback on the success path', async () => {
    mockRunAlertGraph.mockResolvedValueOnce(stubGraphResult);

    await handler(buildBreachEvent(), ctx);

    const fallbackCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockFallback',
    );
    expect(fallbackCall).toBeUndefined();
  });
});

describe('handler — initial notification with LangGraph failure (fail-soft)', () => {
  it('emits BedrockFallback and publishes the deterministic payload', async () => {
    mockRunAlertGraph.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    const result = await handler(buildBreachEvent(), ctx);

    // Alert still succeeds — fail-soft contract.
    expect(result).toEqual({ acknowledged: false, escalated: false });
    expect(mockSnsSend).toHaveBeenCalledTimes(1);

    // BedrockFallback metric incremented
    const fallbackCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockFallback',
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall?.[2]).toBe(1);

    // Payload has no narratives / no routing — pure Phase 5 shape.
    const publishedInput = PublishCommandSpy.mock.calls[0][0];
    const body = JSON.parse(publishedInput.Message);
    expect(body.narratives).toBeUndefined();
    expect(body.routing).toBeUndefined();
    expect(body.severityConfidence).toBeUndefined();
    // Tier defaults to P2 on the non-escalated fallback path.
    expect(body.severity).toBe('P2');
    expect(body.sensorId).toBe('sensor-007');
  });
});

describe('handler — escalation path: skips LangGraph and tolerates Step-Functions-wrapped state (issue #1)', () => {
  it('handles the production-shape escalation payload', async () => {
    const escalationEvent = {
      escalated: true,
      context: {
        ...buildBreachEvent(),
        alert: { acknowledged: false },  // ← appended by NotifyOps' resultPath
      },
    };

    const result = await handler(escalationEvent, ctx);

    expect(result).toEqual({ acknowledged: false, escalated: true });
    expect(mockRunAlertGraph).not.toHaveBeenCalled();

    const publishedInput = PublishCommandSpy.mock.calls[0][0];
    const body = JSON.parse(publishedInput.Message);
    expect(body.severity).toBe('P1');
    expect(body.escalated).toBe(true);
    expect(body.alert).toBeUndefined();
    expect(publishedInput.Subject).toMatch(/^\[P1 ESCALATED\]/);
  });
});

describe('handler — validation failure', () => {
  it('emits AlertValidationFailed metric and throws on bad input', async () => {
    const badEvent = { sensorId: 'NOT-A-SENSOR-ID', value: 'not-a-number' };

    await expect(handler(badEvent as never, ctx)).rejects.toThrow();

    const validationCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'AlertValidationFailed',
    );
    expect(validationCall).toBeDefined();

    // LangGraph was never invoked — validation failed before that point.
    expect(mockRunAlertGraph).not.toHaveBeenCalled();
    // SNS was never called either.
    expect(mockSnsSend).not.toHaveBeenCalled();
  });
});
