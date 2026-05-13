/**
 * SMS stub tests — verifies the P9.1 channel adapter:
 *   1. Returns the uniform `ChannelResult` shape.
 *   2. Generates a `MOCK-sms-{epoch}-{hash}` case ID.
 *   3. Emits a structured `would_call` log via Powertools Logger.
 *   4. Reports non-negative latency.
 *   5. Concurrent calls produce distinct case IDs.
 *
 * The stub has no real I/O — these are pure behavior tests against
 * the log + return-shape contract.
 */

const mockLoggerInfo = jest.fn();

jest.mock('../lib/logger', () => ({
  logger: { info: mockLoggerInfo },
}));

import { callSmsStub, type SmsCallInput } from '../lib/cases/channels/sms-stub';

const baseInput: SmsCallInput = {
  phoneNumber: '+12025551234',
  body: 'P1: sensor-005 voltage 108V (6V below 114V min). Investigate now.',
};

beforeEach(() => {
  mockLoggerInfo.mockClear();
});

describe('callSmsStub — return shape', () => {
  it('returns a ChannelResult with channel=sms and status=delivered', async () => {
    const result = await callSmsStub(baseInput);
    expect(result.channel).toBe('sms');
    expect(result.status).toBe('delivered');
  });

  it('generates a MOCK-sms case ID matching the expected format', async () => {
    const result = await callSmsStub(baseInput);
    expect(result.caseId).toMatch(/^MOCK-sms-\d{13}-[0-9a-f]{6}$/);
  });

  it('includes an externalUrl deep-link shaped like a real SMS log', async () => {
    const result = await callSmsStub(baseInput);
    expect(result.externalUrl).toMatch(
      /^https:\/\/example-sms\.invalid\/log\/MOCK-sms-/,
    );
  });

  it('reports non-negative latency in milliseconds', async () => {
    const result = await callSmsStub(baseInput);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('does not populate the error field on success', async () => {
    const result = await callSmsStub(baseInput);
    expect(result.error).toBeUndefined();
  });
});

describe('callSmsStub — structured log contract', () => {
  it('emits a would_call log event with channel + caseId + input fields', async () => {
    await callSmsStub(baseInput);

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'would_call',
      expect.objectContaining({
        channel: 'sms',
        caseId: expect.stringMatching(/^MOCK-sms-/),
        externalUrl: expect.stringContaining('example-sms.invalid'),
        input: expect.objectContaining({
          phoneNumber: '+12025551234',
          body: baseInput.body,
          bodyLength: baseInput.body.length,
          senderId: null,
        }),
      }),
    );
  });

  it('records body length for downstream observability', async () => {
    await callSmsStub(baseInput);
    const logPayload = mockLoggerInfo.mock.calls[0][1];
    expect(logPayload.input.bodyLength).toBe(baseInput.body.length);
  });

  it('preserves senderId when provided', async () => {
    await callSmsStub({ ...baseInput, senderId: 'GRIDOPS' });
    const logPayload = mockLoggerInfo.mock.calls[0][1];
    expect(logPayload.input.senderId).toBe('GRIDOPS');
  });
});

describe('callSmsStub — case ID uniqueness', () => {
  it('concurrent invocations produce distinct case IDs', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callSmsStub(baseInput)),
    );
    const caseIds = new Set(results.map((r) => r.caseId));
    expect(caseIds.size).toBe(5);
  });

  it('sequential invocations also produce distinct case IDs', async () => {
    const r1 = await callSmsStub(baseInput);
    const r2 = await callSmsStub(baseInput);
    expect(r1.caseId).not.toBe(r2.caseId);
  });
});
