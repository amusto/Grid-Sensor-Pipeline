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
 *
 * Channel set as of 2026-05-13: { email, sms }. SMS bounded to 160
 * chars (GSM-7 single-segment limit), email bounded to 1200 chars.
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
  channels: { email: true, sms: true },
  overrideApplied: false,
  ...overrides,
});

beforeEach(() => {
  mockInvokeStructured.mockReset();
});

describe('generateNarratives — happy path', () => {
  it('returns per-channel narratives for a P1 (email + sms)', async () => {
    const narratives: Narratives = {
      narratives: {
        email:
          'Sensor sensor-005 reported a voltage reading of 108V at 09:15Z, 6V below the 114V minimum threshold in NERC band. This is a P1 — significant deviation, on-call paged via SMS. Investigation in progress; substation feed will be checked first.',
        sms: 'P1: sensor-005 voltage 108V (6V below 114V min). Investigate now.',
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
  });

  it('returns just the email narrative for a P3 (email only)', async () => {
    const narratives: Narratives = {
      narratives: {
        email:
          'Sensor sensor-019 reported a voltage reading of 113V at 09:15Z, 1V below the 114V minimum threshold. This is a P3 informational deviation — monitoring only, no immediate action required.',
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
        channels: { email: true, sms: false },
      }),
    );

    expect(out.narratives.email).toBeDefined();
    expect(out.narratives.sms).toBeUndefined();
  });

  it('returns both narratives for a P0 (paging-grade)', async () => {
    const narratives: Narratives = {
      narratives: {
        email:
          'Critical: sensor sensor-002 reported 95V at 09:15Z — a 19V deviation below the 114V minimum, P0 severity. On-call paged via SMS. Investigation focusing on the zone-1 upstream feed.',
        sms: 'P0: sensor-002 voltage 95V (19V below 114V min). Page acknowledged; investigating.',
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
        channels: { email: true, sms: true },
      }),
    );

    expect(out.narratives.email).toBeDefined();
    expect(out.narratives.sms).toBeDefined();
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
        channels: { email: true, sms: false },
      }),
    );

    const userMessage = mockInvokeStructured.mock.calls[0][1][1];
    const userText: string = userMessage.content;

    expect(userText).toMatch(/Routing plan selected:.*email/);
    // Channels NOT selected must NOT appear in the "selected" line.
    expect(userText).not.toMatch(/Routing plan selected:.*sms/);
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
        channels: { email: true, sms: true },
        overrideApplied: true,
        overrideReason:
          'sensor has breached three times in the last 30 minutes; escalating P2 to SMS paging.',
      }),
    );

    const userText: string = mockInvokeStructured.mock.calls[0][1][1].content;
    expect(userText).toContain('Routing override applied');
    expect(userText).toContain('three times');
  });

  it('system prompt anchors both channels with audience + tone', () => {
    const { SYSTEM_PROMPT } = __testables;

    // Each channel must be named explicitly with tone guidance.
    expect(SYSTEM_PROMPT).toContain('EMAIL');
    expect(SYSTEM_PROMPT).toContain('SMS');

    // Audience anchors (small spot-check; full prompt review is a
    // separate close-out task).
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('on-call');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('engineering leads');

    // SMS bound surfaces as a concrete rule the LLM can obey.
    expect(SYSTEM_PROMPT).toContain('160');
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

  it('accepts an SMS narrative at the 160-char limit', () => {
    const r = narrativesSchema.safeParse({
      narratives: { sms: 'x'.repeat(160) },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an SMS narrative over 160 chars (GSM-7 single-segment limit)', () => {
    const r = narrativesSchema.safeParse({
      narratives: { sms: 'x'.repeat(161) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an SMS narrative under 10 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { sms: 'short' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts an email narrative at the 1200-char limit', () => {
    const r = narrativesSchema.safeParse({
      narratives: { email: 'x'.repeat(1200) },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an email narrative over 1200 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { email: 'x'.repeat(1201) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an email narrative under 20 chars', () => {
    const r = narrativesSchema.safeParse({
      narratives: { email: 'too short' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts unknown channel keys (schema is permissive, not strict)', () => {
    const r = narrativesSchema.safeParse({
      narratives: {
        email:
          'A short but valid email narrative for an informational P3.',
        slack: 'should be ignored',
      },
    });
    // Zod object schemas accept extra keys by default; we explicitly
    // do NOT enforce strict mode here so legacy/future channels parse
    // cleanly even if the codebase has trimmed them. Documented
    // behavior; tighten to .strict() if regressions surface.
    expect(r.success).toBe(true);
  });
});
