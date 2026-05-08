/**
 * Processor Lambda — Kinesis Event Source Mapping consumer.
 *
 * Per CLAUDE.md architectural invariant #1, validation happens here at the
 * I/O boundary. Per invariant #4, this handler orchestrates: it does no
 * business logic itself.
 *
 * Failure-mode contract (see `docs/decisions/phase-02-processor.md`):
 *   1. Idempotency keyed on the Kinesis sequence number, persisted in the
 *      idempotency DynamoDB table with TTL = Kinesis retention + safety
 *      margin (state outlives the replay window).
 *   2. `ConditionalCheckFailedException` from the readings-table write is
 *      swallowed as no-op success — the database is telling us the row is
 *      already there. Every other error bubbles up.
 *   3. Per-record dimensioned metrics use `metrics.singleMetric()` so the
 *      `ReadingType` dimension does not bleed across records in the same
 *      batch.
 *   4. Per CLAUDE.md hard rule #7, we always return `batchItemFailures`
 *      rather than throwing from the top-level handler — Kinesis isolates
 *      bad records via `bisectOnError` before they reach the DLQ.
 *   5. Per CLAUDE.md hard rule #8, `metrics.publishStoredMetrics()` runs in
 *      a `finally` block so EMF emits even on unexpected handler-level
 *      throws.
 */

import {
  type KinesisStreamBatchResponse,
  type KinesisStreamEvent,
  type KinesisStreamRecord,
} from 'aws-lambda';
import {
  IdempotencyConfig,
  makeIdempotent,
} from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger } from '../lib/logger';
import { tracer } from '../lib/tracer';
import { metrics } from '../lib/metrics';
import { validateSensorEvent } from '../lib/validator';
import { SensorRepository } from '../lib/repository';
import type { SensorEvent } from '../lib/types';

const READINGS_TABLE = process.env.READINGS_TABLE ?? '';
const IDEMPOTENCY_TABLE = process.env.IDEMPOTENCY_TABLE ?? '';

if (!READINGS_TABLE) {
  throw new Error('READINGS_TABLE env var is required');
}
if (!IDEMPOTENCY_TABLE) {
  throw new Error('IDEMPOTENCY_TABLE env var is required');
}

/**
 * 25 hours = Kinesis 24 h default retention + 1 h safety margin.
 * Phase 3 CDK will export this same constant when wiring `READINGS_TABLE`
 * and the Kinesis stream so retention and TTL stay coupled.
 */
const IDEMPOTENCY_TTL_SECONDS = 25 * 60 * 60;

const persistence = new DynamoDBPersistenceLayer({
  tableName: IDEMPOTENCY_TABLE,
});

const idempotencyConfig = new IdempotencyConfig({
  // Idempotency key = the Kinesis sequence number, globally unique per
  // shard and stable across Lambda retries.
  eventKeyJmesPath: 'kinesis.sequenceNumber',
  expiresAfterSeconds: IDEMPOTENCY_TTL_SECONDS,
});

const repo = new SensorRepository(READINGS_TABLE);

const isConditionalCheckFailed = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException';

const decodeRecord = (record: KinesisStreamRecord): unknown =>
  JSON.parse(Buffer.from(record.kinesis.data, 'base64').toString('utf-8'));

const emitProcessedRecord = (event: SensorEvent, latencyMs: number): void => {
  const recordMetric = metrics.singleMetric();
  recordMetric.addDimension('ReadingType', event.readingType);
  recordMetric.addMetric('EventsProcessed', MetricUnit.Count, 1);
  recordMetric.addMetric(
    'ProcessingLatencyMs',
    MetricUnit.Milliseconds,
    latencyMs,
  );
};

/**
 * Per-record processing wrapped with Powertools idempotency. The wrapped
 * function throws on any unrecoverable failure; the outer handler catches
 * and routes to `batchItemFailures`. `ConditionalCheckFailedException` is
 * swallowed *inside* this function because the record was already
 * successfully persisted on a prior attempt — retry should not block the
 * batch.
 */
const processRecord = makeIdempotent(
  async (record: KinesisStreamRecord): Promise<void> => {
    const subsegment = tracer
      .getSegment()
      ?.addNewSubsegment('### processRecord');
    const startedAt = Date.now();
    try {
      let event: SensorEvent;
      try {
        event = validateSensorEvent(decodeRecord(record));
      } catch (err) {
        metrics.addMetric('ValidationErrors', MetricUnit.Count, 1);
        logger.error('Validation failed', {
          error: err instanceof Error ? err.message : String(err),
          sequenceNumber: record.kinesis.sequenceNumber,
        });
        throw err;
      }

      try {
        await repo.putReading(event);
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          // Database-level dedup fired — the row already exists from a
          // prior successful processing of this record. Idempotent no-op.
          metrics.addMetric('DuplicateWrites', MetricUnit.Count, 1);
          logger.info('Duplicate write swallowed (server-side dedup)', {
            sensorId: event.sensorId,
            sequenceNumber: record.kinesis.sequenceNumber,
          });
          return;
        }
        logger.error('Persistence failed', {
          error: err instanceof Error ? err.message : String(err),
          sensorId: event.sensorId,
          sequenceNumber: record.kinesis.sequenceNumber,
        });
        throw err;
      }

      emitProcessedRecord(event, Date.now() - startedAt);
      logger.info('Record processed', {
        sensorId: event.sensorId,
        readingType: event.readingType,
        sequenceNumber: record.kinesis.sequenceNumber,
      });
    } finally {
      subsegment?.close();
    }
  },
  {
    persistenceStore: persistence,
    config: idempotencyConfig,
  },
);

const baseHandler = async (
  event: KinesisStreamEvent,
): Promise<KinesisStreamBatchResponse> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  try {
    for (const record of event.Records) {
      try {
        await processRecord(record);
      } catch {
        // Per-record errors are already logged inside `processRecord`.
        // We push to `batchItemFailures` so the Kinesis ESM can isolate
        // the bad record via `bisectOnError` before routing to the DLQ.
        failures.push({ itemIdentifier: record.kinesis.sequenceNumber });
      }
    }
    if (failures.length > 0) {
      metrics.addMetric(
        'PartialBatchFailures',
        MetricUnit.Count,
        failures.length,
      );
    }
    return { batchItemFailures: failures };
  } finally {
    // Hard rule #8: publish in finally so metrics emit even on
    // unexpected handler-level throws.
    metrics.publishStoredMetrics();
  }
};

export const handler = tracer.captureLambdaHandler(
  logger.injectLambdaContext(baseHandler),
);

// Exported for unit tests — lets us exercise the same code path without
// going through the X-Ray + Lambda-context middleware wrappers.
export const __testables = {
  baseHandler,
  isConditionalCheckFailed,
  IDEMPOTENCY_TTL_SECONDS,
};
