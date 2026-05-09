/**
 * Query stack — API Gateway REST API + query Lambda.
 *
 * Exposes `GET /sensors/{sensorId}/readings?from=&to=&limit=` over
 * HTTPS. Read-only access to the readings table; no auth (Phase 12
 * strong-stretch will add API key + usage plan, then Cognito).
 *
 * Per `docs/decisions/phase-07-query-api.md`:
 *   - REST API (not HTTP API) for native API key/usage plan support
 *     and request validation models, anticipating Phase 12 auth work.
 *   - Read-only IAM grant on the readings table (defense in depth).
 *   - Permissive CORS for POC; tightens in Phase 12 alongside auth.
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface QueryStackProps extends cdk.StackProps {
  projectName: string;
  readingsTable: dynamodb.ITable;
}

export class QueryStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly queryFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: QueryStackProps) {
    super(scope, id, props);

    /**
     * Query Lambda log group — explicit per the P3 lesson.
     */
    const queryLogGroup = new logs.LogGroup(this, 'QueryFunctionLogGroup', {
      logGroupName: `/aws/lambda/${props.projectName}-query`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Query Lambda — orchestrates: validate input, call repo, format
     * response. Reuses `src/lib/repository.ts` from Phase 1.
     */
    const queryFunction = new nodejs.NodejsFunction(this, 'QueryFunction', {
      functionName: `${props.projectName}-query`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(__dirname, '../../src/handlers/query.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: queryLogGroup,
      environment: {
        READINGS_TABLE: props.readingsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'grid-sensor-query',
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
     * Read-only DynamoDB grant. Per CLAUDE.md hard rule #6 framing:
     * the query Lambda should never need to write. IAM enforces this
     * even if a future code change tries to. Defense in depth.
     */
    props.readingsTable.grantReadData(queryFunction);

    /**
     * REST API. Access logging enabled for observability and future
     * forensic queries.
     */
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${props.projectName}-query`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'QueryApi', {
      restApiName: `${props.projectName}-query-api`,
      description: 'Grid sensor readings query API',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false, // request/response bodies stay out of logs
        metricsEnabled: true,
        tracingEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      },
      cloudWatchRole: true,
    });

    /**
     * Routes:
     *   /sensors/{sensorId}/readings  GET  -> queryFunction
     */
    const sensors = api.root.addResource('sensors');
    const sensor = sensors.addResource('{sensorId}');
    const readings = sensor.addResource('readings');

    readings.addMethod(
      'GET',
      new apigateway.LambdaIntegration(queryFunction, {
        proxy: true,
      }),
      {
        // Path parameter declared so it appears in the OpenAPI / SDK
        // generation. Validation happens in the Lambda's Zod schema.
        requestParameters: {
          'method.request.path.sensorId': true,
          'method.request.querystring.from': false,
          'method.request.querystring.to': false,
          'method.request.querystring.limit': false,
        },
      },
    );

    this.api = api;
    this.queryFunction = queryFunction;

    new cdk.CfnOutput(this, 'QueryApiUrl', {
      value: api.url,
      description: 'Base URL of the query API. Sensor readings at /sensors/{sensorId}/readings',
      exportName: `${props.projectName}-query-api-url`,
    });
    new cdk.CfnOutput(this, 'QueryFunctionName', {
      value: queryFunction.functionName,
      description: 'Query Lambda function name',
      exportName: `${props.projectName}-query-function`,
    });
  }
}
