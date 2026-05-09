# AWS Kinesis — Cheatsheet

Working-engineer reference grounded in this project's Phase 3 implementation.
For the full picture, see the linked AWS docs at the bottom.

> **Where this is used in the project:** `infra/lib/kinesis-stack.ts`
> (Data Stream + Firehose archive) and `infra/lib/processing-stack.ts`
> (Lambda ESM consumer). Decision rationale lives in
> [`docs/decisions/phase-03-storage-processing.md`](../decisions/phase-03-storage-processing.md).

---

## Mental model

Kinesis Data Streams is a managed, partitioned, replayable, append-only
log. Conceptually: Kafka without the broker ops. You write records,
consumers read records, records are durable for a retention window.

If you understand Kafka topics, partitions, and offsets, the Kinesis
mapping is:

| Kafka | Kinesis |
|---|---|
| Topic | Stream |
| Partition | Shard |
| Offset | Sequence number |
| Consumer group | Lambda ESM (or KCL app) |

---

## Three Kinesis services (this project uses two)

| Service | What it is | Use case in this project |
|---|---|---|
| **Data Streams (KDS)** | Raw stream — you bring the consumer | Real-time pipeline (hot path → processor Lambda) |
| **Data Firehose** | Managed delivery to S3/Redshift/etc., zero-code consumer | Cold archive (every event → S3 for forensics) |
| Managed Service for Apache Flink (formerly Kinesis Data Analytics) | Streaming SQL/analytics over a stream | Not used |

---

## Core concepts

### Stream
The named log itself. Has a region, retention period (24 h default, up to
365 d), and a stream mode (Provisioned or On-Demand).

### Shard
Horizontal partition of a stream. Capacity per shard:

- **1 MB/s** ingest
- **2 MB/s** read (shared across all standard consumers)
- **1000 records/s** ingest

Throughput scales with shard count. We use 1 shard — orders of magnitude
above POC volume.

### Partition key
String the producer attaches to each record. Hashed to determine which
shard receives the record. **Same partition key always lands on the same
shard**, which is how Kinesis preserves per-key ordering.

In this project, the IoT rule sets `partitionKey: ${sensorId}` so all
readings from one sensor are processed in order. Choosing `gridZone`
instead would create hot shards under correlated zone-wide events —
exactly the load that matters most.

### Sequence number
Unique, monotonically increasing identifier per shard. Stable across
Lambda retries — which is *exactly* why we use it as the idempotency
key in the processor (P2 decision log).

Sequence numbers are **shard-scoped**, not globally unique across the
whole stream. With 1 shard this distinction doesn't matter; with N
shards you'd need `(shardId, sequenceNumber)` to uniquely identify a
record across the stream.

### Stream mode
- **Provisioned** — pay per shard-hour. Predictable cost, manual scaling.
  Right for known throughput.
- **On-Demand** — pay per GB throughput, auto-scales up to 200 MB/s.
  Cheaper for spiky workloads, more expensive at sustained high
  throughput. Crossover is around 70% sustained utilization.

---

## Lambda Event Source Mapping (ESM) tuning knobs

Every knob below is in `infra/lib/processing-stack.ts`. These are the
parameters that determine how Lambda consumes from Kinesis.

| Knob | What it does | Project value | Why |
|---|---|---|---|
| `batchSize` | Max records per Lambda invocation | 10 | Small batches = lower p99 latency, more invocations |
| `maxBatchingWindow` | Max wait time for a batch to fill | 1 s | Coupled with batchSize as the latency knob |
| `bisectBatchOnError` | On failure, halve the batch and retry to isolate the bad record | true | CLAUDE.md hard rule #9 |
| `reportBatchItemFailures` | Handler returns `{ batchItemFailures: [...] }`, only those records retry | true | Without this, one bad record forces the whole batch to retry |
| `retryAttempts` | Max retries per record before DLQ | 5 | Bounds the retry storm |
| `maxRecordAge` | Drop records older than this | 24 h | Match Kinesis retention so we don't replay forever |
| `onFailure` | Destination for records that exhausted retries | SQS DLQ | Terminal sink for poison pills |
| `startingPosition` | Where the consumer starts reading on first deploy | TRIM_HORIZON | Process all in-flight records on first deploy |
| `parallelizationFactor` | Concurrent Lambda invocations per shard (1–10) | 1 (default) | Bumping this gives you parallelism within a shard at the cost of ordering |

---

## Producer & consumer options

### Producers (how records get into the stream)
- **PutRecord / PutRecords API** — direct SDK calls. Single record or up
  to 500 per batch.
- **Kinesis Producer Library (KPL)** — Java client with batching,
  aggregation, retry. Not used here.
- **AWS IoT Rules engine** — declarative SQL routing from MQTT topics to
  Kinesis. We use this in P4: `SELECT *, topic(2) AS sensorId FROM
  'sensors/+/telemetry'`.
- **Kinesis Data Firehose** — managed producer for delivering to S3 etc.
  We use this for the cold archive.

### Consumers (how records get out)
- **Lambda ESM** — managed consumer. Lambda runtime polls Kinesis,
  batches, invokes your function. Simplest pattern. We use this.
- **Kinesis Client Library (KCL)** — for self-hosted consumers (EC2,
  ECS). Not used here.
- **Enhanced fan-out** — dedicated 2 MB/s per consumer (vs shared 2 MB/s
  across consumers). Higher throughput, $$. Not needed for this project.

---

## Sequence number & idempotency (the P2 connection)

The reason this matters for the processor:

- Sequence numbers are stable across retries — the same record retried
  has the same sequence number every time.
- They're shard-scoped unique — within one shard, no two records ever
  share a sequence number.
- They're monotonically increasing — useful for ordering checks.

Powertools' idempotency utility uses `kinesis.sequenceNumber` as the
dedup key (set via `eventKeyJmesPath` in the processor). Combined with
the readings table's `attribute_not_exists(pk)` conditional write, the
pipeline is idempotent under retry without any application-level
dedup logic.

---

## The four pitfalls that bite people new to Kinesis

1. **Hot shard.** Partition key with skewed distribution → one shard
   saturated, the rest idle. The classic anti-pattern is partitioning by
   a value that correlates with traffic spikes (in this project: any
   sensor-aggregating key like `gridZone`). Watch the
   `IteratorAgeMilliseconds` metric per shard — divergence between
   shards signals hot-shard skew.

2. **No partial-failure handling.** Without `reportBatchItemFailures`,
   one bad record forces the *whole batch* to retry. This is expensive,
   slow, and noisy. The handshake is two-sided: the ESM has to be
   configured for it (`reportBatchItemFailures: true`) AND the handler
   has to return the right shape (`{ batchItemFailures: [...] }`).

3. **TRIM_HORIZON on a hot redeploy.** A redeploy with TRIM_HORIZON can
   replay the entire retention window. Lambda ESM is smart about this
   on most updates (it retains its checkpoint), but it's worth knowing
   that the *first* deploy will start from the oldest available record.

4. **Cost surprise from extended retention.** Past 24 h, retention is
   per-shard-hour. 1 year of retention on 1 shard ≈ $130/year *just for
   retention*. Always couple retention to the consumer's idempotency
   TTL so they change together (this is why the P2 idempotency TTL is
   25 h and the Kinesis retention is 24 h — flagged in the P3 decision
   log as a deployment-time dependency).

---

## Cost levers, ordered by impact

1. **Shard count.** Provisioned mode pays per shard-hour. 1 shard ≈
   $11/month. Production sizing = `peak ingest / 1 MB-per-shard`.
2. **Extended retention.** Beyond 24 h is per-shard-hour. Linear in
   retention duration.
3. **Enhanced fan-out.** Per consumer, per shard. Skip until you have a
   measurable contention problem.
4. **Cross-region replication.** Extra. Skip until you have a
   disaster-recovery requirement.

On-Demand mode is cheaper than Provisioned for spiky workloads but more
expensive at sustained high throughput.

---

## Cheatsheet of CLI commands

```bash
# List streams
aws kinesis list-streams

# Describe a stream (shard count, retention, etc.)
aws kinesis describe-stream --stream-name grid-sensor-pipeline-telemetry

# Put a single record (used in our smoke test)
aws kinesis put-record \
  --stream-name grid-sensor-pipeline-telemetry \
  --partition-key sensor-001 \
  --data '{"sensorId":"sensor-001","timestamp":"2026-05-08T18:00:00Z","readingType":"voltage","value":120,"unit":"V"}'

# Get a shard iterator (TRIM_HORIZON = oldest available)
aws kinesis get-shard-iterator \
  --stream-name grid-sensor-pipeline-telemetry \
  --shard-id shardId-000000000000 \
  --shard-iterator-type TRIM_HORIZON

# Read records from that iterator
aws kinesis get-records --shard-iterator <iterator-from-above>
```

---

## Learning resources

Ordered by what's most useful first.

### Official docs (with examples you can run)
- **[Kinesis Data Streams Developer Guide](https://docs.aws.amazon.com/streams/latest/dev/)**
  — read the "Key Concepts" and "Producer/Consumer" sections; skim the
  rest.
- **[Lambda + Kinesis Event Source Mapping](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html)**
  — the canonical reference for every flag in our `processing-stack.ts`.
- **[Kinesis Best Practices](https://docs.aws.amazon.com/streams/latest/dev/kinesis-low-latency.html)**
  — short, practical.
- **[Kinesis Data Streams FAQ](https://aws.amazon.com/kinesis/data-streams/faqs/)**
  — surprisingly good for quick "wait, can it do X?" lookups.

### Hands-on workshops
- **[AWS Kinesis Data Streams Workshop](https://catalog.workshops.aws/kinesis-data-streams/)**
  — official self-paced.
- **[Serverless Land — Kinesis patterns](https://serverlessland.com/patterns?services=kinesis)**
  — copy-paste-able CDK examples for common pipelines.

### Conceptual depth (worth the time investment)
- **_Designing Data-Intensive Applications_ by Martin Kleppmann,
  Chapter 11 ("Stream Processing").** Maps 1:1 onto Kinesis but teaches
  the underlying patterns so when you encounter Kafka, Pulsar, or
  Pub/Sub you're thinking in the same model.
- **AWS re:Invent talks** — search YouTube for *"Kinesis Data Streams
  Deep Dive"*. The 2022 and 2023 versions are both solid. ~45 minutes
  each, dense but practical.

### Comparison context
- **Kinesis vs Kafka** — Confluent's writeup (biased, but technically
  accurate): https://www.confluent.io/learn/kinesis-vs-kafka/
- **AWS re:Invent talk *"Choose the right messaging service for your
  workload"*** — covers Kinesis vs SQS vs SNS vs MQ vs MSK in one
  place. Great for understanding *when* to reach for Kinesis.

---

## When to revisit this note

- Before tuning ESM parameters (`batchSize`, `parallelizationFactor`,
  retry budget) based on production metrics.
- When evaluating whether to add a second shard (look at
  `IncomingBytes` and `WriteProvisionedThroughputExceeded` metrics
  per shard).
- When cost reviews flag Kinesis spend — start with shard count and
  retention.
- Before any conversation about the streaming layer in an interview or
  design review.

---

## Did I actually learn this? — self-test

Without looking back at this note, can you:

1. **State what a partition key does in one breath.**
2. **Name at least three of the ESM tuning knobs in our project and
   what each controls.** (Hint: there are at least seven.)
3. **Explain why `pk = sensorId` is the right choice over `pk = gridZone`
   for this project.** Reference the load shape that drove the decision.
4. **Cite the cost lens on shard count and retention.** Which knob has
   linear cost growth past which threshold?
5. **Explain the relationship between Kinesis retention and the
   processor's idempotency TTL.** Why must they change in lockstep?
6. **Name when you'd reach for Kafka over Kinesis** — what specific
   constraint makes one preferable to the other?

If you can answer all six fluently, you've internalized the streaming
layer. If question 5 trips you up, reread the "Sequence number &
idempotency" section — that's the one that ties the streaming layer
to the consumer's correctness contract, and it's the most-asked
follow-up in interviews about this kind of system.
