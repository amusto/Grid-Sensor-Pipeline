/**
 * CaseRepository — DynamoDB access for the cases table (P9.3).
 *
 * Phase 9's case-tracking layer. One conceptual *case* per breach;
 * each case has a metadata row + N per-channel rows in DynamoDB,
 * all keyed by the same natural-key partition key. The dispatcher
 * in P9.4 uses this repository to record + de-duplicate case state
 * before invoking channel adapters.
 *
 * **Pattern instantiation.** Same `attribute_not_exists(pk)`
 * conditional-write idempotency pattern from P2's readings dedup
 * (see `repository.ts` and CLAUDE.md architectural invariant #6),
 * applied at a new boundary: the agentic-tool dispatch layer
 * instead of the Kinesis-processor write layer. Same conceptual
 * key (natural breach identity), different scope (per-channel
 * dispatch state vs raw sensor readings).
 *
 * **Natural key composition** —
 *   pk = `${sensorId}#${timestamp}#${readingType}`
 *   sk = '__metadata__'  (the per-breach metadata row)
 *     OR caseSystem      ('email' | 'sms' — one row per dispatched channel)
 *
 * The `(sensorId, timestamp, readingType)` triple is the natural
 * identity of a breach. Step Functions retries of the same alert
 * carry the same triple, so a retry that tries to record a case
 * row fails the conditional write — the dispatcher's signal to
 * update the existing row instead of creating a duplicate.
 *
 * **Why two row types per breach** —
 *   - Metadata row: per-breach attributes (severity, createdAt,
 *     resolvedAt). Set once on first encounter; updated when the
 *     alert resolves.
 *   - Per-channel rows: one per channel actually dispatched, with
 *     external IDs (SES MessageId, MOCK-sms-...), delivery status,
 *     timestamps. Sparse — a breach that fires email + SMS has
 *     two channel rows; a breach that only fires email has one.
 *
 * Per CLAUDE.md architectural invariant #2, I/O is scoped to
 * DynamoDB only; this module has no orchestration logic.
 *
 * Decision log cross-references:
 *   - `docs/decisions/phase-09-agentic-case-routing.md` pre-flight 2
 *     (idempotency at the case-tracker layer)
 *   - `docs/decisions/phase-09-agentic-case-routing.md` pre-flight 5
 *     (cross-channel case linkage; one row per (alert, channel))
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CaseSystem, ChannelStatus } from './types';
import type { ReadingType } from '../types';

/**
 * Sort-key sentinel for the per-breach metadata row.
 * Per-channel rows use the channel literal ('email' | 'sms') as sk.
 */
const METADATA_SK = '__metadata__';

/**
 * The natural identity of a breach — the triple Step Functions
 * retries preserve. Used to compose the pk of every row this
 * repository writes or reads.
 */
export interface CaseNaturalKey {
  sensorId: string;
  /** ISO 8601 timestamp of the breach. */
  timestamp: string;
  readingType: ReadingType;
}

/**
 * Per-breach metadata row — sk = '__metadata__'.
 * Written once on first dispatch; `resolvedAt` is set when the
 * alert workflow's Wait state completes with an acknowledgment.
 */
export interface CaseMetadataRow {
  /** Severity tier from the LangGraph classifier (P8.3). */
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  /** ISO 8601 timestamp of first case creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update; bumped on every write. */
  updatedAt: string;
  /** ISO 8601 timestamp of operator acknowledgment; null until resolved. */
  resolvedAt: string | null;
}

/**
 * Per-channel row — sk = caseSystem ('email' | 'sms').
 * One per channel actually dispatched. Carries the external ID
 * the channel adapter produced and delivery state for that channel.
 */
export interface CaseChannelRow {
  channel: CaseSystem;
  /** External system ID — SES MessageId for email, MOCK-sms-... for stub. */
  caseId: string;
  /** delivered | failed | skipped from ChannelResult. */
  status: ChannelStatus;
  /** Deep-link to the external system, where one exists. */
  externalUrl?: string;
  /** Populated when status === 'failed'. */
  error?: string;
  /** ISO 8601 timestamp of first dispatch attempt. */
  createdAt: string;
  /** ISO 8601 timestamp of last update; bumped on retries. */
  updatedAt: string;
}

/**
 * Compose the partition key from the natural-key triple.
 *
 * Format: `${sensorId}#${timestamp}#${readingType}`. Step Functions
 * retries preserve all three components, so the composed pk is
 * stable across retries — the conditional-write idempotency
 * contract depends on this stability.
 *
 * Exposed for tests + for any caller that needs the raw pk
 * without going through the repository (rare; mostly the
 * dispatcher in P9.4 will only need the repository methods).
 */
export const buildCasePk = (key: CaseNaturalKey): string => {
  if (!key.sensorId || !key.timestamp || !key.readingType) {
    throw new Error('buildCasePk requires a non-empty sensorId, timestamp, and readingType');
  }
  return `${key.sensorId}#${key.timestamp}#${key.readingType}`
};

export class CaseRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    docClient?: DynamoDBDocumentClient,
  ) {
    if (!tableName || tableName.trim() === '') {
      throw new Error('CaseRepository requires a non-empty tableName');
    }
    this.client =
      docClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /**
   * Look up an existing per-channel case row for a (breach, channel)
   * pair. Returns null if no such row exists.
   *
   * Implementation notes:
   *   1. Issue a GetCommand with TableName + Key { pk: buildCasePk(key), sk: channel }.
   *   2. DynamoDB returns Item: undefined when the row doesn't exist —
   *      treat that as null (no try/catch needed; GetItem on a missing
   *      key is a success with empty Item, not an exception).
   *   3. Cast Item to CaseChannelRow when present.
   */
  async findChannelCase(
    key: CaseNaturalKey,
    channel: CaseSystem,
  ): Promise<CaseChannelRow | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildCasePk(key),
          sk: channel,
        },
      }),
    );
    return (result.Item as CaseChannelRow | undefined) ?? null;
  }

  /**
   * Create a new per-channel case row. Atomic + idempotent: throws
   * `ConditionalCheckFailedException` from the AWS SDK if a row at
   * (pk, sk=channel) already exists.
   *
   * **The dispatcher's contract**: catch that exception and fall
   * back to `updateChannelCase` (treating the encounter as a Step
   * Functions retry of the same alert+channel). Never swallow it
   * silently — that would lose the "this is a retry" signal that
   * the metric layer + audit log depend on.
   *
   * Implementation notes:
   *   1. Item: { pk: buildCasePk(key), sk: row.channel, ...row }.
   *   2. PutCommand with ConditionExpression: 'attribute_not_exists(pk)'.
   *   3. Let ConditionalCheckFailedException propagate.
   *   4. Caller is responsible for setting row.createdAt and
   *      row.updatedAt (both to the current timestamp on first write).
   */
  async createChannelCase(
    key: CaseNaturalKey,
    row: CaseChannelRow,
  ): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...row,
          pk: buildCasePk(key),
          sk: row.channel,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  }

  /**
   * Update an existing per-channel case row. Used when the
   * dispatcher detects a retry (the conditional create failed)
   * and wants to bump the row's status / updatedAt / externalUrl
   * without overwriting createdAt or the original caseId.
   *
   * Implementation notes:
   *   1. Key: { pk: buildCasePk(key), sk: channel }.
   *   2. UpdateExpression: build "SET attr1 = :v1, attr2 = :v2, ..."
   *      dynamically based on which fields in `partial` are defined.
   *      Skip undefined fields.
   *   3. Always include `updatedAt` in the SET clause (a retry write
   *      that bumps nothing else is still a meaningful event).
   *   4. `createdAt` is immutable — the type signature already excludes
   *      it via `Omit<..., 'createdAt'>`, but the implementation should
   *      also defensively skip it if somehow passed.
   *   5. `status` is a DynamoDB reserved word — use ExpressionAttributeNames
   *      with `#status` to alias it. Same for any other reserved words
   *      that show up (none in the current schema, but worth keeping
   *      the pattern in mind).
   *   6. No ConditionExpression — this is a deliberate update; the caller
   *      already established the row exists by failing the create.
   */
  async updateChannelCase(
    key: CaseNaturalKey,
    channel: CaseSystem,
    partial: Partial<Omit<CaseChannelRow, 'channel' | 'createdAt'>>,
  ): Promise<void> {
    // Always bump updatedAt — every write is a meaningful event,
    // even if no other field changes. Caller can override by setting
    // partial.updatedAt explicitly (typical from the dispatcher).
    const effectivePartial = {
      ...partial,
      updatedAt: partial.updatedAt ?? new Date().toISOString(),
    };

    const { expression, names, values } = buildUpdateExpression(
      effectivePartial,
      RESERVED_WORDS,
      IMMUTABLE_CHANNEL_FIELDS,
    );

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: buildCasePk(key), sk: channel },
        UpdateExpression: expression,
        ExpressionAttributeValues: values,
        ...(Object.keys(names).length > 0 && {
          ExpressionAttributeNames: names,
        }),
      }),
    );
  }

  /**
   * Look up the per-breach metadata row. Returns null if no
   * dispatch has yet recorded one.
   *
   * Implementation notes:
   *   1. Issue GetCommand with Key { pk: buildCasePk(key), sk: METADATA_SK }.
   *   2. Return Item as CaseMetadataRow when present, null when undefined.
   */
  async findMetadata(key: CaseNaturalKey): Promise<CaseMetadataRow | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildCasePk(key),
          sk: METADATA_SK,
        },
      }),
    );
    return (result.Item as CaseMetadataRow | undefined) ?? null;
  }

  /**
   * Create the per-breach metadata row. Atomic + idempotent like
   * createChannelCase — throws ConditionalCheckFailedException if
   * a metadata row already exists for this breach.
   *
   * Called once per breach on first dispatch. Subsequent dispatches
   * (Step Functions retries) hit the conditional check and fall
   * back to updateMetadata (typically to bump updatedAt or set
   * resolvedAt).
   *
   * Implementation notes:
   *   1. Item: { pk: buildCasePk(key), sk: METADATA_SK, ...row }.
   *   2. PutCommand with ConditionExpression: 'attribute_not_exists(pk)'.
   *   3. Let ConditionalCheckFailedException propagate.
   */
  async createMetadata(
    key: CaseNaturalKey,
    row: CaseMetadataRow,
  ): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...row,
          pk: buildCasePk(key),
          sk: METADATA_SK,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  }

  /**
   * Update the metadata row. Used to set `resolvedAt` when the
   * alert workflow's WaitForAck completes successfully, and to
   * bump `updatedAt` on retry encounters.
   *
   * Implementation notes:
   *   1. Key: { pk: buildCasePk(key), sk: METADATA_SK }.
   *   2. UpdateExpression: SET dynamically based on `partial` fields.
   *      Skip undefined fields. Always bump updatedAt.
   *   3. `createdAt` is immutable; type signature excludes it.
   *   4. No ConditionExpression.
   */
  async updateMetadata(
    key: CaseNaturalKey,
    partial: Partial<Omit<CaseMetadataRow, 'createdAt'>>,
  ): Promise<void> {
    const effectivePartial = {
      ...partial,
      updatedAt: partial.updatedAt ?? new Date().toISOString(),
    };

    const { expression, names, values } = buildUpdateExpression(
      effectivePartial,
      RESERVED_WORDS,
      IMMUTABLE_METADATA_FIELDS,
    );

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: buildCasePk(key), sk: METADATA_SK },
        UpdateExpression: expression,
        ExpressionAttributeValues: values,
        ...(Object.keys(names).length > 0 && {
          ExpressionAttributeNames: names,
        }),
      }),
    );
  }
}

/**
 * DynamoDB reserved words that need ExpressionAttributeNames aliasing
 * when used as attribute names in UpdateExpression. We only list the
 * ones that appear in our schema; the AWS reserved-words list is much
 * longer (see https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html).
 *
 * `status` is the one that hits us today (CaseChannelRow.status).
 * If a future column collides with a reserved word, add it here.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set(['status']);

/**
 * Fields that must never appear in an UpdateExpression even if they
 * arrive in `partial` (e.g., via `as any` casts that bypass the
 * Omit<...> type guard). `createdAt` is immutable per the schema
 * contract; `channel` is part of the sort key and changing it would
 * corrupt the row identity.
 */
const IMMUTABLE_CHANNEL_FIELDS: ReadonlySet<string> = new Set([
  'createdAt',
  'channel',
]);

const IMMUTABLE_METADATA_FIELDS: ReadonlySet<string> = new Set(['createdAt']);

/**
 * Build a DynamoDB UpdateExpression dynamically from a partial object.
 *
 * Walks the partial, emits `SET attr1 = :attr1, attr2 = :attr2, ...`
 * for every defined (non-undefined) field, skipping fields in
 * `immutableFields` and aliasing fields in `reservedWords` with
 * `#name` / ExpressionAttributeNames.
 *
 * Internal helper — kept at module scope so it's testable in isolation
 * and reusable across the two update methods.
 */
const buildUpdateExpression = (
  partial: Record<string, unknown>,
  reservedWords: ReadonlySet<string>,
  immutableFields: ReadonlySet<string>,
): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} => {
  const setClauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    if (immutableFields.has(field)) continue;

    const isReserved = reservedWords.has(field);
    const nameToken = isReserved ? `#${field}` : field;
    const valueToken = `:${field}`;

    setClauses.push(`${nameToken} = ${valueToken}`);
    if (isReserved) {
      names[nameToken] = field;
    }
    values[valueToken] = value;
  }

  if (setClauses.length === 0) {
    // Caller always sets updatedAt (auto-defaulted by the public
    // methods), so empty SET should be unreachable. If we ever get
    // here, it means the caller violated the contract.
    throw new Error(
      'buildUpdateExpression: no updatable fields in partial — at minimum updatedAt should always be present',
    );
  }

  return {
    expression: `SET ${setClauses.join(', ')}`,
    names,
    values,
  };
};
