/**
 * Alert workflow stack — Step Functions Standard Workflow + alert handler.
 *
 *   NotifyOps          → invokes alert-handler Lambda (P2 notification)
 *   WaitForAck         → 15 minutes (configurable via context)
 *   IsAcknowledged     → Choice on $.alert.acknowledged
 *     true             → AlertResolved (Succeed)
 *     false            → EscalateToOnCall → AlertResolved
 *
 * Standard Workflow per CLAUDE.md hard rule #10: 90-day execution
 * history retention, free Wait state, per-step retry. See
 * `docs/decisions/phase-05-alert-workflow.md` for the full rationale.
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface AlertWorkflowStackProps extends cdk.StackProps {
  projectName: string;
  /**
   * Acknowledgment wait window. Defaults to 15 minutes (per CLAUDE.md);
   * tests / dev runs can override with `cdk deploy -c ackWaitMinutes=1`.
   */
  ackWaitMinutes?: number;
}

export class AlertWorkflowStack extends cdk.Stack {
  public readonly stateMachine: sfn.IStateMachine;
  /**
   * State machine name as a literal string. Exposed separately because
   * newer aws-cdk-lib versions removed `stateMachineName` from the
   * `IStateMachine` interface (it now lives only on the concrete
   * `StateMachine` class). The IoT rule's stepFunctions action needs
   * the name as a string, not the ARN.
   */
  public readonly stateMachineName: string;
  public readonly alertHandler: lambda.IFunction;
  public readonly alertTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: AlertWorkflowStackProps) {
    super(scope, id, props);

    const ackWaitMinutes =
      this.node.tryGetContext('ackWaitMinutes') ??
      props.ackWaitMinutes ??
      15;

    /**
     * SNS topic — notification fan-out target. No subscriptions in
     * code (per decision log P5 pre-flight 5); add via console or a
     * separate stack when an on-call rotation exists.
     */
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${props.projectName}-alerts`,
      displayName: 'Grid Sensor Alert Notifications',
    });

    /**
     * Alert handler Lambda log group — explicit per the P3 lesson.
     */
    const alertHandlerLogGroup = new logs.LogGroup(
      this,
      'AlertHandlerLogGroup',
      {
        logGroupName: `/aws/lambda/${props.projectName}-alert-handler`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    /**
     * Alert handler Lambda — handles both NotifyOps and
     * EscalateToOnCall. Differentiation by `escalated: true` flag on
     * input.
     */
    const alertHandler = new nodejs.NodejsFunction(this, 'AlertHandler', {
      functionName: `${props.projectName}-alert-handler`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../src/handlers/alert-handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: alertHandlerLogGroup,
      environment: {
        ALERT_TOPIC_ARN: alertTopic.topicArn,
        POWERTOOLS_SERVICE_NAME: 'grid-sensor-alert-handler',
        POWERTOOLS_METRICS_NAMESPACE: 'GridSensorPipeline',
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

    alertTopic.grantPublish(alertHandler);

    /**
     * State machine definition.
     *
     * NotifyOps' result is selected to expose only `acknowledged` at
     * `$.alert.acknowledged` so the Choice state can read it cleanly.
     * MVP handler always returns `acknowledged: false`; the choice
     * therefore always routes to escalation. See decision log P5
     * pre-flight 3 for the production extension path.
     */
    const notifyOps = new tasks.LambdaInvoke(this, 'NotifyOps', {
      lambdaFunction: alertHandler,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultSelector: {
        'acknowledged.$': '$.Payload.acknowledged',
      },
      resultPath: '$.alert',
    });

    const waitForAck = new sfn.Wait(this, 'WaitForAck', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(ackWaitMinutes)),
    });

    /**
     * Escalate invokes the same Lambda with an `escalated: true` flag
     * and the original event under `context`. The handler picks up
     * the flag and emits a P1 SNS notification.
     */
    const escalate = new tasks.LambdaInvoke(this, 'EscalateToOnCall', {
      lambdaFunction: alertHandler,
      payload: sfn.TaskInput.fromObject({
        escalated: true,
        context: sfn.JsonPath.entirePayload,
      }),
      resultPath: '$.escalateResult',
    });

    const resolved = new sfn.Succeed(this, 'AlertResolved');

    const isAcknowledged = new sfn.Choice(this, 'IsAcknowledged')
      .when(
        sfn.Condition.booleanEquals('$.alert.acknowledged', true),
        resolved,
      )
      .otherwise(escalate.next(resolved));

    const definition = notifyOps.next(waitForAck).next(isAcknowledged);

    const stateMachineLogGroup = new logs.LogGroup(
      this,
      'StateMachineLogGroup',
      {
        logGroupName: `/aws/stepfunctions/${props.projectName}-alert-workflow`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const stateMachineName = `${props.projectName}-alert-workflow`;
    const stateMachine = new sfn.StateMachine(this, 'AlertWorkflow', {
      stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    this.stateMachine = stateMachine;
    this.stateMachineName = stateMachineName;
    this.alertHandler = alertHandler;
    this.alertTopic = alertTopic;

    new cdk.CfnOutput(this, 'AlertWorkflowArn', {
      value: stateMachine.stateMachineArn,
      description: 'Alert workflow state machine ARN',
      exportName: `${props.projectName}-alert-workflow-arn`,
    });
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'Alert SNS topic ARN',
      exportName: `${props.projectName}-alert-topic-arn`,
    });
    new cdk.CfnOutput(this, 'AlertHandlerFunctionName', {
      value: alertHandler.functionName,
      description: 'Alert handler Lambda function name',
      exportName: `${props.projectName}-alert-handler`,
    });
  }
}
