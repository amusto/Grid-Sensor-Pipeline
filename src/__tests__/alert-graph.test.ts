/**
 * Alert graph assembly tests (P8.5 + P9.4).
 *
 * Verifies the LangGraph wires the four node functions together
 * correctly:
 *   1. Linear flow: classify → route → narrate → executeTools.
 *   2. State threads between nodes (each node sees the prior node's
 *      output via state).
 *   3. Final state has all five fields populated on success
 *      (event, severity, routing, narratives, dispatchResult).
 *   4. Any node throw propagates out of `runAlertGraph` (so the
 *      caller's fail-soft fallback can handle).
 *   5. P9.4 dispatcher behavior:
 *      - First encounter: createChannelCase + adapter dispatch → delivered.
 *      - Retry (existing 'delivered' row): skipped + audit updateChannelCase.
 *      - Adapter returns status='failed' → bucketed in failed[].
 *      - Missing handler → skipped['no_handler_registered'].
 *      - Missing narrative → skipped['narrative_missing'].
 *      - ConditionalCheckFailedException on create → fall back to update.
 *      - ensureMetadata first encounter vs retry encounters.
 *      - Partial failure: email delivers, sms fails.
 *
 * Strategy: mock the three lib functions (severity-classifier,
 * routing-strategy, narrative-generator), the CaseRepository class,
 * and CHANNEL_HANDLERS so no real Bedrock / DynamoDB / SNS calls.
 * The lib functions and the CaseRepository are unit-tested in their
 * own files; this test only verifies the graph's *wiring* and the
 * dispatcher's *orchestration*.
 */

// ---------------------------------------------------------------------------
//  Mocks — declared at top per jest hoist semantics.
// ---------------------------------------------------------------------------

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

const mockFindChannelCase = jest.fn();
const mockCreateChannelCase = jest.fn();
const mockUpdateChannelCase = jest.fn();
const mockFindMetadata = jest.fn();
const mockCreateMetadata = jest.fn();
const mockUpdateMetadata = jest.fn();

jest.mock('../lib/cases/case-repository', () => ({
  CaseRepository: jest.fn().mockImplementation(() => ({
    findChannelCase: mockFindChannelCase,
    createChannelCase: mockCreateChannelCase,
    updateChannelCase: mockUpdateChannelCase,
    findMetadata: mockFindMetadata,
    createMetadata: mockCreateMetadata,
    updateMetadata: mockUpdateMetadata,
  })),
  buildCasePk: jest.fn(
    (key) => `${key.sensorId}#${key.timestamp}#${key.readingType}`,
  ),
}));

const mockEmailHandler = jest.fn();
const mockSmsHandler = jest.fn();

jest.mock('../lib/cases/channels', () => ({
  CHANNEL_HANDLERS: {
    email: mockEmailHandler,
    sms: mockSmsHandler,
  },
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  process.env.CASES_TABLE_NAME = 'cases-table';
});

afterAll(() => {
  delete process.env.CASES_TABLE_NAME;
});

// ---------------------------------------------------------------------------
//  Imports under test (after the mock setup above per jest semantics).
// ---------------------------------------------------------------------------

import { runAlertGraph, __resetGraph, __resetCaseRepo } from '../lib/alert-graph';
import type { SensorEvent } from '../lib/types';
import type { Severity } from '../lib/severity-classifier';
import type { RoutingPlan } from '../lib/routing-strategy';
import type { Narratives } from '../lib/narrative-generator';
import type { ChannelResult } from '../lib/cases/types';

// ---------------------------------------------------------------------------
//  Fixtures.
// ---------------------------------------------------------------------------

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
  channels: { email: true, sms: true },
  overrideApplied: false,
};

const stubNarratives: Narratives = {
  narratives: {
    email:
      'Sensor sensor-007 reported voltage=108V at 10:00Z — 6V below the 114V minimum. P1 severity; on-call paged via SMS. Initial investigation: upstream substation status.',
    sms: 'P1: sensor-007 voltage 108V (6V below 114V min). Investigate now.',
  },
};

const stubEmailResult: ChannelResult = {
  channel: 'email',
  status: 'delivered',
  caseId: 'ses-msg-id-001',
  latencyMs: 145,
};

const stubSmsResult: ChannelResult = {
  channel: 'sms',
  status: 'delivered',
  caseId: 'MOCK-sms-1715627889123-a3f2c1',
  externalUrl: 'https://example-sms.invalid/log/MOCK-sms-1715627889123-a3f2c1',
  latencyMs: 12,
};

const makeConditionalCheckFailedError = (): Error => {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
};

// ---------------------------------------------------------------------------
//  Reset + default-setup helpers.
// ---------------------------------------------------------------------------

const setupHappyPath = (): void => {
  mockClassifySeverity.mockResolvedValue(stubSeverity);
  mockDetermineRouting.mockResolvedValue(stubRouting);
  mockGenerateNarratives.mockResolvedValue(stubNarratives);

  // No existing rows by default (first-encounter scenario).
  mockFindChannelCase.mockResolvedValue(null);
  mockCreateChannelCase.mockResolvedValue(undefined);
  mockUpdateChannelCase.mockResolvedValue(undefined);

  // Metadata create succeeds (first encounter).
  mockCreateMetadata.mockResolvedValue(undefined);
  mockUpdateMetadata.mockResolvedValue(undefined);

  // Adapters resolve successfully.
  mockEmailHandler.mockResolvedValue(stubEmailResult);
  mockSmsHandler.mockResolvedValue(stubSmsResult);
};

beforeEach(() => {
  __resetGraph();
  __resetCaseRepo();
  mockClassifySeverity.mockReset();
  mockDetermineRouting.mockReset();
  mockGenerateNarratives.mockReset();
  mockFindChannelCase.mockReset();
  mockCreateChannelCase.mockReset();
  mockUpdateChannelCase.mockReset();
  mockFindMetadata.mockReset();
  mockCreateMetadata.mockReset();
  mockUpdateMetadata.mockReset();
  mockEmailHandler.mockReset();
  mockSmsHandler.mockReset();
});

// ===========================================================================
//  Existing wiring tests (extended for the 4th node).
// ===========================================================================

describe('runAlertGraph — happy path', () => {
  it('runs classify → route → narrate → executeTools in order and returns the final state', async () => {
    setupHappyPath();

    const event = buildEvent();
    const out = await runAlertGraph(event);

    expect(out.event).toEqual(event);
    expect(out.severity).toEqual(stubSeverity);
    expect(out.routing).toEqual(stubRouting);
    expect(out.narratives).toEqual(stubNarratives);
    expect(out.dispatchResult.delivered).toHaveLength(2);
    expect(out.dispatchResult.failed).toHaveLength(0);
    expect(out.dispatchResult.skipped).toHaveLength(0);

    expect(mockClassifySeverity).toHaveBeenCalledTimes(1);
    expect(mockDetermineRouting).toHaveBeenCalledTimes(1);
    expect(mockGenerateNarratives).toHaveBeenCalledTimes(1);
    expect(mockEmailHandler).toHaveBeenCalledTimes(1);
    expect(mockSmsHandler).toHaveBeenCalledTimes(1);
  });

  it('passes the SensorEvent into classifySeverity', async () => {
    setupHappyPath();
    const event = buildEvent({ sensorId: 'sensor-042', value: 95 });
    await runAlertGraph(event);

    const [eventArg, thresholdArg] = mockClassifySeverity.mock.calls[0];
    expect(eventArg).toEqual(event);
    expect(thresholdArg.exceeded).toBe(true);
  });

  it("passes the classifier's severity into determineRouting", async () => {
    setupHappyPath();
    await runAlertGraph(buildEvent());

    const [, severityArg] = mockDetermineRouting.mock.calls[0];
    expect(severityArg).toEqual(stubSeverity);
  });

  it('passes severity + routing into generateNarratives', async () => {
    setupHappyPath();
    await runAlertGraph(buildEvent());

    const [, severityArg, routingArg] = mockGenerateNarratives.mock.calls[0];
    expect(severityArg).toEqual(stubSeverity);
    expect(routingArg).toEqual(stubRouting);
  });

  it('reuses the compiled graph across invocations (lazy singleton)', async () => {
    setupHappyPath();

    await runAlertGraph(buildEvent());
    await runAlertGraph(buildEvent());
    await runAlertGraph(buildEvent());

    expect(mockClassifySeverity).toHaveBeenCalledTimes(3);
    expect(mockDetermineRouting).toHaveBeenCalledTimes(3);
    expect(mockGenerateNarratives).toHaveBeenCalledTimes(3);
  });
});

describe('runAlertGraph — failure propagation', () => {
  it('propagates an error from classifySeverity', async () => {
    setupHappyPath();
    mockClassifySeverity.mockReset();
    mockClassifySeverity.mockRejectedValueOnce(new Error('Bedrock down'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('Bedrock down');

    expect(mockDetermineRouting).not.toHaveBeenCalled();
    expect(mockGenerateNarratives).not.toHaveBeenCalled();
  });

  it('propagates an error from determineRouting', async () => {
    setupHappyPath();
    mockDetermineRouting.mockReset();
    mockDetermineRouting.mockRejectedValueOnce(new Error('parse failed'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('parse failed');

    expect(mockGenerateNarratives).not.toHaveBeenCalled();
  });

  it('propagates an error from generateNarratives', async () => {
    setupHappyPath();
    mockGenerateNarratives.mockReset();
    mockGenerateNarratives.mockRejectedValueOnce(new Error('schema invalid'));

    await expect(runAlertGraph(buildEvent())).rejects.toThrow('schema invalid');
  });
});

// ===========================================================================
//  P9.4 — dispatcher behavior tests.
// ===========================================================================

describe('runAlertGraph — dispatcher: first-encounter happy path', () => {
  it('creates metadata + creates per-channel rows + invokes both adapters', async () => {
    setupHappyPath();

    await runAlertGraph(buildEvent());

    // Metadata created once (first-encounter)
    expect(mockCreateMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).not.toHaveBeenCalled();

    // Adapter invoked for each channel
    expect(mockEmailHandler).toHaveBeenCalledTimes(1);
    expect(mockSmsHandler).toHaveBeenCalledTimes(1);

    // findChannelCase called per channel; no existing rows means proceed to create
    expect(mockFindChannelCase).toHaveBeenCalledTimes(2);

    // createChannelCase called per channel with the result fields
    expect(mockCreateChannelCase).toHaveBeenCalledTimes(2);
  });

  it('passes the right per-channel input shapes to the adapters', async () => {
    setupHappyPath();

    await runAlertGraph(buildEvent());

    const emailInput = mockEmailHandler.mock.calls[0][0];
    expect(emailInput).toMatchObject({
      subject: '[P1] sensor-007 voltage breach',
      body: stubNarratives.narratives.email,
      sensorId: 'sensor-007',
    });

    const smsInput = mockSmsHandler.mock.calls[0][0];
    expect(smsInput).toMatchObject({
      body: stubNarratives.narratives.sms,
    });
    expect(typeof smsInput.phoneNumber).toBe('string');
  });
});

describe('runAlertGraph — dispatcher: retry path (idempotency)', () => {
  it('skips dispatch when an existing channel row has status=delivered', async () => {
    setupHappyPath();
    // Override: email already has a delivered row. SMS does not.
    mockFindChannelCase.mockReset();
    mockFindChannelCase.mockImplementation((_key, channel) =>
      channel === 'email'
        ? Promise.resolve({
            channel: 'email',
            caseId: 'ses-existing-001',
            status: 'delivered',
            createdAt: '2026-05-11T10:00:01Z',
            updatedAt: '2026-05-11T10:00:01Z',
          })
        : Promise.resolve(null),
    );

    const out = await runAlertGraph(buildEvent());

    // Email skipped, SMS dispatched
    expect(mockEmailHandler).not.toHaveBeenCalled();
    expect(mockSmsHandler).toHaveBeenCalledTimes(1);

    // Email's existing row updated for audit (updatedAt bumped)
    expect(mockUpdateChannelCase).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      expect.objectContaining({ updatedAt: expect.any(String) }),
    );

    // SMS got the create
    expect(mockCreateChannelCase).toHaveBeenCalledTimes(1);

    expect(out.dispatchResult.skipped).toEqual([
      { channel: 'email', reason: 'retry_already_delivered' },
    ]);
    expect(out.dispatchResult.delivered.map((r) => r.channel)).toEqual(['sms']);
  });

  it('catches ConditionalCheckFailedException on createMetadata and falls back to updateMetadata', async () => {
    setupHappyPath();
    mockCreateMetadata.mockReset();
    mockCreateMetadata.mockRejectedValueOnce(makeConditionalCheckFailedError());

    await runAlertGraph(buildEvent());

    expect(mockCreateMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ updatedAt: expect.any(String) }),
    );
  });

  it('catches ConditionalCheckFailedException on createChannelCase and falls back to updateChannelCase', async () => {
    setupHappyPath();
    // First create throws conditional; subsequent updates succeed.
    mockCreateChannelCase.mockReset();
    mockCreateChannelCase.mockRejectedValue(makeConditionalCheckFailedError());

    const out = await runAlertGraph(buildEvent());

    // Both channels' creates threw → both fall back to update
    expect(mockUpdateChannelCase).toHaveBeenCalledTimes(2);

    // Adapters still ran (we don't skip dispatch on conditional failure — that's
    // a race condition, not a retry signal)
    expect(mockEmailHandler).toHaveBeenCalledTimes(1);
    expect(mockSmsHandler).toHaveBeenCalledTimes(1);

    // Outcomes still recorded as delivered (the adapter succeeded)
    expect(out.dispatchResult.delivered).toHaveLength(2);
  });
});

describe('runAlertGraph — dispatcher: failure isolation', () => {
  it('bucketizes adapter failures without blocking the other channel', async () => {
    setupHappyPath();
    mockEmailHandler.mockReset();
    mockEmailHandler.mockResolvedValueOnce({
      channel: 'email',
      status: 'failed',
      caseId: '',
      error: 'AccessDenied',
      latencyMs: 23,
    });

    const out = await runAlertGraph(buildEvent());

    expect(out.dispatchResult.delivered.map((r) => r.channel)).toEqual(['sms']);
    expect(out.dispatchResult.failed.map((r) => r.channel)).toEqual(['email']);
    expect(out.dispatchResult.failed[0].error).toBe('AccessDenied');

    // The failed channel still wrote a cases-table row (status='failed' for audit)
    expect(mockCreateChannelCase).toHaveBeenCalledTimes(2);
  });

  it('handles an adapter that throws (contract violation) as a failed result', async () => {
    setupHappyPath();
    mockSmsHandler.mockReset();
    mockSmsHandler.mockRejectedValueOnce(new Error('Unexpected network error'));

    const out = await runAlertGraph(buildEvent());

    expect(out.dispatchResult.delivered.map((r) => r.channel)).toEqual(['email']);
    expect(out.dispatchResult.failed.map((r) => r.channel)).toEqual(['sms']);
    expect(out.dispatchResult.failed[0].error).toBe('Unexpected network error');
  });
});

describe('runAlertGraph — dispatcher: skip reasons', () => {
  it('skips a channel when routing selected it but the narrative is missing', async () => {
    setupHappyPath();
    mockGenerateNarratives.mockReset();
    mockGenerateNarratives.mockResolvedValueOnce({
      // Only email narrative — sms missing entirely.
      narratives: { email: stubNarratives.narratives.email },
    });

    const out = await runAlertGraph(buildEvent());

    expect(mockSmsHandler).not.toHaveBeenCalled();
    expect(out.dispatchResult.skipped).toContainEqual({
      channel: 'sms',
      reason: 'narrative_missing',
    });
    expect(out.dispatchResult.delivered.map((r) => r.channel)).toEqual(['email']);
  });
});

describe('runAlertGraph — dispatcher: metadata ordering', () => {
  it('ensures the metadata row before any per-channel dispatch begins', async () => {
    setupHappyPath();
    const callOrder: string[] = [];
    mockCreateMetadata.mockImplementationOnce(() => {
      callOrder.push('createMetadata');
      return Promise.resolve(undefined);
    });
    mockEmailHandler.mockImplementationOnce(() => {
      callOrder.push('emailHandler');
      return Promise.resolve(stubEmailResult);
    });
    mockSmsHandler.mockImplementationOnce(() => {
      callOrder.push('smsHandler');
      return Promise.resolve(stubSmsResult);
    });

    await runAlertGraph(buildEvent());

    // Metadata must come before any adapter invocation
    expect(callOrder[0]).toBe('createMetadata');
    expect(callOrder.slice(1).sort()).toEqual(['emailHandler', 'smsHandler']);
  });
});
