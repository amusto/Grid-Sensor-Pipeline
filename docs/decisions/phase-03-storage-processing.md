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

---

## Deploy lessons — four real-world snags

> Captured from the actual `cdk deploy --all` run on Day 1. Each is a
> defensible interview talking point about CDK / CloudFormation gotchas
> that aren't documented in the construct API but matter operationally.

### 1. IAM rejects non-ASCII characters in role descriptions

**What happened.** First deploy attempt failed at the `FirehoseRole`
resource with:

```
Value at 'description' failed to satisfy constraint: Member must satisfy
regular expression pattern: [	
 -~¡-ÿ]*
```

The `description` field was set to `'Firehose role for Kinesis → S3
archive'`. The em-dash arrow `→` (U+2192) sits outside IAM's accepted
character classes (tab/CR/LF + printable ASCII + Latin-1 Supplement).

**Fix.** Replaced `→` with `to` in the description string.

**Pattern lesson.** IAM is stricter than most AWS services about Unicode
in resource metadata. Defensive habit: keep CDK *string properties*
(not JSDoc comments) ASCII-only — especially `description`, `tags`, and
resource names. Comments are local-only and never reach AWS.

---

### 2. `Stream.grantRead()` doesn't include the legacy `kinesis:DescribeStream`

**What happened.** Second deploy attempt failed at `ArchiveDeliveryStream`
with:

```
Role ... is not authorized to perform: kinesis:DescribeStream on resource
arn:aws:kinesis:us-east-1:.../grid-sensor-pipeline-telemetry
```

CDK's `Stream.grantRead(grantee)` grants `kinesis:DescribeStreamSummary`,
`GetRecords`, `GetShardIterator`, `ListShards`, and `SubscribeToShard` —
but NOT `kinesis:DescribeStream` (the older API). Kinesis Firehose
specifically calls `DescribeStream` when configured with
`KinesisStreamAsSource`, so the role hit a hard auth failure.

**Fix.** Replaced the implicit `grantRead` with an explicit `inlinePolicies`
declaration listing every action Firehose needs:

```ts
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
  S3DestinationAccess: ...
},
```

**Pattern lesson.** CDK's `grant*` methods are convenient but their
action lists reflect *modern* SDK usage, not what every consuming service
actually calls. When wiring service A as the source / sink for service B,
verify service B's documented IAM requirements against what the CDK
grant emits. The mismatch is most common with services that predate the
modern SDK conventions (Firehose, Kinesis Producer Library, classic
ELB).

---

### 3. `addToPolicy` creates a race against dependent-resource creation

**What happened.** First fix attempt added `kinesis:DescribeStream` via
`firehoseRole.addToPolicy(...)`. Same auth-failure error returned.

**Diagnosis.** `addToPolicy` doesn't extend the role's resource
definition — it creates a *separate* `AWS::IAM::Policy` resource attached
to the role. CloudFormation's dependency graph only knows the Firehose
DeliveryStream depends on the role itself, not on the policy attachment.
CFN created them in parallel; Firehose attempted `DescribeStream` before
the inline policy attached.

**Fix.** Two-part: (a) move all permissions into the role constructor's
`inlinePolicies` so they're inseparable from the role's CFN resource, and
(b) add an explicit `deliveryStream.node.addDependency(firehoseRole)`
just to be belt-and-suspenders.

**Pattern lesson — adopt this as a default:**

> When a CDK construct needs IAM permissions to call another resource's
> API at create-time (Firehose reading from Kinesis, Lambda's first
> invocation, Step Functions invoking a target), prefer `inlinePolicies`
> in the role constructor over post-hoc `grant*` calls.

`grant*` is fine for runtime-only permissions where the consuming
resource doesn't need IAM to be ready at create-time. For create-time
auth, inline policies are the correctness-preserving choice.

---

### 4. CFN destroy silently leaks Kinesis streams (recurring class of failure)

**Promotion note (Day 3).** This started as a "captured twice" edge
case during the Day-1 deploy run. We've now hit it **four times** —
twice during Day-1 deploy churn, once on the Day-2 morning resume,
and again on Day-3's morning resume after a clean Day-2 evening
destroy. **At four occurrences in three days, this is no longer an
edge case; it's a recurring class of failure with this AWS service
combination.** Section reframed accordingly.

**What happens.** When `cdk destroy --all` (or a CFN rollback after a
failed deploy) tears down the stack containing
`AWS::Kinesis::Stream`, CloudFormation reports the stack-deletion
success cleanly. But the underlying `DeleteStream` API call against
Kinesis can race against any holder of a stream reference (Firehose
delivery stream as source, Lambda ESM consumer, or registered
enhanced-fan-out consumer). When the race is lost, the CFN stack is
gone but the stream survives in `ACTIVE` or `DELETING` status,
*detached from CFN tracking*. The next deploy attempt then fails
early-validation with:

```
Resource of type 'AWS::Kinesis::Stream' with identifier
'grid-sensor-pipeline-telemetry' already exists.
```

**Why this is hard to prevent.** CFN's deletion ordering only
respects the dependency graph it can see. Firehose-as-source and
Lambda ESM-as-consumer introduce a control-plane reference to the
stream that lives outside CFN's view of the stack. The stream
deletion call gets `ResourceInUseException` retries that don't always
complete inside CFN's window before the stack is marked
`DELETE_COMPLETE`.

**Verification command** — run *before* every fresh deploy after a
destroy to catch the orphan before CFN does:

```bash
aws kinesis describe-stream-summary \
  --stream-name grid-sensor-pipeline-telemetry \
  --region us-east-1 \
  --query 'StreamDescriptionSummary.{Name:StreamName,Status:StreamStatus}' \
  2>&1
```

- `ResourceNotFoundException` → clean state, deploy will succeed.
- Returns a stream summary → orphan present, run the cleanup recipe.

**Cleanup recipe** — production-tested across all four occurrences,
including the `--enforce-consumer-deletion` flag (omitted in earlier
captures, which may be why some delete attempts left the stream in
`DELETING` indefinitely):

```bash
aws kinesis delete-stream \
  --stream-name grid-sensor-pipeline-telemetry \
  --enforce-consumer-deletion \
  --region us-east-1

# poll until gone (10-30 seconds typical)
until aws kinesis describe-stream-summary \
  --stream-name grid-sensor-pipeline-telemetry \
  --region us-east-1 2>&1 | grep -q ResourceNotFoundException
do sleep 2; done && echo "✅ stream gone"

# now safe to redeploy
npm run deploy
```

**Why `--enforce-consumer-deletion`.** Forces removal of any
registered enhanced-fan-out consumers that might still be holding the
stream. Without it, `delete-stream` returns
`ResourceInUseException` and stays in limbo.

**Automated detection** — `scripts/post-destroy-check.sh` (added
Day 3 alongside this lesson promotion) runs after every
`npm run destroy` and reports whether the stream survived. Wired into
the `destroy` npm script so the check happens by default; exit code
1 if an orphan is detected so CI / wrapper scripts can react.

**Production hardenings worth knowing** (still applicable; not a
silver bullet for the POC):

1. **Streams in their own micro-stack.** Separating the stream into
   its own CDK stack means a rollback of any other stack doesn't try
   to reach back and delete the stream. Smaller blast radius.
2. **`RemovalPolicy.RETAIN` on the stream.** Tells CFN explicitly
   "don't delete this on rollback." Sidesteps the bug at the cost of
   manual cleanup. POC posture chose `DESTROY` for cost cleanup;
   production posture is `RETAIN` with explicit lifecycle scripts.
3. **Two-pass destroy in CI.** First pass: `cdk destroy`. Second
   pass: poll for the stream and force-delete if present. This is
   essentially what `scripts/post-destroy-check.sh` automates for
   local development.

**Recurrence log:**
- Day 1 morning — Failed deploy + rollback orphan (×2 within one session).
- Day 2 morning — Resumed work, deploy failed early-validation.
- Day 3 morning — Same. Triggered the lesson reframe + script add.

---

## The cross-cutting pattern across all four lessons

These four snags share a common thread: **CDK's high-level constructs
abstract over a lot of CFN ordering, IAM nuance, and service-specific
quirks, but they don't abstract over everything.** When you wire a
service principal that's older than the modern SDK conventions, or when
you compose resources whose lifecycle isn't captured by the explicit
dependency graph, you're back to reading service docs and CFN error
messages.

The Staff-level signal here isn't "I never make these mistakes." It's:

- Read CFN errors carefully and quote them in commits / decision logs.
- Recognize the pattern (auth failures at create-time = dependency
  ordering issue; rollback orphans = a CFN bug class).
- Reach for the right primitive (`inlinePolicies`, explicit
  `addDependency`, micro-stacks, `RetainPolicy`) — not just retry the
  same code.

These lessons inform the design choices for Phase 4 (IoT Rules engine
calls Kinesis), Phase 5 (Step Functions invokes Lambdas), and Phase 7
(API Gateway invokes Lambda).
