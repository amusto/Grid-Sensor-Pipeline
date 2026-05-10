/**
 * lib/llm-client tests — verifies the LangChain Bedrock wrapper:
 *   1. Round-trips a Zod-typed structured output.
 *   2. Emits per-call metrics with the token sum (the
 *      `BedrockTokensUsed` value the runaway-cost alarm watches).
 *   3. Handles both `total_tokens` (newer LangChain) and the
 *      input+output sum fallback (older shape).
 *   4. Caps `maxRetries` at 1 (cost guardrail).
 *   5. Passes the configured model id + region into the constructor
 *      (single source of truth with the IAM grant).
 *   6. Emits `BedrockFallback` and rethrows on Bedrock error.
 *   7. Reuses the same client across invocations (lazy singleton).
 */

// Env vars must be set BEFORE the module under test is imported, since
// it reads them at module load.
process.env.AWS_REGION = 'us-east-1';
process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
process.env.POWERTOOLS_SERVICE_NAME = 'grid-sensor-llm-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'GridSensorPipeline';

import { z } from 'zod';

const mockInvoke = jest.fn();
const mockWithStructuredOutput = jest.fn().mockReturnValue({
  invoke: mockInvoke,
});

const ChatBedrockConverseMock = jest.fn().mockImplementation(() => ({
  withStructuredOutput: mockWithStructuredOutput,
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: ChatBedrockConverseMock,
}));

const mockAddMetric = jest.fn();
const mockPublishStoredMetrics = jest.fn();

jest.mock('../lib/metrics', () => ({
  metrics: {
    addMetric: mockAddMetric,
    publishStoredMetrics: mockPublishStoredMetrics,
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
});

const severitySchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

import { invokeStructured, getModelId, __resetClient } from '../lib/llm-client';

beforeEach(() => {
  __resetClient();
  mockAddMetric.mockClear();
  mockInvoke.mockReset();
  mockWithStructuredOutput.mockClear();
  ChatBedrockConverseMock.mockClear();
});

describe('invokeStructured', () => {
  it('returns typed parsed output and emits 3 metrics on success', async () => {
    const parsed = {
      severity: 'P1' as const,
      confidence: 0.92,
      reasoning: 'Voltage at sensor-002 dropped to 109V; threshold 114V.',
    };
    mockInvoke.mockResolvedValueOnce({
      raw: {
        usage_metadata: {
          input_tokens: 412,
          output_tokens: 187,
          total_tokens: 599,
        },
      },
      parsed,
    });

    const out = await invokeStructured(severitySchema, [
      { role: 'user', content: 'classify this breach' },
    ]);

    expect(out).toEqual(parsed);

    const metricNames = mockAddMetric.mock.calls.map((c) => c[0]);
    expect(metricNames).toEqual(
      expect.arrayContaining([
        'BedrockInvocations',
        'BedrockLatencyMs',
        'BedrockTokensUsed',
      ]),
    );

    const tokensCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockTokensUsed',
    );
    expect(tokensCall?.[2]).toBe(599);

    const invokeCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockInvocations',
    );
    expect(invokeCall?.[2]).toBe(1);
  });

  it('falls back to summing input + output when total_tokens is absent', async () => {
    mockInvoke.mockResolvedValueOnce({
      raw: {
        usage_metadata: { input_tokens: 100, output_tokens: 50 },
      },
      parsed: {
        severity: 'P2',
        confidence: 0.5,
        reasoning: 'mild deviation',
      },
    });

    await invokeStructured(severitySchema, []);

    const tokensCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockTokensUsed',
    );
    expect(tokensCall?.[2]).toBe(150);
  });

  it('reads tokens from response_metadata.usage as a fallback path', async () => {
    mockInvoke.mockResolvedValueOnce({
      raw: {
        response_metadata: {
          usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
        },
      },
      parsed: {
        severity: 'P3',
        confidence: 0.1,
        reasoning: 'within tolerance',
      },
    });

    await invokeStructured(severitySchema, []);

    const tokensCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockTokensUsed',
    );
    expect(tokensCall?.[2]).toBe(100);
  });

  it('emits BedrockTokensUsed=0 when raw has no usage info (does not crash)', async () => {
    mockInvoke.mockResolvedValueOnce({
      raw: {},
      parsed: { severity: 'P3', confidence: 0.0, reasoning: 'noop' },
    });

    await invokeStructured(severitySchema, []);

    const tokensCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockTokensUsed',
    );
    expect(tokensCall?.[2]).toBe(0);
  });

  it('caps maxRetries at 1 (cost guardrail)', async () => {
    mockInvoke.mockResolvedValueOnce({
      raw: { usage_metadata: { input_tokens: 1, output_tokens: 1 } },
      parsed: { severity: 'P3', confidence: 0.1, reasoning: 'x' },
    });

    await invokeStructured(severitySchema, []);

    const constructorArgs = ChatBedrockConverseMock.mock.calls[0][0];
    expect(constructorArgs.maxRetries).toBe(1);
  });

  it('passes the configured model id and region to ChatBedrockConverse', async () => {
    mockInvoke.mockResolvedValueOnce({
      raw: { usage_metadata: { input_tokens: 1, output_tokens: 1 } },
      parsed: { severity: 'P3', confidence: 0.1, reasoning: 'x' },
    });

    await invokeStructured(severitySchema, []);

    const constructorArgs = ChatBedrockConverseMock.mock.calls[0][0];
    expect(constructorArgs.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(constructorArgs.region).toBe('us-east-1');
  });

  it('emits BedrockFallback metric and rethrows on Bedrock error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    await expect(invokeStructured(severitySchema, [])).rejects.toThrow(
      'Bedrock unavailable',
    );

    const fallbackCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockFallback',
    );
    expect(fallbackCall?.[2]).toBe(1);

    // Success metrics MUST NOT be emitted on the error path.
    const invokeCall = mockAddMetric.mock.calls.find(
      (c) => c[0] === 'BedrockInvocations',
    );
    expect(invokeCall).toBeUndefined();
  });

  it('reuses the same client across invocations (lazy singleton)', async () => {
    mockInvoke.mockResolvedValue({
      raw: { usage_metadata: { input_tokens: 1, output_tokens: 1 } },
      parsed: { severity: 'P3', confidence: 0.1, reasoning: 'x' },
    });

    await invokeStructured(severitySchema, []);
    await invokeStructured(severitySchema, []);
    await invokeStructured(severitySchema, []);

    expect(ChatBedrockConverseMock).toHaveBeenCalledTimes(1);
  });
});

describe('getModelId', () => {
  it('returns the model id read from env at module load', () => {
    expect(getModelId()).toBe('us.anthropic.claude-sonnet-4-6');
  });
});
