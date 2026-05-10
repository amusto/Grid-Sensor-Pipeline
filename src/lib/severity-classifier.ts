/**
 * Severity classifier — first node in the LangGraph alert flow (P8.3).
 *
 * Given a breach event + the threshold evaluation that flagged it,
 * classify the operational severity into P0/P1/P2/P3. Output is a
 * Zod-validated structured object: severity tier, confidence, and a
 * short human-readable reasoning string suitable for inclusion in
 * downstream narratives or audit logs.
 *
 * **Why this is a node, not a hard-coded predicate.**
 *   The deterministic threshold check (`lib/threshold.ts`) only tells
 *   us *whether* a value breached its bound. Severity is a richer
 *   judgment — magnitude of deviation, reading type's grid impact,
 *   pattern context. The LLM does the multi-factor judgment that
 *   would otherwise need a hard-coded rules engine.
 *
 * **Why structured output (Zod) and not free text.**
 *   - Routing decisions downstream depend on the tier; ambiguous prose
 *     would force string parsing.
 *   - Bounded enum + numeric confidence is testable; free text is not.
 *   - Audit trails need a stable schema.
 *
 * **What this node does NOT do** (deliberately, per CLAUDE.md
 * invariant #2 — handlers / nodes orchestrate; lib executes):
 *   - Decide channels (that's the routing strategy node, P8.4).
 *   - Open cases (that's P9).
 *   - Generate the user-facing narrative (that's the narrative node,
 *     P8.4). Severity reasoning here is internal/audit only — short,
 *     terse, optimized for log searchability.
 *
 * **Cost shape** (per call). System prompt is ~150 tokens, user
 * context is ~80 tokens, output is ~80 tokens → ~310 tokens/call =
 * ~$0.0027 at Sonnet 4.6 ballpark rates. Per-alert cost rolls up
 * across all three nodes (severity + routing + narrative) ≈ $0.014.
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import { invokeStructured } from './llm-client';
import type { SensorEvent } from './types';
import type { ThresholdResult } from './threshold';

/**
 * Output schema. Tight bounds for two reasons:
 *   - `confidence: [0, 1]` — anything else is a model error worth
 *     surfacing (caught by Zod parse, retried once via maxRetries=1
 *     in the LLM client, then thrown).
 *   - `reasoning: 10..500` — short enough to log inline; long enough
 *     to reference a specific value and threshold. Bounds the prompt
 *     output budget without needing temperature tuning.
 */
export const severitySchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(10).max(500),
});

export type Severity = z.infer<typeof severitySchema>;

/**
 * System prompt. Specific about the tier semantics so the model has a
 * stable rubric. Vague tiers ("high/medium/low") would yield
 * inconsistent classifications across invocations; precise tiers tied
 * to operational responses give the model the same anchors a human
 * on-call engineer would have.
 *
 * Tier semantics align with `docs/decisions/phase-09-agentic-case-routing.md`
 * pre-flight 4 (severity-driven routing matrix as data) — the routing
 * node downstream consults that matrix keyed on these exact strings.
 */
const SYSTEM_PROMPT = `You are an operations classifier for a US power grid sensor pipeline.

Given a sensor reading that breached a threshold, classify the operational severity into one of:
  - P0: Imminent grid stability risk. Extreme deviation or cascading-failure context. Page on-call immediately.
  - P1: Significant deviation. Single reading well outside tolerance. Page on-call within 15 min.
  - P2: Moderate deviation. Investigation warranted, no immediate risk. Email + Slack notification.
  - P3: Mild deviation. Telemetry only, no operator action required. Slack-only notification.

For NERC frequency thresholds (59.5-60.5 Hz nominal), treat:
  - >2 Hz outside band as P0
  - 1-2 Hz outside band as P1
  - 0.5-1 Hz outside band as P2
  - just over the band as P3
For voltage thresholds (114-126 V nominal):
  - >15 V outside band as P0
  - 8-15 V outside band as P1
  - 4-8 V outside band as P2
  - just over the band as P3

Reasoning: ONE OR TWO short sentences. Cite the specific value and threshold. No flourishes.
Confidence: a single number in [0, 1]. Use 0.95+ when the deviation magnitude clearly maps to one tier; lower (0.6-0.8) when the value sits at a boundary between tiers.`;

const buildUserPrompt = (
  event: SensorEvent,
  threshold: ThresholdResult,
): string =>
  [
    `Sensor: ${event.sensorId}`,
    `Reading type: ${event.readingType}`,
    `Value: ${event.value} ${event.unit}`,
    `Timestamp: ${event.timestamp}`,
    `Grid zone: ${event.gridZone ?? 'unknown'}`,
    `Threshold breach: ${threshold.details}`,
  ].join('\n');

/**
 * Classify a breach into a severity tier.
 *
 * @param event     The sensor event that breached.
 * @param threshold The threshold-evaluation result. Must be `exceeded:
 *                  true` — calling this on a non-breach is a programming
 *                  error (asserted defensively below).
 * @returns         `{ severity, confidence, reasoning }` — Zod-validated.
 * @throws          Bedrock errors propagate; caller's fail-soft
 *                  fallback (P8 pre-flight 6) decides whether to swallow.
 */
export const classifySeverity = async (
  event: SensorEvent,
  threshold: ThresholdResult,
): Promise<Severity> => {
  if (!threshold.exceeded) {
    throw new Error(
      'classifySeverity called on a non-breach reading — caller bug. ' +
        'Severity classification only makes sense for events that actually exceeded a threshold.',
    );
  }

  const messages: BaseMessageLike[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(event, threshold)),
  ];

  return invokeStructured(severitySchema, messages);
};

/**
 * Exported for unit tests — lets us assert on the prompt shape without
 * actually invoking Bedrock.
 */
export const __testables = {
  SYSTEM_PROMPT,
  buildUserPrompt,
};
