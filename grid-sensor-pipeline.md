# Grid Sensor Event Processing Pipeline — Design

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                        Grid Sensor Pipeline                                 │
  │                                                                             │
  │  [IoT Device Simulator]                                                     │
  │    Lambda (TypeScript)                                                      │
  │    Publishes to IoT Core topic: sensors/{sensorId}/telemetry               │
  │    Payload: { sensorId, timestamp, readingType, value, unit, gridZone }    │
  │         │                                                                   │
  │         ▼                                                                   │
  │  [AWS IoT Core]  ←── X.509 device auth, device shadows                    │
  │    MQTT broker                                                              │
  │    IoT Rules Engine                                                         │
  │         │                                                                   │
  │    ┌────┴──────────────────────────────────┐                               │
  │    ▼ Rule: all telemetry                   ▼ Rule: value > threshold        │
  │  [Kinesis Data Stream]              [Step Functions]                        │
  │    partition key = sensorId          Alert Workflow                         │
  │    24h retention, replayable         (Standard Workflow)                    │
  │         │                             │                                     │
  │         ▼                             ▼                                     │
  │  [Processor Lambda]             Validate → Notify → Wait Ack → Escalate   │
  │   Kinesis ESM, batch: 10                                                   │
  │   bisectOnError: true                                                       │
  │         │                                                                   │
  │    ┌────┴──────────────────┐                                               │
  │    ▼                       ▼                                               │
  │ [DynamoDB]          [CloudWatch / Datadog]                                 │
  │  PK: sensorId        EMF metrics via Powertools                            │
  │  SK: timestamp       → CloudWatch natively                                 │
  │  idempotency key     → Datadog via Lambda Extension (production)           │
  │  TTL: 30 days        X-Ray distributed tracing                             │
  │    │                       │                                               │
  │    ▼                       ▼                                               │
  │  [Query API]         [Alarms + Dashboard]                                  │
  │  API GW → Lambda      DLQ depth, P99 latency, Step Functions failures      │
  │  GET /sensors/{id}/readings?from=&to=                                      │
  │         │                                                                   │
  │         ▼                                                                   │
  │  [SQS DLQ]  ←── failed Kinesis batches after max retries                  │
  │       │                                                                     │
  │       ▼                                                                     │
  │  [DLQ Inspector Lambda]                                                    │
  │   structured log + alert + optional replay to Kinesis                      │
  │                                                                             │
  │  [Kinesis Firehose → S3]                                                   │
  │   cold archive — all raw events, Parquet by date/sensorId                 │
  └─────────────────────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
grid-sensor-pipeline/
├── src/
│   ├── handlers/
│   │   ├── simulator.ts          # Publishes synthetic events to IoT Core MQTT topic
│   │   ├── processor.ts          # Kinesis ESM → validate → DynamoDB + metrics
│   │   ├── alert-handler.ts      # Invoked by Step Functions — notification step
│   │   ├── dlq-inspector.ts      # SQS DLQ → structured log + SNS alert + optional replay
│   │   └── query.ts              # API Gateway → DynamoDB range query
│   ├── lib/
│   │   ├── validator.ts          # Zod schema + validateSensorEvent() — I/O boundary only
│   │   ├── repository.ts         # SensorRepository — DynamoDB put/query
│   │   ├── threshold.ts          # Threshold evaluation logic (pure, no I/O, testable)
│   │   ├── types.ts              # SensorEvent, SensorReading, AlertContext
│   │   ├── logger.ts             # Powertools Logger singleton
│   │   ├── tracer.ts             # Powertools Tracer singleton
│   │   └── metrics.ts            # Powertools Metrics singleton
│   └── __tests__/
│       ├── processor.test.ts
│       ├── validator.test.ts
│       ├── threshold.test.ts
│       └── repository.test.ts
├── infra/
│   ├── bin/app.ts
│   └── lib/
│       ├── iot-stack.ts              # IoT Core thing type, policy, rules engine, device cert
│       ├── kinesis-stack.ts          # Kinesis stream + Firehose → S3
│       ├── processing-stack.ts       # Processor Lambda + ESM config + DLQ
│       ├── alert-workflow-stack.ts   # Step Functions Standard Workflow + alert Lambda
│       ├── storage-stack.ts          # DynamoDB readings + idempotency tables
│       ├── query-stack.ts            # API Gateway + query Lambda
│       └── observability-stack.ts   # CloudWatch Dashboard + Alarms + SNS
├── scripts/
│   └── simulate.ts               # Invoke simulator Lambda N times
├── CLAUDE.md
├── cdk.json
├── tsconfig.json
└── package.json
```

---

## Key Code

### IoT Core Rules Stack (`infra/lib/iot-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface IotStackProps extends cdk.StackProps {
  stream:       kinesis.Stream;
  alertMachine: sfn.StateMachine;
}

export class IotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IotStackProps) {
    super(scope, id, props);

    const iotRole = new iam.Role(this, 'IotRulesRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
    });
    props.stream.grantWrite(iotRole);
    props.alertMachine.grantStartExecution(iotRole);

    // Rule 1: all telemetry → Kinesis (for processing + cold archive)
    new iot.CfnTopicRule(this, 'AllTelemetryRule', {
      topicRulePayload: {
        sql:     "SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'",
        actions: [{
          kinesis: {
            streamName:   props.stream.streamName,
            partitionKey: '${sensorId}',   // per-sensor ordering
            roleArn:      iotRole.roleArn,
          },
        }],
      },
    });

    // Rule 2: threshold violations → Step Functions alert workflow
    new iot.CfnTopicRule(this, 'ThresholdAlertRule', {
      topicRulePayload: {
        sql: `SELECT * FROM 'sensors/+/telemetry'
              WHERE (readingType = 'frequency' AND (value < 59.5 OR value > 60.5))
                 OR (readingType = 'voltage'   AND (value < 114  OR value > 126))`,
        actions: [{
          stepFunctions: {
            stateMachineName: props.alertMachine.stateMachineName,
            roleArn:          iotRole.roleArn,
          },
        }],
      },
    });
  }
}
```

---

### Step Functions Alert Workflow (`infra/lib/alert-workflow-stack.ts`)

Standard Workflow — auditable escalation chain with Wait state for acknowledgment.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export class AlertWorkflowStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, alertFn: lambda.Function, props?: cdk.StackProps) {
    super(scope, id, props);

    const notifyOps = new tasks.LambdaInvoke(this, 'NotifyOps', {
      lambdaFunction: alertFn,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: '$.notifyResult',
    });

    const waitForAck = new sfn.Wait(this, 'WaitForAck', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(15)),
    });

    const isAcknowledged = new sfn.Choice(this, 'IsAcknowledged');
    const escalate = new tasks.LambdaInvoke(this, 'EscalateToOnCall', {
      lambdaFunction: alertFn,
      payload: sfn.TaskInput.fromObject({ escalated: true, context: sfn.JsonPath.entirePayload }),
    });
    const resolved = new sfn.Succeed(this, 'AlertResolved');

    const definition = notifyOps
      .next(waitForAck)
      .next(
        isAcknowledged
          .when(sfn.Condition.booleanEquals('$.acknowledged', true), resolved)
          .otherwise(escalate.next(resolved))
      );

    // Standard Workflow — auditable, long-running, execution history retained 90 days
    this.stateMachine = new sfn.StateMachine(this, 'AlertWorkflow', {
      definition,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout:          cdk.Duration.hours(1),
      tracingEnabled:   true,
    });
  }
}
```

---

### Processor Lambda (`src/handlers/processor.ts`)

```typescript
import { KinesisStreamEvent, KinesisStreamRecord } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { validateSensorEvent } from '../lib/validator';
import { SensorRepository } from '../lib/repository';

const logger      = new Logger({ serviceName: 'grid-sensor-processor' });
const tracer      = new Tracer({ serviceName: 'grid-sensor-processor' });
const metrics     = new Metrics({ namespace: 'GridSensorPipeline', serviceName: 'processor' });
const persistence = new DynamoDBPersistenceLayer({ tableName: process.env.IDEMPOTENCY_TABLE! });
const repo        = new SensorRepository(process.env.READINGS_TABLE!);

const processRecord = makeIdempotent(
  async (record: KinesisStreamRecord): Promise<void> => {
    const subsegment = tracer.getSegment()?.addNewSubsegment('processRecord');
    try {
      const event = validateSensorEvent(
        JSON.parse(Buffer.from(record.kinesis.data, 'base64').toString('utf-8'))
      );
      logger.info('Processing', { sensorId: event.sensorId, readingType: event.readingType });
      const t0 = Date.now();
      await repo.putReading(event);
      metrics.addMetric('EventsProcessed',     MetricUnit.Count,        1);
      metrics.addMetric('ProcessingLatencyMs', MetricUnit.Milliseconds, Date.now() - t0);
      metrics.addDimension('ReadingType', event.readingType);
    } catch (err) {
      metrics.addMetric('ValidationErrors', MetricUnit.Count, 1);
      logger.error('Record failed', { error: err, seq: record.kinesis.sequenceNumber });
      throw err;
    } finally {
      subsegment?.close();
      metrics.publishStoredMetrics();
    }
  },
  { persistenceStore: persistence }
);

export const handler = tracer.captureLambdaHandler(
  logger.injectLambdaContext(async (event: KinesisStreamEvent) => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try { await processRecord(record); }
      catch { failures.push({ itemIdentifier: record.kinesis.sequenceNumber }); }
    }
    if (failures.length) {
      metrics.addMetric('PartialBatchFailures', MetricUnit.Count, failures.length);
      metrics.publishStoredMetrics();
    }
    return { batchItemFailures: failures.map(f => ({ itemIdentifier: f.itemIdentifier })) };
  })
);
```

---

### Datadog Lambda Extension bridge

```typescript
// In processing-stack.ts — add the Datadog Lambda Extension layer
const datadogLayer = lambda.LayerVersion.fromLayerVersionArn(
  this, 'DatadogExtension',
  `arn:aws:lambda:${this.region}:464622532012:layer:Datadog-Extension:65`
);

processorFn.addLayers(datadogLayer);
processorFn.addEnvironment('DD_API_KEY_SECRET_ARN', datadogSecretArn);
processorFn.addEnvironment('DD_SITE', 'datadoghq.com');
processorFn.addEnvironment('DD_SERVERLESS_LOGS_ENABLED', 'true');
```

Lambda Powertools EMF metrics write to stdout → CloudWatch Logs → Datadog Extension parses and forwards automatically. No application code changes. Structured log fields (`sensorId`, `readingType`, `service`) map directly to Datadog tags.

---

## package.json Dependencies

```json
{
  "dependencies": {
    "@aws-lambda-powertools/logger":       "^2",
    "@aws-lambda-powertools/tracer":       "^2",
    "@aws-lambda-powertools/metrics":      "^2",
    "@aws-lambda-powertools/idempotency":  "^2",
    "@aws-sdk/client-dynamodb":            "^3",
    "@aws-sdk/client-iot-data-plane":      "^3",
    "@aws-sdk/lib-dynamodb":               "^3",
    "@aws-sdk/client-kinesis":             "^3",
    "zod":                                 "^3"
  },
  "devDependencies": {
    "aws-cdk-lib":       "^2",
    "constructs":        "^10",
    "typescript":        "^5",
    "jest":              "^29",
    "ts-jest":           "^29",
    "@types/aws-lambda": "^8"
  }
}
```

---

## Build Plan (9 days to demo-ready)

| Day | Milestone |
|-----|-----------|
| 1 | Types + validator + threshold lib + repository — unit tests passing |
| 2 | Processor Lambda with Powertools wired — Kinesis ESM, idempotency, metrics |
| 3 | CDK stacks: Kinesis + storage + processing deployed; live pipeline accepting events |
| 4 | IoT Core stack deployed — simulator publishes via MQTT → IoT Rules → Kinesis |
| 5 | Alert handler Lambda + Step Functions workflow deployed and triggering on threshold |
| 6 | DLQ handler + Observability stack (CloudWatch dashboard + alarms) |
| 7 | Query API (API Gateway + Lambda + DynamoDB reads) |
| 8 | Datadog Extension wired or documented |
| 9 | README polish + architecture diagram + cost teardown |

---

## Estimated AWS Cost

Running actively for a development week: **~$5–10**

- IoT Core: $0.08/M messages + $0.18/M rules — negligible at dev volume
- Kinesis (1 shard): ~$0.015/hr ≈ $2.52/week
- Step Functions: first 4,000 state transitions/month free
- Lambda, DynamoDB, S3, API Gateway: free tier at dev volumes

Run `cdk destroy --all` after sessions.
