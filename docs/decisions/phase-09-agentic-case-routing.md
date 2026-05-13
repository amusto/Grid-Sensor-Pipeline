# Phase 9 — Agentic Case Routing

Status: **pre-flight**. Extends Phase 8's agentic flow with two-channel
notification routing — one real (SES email) + one stubbed (SMS) —
backed by idempotency-aware case persistence so Step Functions retries
don't duplicate tickets.

This is the phase that turns "send a notification" into "open a case
that flows through the right channels for the right audience and
links back to a durable record."

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## Scope simplification (2026-05-13)

This decision log was originally drafted (2026-05-09) with a
five-stub design — Slack, Jira, ServiceNow, PagerDuty, status page —
plus one real channel (SES email). On 2026-05-13, before P9.1
execution began, **two related scope changes** landed:

1. **Channel inventory simplified** from five stubs + one real to
   **one stub (SMS) + one real (email)**. Two channels exercise the
   adapter pattern, the partial-success failure-isolation behavior,
   and the idempotency layer as completely as five would, with
   materially less surface to maintain. Additional channels remain
   a clean extension point — the `CHANNEL_HANDLERS` registry pattern
   in P9.4 is built explicitly to make future additions a one-file
   change.

2. **Email implementation path changed from SES to SNS subscription.**
   The original plan was a direct SES integration (verified sender
   identity, IAM scoped to `ses:SendEmail`, HTML + plain-text bodies,
   sandbox handling). Verification revealed that the P5 SNS topic
   already exists in CDK; only an `EmailSubscription` was missing.
   For POC scope, adding the subscription is a ~5-minute CDK change
   that completes the "email works end-to-end" deliverable without
   new IAM, new service surface, or sandbox-mode complexity. SES
   remains the production-shape migration path when HTML formatting
   or sender identity matter — and the adapter pattern guarantees
   that swap is a single-file change in `src/lib/cases/channels/email.ts`.

Pre-flights below have been revised in place to reflect both changes.
Where original content remains useful as documentation of the
extension point (additional channels, SES migration), it's noted
inline.

---

## P9 pre-flight 1 — One real channel + one stub

**Concept.** Demonstrate the production-shape integration architecture
without standing up third-party SaaS accounts. Pick one real channel
to prove the pattern works end-to-end; pick one stub to demonstrate
that the adapter interface is uniform across real and synthetic
implementations.

**Decision.** Two channels in P9:

- **Real: Email via SNS subscription.** Recipient configurable via
  CDK context `alertEmail` (default:
  `armando.musto+alertreported@gmail.com`). Implementation: add
  `topic.addSubscription(new EmailSubscription(alertEmail))` to the
  existing P5 alert-workflow SNS topic in
  `infra/lib/alert-workflow-stack.ts`. Recipient confirms via the
  AWS-sent confirmation link on first deploy; from that point every
  publish to the topic lands in the inbox. Plain-text format (SNS
  limitation). The email adapter at `src/lib/cases/channels/email.ts`
  constructs the message body and publishes via the existing SNS
  client — zero new IAM, zero new AWS service surface, zero sandbox
  dance. SES remains the documented future migration when HTML
  formatting or sender identity become real requirements; the
  adapter interface guarantees that swap is a single-file change.

- **Stub: SMS.** Single file at `src/lib/cases/channels/sms-stub.ts`.
  Accepts the same input shape a real SNS-SMS / Twilio call would
  take. Logs a structured `would_call` entry to CloudWatch via
  Powertools Logger. Persists a synthetic case record to the
  DynamoDB cases table (P9.3) with a generated `MOCK-sms-{epochMs}-{hash6}`
  ID. Returns a result identical in shape to the real channel
  adapter — same `ChannelResult` type with `status`, `caseId`,
  `externalUrl`, `latencyMs`.

Both channels are dispatched by the same LangGraph "execute tools"
node (P9.4) iterating over a `CHANNEL_HANDLERS` registry. The
dispatcher doesn't know which adapter is real vs stub — they
implement the same interface.

**Alternatives.**

- **Email only, no stub.** Simplest; but loses the *uniform adapter
  interface* demonstration. With two channels, the interview-defense
  move is *"adding a future channel is a one-file change."* With one
  channel, that claim has nothing to verify against.

- **Five stubs + one real** (the original design). Demonstrates
  routing breadth but adds maintenance surface — five `would_call`
  stubs, five sets of unit tests, five rows in the routing matrix,
  five channels in narrative-generator — for the same architectural
  lesson. Backed off on 2026-05-13.

- **All real integrations.** Requires Slack workspace, Jira instance,
  PagerDuty account, ServiceNow developer instance, status-page
  vendor. Each adds setup complexity and ongoing credentials. Not
  worth it for portfolio scope.

- **Direct SES email** (the original 2026-05-09 plan). New SES sender
  identity, verified recipient, IAM grant scoped to `ses:SendEmail`,
  sandbox handling, bounce/complaint topic wiring, HTML + plain-text
  bodies. Stronger production-shape but adds AWS service surface for
  a POC. SNS subscription does the same operational job (deliver
  email on every alert) with one CDK line. SES is the documented
  production migration path when HTML formatting or sender identity
  become real concerns; the adapter pattern in
  `src/lib/cases/channels/email.ts` is the swap point.

  Note for historical context: the original 2026-05-09 draft of this
  decision log claimed *"Email via SNS already exists in Phase 5."*
  Verification on 2026-05-13 revealed the SNS topic exists but the
  email subscription was never wired. The Option B path corrects
  that — wiring the subscription is now part of P9.2 deliverables.

**Why this hybrid.**

- Architecture is production-correct: every external system goes
  through an adapter function with the same `Promise<ChannelResult>`
  shape.
- One real channel proves the pattern. Reviewers see actual emails
  arriving in the demo inbox.
- One stub demonstrates that the interface is *uniform across real
  and synthetic*. The dispatcher doesn't know which is which.
- The original five-stub design was correct in principle; simplifying
  to one stub doesn't compromise the architectural lesson because
  the registry pattern in P9.4 is the actual extension point.

**Cost lens.** SES sandbox is free for 62k emails/month from a Lambda
sender. At alert volume (a few/hour) we'd send tens per month —
effectively zero. SMS stub has zero cost.

**Tradeoff accepted.** SES sandbox limits sending to verified
recipients only. Production migration is a separate AWS support
request (out-of-sandbox approval). Documented; not blocking for POC.

---

## P9 pre-flight 2 — Idempotency at the case-tracker layer

**Concept.** Same `attribute_not_exists(pk)` defense-in-depth pattern
from Phase 2's readings dedup, applied at the agentic-tool boundary.

**Decision.** A new DynamoDB table (`grid-sensor-pipeline-cases`)
tracks every case opened across all external systems. Before the
LangGraph "execute tools" node calls any channel adapter, it does a
lookup keyed on the alert's natural identity:

```
pk = `${sensorId}#${timestamp}#${readingType}`
sk = caseSystem  ('email' | 'sms')
```

If a case exists for this `(alert, system)` combination, the adapter
posts an UPDATE (e.g., re-send email with `[UPDATED]` subject, log a
follow-up SMS event) instead of creating a new case. If it doesn't
exist, the adapter creates and persists the new case with a
`ConditionExpression: attribute_not_exists(pk)` write.

The natural key composition is *deliberately stable across the
simplified-scope retrofit* — the same `(sensorId, timestamp,
readingType)` triple was used in the original five-stub design.
Future channel additions extend the `caseSystem` enum without
touching the pk pattern.

**Why this is critical.**

- Step Functions retries the alert workflow on transient failures.
  Without dedup, every retry sends another email / fires another SMS
  event.
- Same pattern as Phase 2's `DuplicateWrites` handling — duplicate
  detection at the natural-key layer below the application logic.
- Production grade: real ops teams have nightmare stories about
  duplicate tickets and pages from retry storms. Table-stakes
  engineering, not optional.

**Cost lens.** One additional DynamoDB table on-demand. ~$0.25/GB/month
storage. Cases table volume is small (one row per (alert, channel)
tuple, ~500 bytes each). Negligible.

**Tradeoff accepted.** The natural key is `(sensorId, timestamp,
readingType)` — a true *duplicate* alert (e.g., the sensor genuinely
breached again 5 minutes later, distinct `timestamp`) opens a NEW
case as it should. The dedup is on retries of the SAME alert, not on
similar alerts at later moments.

---

## P9 pre-flight 3 — Tool-call failure isolation (partial-success pattern)

**Concept.** Same partial-batch-failure pattern from Phase 2's Kinesis
ESM, generalized from fan-in (Kinesis records into one Lambda) to
fan-out (one alert dispatched to many channels).

**Decision.** The LangGraph "execute tools" node calls each routing
target (email, sms, plus any future channels) with individual
try/catch boundaries — implemented via `Promise.allSettled` over
the registry handlers. The node returns a structured result:

```ts
{
  delivered: [
    { channel: 'email', caseId: 'ses-msg-id-abc', externalUrl: null, latencyMs: 145 },
  ],
  failed: [
    { channel: 'sms', error: 'rate_limited', shouldRetry: true, latencyMs: 23 },
  ],
  skipped: [
    // populated when a channel was selected by routing but skipped at execute time
    // (e.g., feature-flagged off, severity below per-channel threshold at runtime)
  ],
}
```

The Step Functions workflow continues with this result attached to
its state. Subsequent states can branch on `failed.length > 0` if
needed — but a single channel failure does not fail the workflow.

**Why partial success.**

- An email-service outage shouldn't block the SMS path for a P0 alert.
- An SMS rate limit shouldn't block email delivery.
- Each channel has its own SLA; failures in one shouldn't infect the
  others.
- The pattern generalizes — adding Slack or PagerDuty later inherits
  the same failure-isolation behavior without dispatcher changes.
- This is the same shape operators expect from any multi-channel
  notification system.

**The pattern is the lesson, not the channel count.** Two channels
exercise this behavior as completely as five would. The dispatcher
iterates over `CHANNEL_HANDLERS`; the registry shape is the extension
point.

**Cost lens.** No cost difference. Defensive engineering.

**Tradeoff accepted.** A multi-channel partial failure means the
operator only learns about the breach from some channels. Mitigation:
the `failed` list is logged + emitted as an `AlertChannelFailures`
metric dimensioned by `channel`; an alarm on this metric would fire
if failures become recurrent.

---

## P9 pre-flight 4 — Severity-driven routing matrix as data, not code

**Concept.** Routing decisions should be a configurable table the
LLM consults — not hard-coded conditional logic.

**Decision.** Define a routing matrix in CDK context (or a config
file shipped with the Lambda):

| Severity | Email | SMS  | Notes                                                  |
|----------|-------|------|--------------------------------------------------------|
| **P0**   | yes   | yes  | Both channels — operator must be reached immediately.  |
| **P1**   | yes   | yes  | Both channels — high-severity, paging-equivalent.      |
| **P2**   | yes   | no   | Email only — investigable but not paging-grade.        |
| **P3**   | yes   | no   | Email only — informational.                            |

The LangGraph routing node receives this matrix alongside the
classified severity. The LLM generates the *narratives* for each
channel (per Phase 8's narrative-generator); the routing is
deterministic.

**Override path.** The LLM CAN override the matrix in unusual cases
(e.g., a P2 with cascading-failure context might warrant SMS
escalation). When it does, the override is logged as a
`RoutingOverride` metric event with the LLM's reasoning. Auditable.

**Why data, not code.**

- Operations teams change routing all the time (new escalation
  policy, re-tiered severity bands, new contact list). Editing a
  table is faster than redeploying code.
- The decision rationale (severity → channels) is more readable as a
  table than as nested if/else.
- The override path makes LLM judgment a *strict supplement* to
  declarative rules, not a replacement.

**Why this matrix in particular.** Two channels means the matrix
collapses to a single meaningful threshold: *does severity warrant
SMS paging?* The simplification surfaces the actual decision rather
than hiding it in five-column noise. Future channel additions extend
the matrix by adding columns (Slack, PagerDuty, etc.) without
changing the structure.

**Cost lens.** Zero. Configuration approach.

**Tradeoff accepted.** Two sources of truth (declarative table + LLM
override). Mitigation: every override is logged; if overrides become
frequent for a given severity tier, the matrix needs updating to
match the override pattern.

---

## P9 pre-flight 5 — Cross-channel case linkage

**Concept.** When the operator gets an SMS, the linked email should
be findable. When they reply to the email, the SMS case record
should reflect that the conversation has been engaged.

**Decision.** The cases table stores each alert's per-channel state
as separate rows under a shared pk, with an additional metadata row:

```
# Metadata row — one per alert
{
  pk: 'sensor-002#2026-05-09T14:00:00Z#voltage',
  sk: '__metadata__',
  sensorId: 'sensor-002',
  severity: 'P1',
  createdAt: '2026-05-09T14:00:01Z',
  resolvedAt: null,
}

# Per-channel rows — one per (alert, channel)
{
  pk: 'sensor-002#2026-05-09T14:00:00Z#voltage',
  sk: 'email',
  channel: 'email',
  caseId: 'ses-msg-id-abc123',
  status: 'delivered',
  deliveredAt: '2026-05-09T14:00:03Z',
}
{
  pk: 'sensor-002#2026-05-09T14:00:00Z#voltage',
  sk: 'sms',
  channel: 'sms',
  caseId: 'MOCK-sms-1715627889-a3f2c1',
  externalUrl: 'https://example-sms.invalid/log/MOCK-sms-1715627889-a3f2c1',
  status: 'delivered',
  deliveredAt: '2026-05-09T14:00:04Z',
}
```

A single Query by `pk` returns the metadata row + all per-channel
rows — one read, full case picture. When generating per-channel
narratives (Phase 8.5), the narrative-generator reads this record
and can include cross-references in each narrative ("see also: SMS
sent at 14:00:04").

**Why one row per (alert, channel), not one nested object.**

- DynamoDB items have a 400KB hard limit; nested-channel-object
  scales worse with more channels.
- Per-channel rows allow the idempotency check from pre-flight 2 to
  be a single GetItem keyed on `(pk, sk=channel)` rather than a
  partial-attribute read of a larger object.
- Operator-facing question — *"what's the status of the breach at
  sensor-002 at 14:00?"* — is one Query, all rows.

**Cost lens.** Slightly more rows per alert (1 metadata + N channel
rows). Per-row storage cost negligible; per-query cost is one Query
regardless of row count.

**Tradeoff accepted.** Schema migration if we add a new channel
later — just a new sk value, no schema change required.

---

## P9 pre-flight 6 — SNS subscription confirmation flow + future SES migration

**Concept.** Document the two deploy-time concerns the email channel
introduces today, plus the future migration path so the swap is
captured before it's needed.

**SNS subscription confirmation (deploy-time, today).** When the CDK
stack deploys with the new `EmailSubscription(alertEmail)`, AWS
sends a confirmation email to the recipient address. The recipient
must click the confirmation link before SNS begins delivering. This
is one-time per (topic, address) pair — re-deploys don't re-prompt.

Operational implication: first deploy after P9.2 lands needs a
**manual confirmation click** before the demo will deliver email.
Documented inline in the deploy runbook and the P9.6 smoke-test
checklist.

**Future SES migration (production-shape, when needed).** When
HTML formatting, sender identity, or recipient-list management
become real requirements, the swap is contained:

1. Add SES sender identity verification in CDK
   (`infra/lib/observability-stack.ts` or a new
   `notification-stack.ts`).
2. Replace the body of `src/lib/cases/channels/email.ts` with a
   `SendEmailCommand` via the SES client. The
   `Promise<ChannelResult>` interface is unchanged.
3. Update IAM grants in the alert-handler task role to add
   `ses:SendEmail` on the verified identity ARN, scoped tight.
4. SES sandbox-out-of-sandbox is a separate AWS support request;
   sender becomes verified-domain only, recipient list opens up.
5. Dispatcher (P9.4), idempotency layer (P9.3), narrative generator,
   routing strategy, SMS stub, and tests are all unchanged.

**This is what the adapter pattern is for.** The migration is named
in writing, scoped to one file, and free of cross-cutting changes.

**Cost lens.** SNS publish: $0.50 per 1M publishes — effectively
zero at POC volume. SES (when migrated): $0.10 per 1k emails —
also negligible at POC volume.

---

## P9 pre-flight 7 — Extension-point verification (interview defense)

**Concept.** The architectural claim Phase 9 makes — *"adding a
future channel is a one-file change"* — needs verification, not just
assertion. Two channels alone make the claim plausible; a written
demonstration makes it defensible.

**Decision.** As part of P9.5, include a hypothetical-Slack-adapter
file diff in the learning note `case-management-patterns.md`. The
sketch shows:

- The new file `src/lib/cases/channels/slack-stub.ts` implementing
  the same `Promise<ChannelResult>` signature as the email and SMS
  adapters.
- The one-line addition to `channels/index.ts` registering it in
  `CHANNEL_HANDLERS`.
- Confirmation that no changes to the dispatcher, idempotency layer,
  Step Functions state machine, routing matrix structure, or
  partial-success aggregation are required.

This is the *acceptance criterion that proves the extension claim*.
Skipping it means the claim is asserted but not demonstrated.

**Why this matters as a separate pre-flight.** Interview-defense
material. A Staff/Principal reviewer asking *"how would you add a
fifth channel?"* deserves to land on a written, file-by-file answer,
not a hand-wave.

**Cost lens.** Zero. ~30 minutes of documentation work as part of
P9.5.

---

## Cross-cutting framing for Phase 9

Three durable patterns this phase encodes:

1. **Uniform adapter interface across real and stubbed integrations,
   and across implementation choices within the real channel.** One
   channel is a real email integration (via the existing P5 SNS
   topic + a new email subscription); the other is a synthetic SMS
   stub. Both implement the same `Promise<ChannelResult>` signature,
   both register in the same `CHANNEL_HANDLERS` map, both are
   dispatched the same way by the LangGraph "execute tools" node.
   The dispatcher doesn't know which is real, and it doesn't know
   the email is going via SNS rather than SES. Adding a future
   channel (Slack, PagerDuty, Jira, etc.) is one new file + one map
   entry. Migrating the email implementation from SNS to SES later
   is one file (`src/lib/cases/channels/email.ts`) — the dispatcher
   doesn't change. **The architecture is the lesson, not the
   channel count, and not the specific AWS service either.**

2. **Idempotency follows the natural key, wherever the action
   happens.** Phase 2 dedups DynamoDB writes from the Kinesis
   pipeline; Phase 9 dedups case creation across external channels.
   Same conceptual key (`sensorId + timestamp + readingType`);
   different scope (single readings table vs multiple external
   integrations). The `attribute_not_exists(pk)` conditional-write
   pattern is the through-line.

3. **Routing as data, LLM as override.** The severity → channels
   matrix is a configurable table the LangGraph node consults. The
   LLM generates the *narratives* (per channel) and *can override*
   the routing in unusual contexts, but the deterministic rules are
   the default and the override is auditable. This is how
   decisioning systems should work in regulated industries —
   explainable defaults, judged exceptions, every divergence logged.
