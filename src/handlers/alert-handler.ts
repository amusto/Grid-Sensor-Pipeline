/**
 * Alert handler — notification + escalation Lambda.
 *
 * Invoked by Step Functions twice in a typical workflow:
 *   1. `NotifyOps`           — initial P2 notification on threshold breach.
 *   2. `EscalateToOnCall`    — P1 escalation if no ack within the wait window.
 *
 * Both invocations route through the same handler; differentiation is by
 * the `escalated: true` flag on the input. See
 * `docs/decisions/phase-05-alert-workflow.md` for the rationale.
 */

import type { Context } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { evaluateThreshold } from '../lib/threshold';
import { validateSensorEvent } from '../lib/validator';
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
    const severity = isEscalated ? 'P1' : 'P2';
    const subjectPrefix = isEscalated ? '[P1 ESCALATED]' : '[P2]';

    const subject = `${subjectPrefix} Grid sensor breach: ${validated.sensorId}`;
    const messageBody = JSON.stringify(
      {
        severity,
        sensorId: validated.sensorId,
        timestamp: validated.timestamp,
        readingType: validated.readingType,
        value: validated.value,
        unit: validated.unit,
        gridZone: validated.gridZone,
        threshold: evaluation.threshold,
        details: evaluation.details,
        escalated: isEscalated,
      },
      null,
      2,
    );

    await sns.send(
      new PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        // Subject is restricted to ASCII printable + a few extras and
        // <= 100 chars; sensorId is short enough that this is safe.
        Subject: subject.slice(0, 100),
        Message: messageBody,
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
      severity,
      sensorId: validated.sensorId,
      readingType: validated.readingType,
      value: validated.value,
      thresholdBreached: evaluation.exceeded,
    });

    return { acknowledged: false, escalated: isEscalated };
  } finally {
    metrics.publishStoredMetrics();
  }
};
