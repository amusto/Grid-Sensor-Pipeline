/**
 * Powertools Logger singleton.
 *
 * Re-exported by every handler so structured logs share a serviceName. The
 * actual `serviceName` per Lambda comes from `POWERTOOLS_SERVICE_NAME` set
 * by CDK (e.g., `grid-sensor-processor`); this module just provides the
 * default.
 */

import { Logger } from '@aws-lambda-powertools/logger';

export const logger = new Logger({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'grid-sensor-pipeline',
});
