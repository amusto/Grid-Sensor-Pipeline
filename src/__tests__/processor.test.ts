/**
 * Processor handler tests — partial-batch-failure semantics, conditional-
 * write swallow, validation routing.
 *
 * Strategy:
 *   1. Mock SensorRepository at the module level so DynamoDB calls become
 *      controllable promises.
 *   2. Short-circuit Powertools' `makeIdempotent` to a passthrough so we
 *      exercise the handler's logic without a real DynamoDB persistence
 *      layer.
 *   3. Test against `__testables.baseHandler` (the unwrapped function),
 *      not against the Middy-wrapped `handler`. The middleware chain is
 *      Powertools' responsibility; our concern is the partial-failure
 *      contract.
 *
 * Idempotency-cache behaviour itself (the DynamoDB round-trip) is verified
 * by the integration smoke test on Phase 3 — see review-checklist.md.
 */

// Env vars must be set BEFORE the handler module is imported because it
// reads them at module-load time.
process.env.READINGS_TABLE = 'test-readings';
process.env.IDEMPOTENCY_TABLE = 'test-idempotency';
process.env.POWERTOOLS_SERVICE_NAME = 'grid-sensor-processor-test';

const mockPutReading = jest.fn();

jest.mock('../lib/repository', () => ({
  SensorRepository: jest.fn().mockImplementation(() => ({
    putReading: mockPutReading,
  })),
}));

jest.mock('@aws-lambda-powertools/idempotency', () => ({
  IdempotencyConfig: jest.fn().mockImplementation(() => ({})),
  // Passthrough: `makeIdempotent(fn)` returns `fn` unchanged so the test
  // exercises the wrapped function's logic directly.
  makeIdempotent: <T>(fn: T): T => fn,
}));

jest.mock('@aws-lambda-powertools/idempotency/dynamodb', () => ({
  DynamoDBPersistenceLayer: jest.fn().mockImplementation(() => ({})),
}));

// Silence Powertools log output so the test runner stays readable.
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

import type { KinesisStreamEvent, KinesisStreamRecord } from 'aws-lambda';
import { __testables } from '../handlers/processor';

const { baseHandler } = __testables;

const VALID_PAYLOAD = {
  sensorId: 'sensor-001',
  timestamp: '2026-05-08T12:00:00Z',
  readingType: 'voltage' as const,
  value: 120,
  unit: 'V',
  gridZone: 'zone-1',
};

const buildRecord = (
  sequenceNumber: string,
  payload: unknown,
): KinesisStreamRecord => ({
  kinesis: {
    kinesisSchemaVersion: '1.0',
    partitionKey: 'p',
    sequenceNumber,
    data: Buffer.from(JSON.stringify(payload)).toString('base64'),
    approximateArrivalTimestamp: Date.now() / 1000,
  },
  eventSource: 'aws:kinesis',
  eventVersion: '1.0',
  eventID: `shard-1:${sequenceNumber}`,
  eventName: 'aws:kinesis:record',
  invokeIdentityArn: 'arn:aws:iam::123:role/test',
  awsRegion: 'us-east-1',
  eventSourceARN:
    'arn:aws:kinesis:us-east-1:123456789012:stream/grid-sensor-stream',
});

const buildEvent = (records: KinesisStreamRecord[]): KinesisStreamEvent => ({
  Records: records,
});

class ConditionalCheckFailedException extends Error {
  constructor() {
    super('The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

describe('processor handler', () => {
  describe('happy path', () => {
    it('processes a full valid batch and returns no failures', async () => {
      mockPutReading.mockResolvedValue(undefined);
      const event = buildEvent([
        buildRecord('seq-1', VALID_PAYLOAD),
        buildRecord('seq-2', { ...VALID_PAYLOAD, readingType: 'frequency' }),
        buildRecord('seq-3', { ...VALID_PAYLOAD, readingType: 'current' }),
      ]);

      const result = await baseHandler(event);

      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockPutReading).toHaveBeenCalledTimes(3);
    });
  });

  describe('partial batch failures', () => {
    it('isolates a single bad record while letting valid ones succeed', async () => {
      mockPutReading.mockResolvedValue(undefined);
      const event = buildEvent([
        buildRecord('seq-good-1', VALID_PAYLOAD),
        buildRecord('seq-bad', { malformed: 'payload' }),
        buildRecord('seq-good-2', { ...VALID_PAYLOAD, readingType: 'voltage' }),
      ]);

      const result = await baseHandler(event);

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-bad' },
      ]);
      // Only the two valid records reached the repository.
      expect(mockPutReading).toHaveBeenCalledTimes(2);
    });

    it('returns every record in batchItemFailures when every record is bad', async () => {
      mockPutReading.mockResolvedValue(undefined);
      const event = buildEvent([
        buildRecord('seq-bad-1', { malformed: 1 }),
        buildRecord('seq-bad-2', { malformed: 2 }),
      ]);

      const result = await baseHandler(event);

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-bad-1' },
        { itemIdentifier: 'seq-bad-2' },
      ]);
      expect(mockPutReading).not.toHaveBeenCalled();
    });
  });

  describe('conditional-write swallow', () => {
    it('treats ConditionalCheckFailedException as no-op success', async () => {
      mockPutReading.mockRejectedValueOnce(
        new ConditionalCheckFailedException(),
      );
      const event = buildEvent([buildRecord('seq-dup', VALID_PAYLOAD)]);

      const result = await baseHandler(event);

      // Duplicate is NOT in batchItemFailures — the record was already
      // persisted, retry succeeds silently.
      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockPutReading).toHaveBeenCalledTimes(1);
    });

    it('does NOT swallow a generic DynamoDB error', async () => {
      mockPutReading.mockRejectedValueOnce(
        Object.assign(new Error('Throttled'), {
          name: 'ProvisionedThroughputExceededException',
        }),
      );
      const event = buildEvent([buildRecord('seq-throttle', VALID_PAYLOAD)]);

      const result = await baseHandler(event);

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-throttle' },
      ]);
    });

    it('does NOT swallow a non-Error thrown value', async () => {
      mockPutReading.mockRejectedValueOnce('string error');
      const event = buildEvent([buildRecord('seq-weird', VALID_PAYLOAD)]);

      const result = await baseHandler(event);

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-weird' },
      ]);
    });
  });

  describe('mixed failure modes in one batch', () => {
    it('routes validation, throttling, and conditional-failure correctly', async () => {
      mockPutReading
        // seq-1: success
        .mockResolvedValueOnce(undefined)
        // seq-3: duplicate (swallowed)
        .mockRejectedValueOnce(new ConditionalCheckFailedException())
        // seq-4: throttled (fails)
        .mockRejectedValueOnce(
          Object.assign(new Error('Throttled'), {
            name: 'ProvisionedThroughputExceededException',
          }),
        );

      const event = buildEvent([
        buildRecord('seq-1', VALID_PAYLOAD),
        buildRecord('seq-2', { malformed: true }), // validation failure
        buildRecord('seq-3', VALID_PAYLOAD),
        buildRecord('seq-4', VALID_PAYLOAD),
      ]);

      const result = await baseHandler(event);

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-2' },
        { itemIdentifier: 'seq-4' },
      ]);
      // putReading is only attempted on records that pass validation.
      expect(mockPutReading).toHaveBeenCalledTimes(3);
    });
  });

  describe('isConditionalCheckFailed helper', () => {
    const { isConditionalCheckFailed } = __testables;

    it('matches by error name (case-sensitive)', () => {
      const err = new Error('whatever');
      err.name = 'ConditionalCheckFailedException';
      expect(isConditionalCheckFailed(err)).toBe(true);
    });

    it('rejects errors with a similar but different name', () => {
      const err = new Error('whatever');
      err.name = 'ConditionalRequestFailed';
      expect(isConditionalCheckFailed(err)).toBe(false);
    });

    it('rejects non-Error values', () => {
      expect(isConditionalCheckFailed('ConditionalCheckFailedException')).toBe(
        false,
      );
      expect(isConditionalCheckFailed(null)).toBe(false);
      expect(isConditionalCheckFailed(undefined)).toBe(false);
      expect(
        isConditionalCheckFailed({ name: 'ConditionalCheckFailedException' }),
      ).toBe(false);
    });
  });

  describe('idempotency TTL constant', () => {
    it('exceeds Kinesis default retention (24h) by a safety margin', () => {
      const KINESIS_DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
      expect(__testables.IDEMPOTENCY_TTL_SECONDS).toBeGreaterThan(
        KINESIS_DEFAULT_RETENTION_SECONDS,
      );
      // Sanity bound — much longer would be wasteful storage-wise.
      const ONE_WEEK = 7 * 24 * 60 * 60;
      expect(__testables.IDEMPOTENCY_TTL_SECONDS).toBeLessThan(ONE_WEEK);
    });
  });
});
