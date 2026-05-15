# Case-Management Patterns — Idempotency, Partial-Success, Extension Points

> **Status:** filled — Phase 9 close-out. Three patterns formalized
> here: the conditional-write idempotency pattern reapplied at a new
> boundary, partial-success failure isolation, and the registry-based
> extension point that makes "adding a future channel" a bounded,
> mechanical change.

> **Where these are anchored in the project:**
> - `src/lib/cases/case-repository.ts` — conditional-write idempotency
>   at the case-tracker layer.
> - `src/lib/alert-graph.ts` `executeToolsNode` — partial-success
>   dispatcher; `Promise.allSettled` over `CHANNEL_HANDLERS`.
> - `src/lib/cases/channels/index.ts` — the registry as extension point.
> - System overview diagram: [`../diagrams/system-overview.md`](../diagrams/system-overview.md).
> - Decision log: [`../decisions/phase-09-agentic-case-routing.md`](../decisions/phase-09-agentic-case-routing.md).

---

## Pattern 1 — Conditional-write idempotency, reapplied at a new boundary

### Pattern statement

When you have a natural identity for a domain event — a tuple of
fields that uniquely identifies what happened, regardless of how many
times the event traverses your system — write the event with a
**server-side conditional check** that fails if a row at that natural
key already exists. The exception that the conditional check raises
becomes the **retry signal** for the caller, not a failure to handle.

### Where this project applies it — twice, at two different boundaries

**Phase 2 — readings table.** Every sensor reading published by the
processor Lambda goes through `SensorRepository.putReading`:

```ts
await this.client.send(
  new PutCommand({
    TableName: this.tableName,
    Item: { ...event, pk, sk, ttl },
    ConditionExpression: 'attribute_not_exists(pk)',  // ← here
  }),
);
```

The natural key for a reading is `(sensorId, timestamp, readingType)`.
A retried Kinesis batch carries the same sequence numbers; the
processor's idempotency layer (Powertools) catches most retries
upstream. The conditional write is **belt-and-suspenders** — it
catches retries that bypass Powertools (e.g., the idempotency-table
TTL fires between retries).

**Phase 9 — cases table.** Every case opened by the dispatcher node
goes through `CaseRepository.createChannelCase` (and
`createMetadata`):

```ts
await this.client.send(
  new PutCommand({
    TableName: this.tableName,
    Item: { ...row, pk: buildCasePk(key), sk: row.channel },
    ConditionExpression: 'attribute_not_exists(pk)',  // ← same primitive
  }),
);
```

The natural key for a case is the same triple — `(sensorId,
timestamp, readingType)` — extended by the sort key (`'__metadata__'`
for the per-breach row, or `caseSystem` for the per-channel row).
Step Functions retries of the alert workflow carry the same triple;
the conditional check catches retries before duplicate emails fire.

### The architectural insight

**Same primitive. Different boundary. Different consequence of failure.**

| | Phase 2 (readings) | Phase 9 (cases) |
|---|---|---|
| Boundary | Kinesis processor → DynamoDB | LangGraph dispatcher → DynamoDB |
| Cost of duplicate | Storage cost; analytical noise | **Duplicate emails / pages to the operator** |
| Retry source | Kinesis ESM redelivery | Step Functions task retry |
| Idempotency guard above | Powertools Idempotency (Lambda layer) | None — the conditional write is the only guard |
| Failure handler | Swallow + log + metric | **Fall back to update + skip re-dispatch** |

The cases-layer application carries a higher operational stakes
(duplicate notifications are operator-visible and trust-eroding) but
uses the same primitive. The lesson is the **portability of the
pattern across boundaries**: once you have a natural key for any
domain event, the conditional-write primitive solves idempotency
deterministically.

### Trade-offs accepted

- **The conditional check raises an exception.** The caller MUST
  catch and reason about it — never silently swallow. Catching the
  exception as a control-flow signal (rather than an error) is the
  load-bearing convention. See pattern 3 below.
- **The natural-key composition must be stable across retries.**
  If Step Functions could modify any of `sensorId / timestamp /
  readingType` between retries, the conditional check would not
  match and duplicate writes would slip through. Step Functions
  preserves the original payload on retry — verified.
- **You give up the ability to overwrite by accident.** Worth more
  than it costs.

---

## Pattern 2 — Partial-success failure isolation (fan-out variant)

### Pattern statement

When a single operation fans out to N independent downstream targets,
**none of the targets blocking the others is a load-bearing property**.
Implement with `Promise.allSettled` (or its equivalent in the chosen
async runtime) so each target's success or failure is captured as
data, not as a thrown exception that unwinds the whole operation.

Return the structured outcome as a record with named buckets —
typically `delivered`, `failed`, `skipped` — so downstream consumers
can branch on counts rather than re-parse error strings.

### Where this project applies it — twice, fan-in and fan-out

**Phase 2 — fan-in (batchItemFailures).** A Kinesis batch arriving at
the processor Lambda contains N records. One poison record cannot
fail the batch — the Kinesis ESM expects a `batchItemFailures`
response where the Lambda lists exactly which sequence numbers to
retry. Each record's outcome is captured as data; the function never
throws on a partial-failure batch.

**Phase 9 — fan-out (dispatchResult).** One alert breach dispatches
to N channels. One channel failing cannot fail the breach. The
dispatcher node uses `Promise.allSettled` over the
`CHANNEL_HANDLERS` registry:

```ts
const settled = await Promise.allSettled(
  selectedChannels.map((channel) =>
    dispatchChannel(repo, key, channel, event, severity, narratives),
  ),
);
```

Each per-channel outcome is captured as a `DispatchOutcome` tagged
union (`'delivered' | 'failed' | 'skipped'`); the aggregator routes
each into the corresponding bucket of `DispatchResult`.

### Why naming buckets matters more than `try/catch` would

A naive implementation might wrap each channel call in `try/catch`
and emit only a metric on failure. That's strictly less than what
`DispatchResult` gives you:

- **`delivered[]`** tells downstream consumers exactly which channels
  the operator actually got the alert on.
- **`failed[]`** carries the error reason per channel — useful for
  ops dashboards, post-incident review, and explicit retry policies
  later.
- **`skipped[]`** with typed reasons (`retry_already_delivered`,
  `no_handler_registered`, `narrative_missing`) distinguishes
  "intentionally not dispatched" from "tried and failed".

The named buckets are the **vocabulary** for talking about partial
outcomes. Without them, an operator looking at the SNS payload sees
only the final notification text; with them, the payload carries the
realized routing alongside the planned routing, and any divergence is
queryable.

### The deeper symmetry — fan-in and fan-out are duals

Both Phase 2 (batchItemFailures) and Phase 9 (DispatchResult) are
**the same architectural pattern** applied at opposite ends of a
1:N relationship:

- Fan-in: N records → 1 Lambda invocation; isolation is "which records
  failed, retry just those".
- Fan-out: 1 alert → N channels; isolation is "which channels failed,
  surface them in the result".

In both cases, the structured outcome record is the load-bearing
contract — not the exception-vs-no-exception distinction, not a
single error code field, but a typed record with named outcome
buckets.

---

## Pattern 3 — Exception-as-information (the catch-and-fall-back contract)

### Pattern statement

When a server-side check (like `ConditionExpression`) raises an
exception that **carries semantic content** rather than indicating a
runtime fault, the caller's contract is to **catch the exception as
control flow** and branch into a deliberate alternate path. Treat the
exception as **information**, not as failure.

Document the contract explicitly so future readers know the catch is
load-bearing — not defensive coding, not pragmatic error swallowing.

### Where this project applies it

**`ensureMetadata` in `alert-graph.ts`:**

```ts
try {
  await repo.createMetadata(key, { severity, createdAt, updatedAt, resolvedAt: null });
} catch (err) {
  if (isConditionalCheckFailed(err)) {
    // This breach already has a metadata row from a prior retry.
    // The exception is the signal — fall back to update, don't throw.
    await repo.updateMetadata(key, { updatedAt });
    return;
  }
  throw err;  // any other error is genuinely a failure
}
```

**`dispatchChannel` in `alert-graph.ts`:**

```ts
try {
  await repo.createChannelCase(key, row);
} catch (err) {
  if (isConditionalCheckFailed(err)) {
    // Race: a concurrent retry beat us to the create.
    // Fall back to update with the same result fields.
    await repo.updateChannelCase(key, channel, { ...resultFields, updatedAt });
  } else {
    throw err;
  }
}
```

### The key discipline

**The `isConditionalCheckFailed` check is required.** A bare
`catch (err)` would swallow real errors (e.g., a transient DynamoDB
throttle) alongside the conditional check, hiding bugs. The narrow
check is what makes the exception-as-information pattern correct
rather than dangerous.

### Why this matters for interview defense

The pattern's load-bearing property is its **explicitness**. When a
reviewer asks "what's that catch doing?", the answer isn't "handling
errors" — it's "translating the conditional check's exception into a
retry-detected control flow path, deliberately." That distinction is
the difference between code that looks like it has defensive
error-handling sprinkled in and code that has a documented design
choice.

The convention is the same as treating `404 Not Found` as a "no, this
resource doesn't exist" answer rather than as an HTTP error.
`ConditionalCheckFailedException` is the DynamoDB equivalent for
natural-key uniqueness checks.

---

## The extension point — adding a future channel

The acceptance criterion from
[`../decisions/phase-09-agentic-case-routing.md`](../decisions/phase-09-agentic-case-routing.md)
pre-flight 7 is *"adding a future channel is a bounded, mechanical
change."* This section verifies that claim by sketching the diff for
a hypothetical Slack channel.

### The diff (sketched)

**1. New file** `src/lib/cases/channels/slack-stub.ts` (~50 lines,
mirrors `sms-stub.ts`):

```ts
import { performance } from 'node:perf_hooks';
import { logger } from '../../logger';
import { generateMockCaseId } from '../case-id';
import type { ChannelResult } from '../types';

export interface SlackCallInput {
  channelId: string;          // e.g., '#grid-ops'
  text: string;                // narrative
  threadTs?: string;           // for reply-in-thread support
  mentions?: string[];         // ['@oncall']
}

export const callSlackStub = async (input: SlackCallInput): Promise<ChannelResult> => {
  const start = performance.now();
  const caseId = generateMockCaseId('slack');
  const externalUrl = `https://example-slack.invalid/archives/${input.channelId}/p${caseId}`;

  logger.info('would_call', {
    channel: 'slack',
    caseId,
    externalUrl,
    input: { channelId: input.channelId, text: input.text, mentions: input.mentions ?? [] },
  });

  return {
    channel: 'slack',
    status: 'delivered',
    caseId,
    externalUrl,
    latencyMs: performance.now() - start,
  };
};
```

**2. `src/lib/cases/types.ts`** — add `'slack'` to the union:

```diff
-export type CaseSystem = 'email' | 'sms';
+export type CaseSystem = 'email' | 'sms' | 'slack';
```

**3. `src/lib/cases/channels/index.ts`** — register the handler:

```diff
+import { callSlackStub, type SlackCallInput } from './slack-stub';

 export const CHANNEL_HANDLERS = {
   sms: callSmsStub as ChannelHandler,
   email: callEmail as ChannelHandler,
+  slack: callSlackStub as ChannelHandler,
 } satisfies Record<CaseSystem, ChannelHandler>;

+export { callSlackStub };
+export type { SlackCallInput };
```

**4. `src/lib/alert-graph.ts`** — add a case in `buildChannelInput`:

```diff
 case 'sms': { ... }
+case 'slack': {
+  const body = narratives.narratives.slack;
+  if (!body) return null;
+  const input: SlackCallInput = {
+    channelId: process.env.SLACK_CHANNEL_ID ?? '#grid-ops',
+    text: body,
+    mentions: severity.severity === 'P0' || severity.severity === 'P1' ? ['@oncall'] : [],
+  };
+  return input;
+}
```

**5. (Optional) Routing matrix update** in
`src/lib/routing-strategy.ts` if you want LLM-driven Slack
selection per severity:

```diff
 channels: z.object({
   email: z.boolean(),
   sms: z.boolean(),
+  slack: z.boolean(),
 }),
```

Plus a Slack entry in `BASELINE_MATRIX` per tier.

**6. (Optional) Slack narrative tone guidance** in
`src/lib/narrative-generator.ts` — add a SLACK section to the
`SYSTEM_PROMPT` and a `slack: z.string().min(10).max(280).optional()`
to the `narrativesSchema`.

### What's NOT in the diff — the load-bearing property

Notably **absent from the change set**:

- ❌ `case-repository.ts` — no change. The cases table accepts any
  `caseSystem` value; the schema is open at the sk.
- ❌ `executeToolsNode` itself — no change. The dispatcher iterates
  `CHANNEL_HANDLERS` over routing selections; whichever channels are
  registered get dispatched.
- ❌ `dispatchChannel` — no change. The flow (check → dispatch →
  persist) is channel-agnostic.
- ❌ `ensureMetadata` — no change. Metadata is per-breach, not
  per-channel.
- ❌ The cases DynamoDB table schema — no change. Same pk/sk shape.
- ❌ The cases-table IAM grant — no change. Same readWriteData.
- ❌ `alert-handler.ts` — no change. Reads the dispatchResult as is.
- ❌ Any of P9's metric emission code — no change. Metrics are
  dimensioned by `Channel`, which already accepts new values.

### How to count "files changed"

Counting strictly:

- **1 new file** (the new adapter).
- **3 one-line/one-block additions** (CaseSystem union, registry
  entry, `buildChannelInput` case).
- **0 changes** to the dispatcher logic, the cases repository, the
  cases table schema, the IAM grants, the alert handler, the metrics.

The 3 narrow additions are not a "scattered change" — each is a
one-block addition next to existing similar entries. Type-checked at
compile time (the `satisfies Record<CaseSystem, ChannelHandler>`
constraint on `CHANNEL_HANDLERS` ensures you can't add a `CaseSystem`
literal without a matching handler; TypeScript catches the gap).

**This is what the uniform-adapter-interface pays off.** The
discipline of building the SMS stub + email adapter to the same
`Promise<ChannelResult>` shape, registered through the same
`CHANNEL_HANDLERS` map, exercised through the same
`executeToolsNode`, dispatched through the same `Promise.allSettled`
— all of that is what makes the 4th channel a 1-file-plus-3-lines
change instead of a refactor.

---

## Cross-references

- **Bridge brokers at trust / operational boundaries** —
  [`./bridge-brokers-at-boundaries.md`](./bridge-brokers-at-boundaries.md).
  Same architectural posture (boundary thinking) applied at a
  different layer.
- **Defense-in-depth idempotency** —
  [`../decisions/phase-02-processor.md`](../decisions/phase-02-processor.md)
  pre-flight 2. The pattern that pattern 1 above re-applies.
- **Layered failure isolation** —
  [`./aws-kinesis.md`](./aws-kinesis.md). Fan-in version of pattern 2
  above; same architectural principle.
- **Belt-and-suspenders for invariants you can't afford to break** —
  [`./_design-patterns-index.md`](./_design-patterns-index.md). The
  general form of why the conditional write makes the dispatch path
  retry-safe.
- **Composition over replacement at the right layer** —
  [`./langchain-langgraph.md`](./langchain-langgraph.md). Step
  Functions outer + LangGraph inner; the dispatcher node is the
  fourth LangGraph node inside the outer Step Functions workflow.

---

## Speaking points (interview defense)

Three sentences each for the three patterns. Memorize the shape; the
words shift based on context.

### Pattern 1 — conditional-write idempotency at a new boundary

*"I have one primitive — DynamoDB's `ConditionExpression:
attribute_not_exists(pk)` — deployed at two boundaries in the system.
At the readings table it makes Kinesis retries idempotent. At the
cases table it makes Step Functions retries idempotent — same code
shape, higher operational stakes because duplicate cases mean
duplicate operator pages. The portability of the pattern across
boundaries is the architectural lesson: once you have a natural key
for a domain event, conditional writes solve idempotency for it
deterministically."*

### Pattern 2 — partial-success failure isolation

*"Every fan-out in the system uses `Promise.allSettled` and returns
a structured outcome record with named buckets — `delivered`,
`failed`, `skipped`. One channel failing never fails the breach.
The named buckets matter more than the try/catch wrapping: they give
the SNS payload a vocabulary for talking about partial outcomes, and
they're the same shape we use on the fan-in side via Kinesis
`batchItemFailures`. Fan-in and fan-out are duals; the pattern is
the same."*

### Pattern 3 — exception-as-information

*"In `ensureMetadata` and `dispatchChannel` I catch
`ConditionalCheckFailedException` as control flow, not as error
handling. The exception carries the meaning 'a row with this natural
key already exists' — that's information, not failure. The dispatcher
branches into the update path on catch. The narrow
`isConditionalCheckFailed` check is what keeps this safe — any other
exception still propagates. The pattern's value is its explicitness:
the catch is documented as deliberate, not defensive."*
