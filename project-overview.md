# Grid Sensor Pipeline — Project Overview (Interview Reference)

*A layered reference for expanding on the project. Open with the **one-liner**, walk the **end-to-end flow** if they want the shape, then go as deep as they pull — building blocks, the Powertools four, or the design decisions. Grounded in the project README.*

---

## One-liner

A cloud-native, serverless telemetry and event-processing platform for green-energy grid infrastructure: IoT sensors publish readings over MQTT, the pipeline ingests, validates, stores, and alerts in real time with full observability and zero data loss under failure. Built end-to-end in TypeScript with AWS CDK.

## Two-sentence version

Distributed grid sensors publish telemetry over MQTT to AWS IoT Core, where a rules engine splits the stream two ways — all readings flow through Kinesis to an idempotent Lambda processor that writes to DynamoDB, while threshold breaches route straight to a Step Functions workflow for auditable alert escalation. Everything is instrumented with AWS Lambda Powertools (structured logs, EMF metrics, X-Ray tracing, idempotency), backed by a DLQ with replay and a Kinesis Firehose cold archive to S3 for future ML workloads.

---

## End-to-end flow (the narrative I walk through)

A reading starts at a **sensor** (a TypeScript Lambda simulator stands in for hardware) and is published to **AWS IoT Core** over MQTT on `sensors/{sensorId}/telemetry`, with X.509 device auth. The **IoT Rules Engine** routes it two ways at the edge:

1. **All telemetry → Kinesis Data Streams**, partitioned by `sensorId` so readings stay ordered per sensor and the stream is replayable.
2. **Threshold breaches → Step Functions** directly — the breach condition is simple SQL evaluated in the rules engine, so a safety alert never waits on a Lambda cold start.

From Kinesis, the **Processor Lambda** (Kinesis event-source mapping, batch size 10, `bisectOnError`) validates each record with Zod, then writes it to **DynamoDB** (`PK: sensorId`, `SK: timestamp`, 30-day TTL). Failed records isolate to an **SQS DLQ**, where a **DLQ Inspector Lambda** logs them, raises an SNS alert, and can replay them back to Kinesis. In parallel, **Kinesis Firehose** archives every raw event to **S3 as Parquet**, partitioned by date and sensor — the cold path for future ML/predictive workloads.

The breach path runs a **Step Functions Standard Workflow**: Notify ops → Wait 15 min for acknowledgment → Choice → Escalate if unacknowledged. A **Query API** (API Gateway + Lambda) exposes range reads — `GET /sensors/{id}/readings?from=&to=`. The whole system reports to **CloudWatch** via Powertools, with a Datadog bridge available in production.

---

## Building blocks (what each piece is doing and why)

**AWS IoT Core** — MQTT broker plus X.509 device auth and the Rules Engine. The rules-based split (telemetry vs. alerts) is a deliberate decision: it decouples the alert path from the data path so a processor cold start can't delay a safety alert, and the threshold SQL runs without any Lambda invocation.

**Kinesis Data Streams** — ordered-per-sensor, replayable streaming buffer. Partition key is `sensorId`, not `gridZone`, because grid events cause correlated spikes — every sensor in a zone fires at once when something upstream fails, which would hot-shard a zone-based key right when load matters most.

**Processor Lambda** — the heart of the hot path. Kinesis ESM with `bisectOnError: true` and `batchItemFailures` so one bad record is isolated and retried rather than failing or silently dropping the whole batch. Validates at the I/O boundary with Zod, writes through a thin `SensorRepository`.

**DynamoDB** — hot storage, `sensorId`/`timestamp` key, 30-day TTL so the table self-prunes. A separate table backs idempotency.

**Step Functions (Standard Workflow)** — auditable alert escalation: 90-day execution history, a native Wait state for the ack window with no running Lambda, and per-step retries so a transient notification failure retries only that step. Chosen over a Lambda chain specifically for these guarantees in a safety-critical path.

**SQS DLQ + Inspector Lambda** — failure visibility and a safe replay path. A pipeline with no DLQ is one where failures are invisible until a data gap shows up days later.

**Kinesis Firehose → S3 (Parquet)** — zero-code raw-event cold archive, the foundation for predictive maintenance and ML model training later.

**Query API (API Gateway + Lambda)** — range queries by sensor and time window over DynamoDB.

**AWS CDK v2** — all of it as type-safe infrastructure in TypeScript, composed into focused stacks (`iot-stack`, `kinesis-stack`, `processing-stack`, `alert-workflow-stack`, `storage-stack`, `query-stack`, `observability-stack`).

---

## The Powertools four (the observability + reliability layer)

Every Lambda is instrumented with **AWS Lambda Powertools**, which gives the whole fleet one consistent, opinionated API for the production concerns that matter. I use four of its utilities.

**Logger — structured JSON logging.** Every log line is structured, never string concatenation. The `injectLambdaContext` decorator wraps the handler and automatically stamps each line with request ID, function name, and the cold-start flag, plus any keys I append like `sensorId` and `readingType`. That makes the logs queryable in CloudWatch Logs Insights — `sensorId` is a real field I can filter and group by, not a substring to regex out. On the error path I log the Kinesis sequence number alongside the error so a DLQ record traces straight back to its source.

**Tracer — X-Ray distributed tracing.** A thin wrapper over the X-Ray SDK. `captureLambdaHandler` auto-instruments the handler and patches the AWS SDK clients, so the DynamoDB write shows up as its own timed segment for free. Where I want sharper resolution I open a manual subsegment around the processing logic and close it in a `finally`, which separates "my code" from "the downstream call" in the trace. Tracing is also enabled on the Step Functions state machine, so the escalation path produces its own trace. This is what makes it *distributed* observability — a single reading crosses IoT Core, Kinesis, Lambda, and DynamoDB, and the trace stitches that into one timeline.

**Metrics — custom business metrics via EMF.** This is the one worth understanding deeply. Instead of calling the CloudWatch `PutMetricData` API synchronously — a network round-trip on the hot path, subject to throttling — Powertools buffers metrics during the invocation and `publishStoredMetrics()` flushes them as a single specially-shaped log line to stdout (Embedded Metric Format). CloudWatch parses that line out-of-band and materializes real metrics. So a custom metric costs a `console.log`, not an API call. Under the `GridSensorPipeline` namespace I emit `EventsProcessed`, `ProcessingLatencyMs`, `ValidationErrors`, and `PartialBatchFailures`, dimensioned by `ReadingType` so I can see whether voltage is failing differently from frequency.

**Idempotency — exactly-once processing.** `makeIdempotent` with a DynamoDB persistence layer, keyed on the **Kinesis sequence number** — globally unique per shard and stable across Lambda retries. Combined with a DynamoDB conditional write (`attribute_not_exists(pk)`), the processor is safe to retry without producing duplicates. Idempotency at the consumer is cheaper and simpler than transactional semantics across the boundary.

The architectural payoff: the application code only knows how to write structured logs and EMF to stdout. *Where* the telemetry goes — CloudWatch natively, or Datadog via the Lambda Extension layer — is an infrastructure decision, not a code change. Instrument once, route in infrastructure.

---

## Observability specifics (if they pull on alarms)

Metrics namespace is `GridSensorPipeline`. The alarms watch symptoms a human should act on, not vanity metrics:

- **DLQ depth ≥ 1 → SNS, immediate.** A record reaching the DLQ is a sensor reading I can't account for — for grid telemetry that's not noise.
- **P99 processing latency > 2000ms for 3 min → SNS.** P99, not average, because the average looks fine right up until the tail causes an outage.
- **Step Functions `ExecutionsFailed` ≥ 1 → SNS.** The alert workflow is the safety path; an alert about a failed alert is the worst case.

The **Datadog bridge** is added purely as a CDK layer plus environment variables — the EMF that already goes to CloudWatch Logs is parsed and forwarded by the Datadog Lambda Extension, with structured log fields mapping directly to Datadog tags. No application code changes.

---

## Key design decisions worth defending

**Idempotency key = Kinesis sequence number** — globally unique per shard, stable across retries; conditional write guarantees no duplicates without transactional overhead.

**`bisectOnError` + `batchItemFailures`** — the correct pattern for any at-least-once Kinesis consumer: isolate and retry the bad record, route it to the DLQ after max retries, never fail or drop the whole batch.

**Step Functions Standard Workflow over a Lambda chain** — auditable 90-day history, native Wait state for the ack window, per-step retries. More infrastructure, justified for a safety-critical escalation.

**IoT Rules Engine routing (telemetry vs. alerts split)** — decouples the alert path from the data path so a cold start can't delay a safety alert; the threshold SQL runs in the rules engine with no Lambda invocation.

**DynamoDB partition key = `sensorId`, not `gridZone`** — avoids hot shards under correlated zone-wide spikes while preserving per-sensor ordering.

---

## Quick facts for credibility

- **Language/IaC:** TypeScript (Node 20), AWS CDK v2, multi-stack composition.
- **Validation:** Zod at the I/O boundary; pure threshold logic unit-tested with no I/O.
- **Thresholds:** frequency < 59.5 or > 60.5 Hz (NERC ±0.5 Hz), voltage < 114 or > 126 V (120 V ±5%) — real grid standards, configurable via CDK context.
- **Cost:** ~$5–10 for an active dev week; `cdk destroy --all` after sessions.
- **Why I built it:** to defend real architectural decisions — idempotency, partition strategy, alert orchestration, observability boundaries — the way I would in a design review.

---

## Where to go deeper

- Observability spoken track: `observability-interview-track.md`
- Architecture, code snippets, ADR rationale: `grid-sensor-pipeline.md` and `portfolio-entry.md`
- Source of truth for stack, schema, alarms, cost: `README.md`
