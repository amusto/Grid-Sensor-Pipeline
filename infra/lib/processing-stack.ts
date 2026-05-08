/**
 * Processing stack — Processor Lambda + Kinesis ESM + DLQ.
 *
 * The processor consumes the Kinesis stream, writes to DynamoDB, emits
 * EMF metrics, and routes failures via the partial-batch contract.
 *
 * ESM safety flags (`bisectBatchOnError`, `reportBatchItemFailures`,
 * `retryAttempts`, DLQ) are not optional — they're CLAUDE.md hard rule #9
 * and the foundation of the at-least-once delivery contract. See
 * `docs/decisions/phase-03-storage-processing.md`.
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ProcessingStackProps extends cdk.StackProps {
  projectName: string;
  readingsTable: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  stream: kinesis.IStream;
}

export class ProcessingStack extends cdk.Stack {
  public readonly processor: lambda.IFunction;
  public readonly dlq: sqs.IQueue;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    /**
     * DLQ for records that survive ESM bisection + retry budget.
     *
     * 7-day retention balances "long enough for an on-call to triage on
     * Monday morning" against "not paying for ancient noise." 14 days is
     * the SQS max; 7 days is the operational sweet spot.
     */
    const dlq = new sqs.Queue(this, 'ProcessorDlq', {
      queueName: `${props.projectName}-processor-dlq`,
      retentionPeriod: cdk.Duration.days(7),
      // 6× Lambda timeout — recommended for SQS event sources.
      visibilityTimeout: cdk.Duration.seconds(180),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Explicit LogGroup for the processor — `logRetention` on `Function`
     * was deprecated in favour of an explicit LogGroup so the retention
     * is owned by the same stack rather than created via a custom
     * resource. ONE_WEEK retention keeps CloudWatch Logs cost predictable
     * for a POC; production would extend or ship logs to a long-term sink.
     */
    const processorLogGroup = new logs.LogGroup(this, 'ProcessorLogGroup', {
      logGroupName: `/aws/lambda/${props.projectName}-processor`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Processor Lambda.
     *
     * Memory 512 MB — Powertools Logger/Tracer/Metrics need ~256 MB
     * headroom; 512 MB is the comfort zone for cold starts on Node 20.
     *
     * `externalModules: ['@aws-sdk/*']` — the AWS SDK v3 is on the Node 20
     * runtime, so we don't bundle it. Powertools and Zod are NOT on the
     * runtime, so esbuild bundles them into the function package.
     */
    const processor = new nodejs.NodejsFunction(this, 'Processor', {
      functionName: `${props.projectName}-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../src/handlers/processor.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: processorLogGroup,
      environment: {
        READINGS_TABLE: props.readingsTable.tableName,
        IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'grid-sensor-processor',
        POWERTOOLS_METRICS_NAMESPACE: 'GridSensorPipeline',
        POWERTOOLS_LOGGER_LOG_EVENT: 'false', // PII safety; flip on for debug
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
        // Tree-shake Powertools to keep the bundle small.
        format: nodejs.OutputFormat.CJS,
      },
    });

    // IAM grants — minimum-privilege.
    props.readingsTable.grantWriteData(processor);
    props.idempotencyTable.grantReadWriteData(processor);
    props.stream.grantRead(processor);
    dlq.grantSendMessages(processor);

    /**
     * Kinesis Event Source Mapping.
     *
     * Each flag has a specific failure mode it covers — see
     * docs/decisions/phase-03-storage-processing.md for the layered-failure
     * rationale.
     *
     *   batchSize: 10                — small batches keep p99 down at the
     *                                  cost of more invocations. Tune from
     *                                  metrics.
     *   maxBatchingWindow: 1s        — same tradeoff knob.
     *   bisectBatchOnError: true     — CLAUDE.md hard rule #9. Splits a
     *                                  failing batch in half to isolate the
     *                                  bad record.
     *   reportBatchItemFailures: true — Handshake with the handler's
     *                                   batchItemFailures response shape.
     *   retryAttempts: 5             — bounds the retry storm.
     *   maxRecordAge: 24h            — match Kinesis retention.
     *   onFailure: SQS DLQ           — terminal destination for records
     *                                  that survive bisection + retries.
     */
    processor.addEventSource(
      new eventsources.KinesisEventSource(props.stream, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(1),
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 5,
        maxRecordAge: cdk.Duration.hours(24),
        onFailure: new eventsources.SqsDlq(dlq),
      }),
    );

    this.processor = processor;
    this.dlq = dlq;

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processor.functionName,
      description: 'Processor Lambda function name',
      exportName: `${props.projectName}-processor-function`,
    });
    new cdk.CfnOutput(this, 'DlqUrl', {
      value: dlq.queueUrl,
      description: 'Processor DLQ URL',
      exportName: `${props.projectName}-processor-dlq-url`,
    });
    new cdk.CfnOutput(this, 'DlqArn', {
      value: dlq.queueArn,
      description: 'Processor DLQ ARN',
      exportName: `${props.projectName}-processor-dlq-arn`,
    });
  }
}
