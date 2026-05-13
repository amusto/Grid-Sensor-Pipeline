/**
 * SMS stub channel adapter — P9.1.
 *
 * Mimics what a real SMS API call (SNS-SMS, Twilio, etc.) would
 * receive. Logs a structured `would_call` entry to CloudWatch via
 * Powertools Logger; returns a `ChannelResult` with a synthetic
 * `MOCK-sms-...` case ID and latency from a `performance.now()`
 * bracket.
 *
 * Implements the same `Promise<ChannelResult>` interface as the
 * email adapter (P9.2) and any future channel adapter. The
 * dispatcher in P9.4 doesn't know which adapter is real vs stubbed
 * — that's the uniform-adapter-interface property the architecture
 * relies on.
 *
 * The input shape (`SmsCallInput`) mirrors what a real SMS provider
 * would accept (E.164 phone number, ≤160-char body, optional
 * alphanumeric sender ID). Documented separately from the
 * narrative-generator's SMS bound so the schema and the call shape
 * stay aligned without coupling.
 */

import { performance } from 'node:perf_hooks';
import { logger } from '../../logger';
import { generateMockCaseId } from '../case-id';
import type { ChannelResult } from '../types';

export interface SmsCallInput {
  /** E.164-formatted recipient phone number (real call would validate). */
  phoneNumber: string;
  /** Message body. Real call would reject over 160 chars (GSM-7 limit). */
  body: string;
  /** Optional alphanumeric sender ID, where supported by the carrier. */
  senderId?: string;
}

export const callSmsStub = async (
  input: SmsCallInput,
): Promise<ChannelResult> => {
  const start = performance.now();
  const caseId = generateMockCaseId('sms');
  const externalUrl = `https://example-sms.invalid/log/${caseId}`;

  logger.info('would_call', {
    channel: 'sms',
    caseId,
    externalUrl,
    input: {
      phoneNumber: input.phoneNumber,
      body: input.body,
      bodyLength: input.body.length,
      senderId: input.senderId ?? null,
    },
  });

  return {
    channel: 'sms',
    status: 'delivered',
    caseId,
    externalUrl,
    latencyMs: performance.now() - start,
  };
};
