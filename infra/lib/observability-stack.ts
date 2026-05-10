/**
 * Observability stack — DLQ inspector + CloudWatch dashboard + alarms.
 *
 * The visibility layer over P1-P5. Composes the EMF metrics already
 * emitted by the processor, simulator, and alert handler into a single
 * dashboard URL plus three alarms (DLQ depth, P99 latency, alert
 * workflow failures).
 *
 * Per `docs/decisions/phase-06-dlq-observability.md`:
 *   - One stack, one dashboard URL.
 *   - Alarm thresholds verbatim from CLAUDE.md.
 *   - Separate ops-alerts SNS topic (different audience than P5's
 *     grid-event topic).
 *   - DLQ inspector logs + alerts; no auto-replay by default.
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  projectName: string;
  /** The processor's DLQ — created in ProcessingStack. */
  processorDlq: sqs.IQueue;
  /** The processor Lambda — for log group reference / function name in widgets. */
  processorFunction: lambda.IFunction;
  /** The Kinesis stream — used by DLQ inspector if replay is enabled. */
  stream: kinesis.IStream;
  /** Alert workflow state machine — for failure-count alarm. */
  alertStateMachine: sfn.IStateMachine;
}

const NAMESPACE = 'GridSensorPipeline';

/**
 * Powertools emits every metric with `service` as a default dimension
 * (set from POWERTOOLS_SERVICE_NAME). Per-record metrics also carry
 * `ReadingType` via `singleMetric()`. Dashboard widgets must therefore
 * query at the matching dimension set — querying without dimensions
 * returns no data because no metric stream is stored at the dimensionless
 * level.
 *
 * The service-name constants below come from the env vars set in each
 * Lambda's CDK definition (`POWERTOOLS_SERVICE_NAME`). Keep them in
 * lockstep with the runtime side — this is one of the typed-model
 * pitfalls documented in `docs/learning/cdk-as-typed-model.md`.
 */
const SERVICE_PROCESSOR = 'grid-sensor-processor';
const SERVICE_DLQ_INSPECTOR = 'grid-sensor-dlq-inspector';
const SERVICE_ALERT_HANDLER = 'grid-sensor-alert-handler';
// Alert handler emits AlertsNotified / AlertsEscalated with a ReadingType
// dimension (queried via SEARCH below). Bedrock metrics — emitted by
// `lib/llm-client.ts` from inside the alert handler — carry only the
// default `service` dimension, which is why `SERVICE_ALERT_HANDLER` is
// needed for the runaway-cost alarm.

/**
 * Build a `cloudwatch.Metric` for a plain (non-ReadingType-dimensioned)
 * metric. Powertools' default `service` dimension is required to find
 * the data.
 */
const plainMetric = (
  metricName: string,
  service: string,
  statistic: string = 'Sum',
): cloudwatch.IMetric =>
  new cloudwatch.Metric({
    namespace: NAMESPACE,
    metricName,
    statistic,
    period: cdk.Duration.minutes(1),
    dimensionsMap: { service },
  });

/**
 * Build a `MathExpression` that aggregates a ReadingType-dimensioned
 * metric across all readingType values via SEARCH. Returns a single
 * time series — the sum / percentile across all reading types.
 */
const aggregatedMetric = (
  metricName: string,
  label: string,
  statistic: string,
): cloudwatch.IMetric =>
  new cloudwatch.MathExpression({
    expression: `SUM(SEARCH('{${NAMESPACE},service,ReadingType} MetricName="${metricName}"', '${statistic}', 60))`,
    label,
    period: cdk.Duration.minutes(1),
  });

/**
 * Same as `aggregatedMetric` but for percentile statistics where SUM-of-
 * percentiles isn't meaningful — uses MAX as the cross-ReadingType
 * aggregator (worst-case latency observed in any reading type).
 */
const worstCaseLatency = (
  percentile: 'p50' | 'p95' | 'p99',
  label: string,
): cloudwatch.IMetric =>
  new cloudwatch.MathExpression({
    expression: `MAX(SEARCH('{${NAMESPACE},service,ReadingType} MetricName="ProcessingLatencyMs"', '${percentile}', 60))`,
    label,
    period: cdk.Duration.minutes(1),
  });

export class ObservabilityStack extends cdk.Stack {
  public readonly opsAlertTopic: sns.ITopic;
  public readonly dlqInspector: lambda.IFunction;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    /**
     * Ops-alerts SNS topic — distinct from P5's grid-event topic.
     * Different audience, different runbook, different SLA.
     */
    const opsAlertTopic = new sns.Topic(this, 'OpsAlertTopic', {
      topicName: `${props.projectName}-ops-alerts`,
      displayName: 'Grid Sensor Pipeline Ops Alerts',
    });

    /**
     * DLQ inspector log group — explicit per the P3 lesson.
     */
    const inspectorLogGroup = new logs.LogGroup(this, 'DlqInspectorLogGroup', {
      logGroupName: `/aws/lambda/${props.projectName}-dlq-inspector`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * DLQ inspector Lambda — consumes the processor's DLQ.
     * Auto-replay is opt-in via `REPLAY_TO_KINESIS=true` env var; the
     * default is log + alert + metric only.
     */
    const dlqInspector = new nodejs.NodejsFunction(this, 'DlqInspector', {
      functionName: `${props.projectName}-dlq-inspector`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../src/handlers/dlq-inspector.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: inspectorLogGroup,
      environment: {
        OPS_ALERT_TOPIC_ARN: opsAlertTopic.topicArn,
        // KINESIS_STREAM_NAME removed — replay-to-Kinesis is not yet
        // implemented in dlq-inspector.ts. When replay ships as its
        // own sub-phase (logged warning becomes real `PutRecordCommand`
        // call), this env var goes back here AND
        // `props.stream.grantWrite(inspector)` needs to be added below
        // so the inspector can write to the stream.
        // Default OFF — see docs/decisions/phase-06-dlq-observability.md
        REPLAY_TO_KINESIS: 'false',
        POWERTOOLS_SERVICE_NAME: 'grid-sensor-dlq-inspector',
        POWERTOOLS_METRICS_NAMESPACE: NAMESPACE,
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
        format: nodejs.OutputFormat.CJS,
      },
    });

    opsAlertTopic.grantPublish(dlqInspector);
    props.processorDlq.grantConsumeMessages(dlqInspector);
    // Read-only Kinesis for the (currently unimplemented) replay path.
    props.stream.grantRead(dlqInspector);

    dlqInspector.addEventSource(
      new eventsources.SqsEventSource(props.processorDlq, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    /**
     * Three alarms — verbatim thresholds from CLAUDE.md observability
     * section.
     */

    // 1. DLQ depth ≥ 1 over 1 minute
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `GridSensor-DLQ-Messages`,
      alarmDescription:
        'Processor DLQ has at least one record. Any DLQ message indicates a record exhausted the ESM retry budget.',
      metric: props.processorDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqDepthAlarm.addAlarmAction(new cwActions.SnsAction(opsAlertTopic));

    // 2. ProcessingLatencyMs p99 > 2000ms for 3 consecutive minutes
    // Note: alarm queries the metric WITH the service+ReadingType dimensions
    // since that's where Powertools emits it. Alarms can target a single
    // metric stream; here we alarm on `voltage` as the canary reading type.
    // Production hardening: alarm on each ReadingType separately, or use a
    // composite alarm that ORs across all reading types.
    const p99LatencyAlarm = new cloudwatch.Alarm(this, 'P99LatencyAlarm', {
      alarmName: 'GridSensor-P99-Latency',
      alarmDescription:
        'Processor p99 latency exceeded 2000ms for 3 consecutive minutes (voltage canary). Investigate Lambda cold starts, DynamoDB throttling, or downstream slowness.',
      metric: new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: 'ProcessingLatencyMs',
        statistic: 'p99',
        period: cdk.Duration.minutes(1),
        dimensionsMap: {
          service: SERVICE_PROCESSOR,
          ReadingType: 'voltage',
        },
      }),
      threshold: 2000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    p99LatencyAlarm.addAlarmAction(new cwActions.SnsAction(opsAlertTopic));

    // 3. Step Functions ExecutionsFailed ≥ 1 over 1 minute
    const sfFailuresAlarm = new cloudwatch.Alarm(this, 'AlertWorkflowFailures', {
      alarmName: 'AlertWorkflow-Failures',
      alarmDescription:
        'Alert workflow had at least one failed execution. A failed alert workflow means an alert did not propagate. Safety-critical.',
      metric: props.alertStateMachine.metricFailed({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sfFailuresAlarm.addAlarmAction(new cwActions.SnsAction(opsAlertTopic));

    // 4. BedrockTokensUsed runaway — added P8.2.
    //
    // Why this alarm exists: a malformed-output bug in a LangGraph
    // node could trigger LangChain's parse-failure retry path. We've
    // capped retries at 1 in `lib/llm-client.ts` to bound the spiral,
    // but a stuck loop at the *graph* layer (e.g., a node that hands
    // off to itself on a bad parse) could still 10× the bill in an
    // afternoon. This alarm fires before the credit-card surprise.
    //
    // Threshold rationale (1,000,000 tokens / 60-min window):
    //   - At Sonnet 4.6 rates (~$3 in / $15 out per MTok) and a
    //     pessimistic 50/50 input/output split, 1M tokens ≈ $9. That's
    //     the "stop and look" threshold — well above any realistic
    //     normal-traffic burst (a few alerts/hour × ~1k tokens each =
    //     under 10k/hr nominally), well below "I just lost a meaningful
    //     amount of money."
    //   - Window of 60 min instead of 1 min: looking for sustained
    //     spend, not a single chatty invocation. A 60-second alarm
    //     would flap on any one batch of test invocations.
    //   - Statistic: `Sum`. Tokens aren't averageable.
    //
    // Re-evaluate this threshold if:
    //   1. Production alert volume rises by 10×+ (legitimate traffic
    //      starts breaching the alarm).
    //   2. The model is swapped to a higher-cost tier (Opus) — the
    //      dollar impact at 1M tokens shifts.
    //   3. The retry cap in `lib/llm-client.ts` is bumped above 1.
    const bedrockRunawayAlarm = new cloudwatch.Alarm(this, 'BedrockTokensRunawayAlarm', {
      alarmName: 'BedrockTokens-Runaway',
      alarmDescription:
        'Bedrock token usage exceeded 1M tokens in a 60-minute window. Either alert volume jumped, a LangGraph node is in a parse-retry loop, or a prompt is over-stuffed. Inspect lib/llm-client.ts retry caps and recent alert handler logs.',
      metric: new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: 'BedrockTokensUsed',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
        dimensionsMap: { service: SERVICE_ALERT_HANDLER },
      }),
      threshold: 1_000_000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    bedrockRunawayAlarm.addAlarmAction(new cwActions.SnsAction(opsAlertTopic));

    /**
     * CloudWatch dashboard. One URL, all primary signals.
     *
     * Widgets read EMF metrics directly from the GridSensorPipeline
     * namespace — no Logs Insights queries (per P6 pre-flight 6).
     *
     * Each metric below uses one of three patterns:
     *   - `plainMetric(name, service)`: for metrics emitted at
     *     (service) only — no ReadingType dimension.
     *   - `aggregatedMetric(name, label, stat)`: for metrics emitted at
     *     (service, ReadingType) — sums across all ReadingTypes via
     *     SEARCH expression so the dashboard shows one aggregated line.
     *   - `worstCaseLatency(percentile, label)`: percentile aggregation
     *     where SUM-across-dimensions isn't meaningful; takes MAX
     *     (worst-case-observed) instead.
     */
    const eventsProcessedMetric = aggregatedMetric(
      'EventsProcessed',
      'Events processed',
      'Sum',
    );

    const validationErrorsMetric = plainMetric(
      'ValidationErrors',
      SERVICE_PROCESSOR,
    );

    const partialBatchFailuresMetric = plainMetric(
      'PartialBatchFailures',
      SERVICE_PROCESSOR,
    );

    const duplicateWritesMetric = plainMetric(
      'DuplicateWrites',
      SERVICE_PROCESSOR,
    );

    const dlqMessagesMetric = plainMetric(
      'DlqMessagesReceived',
      SERVICE_DLQ_INSPECTOR,
    );

    const alertsNotifiedMetric = aggregatedMetric(
      'AlertsNotified',
      'Notified',
      'Sum',
    );

    const alertsEscalatedMetric = aggregatedMetric(
      'AlertsEscalated',
      'Escalated',
      'Sum',
    );

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.projectName}-overview`,
      defaultInterval: cdk.Duration.hours(1),
    });

    dashboard.addWidgets(
      // Row 1 — pipeline throughput
      new cloudwatch.GraphWidget({
        title: 'Events processed (per minute)',
        left: [eventsProcessedMetric],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Processing latency — worst-case across reading types (p50/p95/p99)',
        left: [
          worstCaseLatency('p50', 'p50'),
          worstCaseLatency('p95', 'p95'),
          worstCaseLatency('p99', 'p99'),
        ],
        leftYAxis: { label: 'ms', showUnits: false },
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      // Row 2 — failure modes
      new cloudwatch.GraphWidget({
        title: 'Validation errors',
        left: [validationErrorsMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Partial batch failures',
        left: [partialBatchFailuresMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Duplicate writes (idempotency)',
        left: [duplicateWritesMetric],
        width: 8,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      // Row 3 — DLQ + alert pipeline
      new cloudwatch.SingleValueWidget({
        title: 'DLQ depth (current)',
        metrics: [
          props.processorDlq.metricApproximateNumberOfMessagesVisible({
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
          }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DLQ messages received',
        left: [dlqMessagesMetric],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Alerts notified vs escalated',
        left: [alertsNotifiedMetric, alertsEscalatedMetric],
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      // Row 4 — Step Functions
      new cloudwatch.GraphWidget({
        title: 'Alert workflow executions',
        left: [
          props.alertStateMachine.metricStarted({
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Started',
          }),
          props.alertStateMachine.metricSucceeded({
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Succeeded',
          }),
          props.alertStateMachine.metricFailed({
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Failed',
          }),
        ],
        width: 24,
        height: 6,
      }),
    );

    this.opsAlertTopic = opsAlertTopic;
    this.dlqInspector = dlqInspector;
    this.dashboard = dashboard;

    new cdk.CfnOutput(this, 'OpsAlertTopicArn', {
      value: opsAlertTopic.topicArn,
      description: 'Ops-alerts SNS topic ARN',
      exportName: `${props.projectName}-ops-alerts-arn`,
    });
    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch dashboard name',
      exportName: `${props.projectName}-dashboard-name`,
    });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
      description: 'Direct URL to the CloudWatch dashboard',
    });
  }
}
