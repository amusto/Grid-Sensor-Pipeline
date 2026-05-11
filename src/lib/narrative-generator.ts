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
 *   - Slack — on-call ops engineers. Terse, action-oriented, includes
 *     the call-to-action verb. 1-3 sentences.
 *   - Email — engineering leads / management. Structured context,
 *     why this matters, what's being done. Paragraph form.
 *   - PagerDuty — on-call rotation, often half-asleep. Incident-style
 *     summary with the severity prefix, the exact sensor, the
 *     numeric breach, and the suggested first action.
 *   - Status page — customers / public. Plain English, no internal
 *     identifiers, focused on impact and ETA-to-resolution.
 *
 * Trying to write one message for all four channels produces something
 * that's optimal for none. Generating four narratives in one LLM call
 * is more token-efficient than four separate calls (shared prompt
 * preamble) while letting each narrative be channel-appropriate.
 *
 * **What this node does NOT do** (handlers orchestrate; lib executes):
 *   - Send the narrative anywhere (tool calls — P9).
 *   - Decide *which* channels to use (that's the routing node).
 *   - Open cases / persist linkage (P9).
 *
 * **Cost shape.** Single LLM call producing four narratives is
 * cheaper than four calls because the breach context only ships once
 * (shared input tokens) even though the output expands per selected
 * channel. Expected per-call: ~600 input tokens, ~400 output tokens
 * for a P0 (all four channels); ~600 input + ~100 output for a P3
 * (slack only). Bounded by schema length limits below.
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
 * bounds cap output tokens (cost lever).
 *
 *   - slack:        1-3 sentences, max ~280 chars (Twitter-shaped for
 *                   the operator skim case).
 *   - email:        Paragraph form, max ~1200 chars (~200 words).
 *   - pagerduty:    Incident summary, max ~400 chars.
 *   - status_page:  Customer-facing, max ~600 chars.
 *
 * The refinement at the bottom enforces "if routing selected this
 * channel, the narrative for it MUST be present" — caught at parse
 * time so a malformed LLM output trips Zod, not downstream code.
 */
export const narrativesSchema = z.object({
  narratives: z.object({
    slack: z.string().min(10).max(280).optional(),
    email: z.string().min(20).max(1200).optional(),
    pagerduty: z.string().min(10).max(400).optional(),
    status_page: z.string().min(10).max(600).optional(),
  }),
});

export type Narratives = z.infer<typeof narrativesSchema>;

const SYSTEM_PROMPT = `You are a narrative generator for a US power grid sensor pipeline. You write channel-specific alert messages for breaches that have already been classified (severity) and routed (selected channels).

Audience and tone PER CHANNEL — adhere strictly:

  - SLACK: on-call ops engineers, mid-task. Terse, action-oriented. 1-3 SHORT sentences. Lead with the severity tier and the sensor. Include the call-to-action verb ("investigate", "acknowledge", "monitor"). Plain text, no markdown. Max 280 chars.

  - EMAIL: engineering leads / management. Paragraph form, structured context. State: what happened, why it matters, what action is being taken, who is on it. Professional tone. Max ~200 words.

  - PAGERDUTY: on-call rotation, possibly half-asleep. Incident-summary shape. Lead with severity prefix (P0/P1/P2/P3), exact sensor id, numeric breach value vs threshold, and a one-sentence "first thing to check." Max 400 chars. No flourish.

  - STATUS_PAGE: customers / public. Plain English, NO internal sensor IDs or jargon. Focus on impact ("local grid frequency briefly deviated from nominal") and remediation status. Max 600 chars.

RULES:
  - Generate a narrative for EACH channel the routing plan selected. Omit any channel not selected.
  - Cite the specific numeric value and threshold in every narrative (status_page may abstract this to "outside the normal operating range").
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
    `Page on call: ${routing.pageOnCall ? 'yes' : 'no'}`,
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
