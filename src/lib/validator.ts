/**
 * Runtime validation for SensorEvent payloads.
 *
 * Per CLAUDE.md architectural invariant #1, this is the I/O boundary —
 * `validateSensorEvent()` is called once in `processor.ts` immediately after
 * Kinesis decode, then everything else in `lib/` consumes a typed
 * `SensorEvent` rather than `unknown`.
 */

import { z } from 'zod';
import { READING_TYPES, type SensorEvent } from './types';

/** sensorId must look like `sensor-<lowercase-alphanum-and-dashes>`. */
const SENSOR_ID_PATTERN = /^sensor-[a-z0-9-]+$/;

export const sensorEventSchema = z
  .object({
    sensorId: z
      .string()
      .regex(SENSOR_ID_PATTERN, 'sensorId must match sensor-[a-z0-9-]+'),
    /**
     * ISO 8601 datetime. Strict mode (`offset: false`) by default — devices
     * publish UTC. We accept offsets to remain forward-compatible with
     * gateways that may stamp local time.
     */
    timestamp: z.string().datetime({ offset: true }),
    readingType: z.enum(READING_TYPES),
    value: z.number().finite(),
    unit: z.string().min(1).max(16),
    gridZone: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Parse + validate a raw payload into a `SensorEvent`.
 *
 * Throws `z.ZodError` on any structural failure. The caller (the processor
 * Lambda) catches, increments `ValidationErrors`, and routes the record
 * through `batchItemFailures` so Kinesis can isolate it via `bisectOnError`
 * before the DLQ.
 */
export const validateSensorEvent = (input: unknown): SensorEvent => {
  return sensorEventSchema.parse(input);
};
