# Phase 3 — Storage + Processing CDK Stacks

Status: **pre-flight & implementation**. First infrastructure phase. Three
separate CDK stacks (storage, kinesis, processing) with cross-stack
references via constructor props.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P3 pre-flight 1 — DynamoDB billing: on-demand (`PAY_PER_REQUEST`)

**Concept.** Choose the billing mode that matches the load shape.

**Decision.** On-demand for both readings and idempotency tables.

**Why.** Grid event traffic is bursty — correlated zone-wide spikes are
exactly the load that matters most. Provisioned billing would either over-
provision for the baseline (paying for capacity 95% of the time you don't
need) or throttle during the spike that actually counts.

**Alternatives.**
- **Provisioned with autoscaling** — cheaper at sustained high RCU/WCU, but
  autoscaling is reactive and lags the spike by minutes. By the time it
  scales out, the grid event is over.
- **Provisioned with reserved capacity** — only pays off above ~70%
  utilization sustained. Doesn't fit a spiky workload.

**Cost lens.** On-demand is more expensive per write at high steady-state
volume but cheaper for our spiky pattern. A typical cost crossover with
provisioned + autoscaling is ~14× the request volume of average; we're
nowhere near that. **Pattern: pick billing mode by load shape, not by
intuition about cost.**

**Tradeoff accepted.** No provisioned-cost predictability. For a portfolio
project, this doesn't matter; in production, we'd revisit once steady-state
is known.

---

## P3 pre-flight 2 — Kinesis: 1 shard, 24h retention

**Concept.** Right-size the streaming backbone to the throughput that
actually matters; keep retention coupled to the consumer's idempotency TTL.

**Decision.** 1 shard, 24h retention.

**Why.** 1 shard handles 1 MB/s ingest and 1000 records/s — orders of
magnitude above POC volume. 24h retention is the Kinesis default and
matches the 25h idempotency TTL we set in P2 (state outlives delivery
jitter). If retention here ever changes, the TTL must change in lockstep.

**Cost lens.** ~$0.015/hr/shard ≈ $11/month. Extended retention (up to
8760h) adds linear cost. For the POC, default is right; extending would
require a defensible reason.

**Tradeoff accepted.** Single-shard means no parallel consumer scaling.
Production sizing would be `peak ingest / 1 MB/s` shards, with concomitant
TTL adjustments if retention is extended.

---

## P3 pre-flight 3 — Firehose buffering: 5 min / 5 MB, GZIP JSON

**Concept.** Trade analytical lag for S3 PUT cost.

**Decision.** Industry-default buffering — 5 min interval / 5 MB size,
GZIP compressed, JSON output (Parquet conversion deferred).

**Why.** Smaller buffers ⇒ more S3 PUTs ⇒ more cost. Larger buffers ⇒ more
analytical lag. 5 min / 5 MB is the standard balance and matches what most
data-engineering teams adopt as the default.

**Alternatives.**
- **60 s / 1 MB** — sub-minute analytical freshness, ~5× more S3 PUTs.
  Worth it for real-time dashboards; not for cold archive.
- **Parquet output** — Firehose can convert with a Glue schema. Defers to
  Phase 6 where the observability work surfaces a real querying need.

**Cost lens.** S3 PUT pricing is $0.005 per 1000 requests. At 5 MB/buffer
and continuous traffic, ~12 PUTs/hour ≈ $1.05/year — negligible. JSON is
~3× larger than Parquet but compresses well with GZIP, so storage cost is
a wash for our volume.

**Tradeoff accepted.** No Parquet means slower Athena queries. Acceptable
because the use case for the cold archive is forensic, not real-time.

---

## P3 pre-flight 4 — Lambda: 512 MB, 30s timeout, ESM batch=10 / window=1s

**Concept.** Match Lambda config to the per-record cost profile.

**Decision.** 512 MB memory, 30 s timeout. Kinesis ESM with batchSize=10,
maxBatchingWindow=1s.

**Why.** Powertools Logger/Tracer/Metrics need ~256 MB headroom; 512 MB is
the comfort zone for cold starts on Node 20. 30 s timeout covers worst-case
DynamoDB throttling retries. Batch of 10 keeps p99 latency low while still
amortizing invocation cost across multiple records.

**Cost lens.** Lambda is billed per ms × per MB. Doubling memory from 256 to
512 doubles per-ms cost but typically halves duration (faster CPU at higher
memory tiers), so wall-clock cost is roughly equivalent. Smaller batches
cost more per invocation but reduce per-record latency. The pattern:
**memory and batch size are coupled levers; tune both with metrics from
production.**

**Tradeoff accepted.** Smaller batches mean more invocations and more
CloudWatch Logs lines. Acceptable at POC volume; revisit if Logs cost
becomes the dominant line item.

---

## P3 pre-flight 5 — ESM: `bisectOnError=true`, `reportBatchItemFailures=true`, retry=5, DLQ via SQS

**Concept.** Layered failure isolation for at-least-once stream consumers.

**Decision.** All four flags on the Kinesis ESM:
- `bisectBatchOnError: true` — splits a failing batch in half to isolate
  the bad record (CLAUDE.md hard rule #9).
- `reportBatchItemFailures: true` — handshake with the handler's
  `batchItemFailures` response shape.
- `retryAttempts: 5` — bounds the retry storm.
- `maxRecordAge: 24h` — match Kinesis retention.
- `onFailure: SQS DLQ` — terminal destination for surviving bad records.

**Why all four.** Each handles a different failure regime:
- Bisection handles "which record in the batch is bad?"
- Partial failure response handles "report success on the good ones."
- Retry attempts bound the cost of a poison pill (no infinite retries).
- DLQ catches what survives the retry budget so it doesn't get lost.

**Cost lens.** Without these, a single bad record creates retry storms
(retry-loop cost) or full data loss (incident-response cost). With them,
failures cost a few extra invocations of the bisected batch and one SQS
message per dead record. **Pattern: layered failure handling is cheaper
than either of the two alternative tail risks.**

**Tradeoff accepted.** Bisection has measurable latency overhead during
failure events. Acceptable because failure events are rare by design.

---

## P3 pre-flight 6 — `RemovalPolicy.DESTROY` on every stateful resource

**Concept.** POC-grade hygiene — `cdk destroy --all` must actually remove
everything to keep AWS bills clean.

**Decision.** `removalPolicy: cdk.RemovalPolicy.DESTROY` on DynamoDB
tables, S3 archive bucket, and SQS queues. `autoDeleteObjects: true` on
the S3 bucket.

**Why.** Production systems use `RETAIN` to prevent accidental deletes.
This is a portfolio POC; the explicit `cdk destroy` workflow only works
if every resource agrees to be destroyed.

**Cost lens.** Direct cost-saving — orphaned DynamoDB tables and S3
buckets are the most common silent-cost source after a dev session. POC
posture eliminates that risk.

**Tradeoff accepted.** Production-grade safety needs to be added before
any real deployment. Documented in `CLAUDE.md` and the README.

---

## P3 pre-flight 7 — Three separate stacks (storage / kinesis / processing)

**Concept.** Stack boundary = blast radius and lifecycle boundary.

**Decision.** Three stacks rather than one combined.

**Why.** Each stack has a different lifecycle:
- Storage tables persist across infrastructure changes; redeploying the
  processor shouldn't touch them.
- The Kinesis stream and Firehose are stable infrastructure.
- The processor Lambda changes most frequently.

Separate stacks mean a `cdk deploy ProcessingStack` doesn't risk the
storage tier, and a stack-level rollback isolates the failure domain.

**Cost lens.** No direct cost difference — CloudFormation stacks are free.
Indirect savings: faster deploys (only the changed stack rebuilds), and
lower blast-radius during a failed deploy (only the changed stack rolls
back).

**Tradeoff accepted.** Cross-stack references via constructor props add a
small amount of CDK boilerplate. Worth it for the lifecycle separation.

---

## Cross-cutting Phase 3 framing

Every infrastructure decision in this phase exhibits the same meta-pattern:
**a knob whose conservative default costs more, where loosening costs
correctness or operational visibility.** The right answer per-knob:

- DynamoDB billing → **on-demand** (cheaper for spiky load).
- Kinesis sizing → **smallest shard count that handles peak ingest**.
- Firehose buffering → **5 min default** (industry sweet spot).
- Lambda memory → **the floor where Powertools doesn't swap**.
- ESM safety flags → **all on** (failure isolation is mandatory).
- Removal policy → **DESTROY for POC, RETAIN for production**.
- Stack composition → **boundaries follow lifecycle, not category**.

Three durable patterns this phase encodes:

1. **Billing mode follows load shape** — on-demand for spiky, provisioned
   for steady-state.
2. **Stream retention couples to consumer idempotency TTL** — they must
   change together or the dedup contract breaks.
3. **Stack boundaries follow lifecycle** — not technology category, not
   resource type. The boundary is "what fails together, deploys together,
   rolls back together."
