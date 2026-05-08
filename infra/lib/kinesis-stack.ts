/**
 * Kinesis stack — Data Stream + Firehose archive to S3.
 *
 * The streaming backbone (Kinesis) and the cold archive (Firehose → S3)
 * live in the same stack because they share a lifecycle: changing
 * retention or shard count tends to come paired with archive-format
 * adjustments.
 *
 * 1 shard, 24h retention. Retention is intentionally coupled to the
 * processor's idempotency TTL (P2) — they must change together or the
 * dedup contract breaks. See `docs/decisions/phase-03-storage-processing.md`.
 */

import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface KinesisStackProps extends cdk.StackProps {
  projectName: string;
}

export class KinesisStack extends cdk.Stack {
  public readonly stream: kinesis.IStream;
  public readonly archiveBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: KinesisStackProps) {
    super(scope, id, props);

    /**
     * Kinesis Data Stream — durable, replayable backbone.
     *
     * 1 shard handles 1 MB/s ingest and 1000 records/s — orders of
     * magnitude above POC volume. Production sizing is `peak ingest /
     * 1 MB-per-shard`. 24h retention matches the processor's idempotency
     * TTL — extending retention here REQUIRES extending the TTL in lockstep
     * (see processor.ts IDEMPOTENCY_TTL_SECONDS).
     */
    const stream = new kinesis.Stream(this, 'TelemetryStream', {
      streamName: `${props.projectName}-telemetry`,
      shardCount: 1,
      retentionPeriod: cdk.Duration.hours(24),
      streamMode: kinesis.StreamMode.PROVISIONED,
    });

    /**
     * S3 cold archive — every raw event for ad-hoc analytics. Lifecycle
     * rules transition to cheaper storage classes over time (IA → Glacier
     * → expire) so old records aren't paying full S3 standard rates.
     *
     * Parquet output is deferred to a later phase — JSON+GZIP for now is
     * cheaper to set up and adequate for forensic queries.
     */
    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `${props.projectName}-archive-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      // POC posture — see decision log.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'tiered-archive',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    /**
     * Firehose role — read from Kinesis, write to S3.
     *
     * Permissions are declared as `inlinePolicies` in the constructor
     * (rather than via `grantRead` + `addToPolicy` after the fact) for
     * two reasons:
     *
     *   1. CDK's `Stream.grantRead()` does NOT include `kinesis:DescribeStream`
     *      (the older API) — it grants only `DescribeStreamSummary`. Firehose
     *      specifically calls `DescribeStream` when using a Kinesis stream
     *      as its source, so the explicit list below is necessary.
     *   2. Inline policies in the role constructor become part of the role's
     *      `AWS::IAM::Role` resource definition. `addToPolicy` would create
     *      a separate `AWS::IAM::Policy` resource — CFN can race the
     *      Firehose DeliveryStream creation against the policy attachment,
     *      causing intermittent auth failures during first deploy.
     *
     * The S3 bucket permissions follow the AWS-documented Firehose policy
     * for an S3 destination.
     */
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Firehose role for Kinesis to S3 archive',
      inlinePolicies: {
        KinesisSourceAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'kinesis:DescribeStream',
                'kinesis:DescribeStreamSummary',
                'kinesis:GetRecords',
                'kinesis:GetShardIterator',
                'kinesis:ListShards',
                'kinesis:SubscribeToShard',
              ],
              resources: [stream.streamArn],
            }),
          ],
        }),
        S3DestinationAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3:AbortMultipartUpload',
                's3:GetBucketLocation',
                's3:GetObject',
                's3:ListBucket',
                's3:ListBucketMultipartUploads',
                's3:PutObject',
              ],
              resources: [
                archiveBucket.bucketArn,
                `${archiveBucket.bucketArn}/*`,
              ],
            }),
          ],
        }),
      },
    });

    /**
     * Firehose: 5 min / 5 MB buffer is the industry default — balances S3
     * PUT cost against analytical lag. GZIP compression keeps storage
     * reasonable for JSON output. Hive-style date prefix lets Athena/Glue
     * partition by year/month/day natively.
     */
    const deliveryStream = new firehose.CfnDeliveryStream(this, 'ArchiveDeliveryStream', {
      deliveryStreamName: `${props.projectName}-archive`,
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: stream.streamArn,
        roleArn: firehoseRole.roleArn,
      },
      extendedS3DestinationConfiguration: {
        bucketArn: archiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        bufferingHints: {
          intervalInSeconds: 300,
          sizeInMBs: 5,
        },
        compressionFormat: 'GZIP',
        prefix:
          'raw/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix:
          'errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
      },
    });

    // Explicit dependency: Firehose creation must wait until the role
    // (and its inline policies) is fully provisioned.
    deliveryStream.node.addDependency(firehoseRole);

    this.stream = stream;
    this.archiveBucket = archiveBucket;

    new cdk.CfnOutput(this, 'StreamName', {
      value: stream.streamName,
      description: 'Kinesis Data Stream name',
      exportName: `${props.projectName}-stream`,
    });
    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
      description: 'S3 bucket for cold archive',
      exportName: `${props.projectName}-archive-bucket`,
    });
  }
}
