/**
 * Storage stack — DynamoDB tables.
 *
 * Two tables:
 *   1. Readings table — pk: sensorId, sk: timestamp#readingType, TTL 30d.
 *   2. Idempotency table — Powertools-managed schema; do not modify.
 *
 * Both on-demand billing (PAY_PER_REQUEST) because grid event traffic is
 * bursty — provisioned would either over-provision baseline or throttle the
 * spike that matters most. See `docs/decisions/phase-03-storage-processing.md`.
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  projectName: string;
}

export class StorageStack extends cdk.Stack {
  public readonly readingsTable: dynamodb.ITable;
  public readonly idempotencyTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    /**
     * Readings table.
     *
     *   pk  = sensorId
     *   sk  = `${timestamp}#${readingType}`  (composite — see lib/repository.ts)
     *   ttl = epoch + 30 days
     *
     * GSI on (readingType, timestamp) for cross-sensor queries by reading
     * type within a time window — e.g., "all voltage readings in the last
     * hour across the fleet." Optional but cheap to provision now.
     */
    const readings = new dynamodb.Table(this, 'ReadingsTable', {
      tableName: `${props.projectName}-readings`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      // POC posture — `cdk destroy` actually removes resources. Production
      // would use RETAIN.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    readings.addGlobalSecondaryIndex({
      indexName: 'byReadingTypeAndTime',
      partitionKey: {
        name: 'readingType',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /**
     * Idempotency table — schema dictated by Lambda Powertools.
     *
     *   pk  = `id` (Powertools writes the JMESPath-extracted key here)
     *   ttl attribute = `expiration`
     *
     * Do NOT change attribute names — Powertools relies on them.
     * See https://docs.powertools.aws.dev/lambda/typescript/latest/utilities/idempotency/
     */
    const idempotency = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: `${props.projectName}-idempotency`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiration',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.readingsTable = readings;
    this.idempotencyTable = idempotency;

    new cdk.CfnOutput(this, 'ReadingsTableName', {
      value: readings.tableName,
      description: 'DynamoDB table for sensor readings',
      exportName: `${props.projectName}-readings-table`,
    });
    new cdk.CfnOutput(this, 'IdempotencyTableName', {
      value: idempotency.tableName,
      description: 'DynamoDB table for Powertools idempotency state',
      exportName: `${props.projectName}-idempotency-table`,
    });
  }
}
