/**
 * Email channel adapter — P9.2.
 *
 * Publishes the alert email to the P5 alert-workflow SNS topic.
 * Email subscribers on the topic (default recipient wired in
 * `infra/lib/alert-workflow-stack.ts`; ad-hoc viewers added at
 * runtime via `scripts/add-demo-recipient.sh`) receive the message
 * automatically — SNS handles the fan-out.
 *
 * Implements the same `Promise<ChannelResult>` interface as the SMS
 * stub and any future channel adapter. P9.4's dispatcher iterates
 * `CHANNEL_HANDLERS` over routing-plan selections; the dispatcher
 * does not know which adapter is real vs stubbed — that's the
 * uniform-adapter-interface property the architecture relies on.
 *
 * **Why SNS instead of direct SES?** Decision log
 * `phase-09-agentic-case-routing.md` Scope simplification (2026-05-13):
 * the alert-workflow SNS topic already exists from P5; only the
 * `EmailSubscription` was missing. Wiring the subscription is a
 * one-line CDK change with no new IAM, no new AWS service surface,
 * and no SES sandbox handling. SES remains the documented future
 * migration when HTML formatting or sender identity matter — the
 * swap is a single-file change inside this adapter (replace the
 * `SNSClient.send(new PublishCommand(...))` body with an
 * `SESClient.send(new SendEmailCommand(...))` body; the interface
 * is unchanged).
 *
 * **Failure semantics.** SNS publish errors are caught here and
 * returned as `ChannelResult{ status: 'failed', error }` rather than
 * thrown. The P9.4 dispatcher uses `Promise.allSettled` over the
 * registry, so adapters that throw would be aggregated into the
 * rejected branch and the dispatcher would have to reconstruct a
 * `ChannelResult`. Catching here keeps the contract uniform — every
 * adapter always resolves with a `ChannelResult`, status field
 * carries the outcome. Matches the SMS stub's always-resolve shape.
 */

import { performance } from 'node:perf_hooks';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logger } from '../../logger';
import type { ChannelResult } from '../types';

export interface EmailCallInput {
  /** Subject line. Appears in the inbox preview. */
  subject: string;
  /** Email body — the narrative produced by P8.5's narrative-generator. */
  body: string;
  /** Sensor ID for log correlation only (not inserted into the email). */
  sensorId: string;
}

// One client per Lambda container, reused across invocations.
// SDK clients are thread-safe and benefit from cold-start sharing.
const snsClient = new SNSClient({});

export const callEmail = async (
  input: EmailCallInput,
): Promise<ChannelResult> => {
  const start = performance.now();
  const topicArn = process.env.ALERT_TOPIC_ARN;

  if (!topicArn) {
    const latencyMs = performance.now() - start;
    logger.error('email_dispatch_misconfigured', {
      channel: 'email',
      error: 'ALERT_TOPIC_ARN env var is required',
      sensorId: input.sensorId,
    });
    return {
      channel: 'email',
      status: 'failed',
      caseId: '',
      error: 'ALERT_TOPIC_ARN env var is required',
      latencyMs,
    };
  }

  try {
    const response = await snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: input.subject,
        Message: input.body,
        MessageAttributes: {
          channel: { DataType: 'String', StringValue: 'email' },
          sensorId: { DataType: 'String', StringValue: input.sensorId },
        },
      }),
    );

    const latencyMs = performance.now() - start;
    const messageId = response.MessageId ?? '';

    logger.info('email_dispatched', {
      channel: 'email',
      caseId: messageId,
      topicArn,
      subjectLength: input.subject.length,
      bodyLength: input.body.length,
      sensorId: input.sensorId,
      latencyMs,
    });

    return {
      channel: 'email',
      status: 'delivered',
      caseId: messageId,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = performance.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error('email_dispatch_failed', {
      channel: 'email',
      error: errorMessage,
      sensorId: input.sensorId,
      latencyMs,
    });

    return {
      channel: 'email',
      status: 'failed',
      caseId: '',
      error: errorMessage,
      latencyMs,
    };
  }
};
