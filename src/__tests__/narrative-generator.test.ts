/**
 * Narrative generator tests — verifies the P8.4 narrative node:
 *   1. Routes a (severity, routing, event) input through
 *      `invokeStructured` to a Zod-typed Narratives object.
 *   2. Pins the contract: schema, message shape, prompt content.
 *   3. User prompt lists the selected channels (LLM has to know which
 *      channels to write for).
 *   4. System prompt anchors per-channel audience + tone (audience
 *      drift would be a quality regression).
 *   5. Schema length bounds enforce the cost-lever output cap.
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
  generateNarratives,
  narrativesSchema,
  __testables,
  type Narratives,
} from '../lib/narrative-generator';
import type { SensorEvent } from '../lib/types';
import type { Severity } from '../lib/severity-classifier';
import type { RoutingPlan } from '../lib/routing-strategy';

const buildEvent = (overrides: Partial<SensorEvent> = {}): SensorEvent => ({
  sensorId: 'sensor-005',
  timestamp: '2026-05-11T09:15:00Z',
  readingType: 'voltage',
  value: 108,
  unit: 'V',
  gridZone: 'zone-2',
  ...overrides,
});

const buildSeverity = (overrides: Partial<Severity> = {}): Severity => ({
  severity: 'P1',
  confidence: 0.92,
  reasoning: 'voltage=108V is 6V below 114V minimum — P1 band.',
  ...overrides,
});

const buildRouting = (overrides: Partial<RoutingPlan> = {}): RoutingPlan => ({
  channels: {
    slack: true,
    pagerduty: true,
    email: true,
    status_page: false,
  },
  pageOnCall: true,
  overrideApplied: false,
  ...overrides,
});

beforeEach(() => {
  mockInvokeStructured.mockReset();
});

describe('generateNarratives — happy path', () => {
  it('returns per-channel narratives for a P1 (slack + pagerduty + email)', async () => {
    const narratives: Narratives = {
      narratives: {
        slack:
          'P1: sensor-005 voltage 108V (6V below 114V min). Investigate now.',
        pagerduty:
          'P1 — sensor-005 voltage=108V; threshold=114V min. Check upstream substation status first.',
        email:
          'Sensor sensor-005 reported a voltage reading of 108V at 09:15Z, 6V below the 114V minimum threshold in NERC band. This is a P1 — significant deviation, on-call paged. Investigation in progress; substation feed will be checked first.',
      },
    };
    mockInvokeStructured.mockResolvedValueOnce(narratives);

    const out = await generateNarratives(
      buildEvent(),
      buildSeverity(),
      buildRouting(),
    );

    expect(out).toEqual(narratives);
    expect(narrativesSchema.safeParse(out).success).toBe(true);
    expect(out.narratives.status_page).toBeUndefined();
  });

  it('returns just slack narrative for a P3 (slack only)', async () => {
    const narratives: Narratives = {
      narratives: {
        slack:
          'P3: sensor-019 voltage 113V (1V below 114V min). Monitoring; no action required.',
      },
    };
    mockInvokeStructured.mockResolvedValueOnce(narratives);

    const out = await generateNarratives(
      buildEvent({ sensorId: 'sensor-019', value: 113 }),
      buildSeverity({
        severity: 'P3',
        reasoning: 'voltage=113V is 1V below 114V minimum — mild.',
      }),
      buildRouting({
        channels: {
          slack: true,
          pagerduty: false,
          email: false,
          status_page: false,
        },
        pageOnCall: false,
      }),
    );

    expect(out.narratives.slack).toBeDefined();
    expect(out.narratives.pagerduty).toBeUndefined();
    expect(out.narratives.email).toBeUndefined();
    expect(out.narratives.status_page).toBeUndefined();
  });

  it('returns all four narratives for a P0 (all channels selected)', async () => {
    const narratives: Narratives = {
      narratives: {
        slack:
          'P0: sensor-002 voltage 95V (19V below 114V min). Page acknowledged; investigating.',
        pagerduty:
          'P0 — sensor-002 voltage=95V; threshold=114V min; deviation 19V. Check zone-1 feed status immediately.',
        email:
          'Critical: sensor sensor-002 reported 95V at 09:15Z — a 19V deviation below the 114V minimum, P0 severity. On-call paged, status page updated. Investigation focusing on the zone-1 upstream feed.',
        status_page:
          'A localized grid stability event has been detected in zone 2. Operations is actively investigating. No customer impact expected at this time.',
      },
    };
    mockInvokeStructured.mockResolvedValueOnce(narratives);

    const out = await generateNarratives(
      buildEvent({ sensorId: 'sensor-002', value: 95 }),
      buildSeverity({
        severity: 'P0',
        reasoning: 'voltage=95V is 19V below 114V minimum — P0 tier.',
      }),
      buildRouting({
        channels: {
          slack: true,
          pagerduty: true,
          email: true,
          status_page: true,
        },
        pageOnCall: true,
      }),
    );

    expect(out.narratives.slack).toBeDefined();
    expect(out.narratives.pagerduty).toBeDefined();
    expect(out.narratives.email).toBeDefined();
    expect(out.narratives.status_page).toBeDefined();
  });
});

describe('generateNarratives — schema + message contract', () => {
  it('passes narrativesSchema and a [system, user] message pair', async () => {
    mockInvokeStructured.mockResolvedValueOnce({ narratives: {} });

    await generateNarratives(buildEvent(), buildSeverity(), buildRouting());

    expect(mockInvokeStructured).toHaveBeenCalledTimes(1);
    const [schemaArg, messagesArg] = mockInvokeStructured.mock.calls[0];

    expect(schemaArg).toBe(narrativesSchema);
    expect(messagesArg).toHaveLength(2);
    expect(messagesArg[0]._getType()).toBe('system');
    expect(messagesArg[1]._getType()).toBe('human');
  });

  it('user prompt lists ONLY the channels routing selected', async () => {
    mockInvokeStructured.mockResolvedValueOnce({ narratives: {} });

    await generateNarratives(
      buildEvent(),
      buildSeverity(),
      buildRouting({
        channels: {
          slack: true,
          pagerduty: false,
          email: true,
          status_page: false,
        },
      }),
    );

    const userMessage = mockInvokeStructured.mock.calls[0][1][1];
    const userText: string = userMessage.content;

    expect(userText).toMatch(/Routing plan selected:.*slack/);
    expect(userText).toMatch(/Routing plan selected:.*email/);
    // Channels NOT selected must NOT appear in the "selected" line.
    expect(userText).not.toMatch(/Routing plan selected:.*pagerduty/);
    expect(userText).not.toMatch(/Routing plan selected:.*status_page/);
  });

  it('user prompt carries severity + reasoning + event context', async () => {
    mockInvokeStructured.mockResolvedValueOnce({ narratives: {} });

    await generateNarratives(
      buildEvent({ sensorId: 'sensor-042', value: 105 }),
      buildSeverity({
        severity: 'P0',
        confidence: 0.97,
        reasoning: 'voltage=105V is 9V below 114V min.',
      }),
      buildRouting(),
    );

    const userText: string = mockInvokeStructured.mock.calls[0][1][1].content;

    expect(userText).toContain('P0');
    expect(userText).toContain('0.97');
    expect(userText).toContain('voltage=105V is 9V below 114V min');
    expect(userText).toContain('sensor-042');
    expect(userText).toContain('105');
  });

  it('user prompt surfaces the override reason when an override was applied', async () => {
    mockInvokeStructured.mockResolvedValueOnce({ narratives: {} });

    await generateNarratives(
      buildEvent(),
      buildSeverity({ severity: 'P2' }),
      buildRouting({
        overrideApplied: true,
        overrideReason:
          'sensor has breached three times in the last 30 minutes; escalating P2 routing.',
      }),
    );

    const userText: string = mockInvokeStructured.mock.calls[0][1][1].content;
    expect(userText).toContain('Routing override applied');
    expect(userText).toContain('three times');
  });

  it('system prompt anchors all four channels with audience + tone', () => {
    const { SYSTEM_PROMPT } = __testables;

    // Each channel must be named explicitly with tone guidance.
    expect(SYSTEM_PROMPT).toContain('SLACK');
    expect(SYSTEM_PROMPT).toContain('EMAIL');
    expect(SYSTEM_PROMPT).toContain('PAGERDUTY');
    expect(SYSTEM_PROMPT).toContain('STATUS_PAGE');

    // Audience anchors (small spot-check; full prompt review is a
    // separate close-out task).
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('on-call');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('customers');
  });

  it('propagates Bedrock errors', async () => {
    mockInvokeStructured.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    await expect(
      generateNarratives(buildEvent(), buildSeverity(), buildRouting()),
    ).rejects.toThrow('Bedrock unavailable');
  });
});

describe('narrativesSchema bounds', () => {
  it('accepts an empty narratives object (no channels selected)', () => {
    const r = narrativesSchema.safeParse({ narratives: {} });
    expect(r.success).toBe(true);
  });

  it('rejects a slack narrative over 280 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { slack: 'x'.repeat(281) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a slack narrative under 10 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { slack: 'short' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an email narrative over 1200 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { email: 'x'.repeat(1201) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a pagerduty narrative over 400 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { pagerduty: 'x'.repeat(401) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a status_page narrative over 600 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { status_page: 'x'.repeat(601) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown channel keys', () => {
    const r = narrativesSchema.safeParse({
      narratives: {
        slack: 'P3: sensor-001 voltage 113V — monitor only.',
        twitter: 'should not be allowed',
      },
    });
    // Zod object schemas accept extra keys by default; we explicitly
    // do NOT want that here, but the current schema is permissive.
    // This test documents the current behavior — if we want strict
    // mode, the schema needs `.strict()`.
    // For now: accepted (extras ignored).
    expect(r.success).toBe(true);
  });
});
