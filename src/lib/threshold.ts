/**
 * Threshold evaluation — pure function, no I/O.
 *
 * Per CLAUDE.md architectural invariant #3: this is the same predicate
 * encoded in the IoT Rules Engine SQL filter (`ThresholdAlertRule`). Keeping
 * a TypeScript copy lets the processor Lambda annotate stored readings and
 * lets unit tests cover the matrix of boundary conditions independent of
 * any AWS deployment.
 */

import type { ReadingType, SensorEvent } from './types';

export interface ThresholdRange {
  /** Inclusive lower bound. Values below trigger an alert. */
  min: number;
  /** Inclusive upper bound. Values above trigger an alert. */
  max: number;
}

export interface ThresholdConfig {
  frequency: ThresholdRange;
  voltage: ThresholdRange;
}

/**
 * NERC ±0.5 Hz frequency standard, North American 120 V nominal ±5 %.
 * Mirrored verbatim in the IoT Rules Engine SQL — keep in sync.
 */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  frequency: { min: 59.5, max: 60.5 },
  voltage: { min: 114, max: 126 },
};

export interface ThresholdResult {
  exceeded: boolean;
  details: string;
  /** Populated only when `exceeded` is true; carries the breached bound. */
  threshold?: { min?: number; max?: number };
}

const READINGS_WITH_THRESHOLDS = new Set<ReadingType>(['frequency', 'voltage']);

/**
 * Evaluate a sensor reading against the active threshold config.
 *
 * Pure function — no logging, no metrics, no DynamoDB. Side-effects belong
 * to the caller. ReadingTypes without configured thresholds (`current`,
 * `power_factor`, `temperature`) always return `exceeded: false`; the
 * pipeline still archives every reading via Kinesis Firehose for cold
 * analytics.
 */
export const evaluateThreshold = (
  event: SensorEvent,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): ThresholdResult => {
  if (!READINGS_WITH_THRESHOLDS.has(event.readingType)) {
    return {
      exceeded: false,
      details: `${event.readingType}: no threshold configured`,
    };
  }

  const range =
    event.readingType === 'frequency' ? config.frequency : config.voltage;

  if (event.value < range.min) {
    return {
      exceeded: true,
      details: `${event.readingType}=${event.value}${event.unit} below min ${range.min}`,
      threshold: { min: range.min },
    };
  }
  if (event.value > range.max) {
    return {
      exceeded: true,
      details: `${event.readingType}=${event.value}${event.unit} above max ${range.max}`,
      threshold: { max: range.max },
    };
  }
  return {
    exceeded: false,
    details: `${event.readingType}=${event.value}${event.unit} within [${range.min}, ${range.max}]`,
  };
};
