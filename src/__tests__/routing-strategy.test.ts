/**
 * Routing strategy tests — verifies the P8.4 node:
 *   1. Maps a (severity, event) input through `invokeStructured` to a
 *      Zod-typed routing plan.
 *   2. Pins the contract: schema, message shape, prompt content.
 *   3. Schema enforces the override-reason audit constraint.
 *   4. Baseline matrix is well-formed (every tier has an entry; each
 *      entry has the four channels + pageOnCall).
 *   5. Bedrock errors propagate.
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
    expectedPageOnCall: boolean;
  }>([
    {
      name: 'P0 — all channels + page on call',
      tier: 'P0',
      expectedChannels: {
        slack: true,
        pagerduty: true,
        email: true,
        status_page: true,
      },
      expectedPageOnCall: true,
    },
    {
      name: 'P1 — slack + pagerduty + email; page on call; no status page',
      tier: 'P1',
      expectedChannels: {
        slack: true,
        pagerduty: true,
        email: true,
        status_page: false,
      },
      expectedPageOnCall: true,
    },
    {
      name: 'P2 — slack + email; no page',
      tier: 'P2',
      expectedChannels: {
        slack: true,
        pagerduty: false,
        email: true,
        status_page: false,
      },
      expectedPageOnCall: false,
    },
    {
      name: 'P3 — slack only; no page',
      tier: 'P3',
      expectedChannels: {
        slack: true,
        pagerduty: false,
        email: false,
        status_page: false,
      },
      expectedPageOnCall: false,
    },
  ])(
    'returns the baseline routing for $name',
    async ({ tier, expectedChannels, expectedPageOnCall }) => {
      const plan: RoutingPlan = {
        channels: expectedChannels,
        pageOnCall: expectedPageOnCall,
        overrideApplied: false,
      };
      mockInvokeStructured.mockResolvedValueOnce(plan);

      const out = await determineRouting(buildEvent(), buildSeverity(tier));

      expect(out).toEqual(plan);
      expect(routingPlanSchema.safeParse(out).success).toBe(true);
    },
  );
});

describe('determineRouting — override path', () => {
  it('accepts overrideApplied=true with a reason', async () => {
    const plan: RoutingPlan = {
      channels: {
        slack: true,
        pagerduty: true,
        email: true,
        status_page: false,
      },
      pageOnCall: true,
      overrideApplied: true,
      overrideReason:
        'sensor has breached three times in the last 30 minutes; escalating P2 routing to P1 posture.',
    };
    mockInvokeStructured.mockResolvedValueOnce(plan);

    const out = await determineRouting(buildEvent(), buildSeverity('P2'));

    expect(out.overrideApplied).toBe(true);
    expect(out.overrideReason).toBeDefined();
    expect(routingPlanSchema.safeParse(out).success).toBe(true);
  });
});

describe('determineRouting — schema contract', () => {
  it('passes the routingPlanSchema and a [system, user] message pair', async () => {
    mockInvokeStructured.mockResolvedValueOnce({
      channels: {
        slack: true,
        pagerduty: false,
        email: true,
        status_page: false,
      },
      pageOnCall: false,
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
      channels: {
        slack: true,
        pagerduty: true,
        email: true,
        status_page: false,
      },
      pageOnCall: true,
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
  const baseChannels = {
    slack: true,
    pagerduty: false,
    email: false,
    status_page: false,
  };

  it('accepts overrideApplied=false without reason', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      pageOnCall: false,
      overrideApplied: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects overrideApplied=true WITHOUT overrideReason (audit constraint)', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      pageOnCall: false,
      overrideApplied: true,
    });
    expect(r.success).toBe(false);
  });

  it('rejects overrideReason shorter than 10 chars', () => {
    const r = routingPlanSchema.safeParse({
      channels: baseChannels,
      pageOnCall: false,
      overrideApplied: true,
      overrideReason: 'short',
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing channel keys', () => {
    const r = routingPlanSchema.safeParse({
      channels: { slack: true, pagerduty: false, email: false }, // missing status_page
      pageOnCall: false,
      overrideApplied: false,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-boolean channel values', () => {
    const r = routingPlanSchema.safeParse({
      channels: { ...baseChannels, slack: 'yes' },
      pageOnCall: false,
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

  it('every tier defines all four channels plus pageOnCall as booleans', () => {
    tiers.forEach((tier) => {
      const entry = BASELINE_MATRIX[tier];
      expect(typeof entry.slack).toBe('boolean');
      expect(typeof entry.pagerduty).toBe('boolean');
      expect(typeof entry.email).toBe('boolean');
      expect(typeof entry.status_page).toBe('boolean');
      expect(typeof entry.pageOnCall).toBe('boolean');
    });
  });

  it('P0 selects every channel and pages on call', () => {
    const p0 = BASELINE_MATRIX.P0;
    expect(p0.slack).toBe(true);
    expect(p0.pagerduty).toBe(true);
    expect(p0.email).toBe(true);
    expect(p0.status_page).toBe(true);
    expect(p0.pageOnCall).toBe(true);
  });

  it('P3 selects slack only and does NOT page', () => {
    const p3 = BASELINE_MATRIX.P3;
    expect(p3.slack).toBe(true);
    expect(p3.pagerduty).toBe(false);
    expect(p3.email).toBe(false);
    expect(p3.status_page).toBe(false);
    expect(p3.pageOnCall).toBe(false);
  });
});
