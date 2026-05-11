/**
 * Alert handler — notification + escalation Lambda.
 *
 * Invoked by Step Functions twice in a typical workflow:
 *   1. `NotifyOps`           — initial notification on threshold breach.
 *   2. `EscalateToOnCall`    — escalation if no ack within the wait window.
 *
 * Both invocations route through the same handler; differentiation is by
 * the `escalated: true` flag on the input. See
 * `docs/decisions/phase-05-alert-workflow.md` for the rationale.
 *
 * **P8.5 change — LangGraph-powered narrative path with fail-soft fallback.**
 *
 * The handler now invokes a three-node LangGraph
 * (`src/lib/alert-graph.ts`) that:
 *   1. Classifies severity (P0/P1/P2/P3) via Bedrock.
 *   2. Determines routing (which channels + page-on-call).
 *   3. Generates per-channel narratives.
 *
 * The graph output enriches the SNS payload with LLM-generated content
 * for downstream consumers. **If any node throws** (Bedrock outage,
 * parse failure, schema violation), the handler emits a
 * `BedrockFallback` metric and falls back to the Phase 5 deterministic
 * JSON payload — the alert ALWAYS reaches SNS. AI-generated content
 * is best-effort, never load-bearing. See
 * `docs/decisions/phase-08-ai-ml-integration.md` pre-flight 6.
 */

import type { Context } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { evaluateThreshold } from '../lib/threshold';
import { validateSensorEvent } from '../lib/validator';
import { runAlertGraph, type AlertGraphState } from '../lib/alert-graph';
import type { SensorEvent } from '../lib/types';

interface AlertEvent {
  // Initial-notification invocation: the IoT-rule-passed sensor event.
  sensorId?: string;
  timestamp?: string;
  readingType?: string;
  value?: number;
  unit?: string;
  gridZone?: string;

  // Escalation invocation: the original event lives under `context`.
  escalated?: boolean;
  context?: unknown;
}

interface AlertResult {
  /**
   * Acknowledged status for the Step Functions choice state.
   * MVP always returns false — no ack mechanism wired yet. See
   * decision log P5 pre-flight 3 for the production extension path.
   */
  acknowledged: boolean;
  escalated: boolean;
}

const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN ?? '';
if (!ALERT_TOPIC_ARN) {
  throw new Error('ALERT_TOPIC_ARN env var is required');
}

const sns = new SNSClient({});

const extractSourceEvent = (event: AlertEvent): unknown => {
  if (event.escalated === true && event.context) {
    return event.context;
  }
  return event;
};

/**
 * Build the deterministic fallback SNS payload — the Phase 5 shape.
 * Used both when the LangGraph hasn't been invoked (escalation path,
 * which currently doesn't re-run the graph) and when the LangGraph
 * fails and the handler falls back.
 */
const buildFallbackPayload = (
  validated: SensorEvent,
  evaluation: ReturnType<typeof evaluateThreshold>,
  isEscalated: boolean,
) => {
  const tier = isEscalated ? 'P1' : 'P2';
  return {
    severity: tier,
    sensorId: validated.sensorId,
    timestamp: validated.timestamp,
    readingType: validated.readingType,
    value: validated.value,
    unit: validated.unit,
    gridZone: validated.gridZone,
    threshold: evaluation.threshold,
    details: evaluation.details,
    escalated: isEscalated,
    // No narratives field — caller (Slack / Email / etc.) renders from
    // the structured fields directly. Same shape as Phase 5.
  };
};

/**
 * Build the enriched SNS payload from a successful LangGraph run.
 * Includes the LLM-generated narratives alongside the structured fields
 * so downstream consumers can use either shape.
 */
const buildEnrichedPayload = (
  validated: SensorEvent,
  evaluation: ReturnType<typeof evaluateThreshold>,
  graphResult: AlertGraphState,
  isEscalated: boolean,
) => {
  return {
    severity: graphResult.severity.severity, // LLM-classified tier (P0-P3)
    severityConfidence: graphResult.severity.confidence,
    severityReasoning: graphResult.severity.reasoning,
    sensorId: validated.sensorId,
    timestamp: validated.timestamp,
    readingType: validated.readingType,
    value: validated.value,
    unit: validated.unit,
    gridZone: validated.gridZone,
    threshold: evaluation.threshold,
    details: evaluation.details,
    escalated: isEscalated,
    routing: graphResult.routing,
    narratives: graphResult.narratives.narratives,
  };
};

export const handler = async (
  event: AlertEvent,
  _context: Context,
): Promise<AlertResult> => {
  const isEscalated = event.escalated === true;

  try {
    let validated: SensorEvent;
    try {
      validated = validateSensorEvent(extractSourceEvent(event));
    } catch (err) {
      metrics.addMetric('AlertValidationFailed', MetricUnit.Count, 1);
      logger.error('Alert event failed validation', {
        error: err instanceof Error ? err.message : String(err),
        escalated: isEscalated,
      });
      throw err;
    }

    const evaluation = evaluateThreshold(validated);

    // -------------------------------------------------------------------
    // LangGraph path with fail-soft fallback (P8.5).
    //
    // Run the 3-node LangGraph on the INITIAL notification only. The
    // escalation invocation reuses the original notification's payload
    // shape (re-running the graph for an escalation would double the
    // Bedrock cost and the narratives would be near-identical; the
    // escalation Lambda's job is to mark severity escalated + republish,
    // not re-decide).
    //
    // On any failure inside the graph: emit BedrockFallback, log, and
    // continue with the deterministic Phase 5 payload. The alert MUST
    // reach SNS even if Bedrock is down.
    // -------------------------------------------------------------------
    let payload: ReturnType<typeof buildFallbackPayload>
      | ReturnType<typeof buildEnrichedPayload>;
    let usedFallback = false;

    if (!isEscalated) {
      try {
        const graphResult = await runAlertGraph(validated);
        payload = buildEnrichedPayload(
          validated,
          evaluation,
          graphResult,
          isEscalated,
        );
        logger.info('Alert enriched via LangGraph', {
          sensorId: validated.sensorId,
          severityTier: graphResult.severity.severity,
          severityConfidence: graphResult.severity.confidence,
          channelsSelected: Object.entries(graphResult.routing.channels)
            .filter(([, selected]) => selected)
            .map(([name]) => name),
          overrideApplied: graphResult.routing.overrideApplied,
        });
      } catch (err) {
        metrics.addMetric('BedrockFallback', MetricUnit.Count, 1);
        usedFallback = true;
        logger.error(
          'LangGraph alert flow failed; falling back to deterministic payload',
          {
            error: err instanceof Error ? err.message : String(err),
            sensorId: validated.sensorId,
          },
        );
        payload = buildFallbackPayload(validated, evaluation, isEscalated);
      }
    } else {
      // Escalation: reuse the deterministic payload, mark escalated.
      payload = buildFallbackPayload(validated, evaluation, isEscalated);
    }

    const subjectPrefix = isEscalated
      ? '[P1 ESCALATED]'
      : `[${'severity' in payload ? payload.severity : 'P2'}]`;
    const subject = `${subjectPrefix} Grid sensor breach: ${validated.sensorId}`;

    await sns.send(
      new PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        // Subject is restricted to ASCII printable + a few extras and
        // <= 100 chars; sensorId is short enough that this is safe.
        Subject: subject.slice(0, 100),
        Message: JSON.stringify(payload, null, 2),
      }),
    );

    const recordMetric = metrics.singleMetric();
    recordMetric.addDimension('ReadingType', validated.readingType);
    recordMetric.addMetric(
      isEscalated ? 'AlertsEscalated' : 'AlertsNotified',
      MetricUnit.Count,
      1,
    );

    logger.info(isEscalated ? 'Alert escalated' : 'Alert notified', {
      sensorId: validated.sensorId,
      readingType: validated.readingType,
      value: validated.value,
      thresholdBreached: evaluation.exceeded,
      usedFallback,
    });

    return { acknowledged: false, escalated: isEscalated };
  } finally {
    metrics.publishStoredMetrics();
  }
};
