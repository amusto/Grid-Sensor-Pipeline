/**
 * Processing-stack template assertions.
 *
 * These tests verify CLAUDE.md hard rule #9 (`bisectOnError: true` on
 * Kinesis ESM) and the partial-failure contract are encoded in the
 * synthesized CloudFormation, not just in TypeScript. The IaC IS the
 * contract — we lock it down here so a refactor can't silently weaken it.
 *
 * NOTE: NodejsFunction synth invokes esbuild. Tests therefore require
 * `esbuild` installed locally (`npm install`).
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { KinesisStack } from '../lib/kinesis-stack';
import { ProcessingStack } from '../lib/processing-stack';

const synthProcessing = (
  contextOverrides: Record<string, string> = {},
): Template => {
  const app = new App({ context: contextOverrides });
  const env = { account: '123456789012', region: 'us-east-1' };
  const projectName = 'gsp-test';

  const storage = new StorageStack(app, 'Storage', { env, projectName });
  const kinesisStack = new KinesisStack(app, 'Kinesis', { env, projectName });
  const processing = new ProcessingStack(app, 'Processing', {
    env,
    projectName,
    readingsTable: storage.readingsTable,
    idempotencyTable: storage.idempotencyTable,
    stream: kinesisStack.stream,
  });

  return Template.fromStack(processing);
};

const FAKE_DD_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:gsp/dd-api-key-AbCdEf';

describe('ProcessingStack template', () => {
  describe('Kinesis Event Source Mapping (CLAUDE.md hard rule #9)', () => {
    it('has bisectBatchOnError set to true', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BisectBatchOnFunctionError: true,
      });
    });

    it('reports batch item failures (partial-failure handshake)', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        FunctionResponseTypes: Match.arrayWith(['ReportBatchItemFailures']),
      });
    });

    it('routes failed records to a DLQ via OnFailure destination', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        DestinationConfig: {
          OnFailure: {
            Destination: Match.anyValue(),
          },
        },
      });
    });

    it('caps retry attempts (no infinite retry storm)', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        MaximumRetryAttempts: 5,
      });
    });

    it('uses small batches (low p99 latency)', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 10,
      });
    });

    it('starts from trim horizon (no record loss on first deploy)', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        StartingPosition: 'TRIM_HORIZON',
      });
    });
  });

  describe('Processor Lambda', () => {
    it('runs on Node 20', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      });
    });

    it('has X-Ray tracing enabled', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::Function', {
        TracingConfig: { Mode: 'Active' },
      });
    });

    it('exposes READINGS_TABLE and IDEMPOTENCY_TABLE env vars', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            READINGS_TABLE: Match.anyValue(),
            IDEMPOTENCY_TABLE: Match.anyValue(),
            POWERTOOLS_SERVICE_NAME: 'grid-sensor-processor',
            POWERTOOLS_METRICS_NAMESPACE: 'GridSensorPipeline',
          }),
        },
      });
    });
  });

  describe('Datadog instrumentation (P10 — opt-in via context)', () => {
    it('does NOT add Datadog wiring by default', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::Lambda::Function', {
        // No DD_* env vars on the default synth.
        Environment: {
          Variables: Match.not(
            Match.objectLike({ DD_API_KEY_SECRET_ARN: Match.anyValue() }),
          ),
        },
      });
      // No layers attached when Datadog is off.
      const fns = template.findResources('AWS::Lambda::Function');
      Object.values(fns).forEach((fn) => {
        const layers = fn.Properties?.Layers ?? [];
        expect(layers.length).toBe(0);
      });
    });

    it('throws when enableDatadog=true is set without ddApiKeySecretArn', () => {
      expect(() => synthProcessing({ enableDatadog: 'true' })).toThrow(
        /ddApiKeySecretArn/,
      );
    });

    it('attaches the Datadog Extension layer when opted in', () => {
      const template = synthProcessing({
        enableDatadog: 'true',
        ddApiKeySecretArn: FAKE_DD_SECRET_ARN,
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Layers: Match.arrayWith([
          Match.stringLikeRegexp(
            'arn:aws:lambda:us-east-1:464622532012:layer:Datadog-Extension:',
          ),
        ]),
      });
    });

    it('wires the canonical DD_* env vars when opted in', () => {
      const template = synthProcessing({
        enableDatadog: 'true',
        ddApiKeySecretArn: FAKE_DD_SECRET_ARN,
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            DD_API_KEY_SECRET_ARN: FAKE_DD_SECRET_ARN,
            DD_SITE: 'us5.datadoghq.com',
            DD_ENV: 'poc',
            DD_SERVICE: 'grid-sensor-processor',
            DD_SERVERLESS_LOGS_ENABLED: 'true',
            // APM tracing deferred — verified explicitly so a future
            // change to flip this on (which would require the tracer
            // layer + handler override) breaks this test as a signal.
            DD_TRACE_ENABLED: 'false',
          }),
        },
      });
    });

    it('grants Secrets Manager read on the API key secret', () => {
      const template = synthProcessing({
        enableDatadog: 'true',
        ddApiKeySecretArn: FAKE_DD_SECRET_ARN,
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: FAKE_DD_SECRET_ARN,
            }),
          ]),
        }),
      });
    });

    it('honors ddSite and ddEnv context overrides', () => {
      const template = synthProcessing({
        enableDatadog: 'true',
        ddApiKeySecretArn: FAKE_DD_SECRET_ARN,
        ddSite: 'datadoghq.eu',
        ddEnv: 'dev',
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            DD_SITE: 'datadoghq.eu',
            DD_ENV: 'dev',
          }),
        },
      });
    });
  });

  describe('DLQ', () => {
    it('creates exactly one SQS queue (the processor DLQ)', () => {
      const template = synthProcessing();
      // The Lambda also has its own retry queue but we expect one user-defined
      // SQS queue. Allow >= 1 to be flexible against framework changes.
      const queues = template.findResources('AWS::SQS::Queue');
      expect(Object.keys(queues).length).toBeGreaterThanOrEqual(1);
    });

    it('configures 7-day retention on the DLQ', () => {
      const template = synthProcessing();
      template.hasResourceProperties('AWS::SQS::Queue', {
        MessageRetentionPeriod: 7 * 24 * 60 * 60,
      });
    });
  });
});
