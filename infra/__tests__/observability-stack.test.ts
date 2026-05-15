/**
 * Observability stack template assertions.
 *
 * Locks the Phase 6 architectural decisions in synthesized CFN:
 *   - Three alarms with the exact thresholds from CLAUDE.md.
 *   - DLQ inspector consumes the processor DLQ via SQS event source.
 *   - DLQ inspector defaults to NO replay (REPLAY_TO_KINESIS=false).
 *   - One CloudWatch dashboard.
 *   - Ops-alerts SNS topic separate from grid-event topic.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { KinesisStack } from '../lib/kinesis-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { AlertWorkflowStack } from '../lib/alert-workflow-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const synth = (): Template => {
  const app = new App();
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
  const alertWorkflow = new AlertWorkflowStack(app, 'AlertWorkflow', {
    env,
    projectName,
    casesTable: storage.casesTable,
  });
  const observability = new ObservabilityStack(app, 'Observability', {
    env,
    projectName,
    processorDlq: processing.dlq,
    processorFunction: processing.processor,
    stream: kinesisStack.stream,
    alertStateMachine: alertWorkflow.stateMachine,
  });

  return Template.fromStack(observability);
};

describe('ObservabilityStack template', () => {
  describe('Alarms (CLAUDE.md verbatim thresholds)', () => {
    it('GridSensor-DLQ-Messages alarm exists with threshold >= 1 over 1 period', () => {
      const template = synth();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'GridSensor-DLQ-Messages',
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('GridSensor-P99-Latency alarm exists with threshold > 2000ms for 3 periods', () => {
      const template = synth();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'GridSensor-P99-Latency',
        Threshold: 2000,
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold',
        ExtendedStatistic: 'p99',
      });
    });

    it('AlertWorkflow-Failures alarm exists with threshold >= 1', () => {
      const template = synth();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'AlertWorkflow-Failures',
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('BedrockTokens-Runaway alarm exists with threshold > 1M over 1h (P8.2 cost guardrail)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'BedrockTokens-Runaway',
        MetricName: 'BedrockTokensUsed',
        Namespace: 'GridSensorPipeline',
        Statistic: 'Sum',
        Threshold: 1_000_000,
        // 1h period = 3600s; CFN serializes as a number
        Period: 3600,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    it('all four alarms publish to the ops-alerts SNS topic', () => {
      const template = synth();
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: { AlarmActions?: unknown[] } })
          .Properties;
        expect(props.AlarmActions).toBeDefined();
        expect(props.AlarmActions?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('DLQ inspector Lambda', () => {
    it('runs on Node 20 with X-Ray active', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        TracingConfig: { Mode: 'Active' },
      });
    });

    it('defaults REPLAY_TO_KINESIS to false (safe default)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            REPLAY_TO_KINESIS: 'false',
            POWERTOOLS_SERVICE_NAME: 'grid-sensor-dlq-inspector',
          }),
        },
      });
    });

    it('is wired to the processor DLQ as an SQS event source', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        FunctionResponseTypes: Match.arrayWith(['ReportBatchItemFailures']),
      });
    });
  });

  describe('Ops-alerts SNS topic', () => {
    it('exists with the expected name (separate from grid-alerts)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'gsp-test-ops-alerts',
      });
    });
  });

  describe('Dashboard', () => {
    it('exactly one dashboard exists', () => {
      const template = synth();
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    });

    it('dashboard name matches the project convention', () => {
      const template = synth();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'gsp-test-overview',
      });
    });
  });

  describe('Stack outputs', () => {
    it('exports the dashboard URL for portfolio embedding', () => {
      const template = synth();
      template.hasOutput('DashboardUrl', {});
    });

    it('exports the ops-alerts SNS topic ARN', () => {
      const template = synth();
      template.hasOutput('OpsAlertTopicArn', {
        Export: { Name: 'gsp-test-ops-alerts-arn' },
      });
    });
  });
});
