/**
 * Alert workflow stack template assertions.
 *
 * Locks the Phase 5 architectural decisions in the synthesized CFN:
 *   - State machine is Standard (CLAUDE.md hard rule #10), not Express.
 *   - X-Ray tracing on; logging on with ALL level for audit.
 *   - SNS topic exists; alert handler can publish to it.
 *   - Alert handler is Node 20 with active tracing.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlertWorkflowStack } from '../lib/alert-workflow-stack';

const synth = (): Template => {
  const app = new App();
  const stack = new AlertWorkflowStack(app, 'AlertWorkflow', {
    env: { account: '123456789012', region: 'us-east-1' },
    projectName: 'gsp-test',
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

  describe('Stack outputs', () => {
    it('exports the state machine ARN for cross-stack reference', () => {
      const template = synth();
      template.hasOutput('AlertWorkflowArn', {
        Export: { Name: 'gsp-test-alert-workflow-arn' },
      });
    });
  });
});
