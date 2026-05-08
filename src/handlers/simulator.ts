/**
 * Simulator Lambda — publishes synthetic sensor telemetry to IoT Core.
 *
 * Authorization is IAM-based via the IoT Data Plane SDK
 * (`@aws-sdk/client-iot-data-plane`). No MQTT client, no X.509 certs.
 *
 * Invocation payload:
 *   {
 *     count?:     number      // default 1; how many records to publish
 *     sensorIds?: string[]    // default DEFAULT_SENSORS; round-robin pool
 *     breach?:    boolean     // default false; force out-of-range values
 *                             //   on voltage/frequency to trigger the
 *                             //   alert workflow once Phase 5 ships
 *   }
 *
 * Returns:
 *   { published: number }
 *
 * Per `docs/decisions/phase-04-iot-simulator.md`, value generation uses
 * a Gaussian (Box-Muller) distribution around realistic nominal values
 * — produces edge cases organically without being adversarial.
 */

import {
  IoTDataPlaneClient,
  PublishCommand,
} from '@aws-sdk/client-iot-data-plane';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { Context } from 'aws-lambda';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import type { ReadingType, SensorEvent } from '../lib/types';

const IOT_ENDPOINT = process.env.IOT_ENDPOINT ?? '';
if (!IOT_ENDPOINT) {
  throw new Error('IOT_ENDPOINT env var is required');
}

const iotClient = new IoTDataPlaneClient({
  endpoint: `https://${IOT_ENDPOINT}`,
});

const DEFAULT_SENSORS = [
  'sensor-001',
  'sensor-002',
  'sensor-003',
  'sensor-004',
  'sensor-005',
];

const READING_TYPES: ReadingType[] = [
  'voltage',
  'current',
  'frequency',
  'power_factor',
  'temperature',
];

const UNITS: Record<ReadingType, string> = {
  voltage: 'V',
  current: 'A',
  frequency: 'Hz',
  power_factor: 'pf',
  temperature: 'degC',
};

export interface SimulatorEvent {
  count?: number;
  sensorIds?: string[];
  breach?: boolean;
}

export interface SimulatorResult {
  published: number;
  failed: number;
}

/**
 * Box-Muller transform — one sample from N(mean, stdev^2).
 * Pure function, fully deterministic given Math.random.
 */
const randomNormal = (mean: number, stdev: number): number => {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdev;
};

/**
 * Generate a value for the given reading type.
 *
 * In normal mode: Gaussian around nominal, std-dev tuned to produce
 * occasional in-spec edge cases.
 *
 * In breach mode (voltage/frequency only): forces a value outside the
 * threshold band by ~5%. The other reading types have no thresholds,
 * so they stay in nominal range even with breach=true.
 */
const generateValue = (rt: ReadingType, breach: boolean): number => {
  if (breach && rt === 'voltage') {
    return Math.random() < 0.5
      ? randomNormal(110, 1)
      : randomNormal(130, 1);
  }
  if (breach && rt === 'frequency') {
    return Math.random() < 0.5
      ? randomNormal(59.0, 0.1)
      : randomNormal(61.0, 0.1);
  }
  switch (rt) {
    case 'voltage':
      return randomNormal(120, 1.5);
    case 'current':
      return randomNormal(15, 1);
    case 'frequency':
      return randomNormal(60, 0.1);
    case 'power_factor':
      return randomNormal(0.95, 0.02);
    case 'temperature':
      return randomNormal(25, 3);
  }
};

const pickRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const generateEvent = (
  sensorIds: string[],
  breach: boolean,
): SensorEvent => {
  const sensorId = pickRandom(sensorIds);
  const readingType = pickRandom(READING_TYPES);
  const sensorNumber = parseInt(sensorId.slice(-3), 10);
  const gridZone = Number.isFinite(sensorNumber)
    ? `zone-${(sensorNumber % 3) + 1}`
    : undefined;

  return {
    sensorId,
    timestamp: new Date().toISOString(),
    readingType,
    value: Number(generateValue(readingType, breach).toFixed(3)),
    unit: UNITS[readingType],
    ...(gridZone ? { gridZone } : {}),
  };
};

export const handler = async (
  event: SimulatorEvent,
  _context: Context,
): Promise<SimulatorResult> => {
  const count = Math.max(1, event.count ?? 1);
  const sensorIds =
    event.sensorIds && event.sensorIds.length > 0
      ? event.sensorIds
      : DEFAULT_SENSORS;
  const breach = event.breach ?? false;

  let published = 0;
  let failed = 0;

  try {
    for (let i = 0; i < count; i++) {
      const sensorEvent = generateEvent(sensorIds, breach);
      const topic = `sensors/${sensorEvent.sensorId}/telemetry`;

      try {
        await iotClient.send(
          new PublishCommand({
            topic,
            payload: Buffer.from(JSON.stringify(sensorEvent)),
            qos: 0,
          }),
        );
        published++;
      } catch (err) {
        failed++;
        logger.error('Publish failed', {
          error: err instanceof Error ? err.message : String(err),
          topic,
          sensorId: sensorEvent.sensorId,
          readingType: sensorEvent.readingType,
        });
      }
    }

    metrics.addMetric('SimulatedEventsPublished', MetricUnit.Count, published);
    if (failed > 0) {
      metrics.addMetric('SimulatedEventsFailed', MetricUnit.Count, failed);
    }
    if (breach) {
      metrics.addMetric('BreachEventsRequested', MetricUnit.Count, count);
    }
    logger.info('Simulator run complete', {
      requested: count,
      published,
      failed,
      breach,
    });
    return { published, failed };
  } finally {
    metrics.publishStoredMetrics();
  }
};
