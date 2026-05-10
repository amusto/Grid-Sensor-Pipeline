/**
 * Severity classifier tests — verifies the P8.3 node:
 *   1. Maps a breach event to a Zod-typed severity object.
 *   2. Invokes `lib/llm-client.invokeStructured` with the right schema
 *      and a prompt carrying the right context.
 *   3. Refuses to classify non-breach events (caller bug).
 *   4. Propagates Bedrock errors (caller's fail-soft handles fallback).
 *
 * Strategy: mock `lib/llm-client` so no real Bedrock calls. The tests
 * pin the contract between this node and the wrapper, NOT the LLM's
 * actual classification quality. Real-LLM evaluation is out of scope
 * for unit tests — it'd need a fixture corpus of breach scenarios with
 * expected tiers, which is more interesting at the prompt-engineering
 * stage in P8 closeout.
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
  classifySeverity,
  severitySchema,
  __testables,
  type Severity,
} from '../lib/severity-classifier';
import type { SensorEvent } from '../lib/types';
import type { ThresholdResult } from '../lib/threshold';

const buildEvent = (overrides: Partial<SensorEvent> = {}): SensorEvent => ({
  sensorId: 'sensor-002',
  timestamp: '2026-05-10T14:00:00Z',
  readingType: 'voltage',
  value: 109,
  unit: 'V',
  gridZone: 'zone-3',
  ...overrides,
});

const buildBreach = (overrides: Partial<ThresholdResult> = {}): ThresholdResult => ({
  exceeded: true,
  details: 'voltage=109V below min 114',
  threshold: { min: 114 },
  ...overrides,
});

beforeEach(() => {
  mockInvokeStructured.mockReset();
});

describe('classifySeverity', () => {
  it.each<{ name: string; classified: Severity }>([
    {
      name: 'P0 — extreme voltage deviation',
      classified: {
        severity: 'P0',
        confidence: 0.97,
        reasoning:
          'voltage=95V is 19V below the 114V minimum, well into the P0 tier.',
      },
    },
    {
      name: 'P1 — significant frequency deviation',
      classified: {
        severity: 'P1',
        confidence: 0.92,
        reasoning:
          'frequency=58.2Hz is 1.3Hz below 59.5Hz minimum — P1 band.',
      },
    },
    {
      name: 'P2 — moderate voltage deviation',
      classified: {
        severity: 'P2',
        confidence: 0.85,
        reasoning: 'voltage=130V is 4V above 126V max — moderate.',
      },
    },
    {
      name: 'P3 — mild voltage deviation',
      classified: {
        severity: 'P3',
        confidence: 0.78,
        reasoning: 'voltage=113V is 1V below 114V minimum — mild.',
      },
    },
  ])('returns the expected tier shape: $name', async ({ classified }) => {
    mockInvokeStructured.mockResolvedValueOnce(classified);

    const out = await classifySeverity(buildEvent(), buildBreach());

    expect(out).toEqual(classified);
    expect(severitySchema.safeParse(out).success).toBe(true);
  });

  it('throws on non-breach input (caller bug guard)', async () => {
    const cleanThreshold: ThresholdResult = {
      exceeded: false,
      details: 'voltage=120V within [114, 126]',
    };

    await expect(
      classifySeverity(buildEvent({ value: 120 }), cleanThreshold),
    ).rejects.toThrow(/non-breach/i);

    // Crucially: we must NOT have called the LLM on a non-breach.
    expect(mockInvokeStructured).not.toHaveBeenCalled();
  });

  it('passes the severity schema and a 2-message prompt to invokeStructured', async () => {
    mockInvokeStructured.mockResolvedValueOnce({
      severity: 'P1',
      confidence: 0.9,
      reasoning: 'voltage=109V is 5V below 114V minimum — P1 band.',
    });

    await classifySeverity(buildEvent(), buildBreach());

    expect(mockInvokeStructured).toHaveBeenCalledTimes(1);
    const [schemaArg, messagesArg] = mockInvokeStructured.mock.calls[0];

    // Schema is the exact severitySchema we exported.
    expect(schemaArg).toBe(severitySchema);

    // Prompt is [system, user] in that order.
    expect(messagesArg).toHaveLength(2);
    expect(messagesArg[0]._getType()).toBe('system');
    expect(messagesArg[1]._getType()).toBe('human');
  });

  it('user prompt includes sensorId, value, unit, threshold details', async () => {
    mockInvokeStructured.mockResolvedValueOnce({
      severity: 'P2',
      confidence: 0.8,
      reasoning: 'mild deviation',
    });

    const event = buildEvent({
      sensorId: 'sensor-007',
      value: 132.5,
      readingType: 'voltage',
      unit: 'V',
    });
    const breach = buildBreach({ details: 'voltage=132.5V above max 126' });

    await classifySeverity(event, breach);

    const userMessage = mockInvokeStructured.mock.calls[0][1][1];
    const userText = userMessage.content;

    expect(userText).toContain('sensor-007');
    expect(userText).toContain('132.5');
    expect(userText).toContain('V');
    expect(userText).toContain('voltage=132.5V above max 126');
    expect(userText).toContain('voltage'); // reading type
  });

  it('system prompt anchors all four tiers explicitly', () => {
    const { SYSTEM_PROMPT } = __testables;
    // Each tier must appear in the rubric or the model has no anchor
    // for that classification path.
    expect(SYSTEM_PROMPT).toContain('P0');
    expect(SYSTEM_PROMPT).toContain('P1');
    expect(SYSTEM_PROMPT).toContain('P2');
    expect(SYSTEM_PROMPT).toContain('P3');
  });

  it('propagates Bedrock errors (caller decides fallback)', async () => {
    mockInvokeStructured.mockRejectedValueOnce(
      new Error('Bedrock unavailable'),
    );

    await expect(
      classifySeverity(buildEvent(), buildBreach()),
    ).rejects.toThrow('Bedrock unavailable');
  });

  it('rejects an LLM output that violates the schema', async () => {
    // The wrapper would normally surface this as a parse error. We
    // simulate `invokeStructured` having succeeded with a bad shape
    // (defense-in-depth — if a future schema change widens the parser,
    // this test catches it).
    const bad = {
      severity: 'P5', // not in enum
      confidence: 1.5, // out of range
      reasoning: 'too short',
    };
    expect(severitySchema.safeParse(bad).success).toBe(false);

    // Sanity: a known-good shape passes.
    const good: Severity = {
      severity: 'P1',
      confidence: 0.9,
      reasoning: 'voltage=109V is 5V below 114V minimum — P1 band.',
    };
    expect(severitySchema.safeParse(good).success).toBe(true);
  });
});

describe('severitySchema bounds', () => {
  it('confidence bounds: rejects below 0', () => {
    const r = severitySchema.safeParse({
      severity: 'P1',
      confidence: -0.01,
      reasoning: 'short reason text',
    });
    expect(r.success).toBe(false);
  });

  it('confidence bounds: rejects above 1', () => {
    const r = severitySchema.safeParse({
      severity: 'P1',
      confidence: 1.01,
      reasoning: 'short reason text',
    });
    expect(r.success).toBe(false);
  });

  it('reasoning bounds: rejects under 10 chars', () => {
    const r = severitySchema.safeParse({
      severity: 'P1',
      confidence: 0.9,
      reasoning: 'too',
    });
    expect(r.success).toBe(false);
  });

  it('reasoning bounds: rejects over 500 chars', () => {
    const r = severitySchema.safeParse({
      severity: 'P1',
      confidence: 0.9,
      reasoning: 'x'.repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it('severity bounds: rejects unknown tiers', () => {
    const r = severitySchema.safeParse({
      severity: 'P9',
      confidence: 0.9,
      reasoning: 'short reason text',
    });
    expect(r.success).toBe(false);
  });
});

