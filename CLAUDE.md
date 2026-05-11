# grid-sensor-pipeline — Claude Context

IoT grid sensor event processing pipeline built on AWS serverless. AWS IoT Core → Kinesis → Lambda → DynamoDB + S3, with Step Functions for alert orchestration and CloudWatch (Datadog-ready) observability via Lambda Powertools. TypeScript throughout. CDK for infrastructure.

This is a portfolio POC demonstrating a engineering stack for a Staff TypeScript Engineer interview. Every design decision should be explainable and defensible — prefer the idiomatic AWS serverless pattern over the clever one.

---

## Stack Decisions (locked — do not second-guess)

| Decision | Choice | Why                                                                                                                                                              |
|---|---|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Device ingest | AWS IoT Core | Handles device auth (X.509), device shadows, rules engine routing. Building a custom MQTT broker is not a differentiator.                                        |
| Streaming backbone | Kinesis Data Streams | Serverless, replayable (Kafka equivalent without the broker ops). Shards = partitions, sequence numbers = offsets. IoT Rules Engine routes all telemetry here.   |
| IaC | AWS CDK (TypeScript) | Type-safe, same language as application. CDK L3 constructs enforce architectural patterns at the call site.                                                      |
| Alert orchestration | Step Functions Standard Workflow | Auditable execution history, Wait state for ack, per-step error handling. Standard (not Express) because alert escalation is long-running and must be auditable. |
| Observability — POC | CloudWatch via Lambda Powertools EMF | Zero extra API calls; metrics embedded in logs, parsed automatically.                                                                                            |
| Observability — production bridge | Datadog Lambda Extension | uses Datadog. Extension forwards EMF metrics from CloudWatch Logs to Datadog with zero application code changes.                                                 |
| Tracing | AWS X-Ray via Powertools Tracer | Distributed trace correlation across IoT → Lambda → DynamoDB → Step Functions.                                                                                   |
| Schema validation | Zod | Runtime type safety at the I/O boundary; inferred TypeScript types.                                                                                              |
| Idempotency | Lambda Powertools Idempotency + DynamoDB | Safe retries; idempotency key = Kinesis sequence number.                                                                                                         |
| Partial failures | `batchItemFailures` response | Kinesis retries only failed records, not the whole batch.                                                                                                        |
| Error isolation | `bisectOnError: true` on ESM | Splits batch to isolate bad records before DLQ routing.                                                                                                          |
| Hot storage | DynamoDB | Low-latency reads for recent sensor history; TTL 30 days.                                                                                                        |
| Cold archive | Kinesis Firehose → S3 | Zero-code raw event archival; Parquet by date/sensorId.                                                                                                          |
| DLQ | SQS | Failed records after max retries; separate Lambda inspects and alerts.                                                                                           |

---

## Project Structure

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
│   │   ├── validator.ts             # Zod schema + validateSensorEvent() — I/O boundary only
│   │   ├── repository.ts            # SensorRepository — DynamoDB put/query, no business logic
│   │   ├── threshold.ts             # Threshold evaluation logic — pure function, no I/O
│   │   ├── llm-client.ts            # P8.2: ChatBedrockConverse wrapper; invokeStructured(schema, msgs); maxRetries=1; emits BedrockTokensUsed/Latency/Invocations/Fallback metrics
│   │   ├── severity-classifier.ts   # P8.3: classifySeverity(event, threshold) → {severity, confidence, reasoning} — first LangGraph node, currently a plain async function
│   │   ├── types.ts                 # SensorEvent, SensorReading, AlertContext
│   │   ├── logger.ts                # Powertools Logger singleton
│   │   ├── tracer.ts                # Powertools Tracer singleton
│   │   └── metrics.ts               # Powertools Metrics singleton
│   └── __tests__/
│       ├── processor.test.ts
│       ├── validator.test.ts
│       ├── threshold.test.ts
│       ├── repository.test.ts
│       ├── llm-client.test.ts
│       └── severity-classifier.test.ts
├── infra/
│   ├── bin/app.ts
│   └── lib/
│       ├── iot-stack.ts              # IoT Core thing type, policy, rules engine
│       ├── kinesis-stack.ts          # Kinesis stream + Firehose + S3 bucket
│       ├── processing-stack.ts       # Processor Lambda + ESM config + DLQ
│       ├── alert-workflow-stack.ts   # Step Functions Standard Workflow + alert Lambda
│       ├── storage-stack.ts          # DynamoDB readings + idempotency tables
│       ├── query-stack.ts            # API Gateway + query Lambda
│       └── observability-stack.ts   # CloudWatch Dashboard + Alarms + SNS
├── scripts/
│   ├── simulate.ts               # Invoke simulator Lambda N times with synthetic data
│   └── post-destroy-check.sh     # Verify Kinesis orphan didn't survive `cdk destroy`
├── mcp-server/
│   ├── server.ts                 # P8.6: stdio MCP server with 3 read-only tools
│   └── README.md                 # Claude Desktop / Code config + setup guide
├── CLAUDE.md
├── cdk.json
├── tsconfig.json
└── package.json
```

---

## Commands

```bash
npm install                    # install all dependencies
npm test                       # run Jest unit tests
npm run build                  # tsc compile check
npm run lint                   # eslint

cdk bootstrap                  # first-time only
cdk deploy --all               # deploy all stacks
cdk deploy IotStack            # deploy individual stack
cdk destroy --all              # tear down (run after dev sessions — IoT Core has per-message cost)
cdk diff                       # preview changes before deploy

npx ts-node scripts/simulate.ts --count 50   # send 50 synthetic sensor events
```

---

## IoT Core Design

**Topics:**
- `sensors/{sensorId}/telemetry` — all readings (voltage, current, frequency, power_factor, temperature)
- `sensors/{sensorId}/shadow/update` — device shadow updates (desired/reported state)

**IoT Rules:**
1. **AllTelemetryRule** — `SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'` → Kinesis (partition key = `${sensorId}`)
2. **ThresholdAlertRule** — SQL filter on out-of-range voltage/frequency → Step Functions `StartExecution`

**Device simulator:** Lambda function that publishes to IoT Core via the IoT Data Plane SDK (`@aws-sdk/client-iot-data-plane`). No actual MQTT client needed — the SDK handles the HTTP endpoint. For real device simulation, use `aws-iot-device-sdk-v2`.

**Device auth in POC:** Use IoT Core test certificates (generated in console or via CDK custom resource). Not for production — production devices use fleet provisioning.

---

## DynamoDB Data Model

**Readings table**

| Key | Value | Notes |
|-----|-------|-------|
| `pk` (PK) | `sensorId` | Even distribution; per-sensor ordering |
| `sk` (SK) | `timestamp#readingType` | Time-window range queries |
| `ttl` | epoch + 30 days | Auto-expire hot data |

**Access patterns:**
- All readings for a sensor → `pk = sensorId`
- Readings in time range → `pk = sensorId, sk BETWEEN from AND to`
- Readings by type in range → GSI on `readingType + timestamp`

**Why `sensorId` not `gridZone` as PK:** Grid events cause correlated spikes — all sensors in one zone emit simultaneously. `gridZone` partitioning creates hot shards under exactly the load that matters. `sensorId` distributes evenly and preserves per-sensor event ordering.

**Idempotency table** — managed by Lambda Powertools. Do not modify its schema.

---

## SensorEvent Schema

```typescript
{
  sensorId:    string   // pattern: sensor-[a-z0-9-]+
  timestamp:   string   // ISO 8601 datetime
  readingType: 'voltage' | 'current' | 'frequency' | 'power_factor' | 'temperature'
  value:       number   // finite
  unit:        string   // max 16 chars
  gridZone?:   string   // optional — used for GSI queries and IoT rule filtering
}
```

---

## Step Functions Design

**AlertWorkflow** (Standard Workflow):
1. `NotifyOps` — Lambda invocation; sends SNS notification with sensor reading and threshold info
2. `WaitForAck` — Wait state, 15 minutes
3. `IsAcknowledged` — Choice state; checks `$.acknowledged` boolean
4. → True: `AlertResolved` (Succeed state)
5. → False: `EscalateToOnCall` — Lambda invocation with `escalated: true`

**Why Standard, not Express:**
- Execution history retained 90 days — auditable for safety-critical grid events
- Wait state without a running Lambda — Express Workflows can't wait
- Per-step retry configuration — if notification Lambda fails transiently, retry that step only

**Threshold values (configurable via CDK context):**
- Frequency: < 59.5 Hz or > 60.5 Hz (NERC standard ±0.5 Hz)
- Voltage: < 114V or > 126V (nominal 120V ±5%)

---

## Observability

**Metrics namespace:** `GridSensorPipeline`

| Metric | Unit | Emitted by |
|--------|------|-----------|
| `EventsProcessed` | Count | processor (dimensioned by `ReadingType`) |
| `ProcessingLatencyMs` | Milliseconds | processor (dimensioned by `ReadingType`) |
| `ValidationErrors` | Count | processor |
| `PartialBatchFailures` | Count | processor |
| `DuplicateWrites` | Count | processor |
| `DlqMessagesReceived` | Count | dlq-inspector |
| `BedrockInvocations` | Count | alert-handler (via `lib/llm-client.ts`) |
| `BedrockLatencyMs` | Milliseconds | alert-handler (via `lib/llm-client.ts`) |
| `BedrockTokensUsed` | Count | alert-handler — sum of input + output tokens per call. **Alarm watches this.** |
| `BedrockFallback` | Count | alert-handler — incremented on Bedrock error / parse failure (caller's fail-soft path) |
| `QueriesServed` | Count | query |
| `QueryLatencyMs` | Milliseconds | query |
| `QueryItemsReturned` | Count | query |
| `QueryValidationErrors` | Count | query |
| `QueryFailures` | Count | query |
| `AlertWorkflowStarted` | Count | IoT Rules Engine (CloudWatch auto-metric) |
| `AlertWorkflowFailed` | Count | Step Functions (CloudWatch auto-metric) |

**Alarms:**
- `GridSensor-DLQ-Messages` — DLQ depth ≥ 1 → ops-alerts SNS
- `GridSensor-P99-Latency` — P99 > 2000ms for 3 min (voltage canary) → ops-alerts SNS
- `AlertWorkflow-Failures` — Step Functions `ExecutionsFailed` ≥ 1 → ops-alerts SNS
- `BedrockTokens-Runaway` — `Sum(BedrockTokensUsed) > 1,000,000` over 60-minute window on the `grid-sensor-alert-handler` service dimension → ops-alerts SNS. Cost guardrail; rationale + re-evaluation triggers documented inline in `observability-stack.ts`.

**Datadog bridge (production):** Add Datadog Lambda Extension layer + `DD_API_KEY_SECRET_ARN` env var. EMF metrics forward automatically. No application code changes required.

---

## Architectural Invariants

1. **Validate at the I/O boundary only.** `validateSensorEvent()` called once in `processor.ts` immediately after Kinesis decode. `lib/` receives `SensorEvent`, not `unknown`.

2. **No I/O in `lib/`.** `validator.ts`, `types.ts`, `threshold.ts` have zero AWS SDK calls. `repository.ts` has DynamoDB only. Handlers orchestrate; lib executes.

3. **`threshold.ts` is a pure function.** Takes `SensorEvent`, returns `{ exceeded: boolean, details: string }`. No side effects. This is the logic Step Functions evaluates — it must be independently testable.

4. **No business logic in handlers.** Handlers wire lib functions and manage Powertools lifecycle.

5. **Idempotency key = Kinesis sequence number.** Globally unique per shard, stable across retries. Do not change.

6. **`ConditionExpression: 'attribute_not_exists(pk)'` on every DynamoDB write.** Belt-and-suspenders on top of Powertools idempotency.

7. **Always return `batchItemFailures`.** Never throw from the top-level Kinesis handler.

8. **Emit metrics before throwing.** `metrics.publishStoredMetrics()` in the `finally` block always.

9. **`bisectOnError: true` on Kinesis ESM.** Set in CDK. Do not remove.

10. **Step Functions Standard Workflow for alert escalation.** Never replace with a Lambda chain — the audit trail is a requirement for safety-critical grid events.

---

## Environment Variables

| Variable | Used by | Value |
|---|---|---|
| `READINGS_TABLE` | processor, query | DynamoDB readings table name |
| `IDEMPOTENCY_TABLE` | processor | DynamoDB idempotency table name |
| `KINESIS_STREAM_NAME` | simulator (fallback) | Kinesis stream name. Removed from dlq-inspector env in P8.2 — restore when replay-to-Kinesis ships. |
| `IOT_ENDPOINT` | simulator | IoT Core data endpoint (from `aws iot describe-endpoint`) |
| `ALERT_TOPIC_ARN` | alert-handler, dlq-inspector | SNS topic ARN |
| `ALERT_STATE_MACHINE_ARN` | (injected by IoT rule — not in Lambda env) | Step Functions ARN |
| `BEDROCK_MODEL_ID` | alert-handler (read by `lib/llm-client.ts`) | Bedrock model identifier — for current Sonnet, this is the cross-region inference profile id `us.anthropic.claude-sonnet-4-6`, not a bare foundation-model id. **Single source of truth with the IAM grant** in `alert-workflow-stack.ts` (the constant `BEDROCK_MODEL_ID` there is consumed by both the env var and the `bedrock:InvokeModel` resource ARN, so they can never silently drift). |
| `OPS_ALERT_TOPIC_ARN` | dlq-inspector | Ops-alerts SNS topic ARN (separate from grid-event `ALERT_TOPIC_ARN` — different audience, different SLA). |
| `REPLAY_TO_KINESIS` | dlq-inspector | `true`/`false`. Currently a stub — flag-set logs a warning, no records replayed. See `phase-06-dlq-observability.md` pre-flight 1. |
| `POWERTOOLS_SERVICE_NAME` | all Lambdas | e.g., `grid-sensor-processor`, `grid-sensor-alert-handler`, `grid-sensor-dlq-inspector`, `grid-sensor-query`. Default `service` dimension on all EMF metrics — observability widgets and alarms must filter at this dimension. |
| `POWERTOOLS_METRICS_NAMESPACE` | all Lambdas | `GridSensorPipeline` |
| `LOG_LEVEL` | all Lambdas | `INFO` prod, `DEBUG` dev. **Cost lever:** verbose `DEBUG` logging on the alert handler can multiply CloudWatch Logs ingest cost during prompt-iteration sessions. Drop back to `INFO` after debugging. |

---

## Testing Approach

- **Unit tests only** in `src/__tests__/` — mock the AWS SDK with `jest.mock`
- Test `validator.ts` exhaustively: valid events, invalid sensorId, missing fields, non-finite values
- Test `threshold.ts` exhaustively: in-range, out-of-range for each readingType, boundary values
- Test `repository.ts` with mocked `DynamoDBDocumentClient` — verify command shapes
- Test `processor.ts`: valid batch, batch with one invalid record, full batch failure
- No integration tests — the deployed pipeline is the integration test

---

## Hard Rules

- **No `any`.** Strict mode on. Fix the type.
- **No `console.log`.** Use Powertools Logger. `console.log` bypasses structured logging and breaks CloudWatch Logs Insights queries.
- **No bare `catch`.** Always log with `logger.error()` including `sensorId` or sequence number.
- **No hardcoded resource names.** All table names, ARNs, stream names come from environment variables set by CDK.
- **No `cdk deploy --require-approval never`** until stable.
- **`cdk destroy --all` after dev sessions.** IoT Core charges per message; Kinesis per shard-hour.
