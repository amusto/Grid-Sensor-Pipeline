/**
 * SensorRepository — DynamoDB access for the readings table.
 *
 * Per CLAUDE.md architectural invariant #2, this module's I/O is scoped to
 * DynamoDB only. Handlers orchestrate; the repository executes. Per
 * invariant #6, every write uses a `ConditionExpression` of
 * `attribute_not_exists(pk)` as belt-and-suspenders on top of Powertools
 * idempotency at the consumer.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SensorEvent, SensorReading } from './types';

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
/** Sentinel suffix to make `to` an inclusive upper bound on the SK string. */
const SK_UPPER_SENTINEL = '￿';

export interface QueryOptions {
  /** Inclusive ISO 8601 lower bound on `timestamp`. */
  from?: string;
  /** Inclusive ISO 8601 upper bound on `timestamp`. */
  to?: string;
  /** Cap on items returned. */
  limit?: number;
  /** True for ascending by SK; default false (most-recent-first). */
  ascending?: boolean;
}

export class SensorRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    docClient?: DynamoDBDocumentClient,
  ) {
    if (!tableName || tableName.trim() === '') {
      throw new Error('SensorRepository requires a non-empty tableName');
    }
    this.client =
      docClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /**
   * Persist a validated SensorEvent. Returns the stored shape (with pk/sk/ttl)
   * so the caller can log, emit metrics, or pass it downstream.
   *
   * The conditional write makes a duplicate insert at the same (sensorId,
   * timestamp, readingType) fail with `ConditionalCheckFailedException` —
   * the caller (processor Lambda) treats that as a no-op idempotent retry.
   */
  async putReading(
    event: SensorEvent,
    now: Date = new Date(),
  ): Promise<SensorReading> {
    const item: SensorReading = {
      ...event,
      pk: event.sensorId,
      sk: `${event.timestamp}#${event.readingType}`,
      ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return item;
  }

  /**
   * Range query for a sensor's readings, optionally bounded by ISO timestamp.
   *
   * Uses the SK composite (`timestamp#readingType`) so a string BETWEEN
   * naturally constrains by time. The upper bound is extended with a
   * sentinel character so any trailing `#readingType` in stored SKs falls
   * within the range when only `to`'s timestamp is supplied.
   */
  async queryReadings(
    sensorId: string,
    opts: QueryOptions = {},
  ): Promise<SensorReading[]> {
    const { from, to, limit, ascending = false } = opts;
    const expressionValues: Record<string, string> = { ':pk': sensorId };
    let keyExpr = 'pk = :pk';

    if (from && to) {
      keyExpr += ' AND sk BETWEEN :from AND :to';
      expressionValues[':from'] = from;
      expressionValues[':to'] = `${to}${SK_UPPER_SENTINEL}`;
    } else if (from) {
      keyExpr += ' AND sk >= :from';
      expressionValues[':from'] = from;
    } else if (to) {
      keyExpr += ' AND sk <= :to';
      expressionValues[':to'] = `${to}${SK_UPPER_SENTINEL}`;
    }

    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: keyExpr,
        ExpressionAttributeValues: expressionValues,
        Limit: limit,
        ScanIndexForward: ascending,
      }),
    );
    return (result.Items ?? []) as SensorReading[];
  }
}
