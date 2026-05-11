/**
 * Routing strategy — second node in the LangGraph alert flow (P8.4).
 *
 * Given a classified breach severity and the underlying event, decide
 * which downstream channels should receive the alert and whether to
 * page the on-call rotation. Output is a Zod-validated routing plan
 * consumed by the narrative generator (next node) and by the
 * tool-execution layer (P9).
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
 * P0 cascade should probably escalate to P1-style routing; a P1 at
 * 3am on a sensor that's flapped six times today probably warrants
 * a different on-call posture than a P1 on a quiet sensor. The LLM
 * does the multi-factor judgment that would otherwise need explicit
 * heuristics encoded in TypeScript.
 *
 * **What this node does NOT do** (handlers/nodes orchestrate; lib
 * executes — CLAUDE.md invariant #2):
 *   - Open tickets / send Slack / page (those are tool calls — P9).
 *   - Generate the per-channel narrative (that's the next node).
 *   - Decide which exact Slack channel to use (P9 lifts the channel
 *     names into CDK context; here we just select the channel-class).
 *
 * **Matrix lifecycle.** The inline `BASELINE_MATRIX` here is a
 * placeholder for P9 pre-flight 4's *severity-routing matrix as data*
 * pattern. At P9, the matrix moves to CDK context (or a config file
 * shipped with the Lambda) so ops teams can edit routing without
 * redeploying code. The function signature is forward-compatible:
 * `determineRouting(event, severity)` doesn't change; only the source
 * of the matrix moves from a const to an injected dependency.
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import { invokeStructured } from './llm-client';
import type { SensorEvent } from './types';
import type { Severity } from './severity-classifier';

/**
 * Output schema. Each channel is a boolean — selected or not. The
 * Slack channel *name* and the case-tracker product (Jira vs
 * ServiceNow) are P9 concerns; here we only decide channel-class.
 *
 * `overrideApplied` + `overrideReason` are required pair: if the
 * LLM diverged from the baseline matrix, the reason must be present
 * for audit. Enforced by the refinement below.
 */
export const routingPlanSchema = z
  .object({
    channels: z.object({
      slack: z.boolean(),
      pagerduty: z.boolean(),
      email: z.boolean(),
      status_page: z.boolean(),
    }),
    pageOnCall: z.boolean(),
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
 */
type BaselineChannels = {
  slack: boolean;
  pagerduty: boolean;
  email: boolean;
  status_page: boolean;
  pageOnCall: boolean;
};

export const BASELINE_MATRIX: Record<Severity['severity'], BaselineChannels> = {
  P0: {
    slack: true,
    pagerduty: true,
    email: true,
    status_page: true,
    pageOnCall: true,
  },
  P1: {
    slack: true,
    pagerduty: true,
    email: true,
    status_page: false,
    pageOnCall: true,
  },
  P2: {
    slack: true,
    pagerduty: false,
    email: true,
    status_page: false,
    pageOnCall: false,
  },
  P3: {
    slack: true,
    pagerduty: false,
    email: false,
    status_page: false,
    pageOnCall: false,
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
      const channels = [
        r.slack && 'slack',
        r.pagerduty && 'pagerduty',
        r.email && 'email',
        r.status_page && 'status_page',
      ]
        .filter(Boolean)
        .join(', ');
      const page = r.pageOnCall ? 'YES' : 'NO';
      return `  - ${tier}: channels=[${channels}] | pageOnCall=${page}`;
    },
  );
  return rows.join('\n');
};

const buildSystemPrompt = (
  matrix: Record<Severity['severity'], BaselineChannels>,
): string => `You are an operational routing planner for a US power grid sensor pipeline.

Given a classified breach (severity tier, confidence, reasoning) and the underlying sensor event, decide which channels should receive the alert and whether to page the on-call rotation.

The baseline routing matrix is:
${formatMatrix(matrix)}

DEFAULT BEHAVIOR: apply the baseline for the input severity tier unchanged. Set overrideApplied=false. Do NOT explain — just emit the baseline.

OVERRIDE BEHAVIOR: activate the override path ONLY when the input carries context the matrix can't see. Specifically:
  - Cascading-failure pattern (multiple correlated sensors trending toward thresholds).
  - Recent recurrence (the same sensor has breached multiple times in a short window).
  - Off-hours staffing nuance (a P2 at 3am on a critical sensor may warrant P1 routing).
  - Reading-type-specific risk (a P2 voltage on a grid-tie sensor may warrant escalation that a P2 temperature wouldn't).

When you override:
  - Set overrideApplied=true.
  - overrideReason is REQUIRED and must explain the override in one or two sentences citing the specific signal.
  - The output channels and pageOnCall reflect your chosen routing, not the baseline.

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
