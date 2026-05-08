#!/usr/bin/env node
/**
 * CDK app entrypoint.
 *
 * Three stacks composed via constructor props (storage → kinesis →
 * processing). Stack boundaries follow lifecycle: storage tables persist
 * across processor changes; kinesis is stable infrastructure; processing
 * Lambda changes most often. See `docs/decisions/phase-03-storage-processing.md`.
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { KinesisStack } from '../lib/kinesis-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { IotStack } from '../lib/iot-stack';

const app = new cdk.App();

const projectName: string =
  app.node.tryGetContext('project') ?? 'grid-sensor-pipeline';

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const storage = new StorageStack(app, 'GridSensorStorageStack', {
  env,
  projectName,
  description: 'DynamoDB readings + idempotency tables',
});

const kinesis = new KinesisStack(app, 'GridSensorKinesisStack', {
  env,
  projectName,
  description: 'Kinesis Data Stream + Firehose archive to S3',
});

new ProcessingStack(app, 'GridSensorProcessingStack', {
  env,
  projectName,
  description: 'Processor Lambda + Kinesis ESM + DLQ',
  readingsTable: storage.readingsTable,
  idempotencyTable: storage.idempotencyTable,
  stream: kinesis.stream,
});

new IotStack(app, 'GridSensorIotStack', {
  env,
  projectName,
  description: 'IoT Rules engine + simulator Lambda',
  stream: kinesis.stream,
});

cdk.Tags.of(app).add('project', projectName);
cdk.Tags.of(app).add('managed-by', 'cdk');
cdk.Tags.of(app).add('environment', process.env.ENVIRONMENT ?? 'dev');

app.synth();
