/**
 * Email adapter tests — verifies the P9.2 channel adapter:
 *   1. Returns the uniform `ChannelResult` shape.
 *   2. Publishes via SNS PublishCommand with the right Topic / Subject /
 *      Message / Attributes.
 *   3. Emits a structured `email_dispatched` log on success and an
 *      `email_dispatch_failed` log on failure.
 *   4. Catches publish errors and returns status='failed' (rather than
 *      throwing — matches the SMS stub's always-resolve contract).
 *   5. Misconfiguration (no ALERT_TOPIC_ARN) is reported as a failed
 *      ChannelResult, not an exception.
 *
 * Pattern follows alert-handler.test.ts: manual jest.mock for the SNS
 * client so PublishCommand inputs are inspectable.
 */

const mockSnsSend = jest.fn();
const PublishCommandSpy = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => {
    PublishCommandSpy(input);
    return { input };
  }),
}));

jest.mock('../lib/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

import { callEmail, type EmailCallInput } from '../lib/cases/channels/email';

const baseInput: EmailCallInput = {
  subject: '[P1] sensor-005 voltage breach',
  body: 'Sensor sensor-005 reported a voltage reading of 108V at 09:15Z, 6V below the 114V minimum threshold. P1 severity; on-call paged via SMS.',
  sensorId: 'sensor-005',
};

const ORIGINAL_TOPIC_ARN = process.env.ALERT_TOPIC_ARN;

beforeEach(() => {
  mockSnsSend.mockReset();
  PublishCommandSpy.mockClear();
  mockLoggerInfo.mockClear();
  mockLoggerError.mockClear();
  process.env.ALERT_TOPIC_ARN =
    'arn:aws:sns:us-east-1:123456789012:gsp-test-alerts';
});

afterAll(() => {
  if (ORIGINAL_TOPIC_ARN === undefined) {
    delete process.env.ALERT_TOPIC_ARN;
  } else {
    process.env.ALERT_TOPIC_ARN = ORIGINAL_TOPIC_ARN;
  }
});

describe('callEmail — happy path', () => {
  it('returns ChannelResult with channel=email and status=delivered', async () => {
    mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-id-abc-123' });

    const result = await callEmail(baseInput);

    expect(result.channel).toBe('email');
    expect(result.status).toBe('delivered');
    expect(result.caseId).toBe('msg-id-abc-123');
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('publishes to the configured topic with the expected Subject and Message', async () => {
    mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-id-xyz' });

    await callEmail(baseInput);

    expect(PublishCommandSpy).toHaveBeenCalledTimes(1);
    const publishInput = PublishCommandSpy.mock.calls[0][0];
    expect(publishInput.TopicArn).toBe(
      'arn:aws:sns:us-east-1:123456789012:gsp-test-alerts',
    );
    expect(publishInput.Subject).toBe(baseInput.subject);
    expect(publishInput.Message).toBe(baseInput.body);
  });

  it('tags the publish with channel + sensorId message attributes for tracing', async () => {
    mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-id-xyz' });

    await callEmail(baseInput);

    const publishInput = PublishCommandSpy.mock.calls[0][0];
    expect(publishInput.MessageAttributes).toEqual({
      channel: { DataType: 'String', StringValue: 'email' },
      sensorId: { DataType: 'String', StringValue: 'sensor-005' },
    });
  });

  it('emits an email_dispatched log with caseId + sensorId + lengths', async () => {
    mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-id-abc' });

    await callEmail(baseInput);

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'email_dispatched',
      expect.objectContaining({
        channel: 'email',
        caseId: 'msg-id-abc',
        sensorId: 'sensor-005',
        subjectLength: baseInput.subject.length,
        bodyLength: baseInput.body.length,
      }),
    );
  });

  it('handles missing MessageId by setting caseId to empty string', async () => {
    // SNS responses can omit MessageId in edge cases (mocked tests, certain failures).
    mockSnsSend.mockResolvedValueOnce({});

    const result = await callEmail(baseInput);
    expect(result.status).toBe('delivered');
    expect(result.caseId).toBe('');
  });
});

describe('callEmail — failure path', () => {
  it('returns status=failed when SNS publish throws', async () => {
    mockSnsSend.mockRejectedValueOnce(new Error('Throttled'));

    const result = await callEmail(baseInput);

    expect(result.channel).toBe('email');
    expect(result.status).toBe('failed');
    expect(result.caseId).toBe('');
    expect(result.error).toBe('Throttled');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('emits an email_dispatch_failed log on publish error', async () => {
    mockSnsSend.mockRejectedValueOnce(new Error('AccessDenied'));

    await callEmail(baseInput);

    expect(mockLoggerError).toHaveBeenCalledWith(
      'email_dispatch_failed',
      expect.objectContaining({
        channel: 'email',
        error: 'AccessDenied',
        sensorId: 'sensor-005',
      }),
    );
  });

  it('does NOT throw when SNS publish fails', async () => {
    mockSnsSend.mockRejectedValueOnce(new Error('NetworkError'));
    await expect(callEmail(baseInput)).resolves.toEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

describe('callEmail — misconfiguration', () => {
  it('returns status=failed and logs an error when ALERT_TOPIC_ARN is missing', async () => {
    delete process.env.ALERT_TOPIC_ARN;

    const result = await callEmail(baseInput);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('ALERT_TOPIC_ARN env var is required');
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      'email_dispatch_misconfigured',
      expect.objectContaining({
        channel: 'email',
        error: 'ALERT_TOPIC_ARN env var is required',
        sensorId: 'sensor-005',
      }),
    );
  });
});
