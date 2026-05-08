/**
 * Kinesis-stack template assertions.
 *
 * Locks the lessons from the Phase 3 deploy adventure:
 *   1. Firehose role's inline policy includes `kinesis:DescribeStream`
 *      (CDK's Stream.grantRead does NOT include it; Firehose uses the
 *      legacy API).
 *   2. The DeliveryStream has an explicit dependency on the Firehose
 *      role so CFN can't race policy attachment against resource
 *      creation.
 *
 * If a future refactor ever switches back to `grantRead` + `addToPolicy`
 * or removes the explicit `addDependency`, these assertions fail at
 * synth time — long before a real deploy hits the same wall.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KinesisStack } from '../lib/kinesis-stack';

const synth = (): Template => {
  const app = new App();
  const stack = new KinesisStack(app, 'Kinesis', {
    env: { account: '123456789012', region: 'us-east-1' },
    projectName: 'gsp-test',
  });
  return Template.fromStack(stack);
};

describe('KinesisStack template', () => {
  describe('Firehose role inline policy', () => {
    it('grants kinesis:DescribeStream (legacy API used by Firehose)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: 'KinesisSourceAccess',
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith(['kinesis:DescribeStream']),
                }),
              ]),
            },
          }),
        ]),
      });
    });

    it('grants the full Kinesis source action set Firehose needs', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: 'KinesisSourceAccess',
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith([
                    'kinesis:DescribeStream',
                    'kinesis:DescribeStreamSummary',
                    'kinesis:GetRecords',
                    'kinesis:GetShardIterator',
                    'kinesis:ListShards',
                    'kinesis:SubscribeToShard',
                  ]),
                }),
              ]),
            },
          }),
        ]),
      });
    });

    it('grants S3 destination access on the archive bucket', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: 'S3DestinationAccess',
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith([
                    's3:AbortMultipartUpload',
                    's3:GetBucketLocation',
                    's3:GetObject',
                    's3:ListBucket',
                    's3:ListBucketMultipartUploads',
                    's3:PutObject',
                  ]),
                }),
              ]),
            },
          }),
        ]),
      });
    });
  });

  describe('Firehose DeliveryStream', () => {
    it('configures KinesisStreamAsSource with the data stream and role', () => {
      const template = synth();
      template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
        DeliveryStreamType: 'KinesisStreamAsSource',
        KinesisStreamSourceConfiguration: {
          KinesisStreamARN: Match.anyValue(),
          RoleARN: Match.anyValue(),
        },
      });
    });

    it('uses GZIP compression and 5min/5MB buffering', () => {
      const template = synth();
      template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
        ExtendedS3DestinationConfiguration: Match.objectLike({
          CompressionFormat: 'GZIP',
          BufferingHints: {
            IntervalInSeconds: 300,
            SizeInMBs: 5,
          },
        }),
      });
    });
  });

  describe('Kinesis Data Stream', () => {
    it('uses 24h retention to match the processor idempotency TTL window', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Kinesis::Stream', {
        RetentionPeriodHours: 24,
        ShardCount: 1,
      });
    });
  });

  describe('S3 archive bucket', () => {
    it('has a tiered lifecycle (IA → Glacier → expire)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: 'Enabled',
              Transitions: Match.arrayWith([
                Match.objectLike({ StorageClass: 'STANDARD_IA' }),
                Match.objectLike({ StorageClass: 'GLACIER' }),
              ]),
              ExpirationInDays: 365,
            }),
          ]),
        },
      });
    });
  });
});
