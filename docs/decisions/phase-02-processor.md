# Phase 2 — Processor Lambda

Status: **pre-flight**. Decisions captured before the handler is written so
the rationale is documented up-front rather than reverse-engineered later.

For each decision: **concept · why this value · alternatives · cost lens ·
tradeoff knowingly accepted.**

---

## P2 pre-flight 1 — Idempotency expiry window: 24–26 hours

**Concept.** Idempotency state must outlive the longest possible duplicate-
delivery interval.

**Why 24–26 hours.** Powertools' idempotency utility writes one DynamoDB row
per processed Kinesis sequence number, with a TTL that auto-deletes the row
to prevent unbounded growth. The TTL must exceed Kinesis's retention window
— otherwise a record replayed near the end of retention would miss the
dedup table and get processed twice. Kinesis retains 24 h by default; 24 +
a small safety margin (1–2 h) covers the worst-case replay scenario.

**Alternatives rejected.**
- **1 h (Powertools default)** — too short. Any consumer outage longer than
  an hour would re-process records on recovery.
- **7+ days** — safe but pays for storage we never need. The dedup row's
  only purpose is to outlive the replay window.

**Cost lens.** TTL choice is a direct storage-cost lever. Going with the
smallest TTL that satisfies correctness keeps the idempotency table sized
roughly at `events/day × 1 day`. A 7-day TTL would 7× the table size for
zero correctness benefit. At our event volume the absolute dollars are
small, but the principle scales: pick the smallest correctness-safe number,
not the most-conservative-feeling one.

**Tradeoff knowingly accepted.** If we ever increase Kinesis retention
beyond 24 h (allowed up to 365 days), the idempotency TTL must increase
in lockstep. Documented as a deployment-time dependency.

---

## P2 pre-flight 2 — `ConditionalCheckFailedException` swallow scope: strict (named-error only)

**Concept.** Fail-loud / fail-quiet asymmetry. Fail loud on unknown errors;
fail quiet only on the one error that legitimately means "this was a no-op
success."

**Decision.** In the processor, catch the specific
`ConditionalCheckFailedException` from the DynamoDB write and treat it as
no-op success. Every other error bubbles up to `batchItemFailures`.

**Why strict.** The repository writes with `attribute_not_exists(pk)`.
DynamoDB's response of `ConditionalCheckFailedException` is the database
telling us "you already wrote this row." That is not a failure — it's
confirmation that a duplicate is being correctly de-duplicated. Treating
it as success keeps duplicates out of the DLQ and prevents permanent retry
loops on legitimate replays.

**Alternatives rejected.**
- **Swallow any error with "Conditional" in the message** — too broad,
  would mask real validation or constraint errors.
- **Swallow all DynamoDB errors** — catastrophic. Throttling, validation,
  and network errors would be silently dropped, causing data loss without
  alerting.
- **Don't swallow at all** — duplicates would route to the DLQ as
  `batchItemFailures`. Wastes DLQ capacity, generates spurious alarms, and
  forces manual reconciliation.

**Cost lens.** Indirectly cost-aware: **correctness is cheaper than
incident response.** A broad swallow that silently drops real errors leads
to data-loss incidents whose remediation cost (engineering time + customer-
trust cost) dwarfs any runtime savings. Conversely, no swallow at all
floods the DLQ with legitimate duplicates — forcing us to either tune the
alarm to be useless (operational debt) or pay for someone to triage noise
(direct labor cost). Strict swallow is the configuration that minimizes
both the silent-failure risk and the noise-triage cost.

**Tradeoff knowingly accepted.** Tight coupling to DynamoDB's specific
error class. If we ever swap the persistence layer (e.g., Aurora), the
swallow logic must change in lockstep. Documented in the repository
contract.

---

## P2 pre-flight 3 — `ReadingType` metric dimension: include

**Concept.** Bounded, low-cardinality dimensions for slices that match how
you'd actually investigate a problem.

**Decision.** Add `ReadingType` as a dimension on `EventsProcessed` and
`ProcessingLatencyMs`.

**Why include.** Without the dimension, "p99 latency" is one number that
hides slow tails. With the dimension, we can ask "is *frequency* slower
than *voltage*?" — useful when a specific reading type's downstream
processing is misbehaving (e.g., voltage breaches trigger an alert
workflow start that adds latency). The cardinality cost is bounded by the
readingType enum size: 5 values per dimensioned metric.

**Alternatives considered.**
- **No dimensions** — cheaper, but no slicing. Lose the ability to detect
  per-readingType regressions.
- **Dimension on `sensorId`** — high cardinality (potentially thousands),
  costs meaningfully in Datadog at scale. We'd be paying to discover what
  one sensor is doing — a question already answered by logs and the X-Ray
  trace.
- **Dimension on `gridZone`** — bounded and operationally interesting;
  deferred until we have the access pattern in production. Adding it later
  is a one-line change.

**Cost lens.** Direct cost lever. CloudWatch charges per custom metric
stream (~$0.30/metric/month at Tier 1); Datadog custom metrics are
~$0.05 per metric beyond the base quota.

| Configuration | Streams | CloudWatch | Datadog (rough) |
|---|---|---|---|
| No dimensions, 4 metrics | 4 | ~$1.20/mo | within quota |
| `ReadingType` (5 values) × 4 metrics | 20 | ~$6/mo | within quota |
| `sensorId` (5,000) × 4 metrics | 20,000 | ~$6,000/mo | ~$1,000/mo over quota |

**The pattern:** dimensions for **bounded, operationally meaningful slices
only**. Never high-cardinality keys like IDs, timestamps, or user-supplied
strings.

**Tradeoff knowingly accepted.** If a new readingType is added (e.g.,
`harmonic_distortion`), it adds metric streams automatically — no code
change needed but a small cost increment on the next billing cycle.

---

## P2 follow-up — manual instrumentation over Middy or class decorators

**Discovered during local verification.** The original handler used the v1
Powertools function-style wrapper pattern:

```ts
export const handler = tracer.captureLambdaHandler(
  logger.injectLambdaContext(baseHandler),
);
```

In v2, `captureLambdaHandler()` returns a `MethodDecorator`, not a
function wrapper — calling it with a handler argument doesn't wrap
anything; the deployed Lambda would crash on first invocation, and
TypeScript reports the call-signature mismatch. So the wrapper had to
change.

**First attempt: Middy middleware.** The Powertools v2 docs lead with
Middy as the recommended composition style. But middy v5.x is ESM-only
(`"type": "module"` and an `exports` map without a `"require"`
condition); ts-jest defaults to CommonJS and Jest's resolver bails when
required from a CJS context. Configuring Jest to run ESM is achievable
but adds non-trivial complexity (`extensionsToTreatAsEsm`,
`useESM: true`, `--experimental-vm-modules`, transform tweaks) for a
3-line wrapper. Downgrading middy to v4 (the last CJS line) would work
but freezes a transitive dependency on a deprecated major.

**Final decision — manual instrumentation.**

```ts
export const handler = async (
  event: KinesisStreamEvent,
  context: Context,
): Promise<KinesisStreamBatchResponse> => {
  logger.addContext(context);
  return baseHandler(event);
};
```

**Why this is the right call here.**

- **X-Ray.** Lambda's `tracing: ACTIVE` already wraps the entire
  invocation in a segment. Our per-record subsegments inside
  `processRecord` give us the granular breakdowns we'd actually use. The
  function-level subsegment Middy would add is redundant.
- **Logger context.** `logger.addContext(context)` decorates subsequent
  log lines with the Lambda request ID and function metadata. One line.
- **Metrics.** `metrics.publishStoredMetrics()` is already in the
  handler's `finally` per CLAUDE.md hard rule #8.
- **No extra dependency.** Bundle stays smaller, no ESM/CJS interop
  knot, no version-pinning a deprecated middy major.

**Concept the pattern encodes.** Use libraries when they solve a problem
you actually have; manual instrumentation when the library would
introduce more complexity than it removes. Middy is the right answer for
deeply composed handlers (auth + validation + tracing + logging across
many endpoints). For one Kinesis processor, three lines of explicit
instrumentation is clearer to read and easier to debug.

**Tradeoff knowingly accepted.** If we ever add cross-cutting concerns —
auth, multi-step validation, response transformations — we'll revisit
and adopt Middy (with the Jest ESM config it requires) or the class
decorator pattern.

---

## Cross-cutting framing for Phase 2

All three decisions exhibit the same meta-pattern: **a runtime knob whose
default value is conservative, where tightening costs storage or metrics
budget and loosening costs correctness or operability.** The right answer
isn't always "minimize cost" — it's "**minimize unnecessary cost while
preserving the operational guarantees that matter**." That's the lens for
every cost-aware decision in this project.

**Three durable patterns this phase encodes:**

1. **State outlives delivery jitter** — for any system relying on at-least-
   once delivery, dedup state's lifetime must exceed the replay window.
2. **Fail-loud / fail-quiet asymmetry** — silent dropping is the worst
   failure mode; swallow only on the one named exception that legitimately
   means no-op success.
3. **Bounded low-cardinality dimensions** — dimensions are useful for
   *slices* (operationally meaningful, finite-set categories), never for
   *identifiers* (high-cardinality, billing footgun).
