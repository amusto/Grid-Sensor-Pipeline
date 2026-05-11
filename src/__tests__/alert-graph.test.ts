/**
 * Alert graph assembly tests (P8.5).
 *
 * Verifies the LangGraph wires the three node functions together
 * correctly:
 *   1. Linear flow: classify → route → narrate.
 *   2. State threads between nodes (each node sees the prior node's
 *      output via state).
 *   3. Final state has all four fields populated on success.
 *   4. Any node throw propagates out of `runAlertGraph` (so the
 *      caller's fail-soft fallback can handle).
 *
 * Strategy: mock the three lib functions (severity-classifier,
 * routing-strategy, narrative-generator) so no real Bedrock calls.
 * The lib functions themselves are unit-tested in their own files;
 * this test only verifies the graph's *wiring*.
 */

const mockClassifySeverity = jest.fn();
const mockDetermineRouting = jest.fn();
const mockGenerateNarratives = jest.fn();

jest.mock('../lib/severity-classifier', () => ({
  classifySeverity: mockClassifySeverity,
}));
jest.mock('../lib/routing-strategy', () => ({
  determineRouting: mockDetermineRouting,
}));
jest.mock('../lib/narrative-generator', () => ({
  generateNarratives: mockGenerateNarratives,
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

import { runAlertGraph, __resetGraph } from '../lib/alert-graph';
import type { SensorEvent } from '../lib/types';
import type { Severity } from '../lib/severity-classifier';
import type { RoutingPlan } from '../lib/routing-strategy';
import type { Narratives } from '../lib/narrative-generator';

const buildEvent = (overrides: Partial<SensorEvent> = {}): SensorEvent => ({
  sensorId: 'sensor-007',
  timestamp: '2026-05-11T10:00:00Z',
  readingType: 'voltage',
  value: 108,
  unit: 'V',
  gridZone: 'zone-2',
  ...overrides,
});

const stubSeverity: Severity = {
  severity: 'P1',
  confidence: 0.91,
  reasoning: 'voltage=108V is 6V below 114V minimum — P1 band.',
};

const stubRouting: RoutingPlan = {
  channels: { slack: true, pagerduty: true, email: true, status_page: false },
  pageOnCall: true,
  overrideApplied: false,
};

const stubNarratives: Narratives = {
  narratives: {
    slack: 'P1: sensor-007 voltage 108V (6V below 114V min). Investigate now.',
    pagerduty: 'P1 — sensor-007 voltage=108V; threshold=114V. Check substation feed first.',
    email:
      'Sensor sensor-007 reported voltage=108V at 10:00Z — 6V below the 114V minimum. P1 severity; on-call paged. Initial investigation: upstream substation status.',
  },
};

beforeEach(() => {
  __resetGraph();
  mockClassifySeverity.mockReset();
  mockDetermineRouting.mockReset();
  mockGenerateNarratives.mockReset();
});

describe('runAlertGraph — happy path', () => {
  it('runs classify → route → narrate in order and returns the final state', async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockResolvedValueOnce(stubRouting);
    mockGenerateNarratives.mockResolvedValueOnce(stubNarratives);

    const event = buildEvent();
    const out = await runAlertGraph(event);

    expect(out.event).toEqual(event);
    expect(out.severity).toEqual(stubSeverity);
    expect(out.routing).toEqual(stubRouting);
    expect(out.narratives).toEqual(stubNarratives);

    expect(mockClassifySeverity).toHaveBeenCalledTimes(1);
    expect(mockDetermineRouting).toHaveBeenCalledTimes(1);
    expect(mockGenerateNarratives).toHaveBeenCalledTimes(1);
  });

  it('passes the SensorEvent into classifySeverity', async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockResolvedValueOnce(stubRouting);
    mockGenerateNarratives.mockResolvedValueOnce(stubNarratives);

    const event = buildEvent({ sensorId: 'sensor-042', value: 95 });
    await runAlertGraph(event);

    const [eventArg, thresholdArg] = mockClassifySeverity.mock.calls[0];
    expect(eventArg).toEqual(event);
    // The threshold is computed inside the node by evaluateThreshold;
    // assert it's a breach result, which is the precondition the
    // classifier asserts defensively.
    expect(thresholdArg.exceeded).toBe(true);
  });

  it("passes the classifier's severity into determineRouting", async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockResolvedValueOnce(stubRouting);
    mockGenerateNarratives.mockResolvedValueOnce(stubNarratives);

    await runAlertGraph(buildEvent());

    const [, severityArg] = mockDetermineRouting.mock.calls[0];
    expect(severityArg).toEqual(stubSeverity);
  });

  it('passes severity + routing into generateNarratives', async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockResolvedValueOnce(stubRouting);
    mockGenerateNarratives.mockResolvedValueOnce(stubNarratives);

    await runAlertGraph(buildEvent());

    const [, severityArg, routingArg] = mockGenerateNarratives.mock.calls[0];
    expect(severityArg).toEqual(stubSeverity);
    expect(routingArg).toEqual(stubRouting);
  });

  it('reuses the compiled graph across invocations (lazy singleton)', async () => {
    mockClassifySeverity.mockResolvedValue(stubSeverity);
    mockDetermineRouting.mockResolvedValue(stubRouting);
    mockGenerateNarratives.mockResolvedValue(stubNarratives);

    await runAlertGraph(buildEvent());
    await runAlertGraph(buildEvent());
    await runAlertGraph(buildEvent());

    // Each invocation calls each node once — three invocations = three
    // calls per node. The fact that this works at all proves the
    // compiled graph is reusable.
    expect(mockClassifySeverity).toHaveBeenCalledTimes(3);
    expect(mockDetermineRouting).toHaveBeenCalledTimes(3);
    expect(mockGenerateNarratives).toHaveBeenCalledTimes(3);
  });
});

describe('runAlertGraph — failure propagation', () => {
  it('propagates an error from classifySeverity', async () => {
    mockClassifySeverity.mockRejectedValueOnce(new Error('Bedrock down'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('Bedrock down');

    // Downstream nodes must NOT have been invoked.
    expect(mockDetermineRouting).not.toHaveBeenCalled();
    expect(mockGenerateNarratives).not.toHaveBeenCalled();
  });

  it('propagates an error from determineRouting', async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockRejectedValueOnce(new Error('parse failed'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('parse failed');

    expect(mockGenerateNarratives).not.toHaveBeenCalled();
  });

  it('propagates an error from generateNarratives', async () => {
    mockClassifySeverity.mockResolvedValueOnce(stubSeverity);
    mockDetermineRouting.mockResolvedValueOnce(stubRouting);
    mockGenerateNarratives.mockRejectedValueOnce(new Error('schema invalid'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('schema invalid');
  });
});
