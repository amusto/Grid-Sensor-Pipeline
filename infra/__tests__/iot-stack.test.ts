/**
 * IoT-stack template assertions.
 *
 * Locks the Phase 4 architectural decisions in the synthesized CFN:
 *   - AllTelemetryRule routes `sensors/+/telemetry` to Kinesis with
 *     `${sensorId}` partition key.
 *   - IoT Rules role has Kinesis PutRecord/PutRecords on the stream.
 *   - Simulator Lambda has narrowly-scoped iot:Publish permission on `sensors / * / telemetry` topics only.
 *   - Endpoint discovery custom resource exists.
 *   - ThresholdAlertRule is NOT present (deferred to Phase 5).
 *
**/

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KinesisStack } from '../lib/kinesis-stack';
import { IotStack } from '../lib/iot-stack';

const synth = (): Template => {
  const app = new App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const projectName = 'gsp-test';
  const kinesisStack = new KinesisStack(app, 'Kinesis', { env, projectName });
  const iot = new IotStack(app, 'Iot', {
    env,
    projectName,
    stream: kinesisStack.stream,
  });
  return Template.fromStack(iot);
};

describe('IotStack template', () => {
  describe('AllTelemetryRule', () => {
    it('routes from sensors/+/telemetry to Kinesis', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IoT::TopicRule', {
        TopicRulePayload: Match.objectLike({
          Sql: "SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'",
          AwsIotSqlVersion: '2016-03-23',
          RuleDisabled: false,
          Actions: Match.arrayWith([
            Match.objectLike({
              Kinesis: Match.objectLike({
                PartitionKey: '${sensorId}',
              }),
            }),
          ]),
        }),
      });
    });

    it('does NOT include a ThresholdAlertRule (deferred to Phase 5)', () => {
      const template = synth();
      // Currently expect exactly one IoT rule (telemetry → Kinesis).
      template.resourceCountIs('AWS::IoT::TopicRule', 1);
    });
  });

  describe('IoT Rules role', () => {
    it('grants Kinesis PutRecord/PutRecords via inline policy', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'iot.amazonaws.com' },
            }),
          ]),
        }),
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: 'KinesisWrite',
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith([
                    'kinesis:PutRecord',
                    'kinesis:PutRecords',
                  ]),
                }),
              ]),
            },
          }),
        ]),
      });
    });
  });

  describe('Simulator Lambda', () => {
    it('runs on Node 20', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      });
    });

    it('has X-Ray active tracing', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        TracingConfig: { Mode: 'Active' },
      });
    });

    it('has IOT_ENDPOINT env var injected from the discovery custom resource', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            IOT_ENDPOINT: Match.anyValue(),
            POWERTOOLS_SERVICE_NAME: 'grid-sensor-simulator',
          }),
        },
      });
    });

    it('has iot:Publish scoped to sensors/*/telemetry topics only', () => {
      const template = synth();
      // Inline policy attached to the Lambda's role via addToRolePolicy
      // shows up as an AWS::IAM::Policy resource with a Resource ARN
      // matching the topic pattern. Because the test runs with an
      // explicit env (account+region), CDK resolves the ${this.region}
      // and ${this.account} substitutions at synth time and emits a
      // literal ARN string rather than an Fn::Join.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iot:Publish',
              Resource: Match.stringLikeRegexp(
                'arn:aws:iot:.*:topic/sensors/\\*/telemetry$',
              ),
            }),
          ]),
        }),
      });
    });
  });

  describe('Endpoint discovery custom resource', () => {
    it('exists (resolves IOT_ENDPOINT at deploy time)', () => {
      const template = synth();
      // AwsCustomResource emits a `Custom::AWS` resource type, not
      // `AWS::CloudFormation::CustomResource`. The presence of any
      // `Custom::*` resource confirms the discovery infra was synthed.
      const allResources = template.toJSON().Resources as Record<
        string,
        { Type?: string }
      >;
      const customResources = Object.values(allResources).filter((r) =>
        r.Type?.startsWith('Custom::'),
      );
      expect(customResources.length).toBeGreaterThanOrEqual(1);
    });

    it('grants iot:DescribeEndpoint to the provider Lambda', () => {
      // Belt-and-suspenders: the provider Lambda's policy should have
      // exactly the permission the custom resource calls.
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iot:DescribeEndpoint',
            }),
          ]),
        }),
      });
    });
  });
});
