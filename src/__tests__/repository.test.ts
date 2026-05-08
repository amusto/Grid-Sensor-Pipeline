import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { SensorRepository } from '../lib/repository';
import type { SensorEvent } from '../lib/types';

interface MockDocClient {
  send: jest.Mock;
}

const makeRepo = (): { repo: SensorRepository; client: MockDocClient } => {
  const client: MockDocClient = { send: jest.fn() };
  const repo = new SensorRepository(
    'readings-table',
    client as unknown as DynamoDBDocumentClient,
  );
  return { repo, client };
};

const baseEvent: SensorEvent = {
  sensorId: 'sensor-001',
  timestamp: '2026-05-08T12:00:00Z',
  readingType: 'voltage',
  value: 120,
  unit: 'V',
  gridZone: 'zone-1',
};

describe('SensorRepository', () => {
  describe('constructor', () => {
    it('throws on empty tableName', () => {
      expect(() => new SensorRepository('')).toThrow(/tableName/);
    });

    it('throws on whitespace-only tableName', () => {
      expect(() => new SensorRepository('   ')).toThrow(/tableName/);
    });
  });

  describe('putReading', () => {
    it('issues a PutCommand with the conditional write and proper key shape', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});
      const fixedNow = new Date('2026-05-08T12:00:00Z');

      const stored = await repo.putReading(baseEvent, fixedNow);

      expect(client.send).toHaveBeenCalledTimes(1);
      const cmd = client.send.mock.calls[0][0] as PutCommand;
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input).toMatchObject({
        TableName: 'readings-table',
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      expect(cmd.input.Item).toMatchObject({
        pk: 'sensor-001',
        sk: '2026-05-08T12:00:00Z#voltage',
        sensorId: 'sensor-001',
        timestamp: '2026-05-08T12:00:00Z',
        readingType: 'voltage',
        value: 120,
        unit: 'V',
        gridZone: 'zone-1',
      });

      const expectedTtl =
        Math.floor(fixedNow.getTime() / 1000) + 30 * 24 * 60 * 60;
      expect(cmd.input.Item?.ttl).toBe(expectedTtl);
      expect(stored.pk).toBe('sensor-001');
      expect(stored.sk).toBe('2026-05-08T12:00:00Z#voltage');
      expect(stored.ttl).toBe(expectedTtl);
    });

    it('omits gridZone from the stored item when the source event omits it', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});
      const { gridZone: _gz, ...withoutZone } = baseEvent;

      const stored = await repo.putReading(withoutZone);

      const cmd = client.send.mock.calls[0][0] as PutCommand;
      expect(cmd.input.Item).not.toHaveProperty('gridZone');
      expect(stored).not.toHaveProperty('gridZone');
    });

    it('propagates DynamoDB errors (e.g. ConditionalCheckFailedException)', async () => {
      const { repo, client } = makeRepo();
      client.send.mockRejectedValueOnce(
        new Error('ConditionalCheckFailedException'),
      );
      await expect(repo.putReading(baseEvent)).rejects.toThrow(
        'ConditionalCheckFailedException',
      );
    });
  });

  describe('queryReadings', () => {
    it('queries by PK only when no time range is supplied', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Items: [] });

      await repo.queryReadings('sensor-001');

      const cmd = client.send.mock.calls[0][0] as QueryCommand;
      expect(cmd).toBeInstanceOf(QueryCommand);
      expect(cmd.input.TableName).toBe('readings-table');
      expect(cmd.input.KeyConditionExpression).toBe('pk = :pk');
      expect(cmd.input.ExpressionAttributeValues).toEqual({
        ':pk': 'sensor-001',
      });
      expect(cmd.input.ScanIndexForward).toBe(false);
    });

    it('builds a BETWEEN expression when both from and to are supplied', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Items: [] });

      await repo.queryReadings('sensor-001', {
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-08T00:00:00Z',
      });

      const cmd = client.send.mock.calls[0][0] as QueryCommand;
      expect(cmd.input.KeyConditionExpression).toContain('BETWEEN');
      const values = cmd.input.ExpressionAttributeValues ?? {};
      expect(values[':from']).toBe('2026-05-01T00:00:00Z');
      expect(typeof values[':to']).toBe('string');
      expect(values[':to'] as string).toMatch(/^2026-05-08T00:00:00Z/);
    });

    it("uses sk >= :from when only 'from' is supplied", async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Items: [] });

      await repo.queryReadings('sensor-001', {
        from: '2026-05-01T00:00:00Z',
      });

      const cmd = client.send.mock.calls[0][0] as QueryCommand;
      expect(cmd.input.KeyConditionExpression).toContain('sk >= :from');
      expect(cmd.input.KeyConditionExpression).not.toContain('BETWEEN');
    });

    it("uses sk <= :to when only 'to' is supplied", async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Items: [] });

      await repo.queryReadings('sensor-001', {
        to: '2026-05-08T00:00:00Z',
      });

      const cmd = client.send.mock.calls[0][0] as QueryCommand;
      expect(cmd.input.KeyConditionExpression).toContain('sk <= :to');
    });

    it('honours limit and ascending options', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({ Items: [] });

      await repo.queryReadings('sensor-001', { limit: 25, ascending: true });

      const cmd = client.send.mock.calls[0][0] as QueryCommand;
      expect(cmd.input.Limit).toBe(25);
      expect(cmd.input.ScanIndexForward).toBe(true);
    });

    it('returns Items directly when DynamoDB returns them', async () => {
      const { repo, client } = makeRepo();
      const stored = {
        ...baseEvent,
        pk: baseEvent.sensorId,
        sk: '2026-05-08T12:00:00Z#voltage',
        ttl: 1234,
      };
      client.send.mockResolvedValueOnce({ Items: [stored] });

      const result = await repo.queryReadings('sensor-001');
      expect(result).toEqual([stored]);
    });

    it('returns [] when DynamoDB response has no Items field', async () => {
      const { repo, client } = makeRepo();
      client.send.mockResolvedValueOnce({});
      expect(await repo.queryReadings('sensor-001')).toEqual([]);
    });
  });
});
