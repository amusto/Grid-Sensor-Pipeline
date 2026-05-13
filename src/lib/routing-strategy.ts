/**
 * Routing strategy — second node in the LangGraph alert flow (P8.4).
 *
 * Given a classified breach severity and the underlying event, decide
 * which downstream channels should receive the alert. The two channels
 * are EMAIL (always available, default) and SMS (paging-grade — used
 * when the operator must be reached immediately). Output is a Zod-
 * validated routing plan consumed by the narrative generator (next
 * node) and by the tool-execution layer (P9.4).
 *
 * **Routing model — matrix as data, LLM as override.** The baseline
 * routing for each severity tier is a deterministic table, mirrored
 * inline in this file. The LLM is instructed to apply the baseline
 * unchanged in the typical case. The override path activates only for
 * cross-cutting context the matrix doesn't capture — cascading-failure
 * patterns, off-hours staffing, recent recurrence at the same sensor.
 * Every override is flagged + reasoned in the output so downstream
 * audit can count overrides and trigger a matrix review if they
 * become frequent.
 *
 * **Why this is a node, not a hard-coded lookup.** A lookup table
 * alone can't reason about *context*. A P2 breach during an active
 * P0 cascade should probably escalate to SMS paging; a P1 at
 * 3am on a sensor that's flapped six times today probably warrants
 * a different on-call posture than a P1 on a quiet sensor. The LLM
 * does the multi-factor judgment that would otherwise need explicit
 * heuristics encoded in TypeScript.
 *
 * **What this node does NOT do** (handlers/nodes orchestrate; lib
 * executes — CLAUDE.md invariant #2):
 *   - Dispatch to channels (tool calls — P9.4 "execute tools" node).
 *   - Generate the per-channel narrative (that's the next node).
 *   - Resolve channel-specific details — email recipient address,
 *     SMS phone number (P9 lifts those into CDK context; here we
 *     just decide which channels fire).
 *
 * **Matrix lifecycle.** The inline `BASELINE_MATRIX` here is a
 * placeholder for P9 pre-flight 4's *severity-routing matrix as data*
 * pattern. At P9, the matrix moves to CDK context (or a config file
 * shipped with the Lambda) so ops teams can edit routing without
 * redeploying code. The function signature is forward-compatible:
 * `determineRouting(event, severity)` doesn't change; only the source
 * of the matrix moves from a const to an injected dependency.
 *
 * **Channel set as of 2026-05-13.** Phase 9 simplified the original
 * 4-channel design (slack, pagerduty, email, status_page) to 2
 * channels (email, sms). The `channels` Zod object below is the
 * extension point — adding a future channel is one new key here plus
 * one new entry in BASELINE_MATRIX.
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import { invokeStructured } from './llm-client';
import type { SensorEvent } from './types';
import type { Severity } from './severity-classifier';

/**
 * Output schema. Each channel is a boolean — selected or not. Channel-
 * specific details (email recipient, SMS phone number) live in CDK
 * context and are resolved at dispatch time (P9.4); here we only
 * decide which channels fire.
 *
 * `overrideApplied` + `overrideReason` are a required pair: if the
 * LLM diverged from the baseline matrix, the reason must be present
 * for audit. Enforced by the refinement below.
 *
 * Note: `pageOnCall` was a separate boolean in the original 4-channel
 * design. As of 2026-05-13, paging-grade is expressed by setting
 * `channels.sms=true` — SMS *is* the paging mechanism in this design.
 */
export const routingPlanSchema = z
  .object({
    channels: z.object({
      email: z.boolean(),
      sms: z.boolean(),
    }),
    overrideApplied: z.boolean(),
    overrideReason: z.string().min(10).max(500).optional(),
  })
  .refine(
    (plan) => !plan.overrideApplied || plan.overrideReason !== undefined,
    {
      message:
        'overrideReason is required when overrideApplied is true (audit constraint)',
      path: ['overrideReason'],
    },
  );

export type RoutingPlan = z.infer<typeof routingPlanSchema>;

/**
 * Baseline matrix — the deterministic part of routing. The LLM is
 * told to apply this unchanged in the typical case; override path
 * activates only for cross-cutting context.
 *
 * Mirrors `docs/decisions/phase-09-agentic-case-routing.md` pre-flight 4
 * table. When P9 lifts the matrix to CDK context, this constant
 * moves to an injected dependency; the prompt-building below uses
 * the matrix through a parameter, so the swap is non-breaking.
 *
 * Threshold rationale: P0/P1 fire SMS because the operator must be
 * reached immediately (paging-grade). P2/P3 are investigable or
 * informational and don't warrant a phone interrupt — email only.
 */
type BaselineChannels = {
  email: boolean;
  sms: boolean;
};

export const BASELINE_MATRIX: Record<Severity['severity'], BaselineChannels> = {
  P0: {
    email: true,
    sms: true,
  },
  P1: {
    email: true,
    sms: true,
  },
  P2: {
    email: true,
    sms: false,
  },
  P3: {
    email: true,
    sms: false,
  },
};

/**
 * Format the matrix into the system-prompt baseline table. Done as a
 * function rather than a string constant so a future override pattern
 * (matrix injection at P9) doesn't require duplicating the
 * stringification logic.
 */
const formatMatrix = (
  matrix: Record<Severity['severity'], BaselineChannels>,
): string => {
  const rows = (Object.keys(matrix) as Array<Severity['severity']>).map(
    (tier) => {
      const r = matrix[tier];
      const channels = [r.email && 'email', r.sms && 'sms']
        .filter(Boolean)
        .join(', ');
      return `  - ${tier}: channels=[${channels}]`;
    },
  );
  return rows.join('\n');
};

const buildSystemPrompt = (
  matrix: Record<Severity['severity'], BaselineChannels>,
): string => `You are an operational routing planner for a US power grid sensor pipeline.

Given a classified breach (severity tier, confidence, reasoning) and the underlying sensor event, decide which channels should receive the alert. The two channels are EMAIL (always available) and SMS (paging-grade — used when the operator must be reached immediately).

The baseline routing matrix is:
${formatMatrix(matrix)}

DEFAULT BEHAVIOR: apply the baseline for the input severity tier unchanged. Set overrideApplied=false. Do NOT explain — just emit the baseline.

OVERRIDE BEHAVIOR: activate the override path ONLY when the input carries context the matrix can't see. Specifically:
  - Cascading-failure pattern (multiple correlated sensors trending toward thresholds).
  - Recent recurrence (the same sensor has breached multiple times in a short window).
  - Off-hours staffing nuance (a P2 at 3am on a critical sensor may warrant SMS paging despite the P2 tier).
  - Reading-type-specific risk (a P2 voltage on a grid-tie sensor may warrant escalation that a P2 temperature wouldn't).

When you override:
  - Set overrideApplied=true.
  - overrideReason is REQUIRED and must explain the override in one or two sentences citing the specific signal.
  - The output channels reflect your chosen routing, not the baseline. Paging-grade context (severity escalation) is expressed by setting channels.sms=true.

Be conservative. The default path is the matrix. Overrides should be the exception, not the rule.`;

const buildUserPrompt = (event: SensorEvent, severity: Severity): string =>
  [
    `Severity classification: ${severity.severity}`,
    `Severity confidence: ${severity.confidence}`,
    `Severity reasoning: ${severity.reasoning}`,
    ``,
    `Sensor: ${event.sensorId}`,
    `Reading type: ${event.readingType}`,
    `Value: ${event.value} ${event.unit}`,
    `Timestamp: ${event.timestamp}`,
    `Grid zone: ${event.gridZone ?? 'unknown'}`,
  ].join('\n');

/**
 * Decide the routing plan for a classified breach.
 *
 * @param event     The underlying sensor event.
 * @param severity  The output of `classifySeverity` from the previous
 *                  node. Determines the baseline matrix row.
 * @returns         A Zod-validated routing plan.
 * @throws          Bedrock errors propagate; the caller's fail-soft
 *                  fallback (P8 pre-flight 6) decides whether to swallow.
 */
export const determineRouting = async (
  event: SensorEvent,
  severity: Severity,
): Promise<RoutingPlan> => {
  const messages: BaseMessageLike[] = [
    new SystemMessage(buildSystemPrompt(BASELINE_MATRIX)),
    new HumanMessage(buildUserPrompt(event, severity)),
  ];

  return invokeStructured(routingPlanSchema, messages);
};

/**
 * Exported for unit tests — lets us assert on prompt shape without
 * actually invoking Bedrock.
 */
export const __testables = {
  buildSystemPrompt,
  buildUserPrompt,
  formatMatrix,
};
