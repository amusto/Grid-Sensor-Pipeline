/**
 * DLQ inspector — consumes the processor's dead-letter queue.
 *
 * For each SQS message:
 *   1. Parse the original Kinesis record metadata + failure context
 *      (Lambda's onFailure destination wraps the failed batch in a
 *      structured envelope — see AWS docs for the schema).
 *   2. Structured-log the sensor ID, sequence number, and failure
 *      reason for forensic visibility.
 *   3. Emit `DlqMessagesReceived` metric (consumed by the P6 alarm).
 *   4. Publish to the ops-alerts SNS topic so a human triages.
 *   5. (Optional, env-flagged off by default) Replay to Kinesis.
 *
 * Per `docs/decisions/phase-06-dlq-observability.md` pre-flight 1:
 * auto-replay is dangerous (poison pill → infinite retry loop). The
 * `REPLAY_TO_KINESIS=true` env var is opt-in for cases where a human
 * has triaged and decided replay is safe.
 */

import {
  SNSClient,
  PublishCommand,
} from '@aws-sdk/client-sns';
import {
  KinesisClient,
  PutRecordCommand,
} from '@aws-sdk/client-kinesis';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';

const OPS_ALERT_TOPIC_ARN = process.env.OPS_ALERT_TOPIC_ARN ?? '';
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME ?? '';
const REPLAY_TO_KINESIS = process.env.REPLAY_TO_KINESIS === 'true';

if (!OPS_ALERT_TOPIC_ARN) {
  throw new Error('OPS_ALERT_TOPIC_ARN env var is required');
}

const sns = new SNSClient({});
const kinesis = REPLAY_TO_KINESIS ? new KinesisClient({}) : null;

/**
 * Lambda's `onFailure` destination for a Kinesis ESM wraps the failed
 * batch in this envelope. We extract what we need for forensic logs.
 */
interface KinesisFailureEnvelope {
  requestContext?: {
    requestId?: string;
    functionArn?: string;
    condition?: string;
    approximateInvokeCount?: number;
  };
  responseContext?: {
    statusCode?: number;
    executedVersion?: string;
    functionError?: string;
  };
  KinesisBatchInfo?: {
    shardId?: string;
    startSequenceNumber?: string;
    endSequenceNumber?: string;
    approximateArrivalOfFirstRecord?: string;
    approximateArrivalOfLastRecord?: string;
    batchSize?: number;
    streamArn?: string;
  };
}

const parseEnvelope = (body: string): KinesisFailureEnvelope | null => {
  try {
    return JSON.parse(body) as KinesisFailureEnvelope;
  } catch {
    return null;
  }
};

const inspectMessage = async (
  record: SQSRecord,
): Promise<{ replayed: boolean }> => {
  const envelope = parseEnvelope(record.body);
  const failureReason =
    envelope?.responseContext?.functionError ??
    envelope?.requestContext?.condition ??
    'unknown';
  const sequenceRange = envelope?.KinesisBatchInfo
    ? `${envelope.KinesisBatchInfo.startSequenceNumber}..${envelope.KinesisBatchInfo.endSequenceNumber}`
    : 'unknown';
  const batchSize = envelope?.KinesisBatchInfo?.batchSize ?? 1;
  const approximateInvokeCount =
    envelope?.requestContext?.approximateInvokeCount ?? 0;

  // Structured log — this is the forensic record. Includes everything
  // an operator needs to diagnose without poking at SQS directly.
  logger.error('DLQ message received — record exhausted retry budget', {
    sqsMessageId: record.messageId,
    sequenceRange,
    batchSize,
    approximateInvokeCount,
    failureReason,
    streamArn: envelope?.KinesisBatchInfo?.streamArn,
    functionArn: envelope?.requestContext?.functionArn,
  });

  // Ops-alert SNS publish — human triage signal.
  const subject = `[DLQ] Grid sensor pipeline: ${batchSize} record(s) dead-lettered`;
  const message = JSON.stringify(
    {
      severity: 'P3',
      reason: failureReason,
      sequenceRange,
      batchSize,
      approximateInvokeCount,
      sqsMessageId: record.messageId,
      streamArn: envelope?.KinesisBatchInfo?.streamArn,
      functionArn: envelope?.requestContext?.functionArn,
      receivedAt: new Date().toISOString(),
      replayPolicy: REPLAY_TO_KINESIS
        ? 'auto-replay enabled (REPLAY_TO_KINESIS=true)'
        : 'manual triage required (REPLAY_TO_KINESIS not set)',
    },
    null,
    2,
  );

  await sns.send(
    new PublishCommand({
      TopicArn: OPS_ALERT_TOPIC_ARN,
      Subject: subject.slice(0, 100),
      Message: message,
    }),
  );

  // Conditional replay — only if explicitly opted in.
  if (REPLAY_TO_KINESIS && kinesis && KINESIS_STREAM_NAME) {
    // The envelope doesn't carry the original payload bytes; replay would
    // require fetching from Kinesis using the sequence range. For the
    // POC we log that replay was *requested* but not implemented here —
    // production would do the GetRecords call and re-PutRecord.
    logger.warn(
      'REPLAY_TO_KINESIS is set but POC implementation does not fetch ' +
        'the original payload from Kinesis. Production should call ' +
        'GetShardIterator + GetRecords + PutRecord to replay.',
      { sequenceRange, streamName: KINESIS_STREAM_NAME },
    );
    return { replayed: false };
  }

  return { replayed: false };
};

export const handler = async (
  event: SQSEvent,
  _context: Context,
): Promise<SQSBatchResponse> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  let totalInspected = 0;
  let totalReplayed = 0;

  try {
    for (const record of event.Records) {
      totalInspected++;
      try {
        const { replayed } = await inspectMessage(record);
        if (replayed) totalReplayed++;
      } catch (err) {
        // If inspection itself fails (e.g., SNS down), keep the message
        // in the DLQ for retry rather than acknowledging it. The
        // partial-batch-failure response handles this without throwing.
        logger.error('DLQ message inspection failed', {
          error: err instanceof Error ? err.message : String(err),
          sqsMessageId: record.messageId,
        });
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    metrics.addMetric(
      'DlqMessagesReceived',
      MetricUnit.Count,
      totalInspected - failures.length,
    );
    if (totalReplayed > 0) {
      metrics.addMetric('DlqMessagesReplayed', MetricUnit.Count, totalReplayed);
    }
    if (failures.length > 0) {
      metrics.addMetric(
        'DlqInspectionFailures',
        MetricUnit.Count,
        failures.length,
      );
    }

    return { batchItemFailures: failures };
  } finally {
    metrics.publishStoredMetrics();
  }
};
