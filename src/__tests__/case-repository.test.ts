/**
 * CaseRepository tests — verifies the P9.3 cases-layer access:
 *   1. Constructor validation.
 *   2. buildCasePk composition.
 *   3. findChannelCase: returns row when present, null when absent.
 *   4. createChannelCase: PutCommand with the conditional write +
 *      the right key composition; ConditionalCheckFailedException
 *      propagates to the caller.
 *   5. updateChannelCase: UpdateCommand without ConditionExpression;
 *      updatedAt always bumped; createdAt never touched; #status
 *      alias used (reserved word).
 *   6. Same shape for findMetadata / createMetadata / updateMetadata.
 *
 * Pattern matches src/__tests__/repository.test.ts: mock the
 * DynamoDBDocumentClient with a jest.fn() for send, assert command
 * shapes via mock.calls.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  CaseRepository,
  buildCasePk,
  type CaseNaturalKey,
  type CaseChannelRow,
  type CaseMetadataRow,
} from '../lib/cases/case-repository';

interface MockDocClient {
  send: jest.Mock;
}

const makeRepo = (): { repo: CaseRepository; client: MockDocClient } => {
  const client: MockDocClient = { send: jest.fn() };
  const repo = new CaseRepository(
    'cases-table',
    client as unknown as DynamoDBDocumentClient,
  );
  return { repo, client };
};

const baseKey: CaseNaturalKey = {
  sensorId: 'sensor-007',
  timestamp: '2026-05-14T10:00:00Z',
  readingType: 'voltage',
};

const expectedPk = 'sensor-007#2026-05-14T10:00:00Z#voltage';

const baseChannelRow: CaseChannelRow = {
  channel: 'email',
  caseId: 'ses-msg-abc-123',
  status: 'delivered',
  externalUrl: undefined,
  createdAt: '2026-05-14T10:00:01Z',
  updatedAt: '2026-05-14T10:00:01Z',
};

const baseMetadataRow: CaseMetadataRow = {
  severity: 'P1',
  createdAt: '2026-05-14T10:00:01Z',
  updatedAt: '2026-05-14T10:00:01Z',
  resolvedAt: null,
};

describe('CaseRepository', () => {
  describe('constructor', () => {
    it('throws on empty tableName', () => {
      expect(() => new CaseRepository('')).toThrow(/tableName/);
    });

    it('throws on whitespace-only tableName', () => {
      expect(() => new CaseRepository('   ')).toThrow(/tableName/);
    });
  });

  describe('buildCasePk', () => {
    it('composes pk as `${sensorId}#${timestamp}#${readingType}`', () => {
      expect(buildCasePk(baseKey)).toBe(expectedPk);
    });

    it('is deterministic for the same input', () => {
      expect(buildCasePk(baseKey)).toBe(buildCasePk(baseKey));
    });

    it('throws when any natural-key component is missing', () => {
      expect(() => buildCasePk({ ...baseKey, sensorId: '' })).toThrow(
        /non-empty/,
      );
      expect(() => buildCasePk({ ...baseKey, timestamp: '' })).toThrow(
        /non-empty/,
      );
      expect(() =>
        buildCasePk({ ...baseKey, readingType: '' as never }),
      ).toThrow(/non-empty/);
    });
  });

  describe('findChannelCase', () => {
    it('issues a GetCommand with the right key shape and returns the row when present', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Item: baseChannelRow });

      const out = await repo.findChannelCase(baseKey, 'email');

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as GetCommand;
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        Key: { pk: expectedPk, sk: 'email' },
      });
      expect(out).toEqual(baseChannelRow);
    });

    it('returns null when the row is absent (Item undefined)', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      const out = await repo.findChannelCase(baseKey, 'email');

      expect(out).toBeNull();
    });
  });

  describe('createChannelCase', () => {
    it('issues a PutCommand with the conditional write and full row shape', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.createChannelCase(baseKey, baseChannelRow);

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as PutCommand;
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      expect(cmd.input.Item).toMatchObject({
        pk: expectedPk,
        sk: 'email',
        channel: 'email',
        caseId: 'ses-msg-abc-123',
        status: 'delivered',
        createdAt: '2026-05-14T10:00:01Z',
        updatedAt: '2026-05-14T10:00:01Z',
      });
    });

    it('propagates ConditionalCheckFailedException to the caller', async () => {
      const { repo, client } = makeRepo();
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      client.send.mockRejectedValueOnce(err);

      await expect(repo.createChannelCase(baseKey, baseChannelRow)).rejects.toThrow(
        /conditional/i,
      );
    });
  });

  describe('updateChannelCase', () => {
    it('issues an UpdateCommand without ConditionExpression and bumps updatedAt', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.updateChannelCase(baseKey, 'email', {
        status: 'failed',
        error: 'Throttled',
        updatedAt: '2026-05-14T10:00:02Z',
      });

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      expect(cmd).toBeInstanceOf(UpdateCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        Key: { pk: expectedPk, sk: 'email' },
      });
      expect(cmd.input.UpdateExpression).toMatch(/^SET\s/);
      expect(cmd.input.UpdateExpression).toContain('updatedAt = :updatedAt');
      expect(cmd.input.ConditionExpression).toBeUndefined();
      expect(cmd.input.ExpressionAttributeValues).toMatchObject({
        ':status': 'failed',
        ':error': 'Throttled',
        ':updatedAt': '2026-05-14T10:00:02Z',
      });
    });

    it('uses ExpressionAttributeNames for the `status` reserved word', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.updateChannelCase(baseKey, 'email', {
        status: 'failed',
        updatedAt: '2026-05-14T10:00:02Z',
      });

      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      expect(cmd.input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
      expect(cmd.input.UpdateExpression).toContain('#status = :status');
    });

    it('auto-generates updatedAt when caller omits it', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});
      const before = Date.now();

      await repo.updateChannelCase(baseKey, 'email', { status: 'failed' });

      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      const auto = cmd.input.ExpressionAttributeValues?.[':updatedAt'] as string;
      expect(typeof auto).toBe('string');
      // ISO 8601 timestamp within a reasonable window of the test start.
      expect(Date.parse(auto)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(auto)).toBeLessThanOrEqual(Date.now());
    });

    it('does NOT include createdAt in the UpdateExpression even if forced through', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      // Force createdAt into the partial via `as any` to bypass the
      // type guard. The implementation must still skip it.
      await repo.updateChannelCase(
        baseKey,
        'email',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { createdAt: '1999-01-01T00:00:00Z', status: 'delivered' } as any,
      );

      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      expect(cmd.input.UpdateExpression).not.toContain('createdAt');
      expect(
        Object.keys(cmd.input.ExpressionAttributeValues ?? {}),
      ).not.toContain(':createdAt');
    });
  });

  describe('findMetadata', () => {
    it('issues a GetCommand with sk=__metadata__ and returns the row when present', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Item: baseMetadataRow });

      const out = await repo.findMetadata(baseKey);

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as GetCommand;
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        Key: { pk: expectedPk, sk: '__metadata__' },
      });
      expect(out).toEqual(baseMetadataRow);
    });

    it('returns null when the metadata row is absent', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      const out = await repo.findMetadata(baseKey);

      expect(out).toBeNull();
    });
  });

  describe('createMetadata', () => {
    it('issues a PutCommand with conditional write and sk=__metadata__', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.createMetadata(baseKey, baseMetadataRow);

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as PutCommand;
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      expect(cmd.input.Item).toMatchObject({
        pk: expectedPk,
        sk: '__metadata__',
        severity: 'P1',
        createdAt: '2026-05-14T10:00:01Z',
        updatedAt: '2026-05-14T10:00:01Z',
        resolvedAt: null,
      });
    });

    it('propagates ConditionalCheckFailedException to the caller', async () => {
      const { repo, client } = makeRepo();
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      client.send.mockRejectedValueOnce(err);

      await expect(repo.createMetadata(baseKey, baseMetadataRow)).rejects.toThrow(
        /conditional/i,
      );
    });
  });

  describe('updateMetadata', () => {
    it('issues an UpdateCommand with sk=__metadata__ and bumps updatedAt', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.updateMetadata(baseKey, {
        resolvedAt: '2026-05-14T10:15:01Z',
        updatedAt: '2026-05-14T10:15:01Z',
      });

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      expect(cmd).toBeInstanceOf(UpdateCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'cases-table',
        Key: { pk: expectedPk, sk: '__metadata__' },
      });
      expect(cmd.input.UpdateExpression).toMatch(/^SET\s/);
      expect(cmd.input.UpdateExpression).toContain('updatedAt = :updatedAt');
      expect(cmd.input.UpdateExpression).toContain('resolvedAt = :resolvedAt');
      expect(cmd.input.ConditionExpression).toBeUndefined();
      expect(cmd.input.ExpressionAttributeValues).toMatchObject({
        ':resolvedAt': '2026-05-14T10:15:01Z',
        ':updatedAt': '2026-05-14T10:15:01Z',
      });
    });

    it('does NOT update createdAt even if forced through', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});

      await repo.updateMetadata(
        baseKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { createdAt: '1999-01-01T00:00:00Z', severity: 'P2' } as any,
      );

      const cmd = client.send.mock.calls[0][0] as UpdateCommand;
      expect(cmd.input.UpdateExpression).not.toContain('createdAt');
      expect(
        Object.keys(cmd.input.ExpressionAttributeValues ?? {}),
      ).not.toContain(':createdAt');
    });
  });
});
