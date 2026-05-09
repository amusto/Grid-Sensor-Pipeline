# Phase 6 — DLQ + Observability

Status: **pre-flight & implementation**. The visibility layer over P1-P5.
DLQ inspector consumes failed records; observability stack composes the
EMF metrics already being emitted into a single dashboard plus three
alarms.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P6 pre-flight 1 — DLQ inspector: log + alert + metric, NO auto-replay

**Concept.** Make failures visible cheaply; force human triage for the
expensive recovery action.

**Decision.** The DLQ inspector reads each SQS message, structured-logs
the original Kinesis sequence number + failure context, emits a
`DlqMessagesReceived` metric, and publishes to the ops-alerts SNS
topic. It does NOT automatically replay records back to Kinesis.

**Alternatives.**
- **Auto-replay every DLQ message** — easy to wire (one `kinesis:PutRecord`
  call per message), but operationally dangerous: a record that landed
  in the DLQ failed for a reason. Replay without inspection turns a
  poison pill into an infinite-cost retry storm.
- **Replay-when-error-is-transient (heuristic-driven)** — clever but
  brittle; "transient" is hard to detect from a poisoned message.
- **No inspector at all (just alarm on DLQ depth)** — loses the
  per-record context (which sensor, which sequence number, which
  failure). Operator has to manually `aws sqs receive-message` to
  investigate.

**Why log + alert.** Cheap, safe, complete-information. The operator
gets a CloudWatch log entry with everything they need plus an SNS
notification. If they decide replay is appropriate, the
**`REPLAY_TO_KINESIS=true` environment variable** flag turns it on —
explicit opt-in, not default behavior.

**Cost lens.** A handful of DLQ messages per month under normal
operation; cost is negligible. The pattern matters: optimize for the
*cheapest correct response*, not the *automated convenience response*.

**Tradeoff accepted.** A truly transient failure (e.g., a one-time
DynamoDB throttle that already cleared) doesn't auto-recover. The
operator has to explicitly replay. Acceptable: with `bisectBatchOnError`
and 5 retries already in place, anything reaching the DLQ has *survived*
the auto-recovery budget.

---

## P6 pre-flight 2 — Single observability stack, one dashboard URL

**Concept.** Operational truth lives in one place. Don't make the
operator hunt across stacks for the right view.

**Decision.** One `infra/lib/observability-stack.ts` with the dashboard
+ alarms + DLQ inspector + ops-alerts SNS topic. Pulls cross-stack
references from `ProcessingStack`, `AlertWorkflowStack` to compose
widgets and wire the inspector to the existing DLQ.

**Alternatives.**
- **Per-stack dashboards** (each stack creates its own widgets) —
  splinters the operational view. The "is the pipeline healthy?"
  question becomes "open four dashboards and synthesize."
- **No CDK-managed dashboard at all** (manage in console) — easy to
  start; impossible to recreate after destroy. IaC discipline says
  the dashboard is part of the deployable system, not a console
  artifact.

**Cost lens.** First three CloudWatch dashboards per region are free;
we'll have one custom dashboard, the auto-generated CDK Lambda
dashboards (separate tier), and Phase 10's demo dashboard. Total: $0.

---

## P6 pre-flight 3 — Alarm thresholds verbatim from CLAUDE.md

**Concept.** When a thoughtful spec exists, follow it; only deviate
with documented reason.

**Decision.** Three alarms per CLAUDE.md observability section:
- **`GridSensor-DLQ-Messages`** — `ApproximateNumberOfMessagesVisible`
  on the DLQ ≥ 1 over 1 minute → SNS.
- **`GridSensor-P99-Latency`** — `ProcessingLatencyMs` p99 > 2000ms
  for 3 consecutive minutes → SNS.
- **`AlertWorkflow-Failures`** — Step Functions `ExecutionsFailed` ≥ 1
  over 1 minute → SNS.

**Why these specific values.**
- DLQ depth ≥ 1: the DLQ should always be empty. Any single message
  is operationally significant.
- P99 > 2000ms × 3 min: 2 seconds is the spec; 3 minutes prevents
  flapping on transient spikes.
- SF failures ≥ 1: a failed alert workflow execution means an alert
  did NOT escalate. Safety-critical; immediate escalation.

**Tradeoff accepted.** Alarms are noisy in dev (any forced-failure
test fires DLQ alarm). For production, tune thresholds based on
observed baseline. For POC, the strict values are pedagogically clearer.

---

## P6 pre-flight 4 — Separate ops-alerts SNS topic from grid-alerts

**Concept.** Operational alerts and grid-event alerts have different
audiences, different SLAs, different runbook responses. Don't conflate.

**Decision.** New `${projectName}-ops-alerts` SNS topic in the
observability stack, separate from `${projectName}-alerts` (P5's
grid-event topic).

**Why separate.**
- **Different audiences.** Grid-event alerts go to operators who
  respond to *physical* sensor anomalies. Ops alerts go to the
  engineers responsible for the pipeline's health.
- **Different runbooks.** "Voltage spiked at sensor-002" requires
  field response. "DLQ has 5 messages" requires log inspection.
- **Different SLAs.** A grid event is P2 → P1 escalation in 15 min.
  An ops alert ("DynamoDB throttling") may have a 1-hour ack window.

**Cost lens.** Two SNS topics: $0.50/M publishes per topic, with no
subscriptions = effectively free. Indirect cost saving: clearer
operational triage.

---

## P6 pre-flight 5 — Manual chaos verification, not automated

**Concept.** Phase 6 verifies the alarm paths fire under deliberate
failure injection; full automation of chaos engineering is out of scope.

**Decision.** P6.6 is a **CLI recipe** that drives each alarm:
- DLQ alarm: `aws kinesis put-record` with garbage payload → DLQ
  message → alarm fires.
- P99 alarm: forced traffic burst with degraded payload (e.g., 1000
  events at once) → ESM throttling → latency spike.
- SF failures alarm: deliberately broken alert handler env var →
  state machine execution fails → alarm fires.

**Alternatives.**
- **AWS Fault Injection Service (FIS)** — proper chaos engineering
  toolkit. Out of scope for POC; would be Phase 11+.
- **Continuous chaos testing in CI** — even more out of scope.

**Cost lens.** Manual recipes are free. FIS adds per-experiment cost.

**Tradeoff accepted.** Verification is a one-time exercise, not a
recurring guarantee. Production hardening would automate.

---

## P6 pre-flight 6 — Dashboard reads CloudWatch metrics directly, not Logs Insights

**Concept.** Use the cheapest signal that answers the question.

**Decision.** Dashboard widgets read EMF metrics from CloudWatch
namespace `GridSensorPipeline` directly. No `MetricFilter` resources;
no Logs Insights queries embedded in widgets.

**Why direct metrics.**
- Powertools EMF is already wired into every Lambda. The metrics are
  there. Reading them is one widget definition; running an LI query
  is a per-render cost (~$0.005 per query).
- For the dashboard's primary signals (throughput, latency, error
  count, DLQ depth), pre-aggregated metrics are exactly what
  CloudWatch is designed for.

**When LI queries are appropriate** (none in this project, noted for
future reference):
- Ad-hoc forensic investigation: "find every record from sensor-002
  in the last hour with `validationFailed: true`."
- Dashboards over high-cardinality data that *can't* be pre-aggregated
  as metrics (e.g., per-sensor latencies if we ever needed that).

**Cost lens.** $0 for metric-driven widgets. ~$0.005 per LI-query
widget per dashboard render × N daily views × 30 days = a few dollars
per dashboard per month at modest usage. Negligible at our scale, but
the pattern matters: metrics for known-shape signals, queries for
exploratory work.

---

## Deploy lesson — Powertools `singleMetric()` flushes after first metric

**Discovered during P6.5 dashboard verification.** The `Events processed`
widget rendered correctly (dimensioned by `ReadingType`); the
`Processing latency` widget showed *"No data available."* Diagnostic:

```bash
aws cloudwatch list-metrics --namespace GridSensorPipeline --output json \
  | jq -r '.Metrics[] | "\(.MetricName) → \(.Dimensions | map("\(.Name)=\(.Value)") | join(", "))"'
```

Output revealed:
- `EventsProcessed` → 5 streams, one per `ReadingType` ✅
- `ProcessingLatencyMs` → 1 stream, **no `ReadingType`** ❌

**Root cause.** Both metrics were emitted from the same `singleMetric()`
instance:

```ts
const recordMetric = metrics.singleMetric();
recordMetric.addDimension('ReadingType', event.readingType);
recordMetric.addMetric('EventsProcessed', MetricUnit.Count, 1);          // ✅ has ReadingType
recordMetric.addMetric('ProcessingLatencyMs', MetricUnit.Milliseconds, ...); // ❌ shared instance, no ReadingType
```

Powertools v2's `singleMetric()` flushes its custom dimensions after the
*first* `addMetric` call. Subsequent `addMetric` calls on the same
instance fall through to the shared `metrics` singleton, losing the
custom dimensions.

**Fix.** One `singleMetric()` per metric — verbose but correct:

```ts
const eventsMetric = metrics.singleMetric();
eventsMetric.addDimension('ReadingType', event.readingType);
eventsMetric.addMetric('EventsProcessed', MetricUnit.Count, 1);

const latencyMetric = metrics.singleMetric();
latencyMetric.addDimension('ReadingType', event.readingType);
latencyMetric.addMetric('ProcessingLatencyMs', MetricUnit.Milliseconds, latencyMs);
```

**Pattern lesson.** When you need multiple metrics with the *same custom
dimensions*, use one `singleMetric()` per metric. The 2× EMF entries are
cheap (CloudWatch ingest is per-MB; structured logs are tiny).
Alternative — emit metrics on the shared instance with `addDimensions()`
once at the start of the invocation — works only if every metric in the
invocation should carry that dimension set.

**Where else to look.** The alert handler (P5) emits exactly *one*
metric per `singleMetric()`, so it's not affected. The DLQ inspector
and simulator emit through the shared metrics instance, so also fine.
Audit when adding new handlers (P8 alert handler will use multiple
metrics with `ReadingType`).

---

## Cross-cutting framing for Phase 6

Three durable patterns this phase encodes:

1. **Visibility is a deliverable, not an afterthought.** Phase 6 isn't
   "adding observability later" — it's the moment the metrics emitted
   by P1-P5 become *legible*. The dashboard makes the system's
   behavior debuggable in 10 seconds instead of 10 minutes of log
   spelunking.

2. **Fail-loud at the alarm layer too.** The DLQ alarm threshold is
   `≥ 1`. Any single dead-lettered record is operationally
   significant. Tuning thresholds to "ignore noise" is the wrong
   instinct here; the right instinct is "make the noise unambiguous."

3. **Manual chaos as documentation.** P6.6's forced-failure recipe is
   a *runbook* — it tells future engineers how to verify the alarm
   paths still work after a refactor. Not a one-time test; a
   repeatable contract test against the alarm layer.
