/**
 * Routing strategy tests — verifies the P8.4 node:
 *   1. Maps a (severity, event) input through `invokeStructured` to a
 *      Zod-typed routing plan.
 *   2. Pins the contract: schema, message shape, prompt content.
 *   3. Schema enforces the override-reason audit constraint.
 *   4. Baseline matrix is well-formed (every tier has an entry; each
 *      entry has the two channels as booleans).
 *   5. Bedrock errors propagate.
 *
 * Channel set as of 2026-05-13: { email, sms }. SMS is paging-grade.
 * The `pageOnCall` boolean from the original 4-channel design was
 * collapsed into `channels.sms`.
 */

const mockInvokeStructured = jest.fn();

jest.mock('../lib/llm-client', () => ({
  invokeStructured: mockInvokeStructured,
}));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

import {
  determineRouting,
  routingPlanSchema,
  BASELINE_MATRIX,
  __testables,
  type RoutingPlan,
} from '../lib/routing-strategy';
import type { SensorEvent } from '../lib/types';
import type { Severity } from '../lib/severity-classifier';

const buildEvent = (overrides: Partial<SensorEvent> = {}): SensorEvent => ({
  sensorId: 'sensor-005',
  timestamp: '2026-05-11T09:00:00Z',
  readingType: 'voltage',
  value: 108,
  unit: 'V',
  gridZone: 'zone-2',
  ...overrides,
});

const buildSeverity = (
  tier: Severity['severity'] = 'P1',
  overrides: Partial<Severity> = {},
): Severity => ({
  severity: tier,
  confidence: 0.92,
  reasoning: 'voltage=108V is 6V below 114V minimum — P1 band.',
  ...overrides,
});

beforeEach(() => {
  mockInvokeStructured.mockReset();
});

describe('determineRouting — baseline-path fixture matrix', () => {
  it.each<{
    name: string;
    tier: Severity['severity'];
    expectedChannels: RoutingPlan['channels'];
  }>([
    {
      name: 'P0 — both channels (email + sms, paging-grade)',
      tier: 'P0',
      expectedChannels: { email: true, sms: true },
    },
    {
      name: 'P1 — both channels (email + sms, paging-grade)',
      tier: 'P1',
      expectedChannels: { email: true, sms: true },
    },
    {
      name: 'P2 — email only (no SMS paging)',
      tier: 'P2',
      expectedChannels: { email: true, sms: false },
    },
    {
      name: 'P3 — email only (informational)',
      tier: 'P3',
      expectedChannels: { email: true, sms: false },
    },
  ])('returns the baseline routing for $name', async ({ tier, expectedChannels }) => {
    const plan: RoutingPlan = {
      channels: expectedChannels,
      overrideApplied: false,
    };
    mockInvokeStructured.mockResolvedValueOnce(plan);

    const out = await determineRouting(buildEvent(), buildSeverity(tier));

    expect(out).toEqual(plan);
    expect(routingPlanSchema.safeParse(out).success).toBe(true);
  });
});

describe('determineRouting — override path', () => {
  it('accepts overrideApplied=true with a reason (P2 escalated to SMS paging)', async () => {
    const plan: RoutingPlan = {
      channels: { email: true, sms: true },
      overrideApplied: true,
      overrideReason:
        'sensor has breached three times in the last 30 minutes; escalating P2 to SMS paging posture.',
    };
    mockInvokeStructured.mockResolvedValueOnce(plan);

    const out = await determineRouting(buildEvent(), buildSeverity('P2'));

    expect(out.overrideApplied).toBe(true);
    expect(out.overrideReason).toBeDefined();
    expect(out.channels.sms).toBe(true);
    expect(routingPlanSchema.safeParse(out).success).toBe(true);
  });
});

describe('determineRouting — schema contract', () => {
  it('passes the routingPlanSchema and a [system, user] message pair', async () => {
    mockInvokeStructured.mockResolvedValueOnce({
      channels: { email: true, sms: false },
      overrideApplied: false,
    });

    await determineRouting(buildEvent(), buildSeverity('P2'));

    expect(mockInvokeStructured).toHaveBeenCalledTimes(1);
    const [schemaArg, messagesArg] = mockInvokeStructured.mock.calls[0];

    expect(schemaArg).toBe(routingPlanSchema);
    expect(messagesArg).toHaveLength(2);
    expect(messagesArg[0]._getType()).toBe('system');
    expect(messagesArg[1]._getType()).toBe('human');
  });

  it('user prompt includes severity tier, confidence, reasoning, and event context', async () => {
    mockInvokeStructured.mockResolvedValueOnce({
      channels: { email: true, sms: true },
      overrideApplied: false,
    });

    await determineRouting(
      buildEvent({ sensorId: 'sensor-042', value: 105 }),
      buildSeverity('P1', {
        reasoning: 'voltage=105V is 9V below 114V minimum — P1 band.',
      }),
    );

    const userMessage = mockInvokeStructured.mock.calls[0][1][1];
    const userText = userMessage.content;

    expect(userText).toContain('P1');
    expect(userText).toContain('0.92');
    expect(userText).toContain('voltage=105V is 9V below 114V minimum');
    expect(userText).toContain('sensor-042');
    expect(userText).toContain('105');
  });

  it('system prompt embeds the baseline matrix and the override criteria', () => {
    const { buildSystemPrompt } = __testables;
    const prompt = buildSystemPrompt(BASELINE_MATRIX);

    // All four tiers must be in the matrix prompt — otherwise the
    // model has no rubric for that tier.
    expect(prompt).toContain('P0');
    expect(prompt).toContain('P1');
    expect(prompt).toContain('P2');
    expect(prompt).toContain('P3');

    // Both channels must be named (the model has to know the choice set).
    expect(prompt.toLowerCase()).toContain('email');
    expect(prompt.toLowerCase()).toContain('sms');

    // Override criteria mentioned (model must know when to deviate).
    expect(prompt.toLowerCase()).toContain('cascading-failure');
    expect(prompt.toLowerCase()).toContain('recurrence');
    expect(prompt.toLowerCase()).toContain('override');

    // Bias toward baseline must be explicit.
    expect(prompt).toContain('DEFAULT BEHAVIOR');
  });

  it('propagates Bedrock errors', async () => {
    mockInvokeStructured.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    await expect(
      determineRouting(buildEvent(), buildSeverity('P1')),
    ).rejects.toThrow('Bedrock unavailable');
  });
});

describe('routingPlanSchema bounds', () => {
  const baseChannels = { email: true, sms: false };

  it('accepts overrideApplied=false without reason', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      overrideApplied: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects overrideApplied=true WITHOUT overrideReason (audit constraint)', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      overrideApplied: true,
    });
    expect(r.success).toBe(false);
  });

  it('rejects overrideReason shorter than 10 chars', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      overrideApplied: true,
      overrideReason: 'short',
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing channel keys', () => {
    const r = routingPlanSchema.safeParse({
      channels: { email: true }, // missing sms
      overrideApplied: false,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-boolean channel values', () => {
    const r = routingPlanSchema.safeParse({
      channels: { email: 'yes', sms: false },
      overrideApplied: false,
    });
    expect(r.success).toBe(false);
  });
});

describe('BASELINE_MATRIX integrity', () => {
  const tiers: Array<Severity['severity']> = ['P0', 'P1', 'P2', 'P3'];

  it('has an entry for every severity tier', () => {
    tiers.forEach((tier) => {
      expect(BASELINE_MATRIX[tier]).toBeDefined();
    });
  });

  it('every tier defines email + sms as booleans', () => {
    tiers.forEach((tier) => {
      const entry = BASELINE_MATRIX[tier];
      expect(typeof entry.email).toBe('boolean');
      expect(typeof entry.sms).toBe('boolean');
    });
  });

  it('P0 selects both channels (paging-grade)', () => {
    const p0 = BASELINE_MATRIX.P0;
    expect(p0.email).toBe(true);
    expect(p0.sms).toBe(true);
  });

  it('P1 selects both channels (paging-grade)', () => {
    const p1 = BASELINE_MATRIX.P1;
    expect(p1.email).toBe(true);
    expect(p1.sms).toBe(true);
  });

  it('P2 selects email only (no SMS paging)', () => {
    const p2 = BASELINE_MATRIX.P2;
    expect(p2.email).toBe(true);
    expect(p2.sms).toBe(false);
  });

  it('P3 selects email only (informational)', () => {
    const p3 = BASELINE_MATRIX.P3;
    expect(p3.email).toBe(true);
    expect(p3.sms).toBe(false);
  });
});
