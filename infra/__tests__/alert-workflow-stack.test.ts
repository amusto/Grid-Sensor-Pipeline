/**
 * Alert workflow stack template assertions.
 *
 * Locks the Phase 5 architectural decisions in the synthesized CFN:
 *   - State machine is Standard (CLAUDE.md hard rule #10), not Express.
 *   - X-Ray tracing on; logging on with ALL level for audit.
 *   - SNS topic exists; alert handler can publish to it.
 *   - Alert handler is Node 20 with active tracing.
 */

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { AlertWorkflowStack } from '../lib/alert-workflow-stack';

/**
 * Build a fake cases table reference for tests. The real cases table
 * comes from StorageStack at app composition time; here we synthesize
 * a sibling stack with a minimal table just so the AlertWorkflowStack
 * has a real `dynamodb.ITable` to grant against.
 */
const synth = (
  contextOverrides: Record<string, string> = {},
): Template => {
  const app = new App({ context: contextOverrides });
  const fakeStorage = new Stack(app, 'FakeStorage', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const casesTable = new dynamodb.Table(fakeStorage, 'FakeCasesTable', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  const stack = new AlertWorkflowStack(app, 'AlertWorkflow', {
    env: { account: '123456789012', region: 'us-east-1' },
    projectName: 'gsp-test',
    casesTable,
  });
  return Template.fromStack(stack);
};

describe('AlertWorkflowStack template', () => {
  describe('State machine (CLAUDE.md hard rule #10)', () => {
    it('is a Standard Workflow, not Express', () => {
      const template = synth();
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
    });

    it('has X-Ray tracing enabled (audit trail)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        TracingConfiguration: { Enabled: true },
      });
    });

    it('logs at ALL level with execution data (audit trail)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        LoggingConfiguration: Match.objectLike({
          Level: 'ALL',
          IncludeExecutionData: true,
        }),
      });
    });
  });

  describe('Alert handler Lambda', () => {
    it('runs on Node 20 with active X-Ray tracing', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        TracingConfig: { Mode: 'Active' },
      });
    });

    it('exposes ALERT_TOPIC_ARN env var', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ALERT_TOPIC_ARN: Match.anyValue(),
            POWERTOOLS_SERVICE_NAME: 'grid-sensor-alert-handler',
          }),
        },
      });
    });

    it('exposes CASES_TABLE_NAME env var (P9.4 — dispatcher consumes this)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            CASES_TABLE_NAME: Match.anyValue(),
          }),
        },
      });
    });

    it('exposes BEDROCK_MODEL_ID env var (P8.1 — single source of truth with the IAM grant)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            // Holds the inference profile ID (current Sonnet on Bedrock
            // ships behind cross-region profiles). Var name is unchanged
            // because InvokeModel's `modelId` parameter accepts either form.
            BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
          }),
        },
      });
    });
  });

  describe('Bedrock IAM grant (P8.1, phase-08 pre-flight 7)', () => {
    it('grants bedrock:InvokeModel scoped to BOTH the inference profile and underlying foundation model', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'bedrock:InvokeModel',
              Effect: 'Allow',
              // Inference profile ARN includes account-id slot;
              // foundation-model ARN has empty account slot and `*`
              // region because the profile routes cross-region.
              Resource: [
                'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
              ],
            }),
          ]),
        }),
      });
    });

    it('does NOT grant any wildcard bedrock:* permissions', () => {
      const template = synth();
      const policies = template.findResources('AWS::IAM::Policy');
      Object.values(policies).forEach((policy) => {
        const statements: Array<{ Action?: string | string[] }> =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        statements.forEach((s) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          actions.forEach((a) => {
            if (typeof a === 'string' && a.startsWith('bedrock:')) {
              expect(a).toBe('bedrock:InvokeModel');
            }
          });
        });
      });
    });
  });

  describe('SNS topic', () => {
    it('exists with the expected name pattern', () => {
      const template = synth();
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'gsp-test-alerts',
      });
    });

    it('grants publish permission to the alert handler role', () => {
      const template = synth();
      // The grant emits an inline policy on the handler's role.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sns:Publish',
            }),
          ]),
        }),
      });
    });
  });

  describe('Cases table grant (P9.4 — dispatcher idempotency)', () => {
    it('grants read+write DynamoDB actions on the alert handler role', () => {
      const template = synth();
      // The grant emits an inline policy on the handler's role with the
      // CDK standard read+write action set for DynamoDB. The
      // hasResourceProperties matcher struggles with the multi-statement
      // policy shape (Bedrock + SNS + DynamoDB + XRay all stacked), so
      // walk the policies manually and assert that at least one statement
      // contains DynamoDB read+write actions.
      const policies = template.findResources('AWS::IAM::Policy');

      const writeActions = ['dynamodb:PutItem', 'dynamodb:UpdateItem'];
      const readActions = ['dynamodb:GetItem', 'dynamodb:Query'];

      const grantsAllActions = Object.values(policies).some((policy) => {
        const statements: Array<{ Action?: string | string[] }> =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        return statements.some((s) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            writeActions.every((a) => actions.includes(a)) &&
            readActions.every((a) => actions.includes(a))
          );
        });
      });

      expect(grantsAllActions).toBe(true);
    });
  });

  describe('Email subscription (P9.2 — Option B)', () => {
    it('wires an EmailSubscription with the default recipient', () => {
      const template = synth();
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'armando.musto+alertreported@gmail.com',
      });
    });

    it('honors the alertEmail CDK context override', () => {
      const app = new App({
        context: { alertEmail: 'custom-recipient@example.com' },
      });
      const fakeStorage = new Stack(app, 'FakeStorage', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const casesTable = new dynamodb.Table(fakeStorage, 'FakeCasesTable', {
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      });
      const stack = new AlertWorkflowStack(app, 'AlertWorkflow', {
        env: { account: '123456789012', region: 'us-east-1' },
        projectName: 'gsp-test',
        casesTable,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'custom-recipient@example.com',
      });
    });

    it('exposes the recipient via the AlertEmailRecipient CFN output', () => {
      const template = synth();
      template.hasOutput('AlertEmailRecipient', {
        Export: { Name: 'gsp-test-alert-email-recipient' },
      });
    });
  });

  describe('Datadog instrumentation (P10 — opt-in via context)', () => {
    const FAKE_DD_SECRET_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:gsp/dd-api-key-AbCdEf';

    it('does NOT add Datadog wiring by default', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.not(
            Match.objectLike({ DD_API_KEY_SECRET_ARN: Match.anyValue() }),
          ),
        },
      });
    });

    it('throws when enableDatadog=true is set without ddApiKeySecretArn', () => {
      expect(() => synth({ enableDatadog: 'true' })).toThrow(
        /ddApiKeySecretArn/,
      );
    });

    it('attaches the Datadog Extension layer when opted in', () => {
      const template = synth({
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
      const template = synth({
        enableDatadog: 'true',
        ddApiKeySecretArn: FAKE_DD_SECRET_ARN,
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            DD_API_KEY_SECRET_ARN: FAKE_DD_SECRET_ARN,
            DD_SITE: 'us5.datadoghq.com',
            DD_ENV: 'poc',
            DD_SERVICE: 'grid-sensor-alert-handler',
            DD_SERVERLESS_LOGS_ENABLED: 'true',
            DD_TRACE_ENABLED: 'false',
          }),
        },
      });
    });

    it('grants Secrets Manager read on the API key secret', () => {
      const template = synth({
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
  });

  describe('Stack outputs', () => {
    it('exports the state machine ARN for cross-stack reference', () => {
      const template = synth();
      template.hasOutput('AlertWorkflowArn', {
        Export: { Name: 'gsp-test-alert-workflow-arn' },
      });
    });

    it('exports the alert topic ARN for runtime subscription helpers', () => {
      const template = synth();
      template.hasOutput('AlertTopicArn', {
        Export: { Name: 'gsp-test-alert-topic-arn' },
      });
    });
  });
});
