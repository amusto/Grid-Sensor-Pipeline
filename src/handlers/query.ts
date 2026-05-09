/**
 * Query handler — `GET /sensors/{sensorId}/readings?from=&to=&limit=`.
 *
 * Per CLAUDE.md invariant #4, the handler is orchestration only:
 *   1. Validate path + query params with Zod.
 *   2. Call SensorRepository.queryReadings() — same lib code the
 *      processor uses for writes.
 *   3. Format the response (200 OK with array; 400 on bad input).
 *
 * No business logic in the handler.
 *
 * Per `docs/decisions/phase-07-query-api.md` pre-flight 4, this uses a
 * separate Zod schema from `sensorEventSchema` because the input shape
 * is path/query params (strings arriving from URL), not a parsed event
 * object.
 */

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';
import { z } from 'zod';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { SensorRepository } from '../lib/repository';

const READINGS_TABLE = process.env.READINGS_TABLE ?? '';
if (!READINGS_TABLE) {
  throw new Error('READINGS_TABLE env var is required');
}

const repo = new SensorRepository(READINGS_TABLE);

/**
 * Schema for path + query parameters. Note that all values arrive as
 * strings from API Gateway; we use `coerce` for `limit` to convert.
 */
const queryParamsSchema = z.object({
  sensorId: z
    .string()
    .regex(/^sensor-[a-z0-9-]+$/, 'sensorId must match sensor-[a-z0-9-]+'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

const respond = (
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...corsHeaders,
  },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context,
): Promise<APIGatewayProxyResult> => {
  try {
    const rawParams = {
      sensorId: event.pathParameters?.sensorId,
      from: event.queryStringParameters?.from,
      to: event.queryStringParameters?.to,
      limit: event.queryStringParameters?.limit,
    };

    let params: z.infer<typeof queryParamsSchema>;
    try {
      params = queryParamsSchema.parse(rawParams);
    } catch (err) {
      metrics.addMetric('QueryValidationErrors', MetricUnit.Count, 1);
      logger.warn('Invalid query parameters', {
        error: err instanceof Error ? err.message : String(err),
        rawParams,
      });
      return respond(400, {
        error: 'Invalid request parameters',
        details: err instanceof z.ZodError ? err.flatten() : String(err),
      });
    }

    const startedAt = Date.now();
    const items = await repo.queryReadings(params.sensorId, {
      from: params.from,
      to: params.to,
      limit: params.limit,
    });
    const elapsedMs = Date.now() - startedAt;

    metrics.addMetric('QueriesServed', MetricUnit.Count, 1);
    metrics.addMetric('QueryLatencyMs', MetricUnit.Milliseconds, elapsedMs);
    metrics.addMetric('QueryItemsReturned', MetricUnit.Count, items.length);

    logger.info('Query served', {
      sensorId: params.sensorId,
      from: params.from,
      to: params.to,
      limit: params.limit,
      itemsReturned: items.length,
      elapsedMs,
    });

    return respond(200, {
      sensorId: params.sensorId,
      count: items.length,
      items,
    });
  } catch (err) {
    metrics.addMetric('QueryFailures', MetricUnit.Count, 1);
    logger.error('Query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return respond(500, { error: 'Internal server error' });
  } finally {
    metrics.publishStoredMetrics();
  }
};
