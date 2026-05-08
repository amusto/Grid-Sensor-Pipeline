/**
 * IoT stack — IoT Rules engine + simulator Lambda.
 *
 * Per `docs/decisions/phase-04-iot-simulator.md`:
 *   - No device certificates (POC simulator uses IAM-authorized HTTPS
 *     publishes via the Data Plane SDK; Fleet Provisioning is the
 *     production migration path).
 *   - Simulator's IAM policy uses per-Thing topic wildcards so the
 *     access pattern matches what production devices would get.
 *   - IoT data endpoint resolved at deploy time via custom resource.
 *   - Only `AllTelemetryRule` deployed here. `ThresholdAlertRule`
 *     deferred to Phase 5 where the Step Functions ARN exists.
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface IotStackProps extends cdk.StackProps {
  projectName: string;
  stream: kinesis.IStream;
  /**
   * Optional alert workflow state machine. When provided, IotStack
   * adds a `ThresholdAlertRule` IoT rule that fires on out-of-range
   * voltage/frequency readings and starts an execution of the state
   * machine. Phase 5+ wiring; Phase 4 deploys without this prop and
   * only the `AllTelemetryRule` is created.
   */
  alertStateMachine?: sfn.IStateMachine;
  /**
   * Name of the alert state machine. Required when `alertStateMachine`
   * is set — the IoT rule's `stepFunctions` action needs the literal
   * name (not the ARN), and newer aws-cdk-lib versions don't expose
   * `stateMachineName` on the `IStateMachine` interface.
   */
  alertStateMachineName?: string;
}

export class IotStack extends cdk.Stack {
  public readonly simulator: lambda.IFunction;
  public readonly iotEndpoint: string;

  constructor(scope: Construct, id: string, props: IotStackProps) {
    super(scope, id, props);

    /**
     * Discover the account-specific IoT data endpoint at deploy time.
     * The result is baked into the simulator's env vars; never re-resolved
     * at runtime.
     */
    const endpointDiscovery = new cr.AwsCustomResource(this, 'IotEndpoint', {
      onCreate: {
        service: 'Iot',
        action: 'DescribeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of('GridSensorIotEndpoint'),
      },
      onUpdate: {
        service: 'Iot',
        action: 'DescribeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of('GridSensorIotEndpoint'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iot:DescribeEndpoint'],
          resources: ['*'],
        }),
      ]),
    });
    this.iotEndpoint =
      endpointDiscovery.getResponseField('endpointAddress');

    /**
     * IoT Rules engine role.
     *
     * Inline policies in the constructor (per the P3 deploy lessons)
     * so CFN can't race the policy attachment against rule creation.
     * Permissions are conditional on which rules this stack actually
     * deploys: always Kinesis (for AllTelemetryRule); Step Functions
     * StartExecution only if Phase 5's alert workflow is wired.
     */
    const inlinePolicies: Record<string, iam.PolicyDocument> = {
      KinesisWrite: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
            resources: [props.stream.streamArn],
          }),
        ],
      }),
    };
    if (props.alertStateMachine) {
      inlinePolicies.StepFunctionsStart = new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['states:StartExecution'],
            resources: [props.alertStateMachine.stateMachineArn],
          }),
        ],
      });
    }
    const iotRulesRole = new iam.Role(this, 'IotRulesRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'IoT Rules engine role for routing telemetry to Kinesis',
      inlinePolicies,
    });

    /**
     * AllTelemetryRule — every telemetry message → Kinesis.
     *
     * SQL: `topic(2) AS sensorId` extracts the second segment of the
     * MQTT topic (e.g., `sensor-001` from `sensors/sensor-001/telemetry`)
     * and exposes it as a SELECT alias. The Kinesis action then uses
     * `${sensorId}` substitution as the partition key, preserving
     * per-sensor ordering on the stream.
     *
     * AWS IoT SQL version 2016-03-23 supports the `topic()` function.
     */
    const ruleName = `${props.projectName.replace(/-/g, '_')}_all_telemetry`;
    new iot.CfnTopicRule(this, 'AllTelemetryRule', {
      ruleName,
      topicRulePayload: {
        sql: "SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            kinesis: {
              streamName: props.stream.streamName,
              partitionKey: '${sensorId}',
              roleArn: iotRulesRole.roleArn,
            },
          },
        ],
      },
    });

    /**
     * ThresholdAlertRule — out-of-range readings start the alert
     * workflow. SQL filter mirrors `src/lib/threshold.ts` exactly;
     * keep them in lockstep (predicate-duplication smell flagged in
     * the P5 decision log).
     *
     * NERC standard: frequency 60 Hz +/- 0.5 Hz; voltage 120 V +/- 5%.
     */
    if (props.alertStateMachine && props.alertStateMachineName) {
      const alertRuleName = `${props.projectName.replace(/-/g, '_')}_threshold_alert`;
      new iot.CfnTopicRule(this, 'ThresholdAlertRule', {
        ruleName: alertRuleName,
        topicRulePayload: {
          sql:
            "SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry' " +
            "WHERE (readingType = 'frequency' AND (value < 59.5 OR value > 60.5)) " +
            "OR (readingType = 'voltage' AND (value < 114 OR value > 126))",
          awsIotSqlVersion: '2016-03-23',
          ruleDisabled: false,
          actions: [
            {
              stepFunctions: {
                stateMachineName: props.alertStateMachineName,
                roleArn: iotRulesRole.roleArn,
              },
            },
          ],
        },
      });

      new cdk.CfnOutput(this, 'ThresholdAlertRuleName', {
        value: alertRuleName,
        description: 'IoT Rule routing breach readings to alert workflow',
        exportName: `${props.projectName}-threshold-alert-rule`,
      });
    }

    /**
     * Simulator Lambda log group — explicit per the P3 lesson.
     */
    const simulatorLogGroup = new logs.LogGroup(this, 'SimulatorLogGroup', {
      logGroupName: `/aws/lambda/${props.projectName}-simulator`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Simulator Lambda — IAM-authorized publishes via the IoT Data Plane
     * SDK. No MQTT, no certificates. The Function's role gets a tightly
     * scoped `iot:Publish` permission on the
     * `sensors/<sensorId>/telemetry` topic pattern (IAM wildcard `*`
     * applied at the resource ARN, see below).
     */
    const simulator = new nodejs.NodejsFunction(this, 'Simulator', {
      functionName: `${props.projectName}-simulator`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../src/handlers/simulator.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: simulatorLogGroup,
      environment: {
        IOT_ENDPOINT: this.iotEndpoint,
        POWERTOOLS_SERVICE_NAME: 'grid-sensor-simulator',
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

    /**
     * `iot:Publish` is a runtime-only permission (the simulator never
     * publishes during create-time), so `addToRolePolicy` is safe here
     * — no race against dependent-resource creation. Inline policies
     * in the role constructor are still the safer default for create-
     * time auth needs.
     *
     * Topic pattern matches what real devices would get if the simulator
     * were ever migrated to cert-based MQTT auth.
     */
    simulator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:Publish'],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:topic/sensors/*/telemetry`,
        ],
      }),
    );

    // Endpoint must exist before the simulator can use it via env var.
    simulator.node.addDependency(endpointDiscovery);

    this.simulator = simulator;

    new cdk.CfnOutput(this, 'IotEndpointAddress', {
      value: this.iotEndpoint,
      description: 'IoT data endpoint (HTTPS host, no scheme)',
      exportName: `${props.projectName}-iot-endpoint`,
    });
    new cdk.CfnOutput(this, 'SimulatorFunctionName', {
      value: simulator.functionName,
      description: 'Simulator Lambda function name',
      exportName: `${props.projectName}-simulator-function`,
    });
    new cdk.CfnOutput(this, 'AllTelemetryRuleName', {
      value: ruleName,
      description: 'IoT Rule routing telemetry to Kinesis',
      exportName: `${props.projectName}-all-telemetry-rule`,
    });
  }
}
