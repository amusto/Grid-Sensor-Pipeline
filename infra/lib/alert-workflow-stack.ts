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
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

/**
 * Bedrock model identifier used by the LangGraph alert flow.
 *
 * NOTE — this constant holds a **cross-region inference profile ID**,
 * not a bare foundation-model ID. AWS migrated current-generation
 * Anthropic models on Bedrock behind inference profiles (Sonnet 4.6
 * onward); calling `InvokeModel` with the bare foundation-model ID
 * returns `ValidationException: ... isn't supported with on-demand
 * throughput. Retry your request with the ID or ARN of an inference
 * profile that contains this model.` The `InvokeModel` API parameter
 * is still called `modelId` in either case, which is why the env-var
 * name `BEDROCK_MODEL_ID` is still accurate.
 *
 * `us.` prefix = US-region inference profile (routes among US regions
 * only). Chosen over `global.` for data-residency conservatism on a
 * US grid telemetry workload.
 *
 * The IAM grant below is resource-scoped to BOTH the profile ARN AND
 * the underlying foundation-model ARN — the profile call internally
 * dispatches to the foundation model in whichever US region it picks,
 * so the principal needs permission on both. Wildcards rejected per
 * `phase-08-ai-ml-integration.md` pre-flight 7.
 *
 * The handler reads `BEDROCK_MODEL_ID` from env so the LangChain
 * client and the IAM grant can never drift apart silently.
 */
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

/**
 * The foundation model ID that the inference profile resolves to.
 * Used only to construct the foundation-model ARN in the IAM grant
 * below; the application never calls this ID directly.
 */
const BEDROCK_UNDERLYING_MODEL = 'anthropic.claude-sonnet-4-6';

export interface AlertWorkflowStackProps extends cdk.StackProps {
  projectName: string;
  /**
   * Acknowledgment wait window. Defaults to 15 minutes (per CLAUDE.md);
   * tests / dev runs can override with `cdk deploy -c ackWaitMinutes=1`.
   */
  ackWaitMinutes?: number;
  /**
   * Default email recipient subscribed to the alert SNS topic at
   * deploy time. P9.2 — the one real channel for the case-routing
   * layer. Additional viewers can be added ad-hoc at runtime via
   * `scripts/add-demo-recipient.sh` without redeploying.
   *
   * Resolution order: CDK context (`alertEmail`) → this prop →
   * the documented default below. Override at deploy time with
   * `cdk deploy -c alertEmail=someone@example.com`.
   */
  alertEmail?: string;
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
     * Default email recipient for the alert topic. Resolution order:
     *   1. CDK context `alertEmail` (e.g., `cdk deploy -c alertEmail=...`)
     *   2. Stack prop `alertEmail` (programmatic instantiation)
     *   3. Documented default — Armando's Gmail+alias.
     *
     * Ad-hoc demo viewers add their own addresses at runtime via
     * `scripts/add-demo-recipient.sh` — SNS topics accept new
     * subscriptions any time, independent of CDK.
     */
    const alertEmail: string =
      this.node.tryGetContext('alertEmail') ??
      props.alertEmail ??
      'armando.musto+alertreported@gmail.com';

    /**
     * SNS topic — notification fan-out target.
     *
     * P9.2 — one `EmailSubscription` is wired at deploy time so the
     * topic has a working default recipient on first apply. The P5
     * decision log originally said "no subscriptions in code"; that
     * call was revisited on 2026-05-13 when verification showed the
     * SNS topic existed but no subscription was ever wired, making
     * the "email already works" assumption from the original Phase 9
     * design log misleading. See `docs/decisions/phase-09-agentic-case-routing.md`
     * Scope simplification + pre-flight 1.
     *
     * Additional viewers are added at runtime (no redeploy) via
     * `scripts/add-demo-recipient.sh`. CDK manages the topic;
     * subscriptions are operational.
     */
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${props.projectName}-alerts`,
      displayName: 'Grid Sensor Alert Notifications',
    });

    alertTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(alertEmail),
    );

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
        BEDROCK_MODEL_ID,
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
     * P8.1 — Bedrock IAM grant for the cross-region inference profile.
     *
     * Two ARNs are required because invoking an inference profile
     * dispatches to one of N underlying foundation-model invocations
     * (the profile chooses the region at call time). The principal
     * needs permission on both:
     *
     *  1. Inference-profile ARN — has an account-id slot:
     *       `arn:aws:bedrock:<region>:<account>:inference-profile/<profileId>`
     *
     *  2. Foundation-model ARN — has an EMPTY account-id slot
     *     (foundation models are AWS-managed, not per-account):
     *       `arn:aws:bedrock:*::foundation-model/<modelId>`
     *     Region is `*` because the profile may route to any US region.
     *
     * Wildcard `bedrock:*` grant rejected — would also allow
     * `CreateModel` / `DeleteModel` / etc. Decision rationale in
     * `docs/decisions/phase-08-ai-ml-integration.md` pre-flight 7.
     */
    const inferenceProfileArn = `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/${BEDROCK_MODEL_ID}`;
    const foundationModelArn = `arn:aws:bedrock:*::foundation-model/${BEDROCK_UNDERLYING_MODEL}`;
    alertHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeClaudeSonnetViaInferenceProfile',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [inferenceProfileArn, foundationModelArn],
      }),
    );

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

    new cdk.CfnOutput(this, 'AlertEmailRecipient', {
      value: alertEmail,
      description:
        'Default email recipient subscribed to the alert topic. ' +
        'Additional viewers added at runtime via ' +
        'scripts/add-demo-recipient.sh do not appear here.',
      exportName: `${props.projectName}-alert-email-recipient`,
    });
  }
}
