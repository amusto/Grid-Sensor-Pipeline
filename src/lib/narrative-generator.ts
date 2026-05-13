/**
 * Narrative generator — third node in the LangGraph alert flow (P8.4).
 *
 * Given the severity classification, the routing plan, and the
 * underlying event, produce a channel-specific narrative for every
 * channel the routing plan selected. Output is a Zod-validated object
 * with per-channel strings; channels NOT selected by routing are
 * omitted (schema enforces this via optionality + a refinement).
 *
 * **Why per-channel narratives, not one canonical message.** Each
 * channel has different audience, tone, and information needs:
 *   - Email — engineering leads / management / ops engineers reading
 *     in their inbox. Structured context, why this matters, what's
 *     being done. Paragraph form. Always sent (the default channel).
 *   - SMS — on-call ops engineer's phone, possibly mid-task or asleep.
 *     Extreme brevity, paging-grade. One sentence, single-segment
 *     (≤160 chars). Sent only when severity warrants the phone
 *     interrupt.
 *
 * Trying to write one message for both channels produces something
 * that's optimal for neither — a paragraph is too long for SMS, a
 * 160-char sentence is too thin for email. Generating both narratives
 * in one LLM call is more token-efficient than two separate calls
 * (shared prompt preamble) while letting each narrative be channel-
 * appropriate.
 *
 * **What this node does NOT do** (handlers orchestrate; lib executes):
 *   - Send the narrative anywhere (tool calls — P9.4 "execute tools").
 *   - Decide *which* channels to use (that's the routing node).
 *   - Open cases / persist linkage (P9.3 cases table).
 *
 * **Cost shape.** Single LLM call producing up to two narratives.
 * Breach context ships once (shared input tokens); output expands per
 * selected channel. Expected per-call: ~600 input tokens, ~250 output
 * tokens for a P0/P1 (both channels); ~600 input + ~150 output for a
 * P2/P3 (email only). Bounded by schema length limits below — the
 * SMS ≤160 cap is both a real-world segment limit and a cost lever.
 *
 * **Channel set as of 2026-05-13.** Phase 9 simplified the original
 * 4-channel design (slack, pagerduty, email, status_page) to 2
 * channels (email, sms).
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import { invokeStructured } from './llm-client';
import type { SensorEvent } from './types';
import type { Severity } from './severity-classifier';
import type { RoutingPlan } from './routing-strategy';

/**
 * Output schema. Each channel narrative is optional — present iff the
 * corresponding routing channel was selected. Schema-level length
 * bounds cap output tokens (cost lever) and enforce real-world
 * channel constraints (the 160-char SMS bound is the GSM-7 single-
 * segment limit).
 *
 *   - email: Paragraph form, max ~1200 chars (~200 words).
 *   - sms:   One sentence, max 160 chars (GSM-7 single segment).
 *
 * Downstream channel-selection refinement (narrative present iff
 * channel selected) is enforced at the alert-handler layer where both
 * routing and narratives are in scope. Here we only enforce per-field
 * length bounds.
 */
export const narrativesSchema = z.object({
  narratives: z.object({
    email: z.string().min(20).max(1200).optional(),
    sms: z.string().min(10).max(160).optional(),
  }),
});

export type Narratives = z.infer<typeof narrativesSchema>;

const SYSTEM_PROMPT = `You are a narrative generator for a US power grid sensor pipeline. You write channel-specific alert messages for breaches that have already been classified (severity) and routed (selected channels).

Audience and tone PER CHANNEL — adhere strictly:

  - EMAIL: engineering leads / management / ops engineers in their inbox. Paragraph form, structured context. State: what happened, why it matters, what action is being taken, who is on it. Professional tone. Max ~200 words.

  - SMS: on-call ops engineer's phone, possibly mid-task or asleep. Extreme brevity. ONE sentence. Lead with severity prefix (P0/P1/P2/P3) and the sensor id, then the numeric breach. No fluff, no greetings, no signature. Max 160 chars (single SMS segment).

RULES:
  - Generate a narrative for EACH channel the routing plan selected. Omit any channel not selected.
  - Cite the specific numeric value and threshold in every narrative.
  - Do NOT speculate beyond the data. No "this is probably caused by X" unless the input says so.
  - Do NOT include URLs, tickets, or identifiers that aren't in the input.
  - Keep each narrative INSIDE the per-channel character limits below the bound.`;

const buildUserPrompt = (
  event: SensorEvent,
  severity: Severity,
  routing: RoutingPlan,
): string => {
  const selectedChannels = (
    Object.keys(routing.channels) as Array<keyof RoutingPlan['channels']>
  )
    .filter((c) => routing.channels[c])
    .join(', ');

  return [
    `Severity: ${severity.severity} (confidence ${severity.confidence})`,
    `Severity reasoning: ${severity.reasoning}`,
    ``,
    `Routing plan selected: ${selectedChannels || '(none)'}`,
    routing.overrideApplied
      ? `Routing override applied: ${routing.overrideReason}`
      : 'Routing override applied: no (baseline matrix)',
    ``,
    `Sensor: ${event.sensorId}`,
    `Reading type: ${event.readingType}`,
    `Value: ${event.value} ${event.unit}`,
    `Timestamp: ${event.timestamp}`,
    `Grid zone: ${event.gridZone ?? 'unknown'}`,
    ``,
    `Generate narratives ONLY for the channels in "Routing plan selected" above.`,
  ].join('\n');
};

/**
 * Generate per-channel narratives for a classified, routed breach.
 *
 * @param event     The underlying sensor event.
 * @param severity  Output of `classifySeverity` (P8.3).
 * @param routing   Output of `determineRouting` (P8.4 routing node).
 * @returns         Zod-validated `Narratives` — has a string for each
 *                  selected channel, omits the others.
 * @throws          Bedrock errors propagate; caller's fail-soft handles.
 */
export const generateNarratives = async (
  event: SensorEvent,
  severity: Severity,
  routing: RoutingPlan,
): Promise<Narratives> => {
  const messages: BaseMessageLike[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(event, severity, routing)),
  ];

  return invokeStructured(narrativesSchema, messages);
};

/**
 * Exported for unit tests — prompt-shape assertions without invoking
 * Bedrock.
 */
export const __testables = {
  SYSTEM_PROMPT,
  buildUserPrompt,
};
