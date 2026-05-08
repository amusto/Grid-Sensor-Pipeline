/**
 * Powertools Tracer singleton — AWS X-Ray distributed tracing.
 *
 * Handlers wrap their entrypoint with `tracer.captureLambdaHandler(...)`;
 * `repository.ts` and downstream SDK calls are auto-instrumented via the
 * X-Ray AWS SDK v3 integration once tracing is enabled at the function
 * level (CDK).
 */

import { Tracer } from '@aws-lambda-powertools/tracer';

export const tracer = new Tracer({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'grid-sensor-pipeline',
});
