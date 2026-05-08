/**
 * Domain types for the grid sensor pipeline.
 *
 * Per CLAUDE.md architectural invariant #2: this module has zero AWS SDK
 * imports and zero side effects. It defines the wire/data contracts only.
 */

/** All readingType values the pipeline understands. */
export const READING_TYPES = [
  'voltage',
  'current',
  'frequency',
  'power_factor',
  'temperature',
] as const;

export type ReadingType = (typeof READING_TYPES)[number];

/**
 * The shape published by devices on `sensors/{sensorId}/telemetry` and
 * delivered to the processor via Kinesis. This is the validated I/O type —
 * `lib/` consumers should receive `SensorEvent`, never `unknown`.
 */
export interface SensorEvent {
  sensorId: string;
  /** ISO 8601 datetime, UTC (`Z`). */
  timestamp: string;
  readingType: ReadingType;
  /** Finite number; units depend on readingType. */
  value: number;
  /** Free-form unit label, max 16 chars (e.g., `V`, `A`, `Hz`, `pf`, `degC`). */
  unit: string;
  /** Optional grid zone for GSI queries and IoT rule filtering. */
  gridZone?: string;
}

/**
 * The persisted shape in DynamoDB.
 *
 *   pk  = sensorId
 *   sk  = `${timestamp}#${readingType}`
 *   ttl = epoch seconds, +30 days from write time
 *
 * The composite SK preserves per-sensor time ordering and allows multiple
 * readingTypes at the same instant.
 */
export interface SensorReading extends SensorEvent {
  pk: string;
  sk: string;
  ttl: number;
}

/**
 * Payload passed to the Step Functions alert workflow when a threshold rule
 * fires. `threshold` records the bound that was breached so escalation
 * downstream can render a meaningful message without re-evaluating.
 */
export interface AlertContext {
  sensorId: string;
  timestamp: string;
  readingType: ReadingType;
  value: number;
  unit: string;
  gridZone?: string;
  threshold: {
    min?: number;
    max?: number;
  };
  details: string;
}
