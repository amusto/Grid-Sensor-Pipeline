/**
 * Datadog Lambda Extension instrumentation helper (Phase 10).
 *
 * Attaches the Datadog Lambda Extension layer + the canonical
 * `DD_*` env vars + a Secrets Manager read grant to a Lambda
 * function. Forwards EMF custom metrics (from Powertools Metrics)
 * and CloudWatch Logs to Datadog in near-real-time.
 *
 * # Scope
 *
 * Metric + log forwarding only. APM tracing (which needs the
 * Node.js tracer layer + handler wrapping) is intentionally
 * deferred — Phase 10 acceptance criterion is "same EMF metrics
 * visible in Datadog," not full distributed tracing. Adding APM
 * later is a one-file change: include the tracer layer here, set
 * `DD_TRACE_ENABLED=true`, and switch the function's `handler`
 * property to `/opt/nodejs/node_modules/datadog-lambda-js/handler.handler`
 * via a `DD_LAMBDA_HANDLER=index.handler` env var.
 *
 * # How metric forwarding actually works
 *
 *   1. Powertools Metrics writes EMF (Embedded Metric Format)
 *      JSON lines to stdout — the same shape CloudWatch parses to
 *      index custom metrics into the `GridSensorPipeline` namespace.
 *   2. The Datadog Extension subscribes to the Lambda log stream
 *      from inside the runtime sandbox, parses those EMF lines,
 *      and ships them to Datadog over HTTPS in batches.
 *   3. CloudWatch Logs ALSO indexes the same EMF lines (the
 *      existing pre-Datadog path is unaffected).
 *
 *   Result: identical metrics visible in both CloudWatch and
 *   Datadog without any application-code change.
 *
 * # Opt-in by default
 *
 * Wired through `maybeAttachDatadog`, which reads `enableDatadog`
 * from CDK context and no-ops if unset. This keeps the existing
 * deploy path unchanged for anyone (CI, fresh clones, the
 * Datadog-disabled cost-minimization path) until the deploy
 * explicitly opts in:
 *
 *   cdk deploy GridSensorProcessingStack \
 *     -c enableDatadog=true \
 *     -c ddApiKeySecretArn=arn:aws:secretsmanager:us-east-1:...:secret:gsp/dd-api-key-AbCdEf
 *
 * # Cost notes
 *
 *   - Layer adds ~50–200 ms cold-start, a few ms warm.
 *   - Secrets Manager: $0.40/mo per secret + $0.05/10k API calls.
 *   - Datadog ingest billing is separate (and the bigger lever
 *     post-trial — see decision log Phase 10).
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * AWS account that publishes the Datadog Lambda Extension layer in
 * every region. The account is the same everywhere; only the layer
 * version + region change.
 *
 * Source: https://docs.datadoghq.com/serverless/installation/nodejs/
 */
const DATADOG_LAYER_ACCOUNT = '464622532012';

/**
 * Default Extension layer version. Pin a known-stable version
 * rather than chasing latest — layer ARNs are immutable, and
 * upgrading is intentional. Override via CDK context:
 *
 *   cdk deploy -c ddExtensionVersion=78
 *
 * Check Datadog's release notes before bumping:
 * https://github.com/DataDog/datadog-lambda-extension/releases
 */
const DEFAULT_EXTENSION_VERSION = 75;

export interface DatadogInstrumentationProps {
  /**
   * Datadog Secrets Manager API-key secret ARN. The secret value
   * is the raw API key string (no JSON wrapper). Required.
   */
  apiKeySecretArn: string;

  /**
   * Datadog ingestion site — match the URL hostname of the Datadog
   * org. Common values: `datadoghq.com` (US1), `us3.datadoghq.com`,
   * `us5.datadoghq.com`, `datadoghq.eu` (EU1), `ap1.datadoghq.com`.
   */
  site: string;

  /**
   * Per-function service tag, surfaces as the service name in
   * Datadog's Serverless view (groups invocations under one
   * heading). One service per Lambda; do not share.
   */
  service: string;

  /**
   * Deployment environment tag — `poc`, `dev`, `staging`, `prod`.
   * Datadog uses this to scope dashboards + alerts.
   */
  env: string;

  /**
   * Datadog Lambda Extension layer version. Defaults to
   * {@link DEFAULT_EXTENSION_VERSION}; override via CDK context.
   */
  extensionVersion?: number;
}

/**
 * Attaches Datadog instrumentation to a Lambda function. Caller
 * provides the props directly — use {@link maybeAttachDatadog} if
 * you want CDK-context-driven opt-in.
 */
export const attachDatadog = (
  scope: Construct,
  fn: lambda.Function,
  props: DatadogInstrumentationProps,
): void => {
  const version = props.extensionVersion ?? DEFAULT_EXTENSION_VERSION;
  const region = cdk.Stack.of(scope).region;
  const layerArn =
    `arn:aws:lambda:${region}:${DATADOG_LAYER_ACCOUNT}` +
    `:layer:Datadog-Extension:${version}`;

  // `fromSecretCompleteArn` requires the trailing random suffix
  // Secrets Manager appends (e.g. `-AbCdEf`). That's stable per
  // secret and safer than `fromSecretPartialArn`, which would
  // grant on a name prefix that could match siblings.
  const secret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    `DatadogApiKeySecret-${fn.node.id}`,
    props.apiKeySecretArn,
  );

  fn.addLayers(
    lambda.LayerVersion.fromLayerVersionArn(
      scope,
      `DatadogExtensionLayer-${fn.node.id}`,
      layerArn,
    ),
  );

  fn.addEnvironment('DD_API_KEY_SECRET_ARN', props.apiKeySecretArn);
  fn.addEnvironment('DD_SITE', props.site);
  fn.addEnvironment('DD_ENV', props.env);
  fn.addEnvironment('DD_SERVICE', props.service);
  fn.addEnvironment('DD_SERVERLESS_LOGS_ENABLED', 'true');
  // APM tracing is off — would require the Node.js tracer layer.
  // Out of scope for P10; revisit as a P10 stretch.
  fn.addEnvironment('DD_TRACE_ENABLED', 'false');

  secret.grantRead(fn);
};

/**
 * Context-driven wrapper around {@link attachDatadog}. Reads
 * `enableDatadog` from CDK context and:
 *
 *   - returns silently (no-op) if unset / falsy.
 *   - throws if enabled but `ddApiKeySecretArn` is missing —
 *     fail-loud is correct here, a silent partial wiring would
 *     surprise the operator at runtime when Datadog never
 *     receives data.
 *
 * Read order for the optional values:
 *   - `ddSite`            — default: `us5.datadoghq.com`
 *   - `ddEnv`             — default: `poc`
 *   - `ddExtensionVersion`— default: {@link DEFAULT_EXTENSION_VERSION}
 *
 * Usage:
 *
 *   maybeAttachDatadog(this, processor, 'grid-sensor-processor');
 */
export const maybeAttachDatadog = (
  scope: Construct,
  fn: lambda.Function,
  service: string,
): void => {
  const enabled = scope.node.tryGetContext('enableDatadog');
  // CDK context values arrive as either booleans (cdk.context.json)
  // or strings (CLI `-c key=value`). Accept both true forms.
  if (enabled !== true && enabled !== 'true') {
    return;
  }
  const apiKeySecretArn = scope.node.tryGetContext('ddApiKeySecretArn');
  if (!apiKeySecretArn) {
    throw new Error(
      'enableDatadog=true requires -c ddApiKeySecretArn=<secrets-manager-arn>',
    );
  }
  const extensionVersionRaw = scope.node.tryGetContext('ddExtensionVersion');
  const extensionVersion =
    extensionVersionRaw !== undefined
      ? Number(extensionVersionRaw)
      : undefined;

  attachDatadog(scope, fn, {
    apiKeySecretArn,
    site: scope.node.tryGetContext('ddSite') ?? 'us5.datadoghq.com',
    service,
    env: scope.node.tryGetContext('ddEnv') ?? 'poc',
    extensionVersion,
  });
};
