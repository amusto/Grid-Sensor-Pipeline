/**
 * Powertools Metrics singleton — EMF emission to CloudWatch Logs.
 *
 * Namespace `GridSensorPipeline` is fixed; `serviceName` differentiates
 * which Lambda emitted the metric (processor, dlq-inspector, etc.) and
 * comes from `POWERTOOLS_SERVICE_NAME`.
 *
 * Per CLAUDE.md hard rule #8, handlers MUST call
 * `metrics.publishStoredMetrics()` in a `finally` block — EMF lines are
 * buffered until then.
 */

import { Metrics } from '@aws-lambda-powertools/metrics';

export const metrics = new Metrics({
  namespace: 'GridSensorPipeline',
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'grid-sensor-pipeline',
});

/**
 * Re-exported for ergonomic imports at handler call sites:
 *   import { metrics, MetricUnit } from '../lib/metrics';
 */
export { MetricUnit } from '@aws-lambda-powertools/metrics';
