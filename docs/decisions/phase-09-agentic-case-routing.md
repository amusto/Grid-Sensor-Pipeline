# Phase 9 — Agentic Case Routing

Status: **pre-flight**. Extends Phase 8's agentic flow with multi-
channel routing, external case-tracking integrations (stubbed), one
real email channel via SES, and idempotency-aware case persistence.

This is the phase that turns "send a notification" into "open a case
that flows through the right channels for the right audience and
links back to a durable record."

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P9 pre-flight 1 — Stubbed external systems + one real channel (SES email)

**Concept.** Demonstrate the production-shape integration architecture
without standing up third-party SaaS accounts. Pick one real channel
to prove the pattern works end-to-end.

**Decision.** Stub Slack, Jira, ServiceNow, PagerDuty, and status-page
integrations. Each stub:
- Accepts the same input shape a real call would take.
- Logs the call to CloudWatch with a structured "would-call" entry.
- Persists a synthetic case record to the DynamoDB cases table (new in
  P9.3) with a generated mock ID.
- Returns a result identical in shape to the real API.

**The one real channel: SES email** to a configurable recipient
(default: `armando.musto+alertreported@gmail.com`, set via CDK context
`alertEmail`). SES sandbox mode is fine — only one verified recipient
needed. Demonstrates real production-shape integration on at least
one channel.

**Alternatives.**
- **All stubs, no real channel.** Cheaper, but reviewers can't see the
  system actually firing. Email alone is a small extension that
  closes the demo loop.
- **All real integrations.** Requires Slack workspace, Jira instance,
  PagerDuty account, ServiceNow developer instance, status-page
  vendor. Each adds setup complexity and ongoing credentials. Not
  worth it for portfolio scope.
- **Email via SNS** (already exists in Phase 5). SNS email
  subscription works but is plain-text only and adds an extra
  unsubscribe-link dance. Direct SES gives full HTML formatting and
  cleaner sender identity.

**Why this hybrid.**
- Architecture is production-correct: every external system goes
  through a tool function with the same shape.
- One real channel proves the pattern. Reviewers see actual emails.
- Five stubs demonstrate the routing breadth without operational
  burden.

**Cost lens.** SES sandbox is free for 62k emails/month from a Lambda
sender. At alert volume (a few/hour) we'd send tens per month —
effectively zero. Stubs cost nothing.

**Tradeoff accepted.** SES sandbox limits sending to verified
recipients only. Production migration is a separate AWS support
request (out-of-sandbox approval). Documented; not blocking for POC.

---

## P9 pre-flight 2 — Idempotency at the case-tracker layer

**Concept.** Same `attribute_not_exists(pk)` defense-in-depth pattern
from Phase 2, applied at the agentic-tool boundary.

**Decision.** A new DynamoDB table (`grid-sensor-pipeline-cases`)
tracks every case opened across all external systems. Before the
LangGraph "execute tools" node calls any case-creation tool, it does
a lookup keyed on the alert's natural identity:

```
pk = `${sensorId}#${timestamp}#${readingType}`
sk = caseSystem  ('slack' | 'jira' | 'servicenow' | 'pagerduty' | 'email')
```

If a case exists for this `(alert, system)` combination, the tool
posts an UPDATE (e.g., new Slack thread reply, Jira comment) instead
of creating a new case. If it doesn't exist, the tool creates and
persists the new case with a `ConditionExpression: attribute_not_exists(pk)`
write.

**Why this is critical.**
- Step Functions retries the alert workflow on transient failures.
  Without dedup, every retry opens a new ticket.
- Same pattern as Phase 2's `DuplicateWrites` handling — duplicate
  detection at the natural-key layer below the application logic.
- Production grade: real ops teams have nightmare stories about
  duplicate tickets. This is table-stakes engineering, not optional.

**Cost lens.** One additional DynamoDB table on-demand. ~$0.25/GB/month
storage. Negligible.

**Tradeoff accepted.** The natural key is `(sensorId, timestamp,
readingType)` — a true *duplicate* alert (e.g., the sensor genuinely
breached again 5 minutes later) opens a NEW case as it should. The
dedup is on retries of the SAME alert, not on similar alerts.

---

## P9 pre-flight 3 — Tool-call failure isolation (partial-success pattern)

**Concept.** Same partial-batch-failure pattern from Phase 2's Kinesis
ESM, applied at the LangGraph tool-execution layer.

**Decision.** The LangGraph "execute tools" node calls each routing
target (Slack, Jira, PagerDuty, email, etc.) with individual try/catch
boundaries. The node returns a structured result:

```ts
{
  delivered: [{ channel: 'email', caseId: '...', latencyMs: 145 }, ...],
  failed:    [{ channel: 'slack', error: 'rate_limited', shouldRetry: true }],
  skipped:   [{ channel: 'pagerduty', reason: 'severity below threshold' }]
}
```

The Step Functions workflow continues with this result attached to
its state. Subsequent states can branch on `failed.length > 0` if
needed.

**Why partial success.**
- A Slack outage shouldn't block PagerDuty paging for a P0 alert.
- A PagerDuty rate limit shouldn't block ticket creation.
- Each channel has its own SLA; failures in one shouldn't infect the
  others.
- This is the same pattern operators expect from any multi-channel
  notification system.

**Cost lens.** No cost difference. Defensive engineering.

**Tradeoff accepted.** A multi-channel partial failure means the
operator only learns about the breach from some channels. Mitigation:
the `failed` list is logged + emitted as an `AlertChannelFailures`
metric; an alarm on it would fire if this becomes recurrent.

---

## P9 pre-flight 4 — Severity-driven routing matrix as data, not code

**Concept.** Routing decisions should be a configurable table the
LLM consults — not hard-coded conditional logic.

**Decision.** Define a routing matrix in CDK context (or a config
file shipped with the Lambda):

| Severity | Slack channels | PagerDuty? | Case tracker | Email | Status page |
|---|---|---|---|---|---|
| P0 | `#incident-warroom` | yes | ServiceNow P1 | yes | yes |
| P1 | `#grid-ops` | yes | ServiceNow P2 | yes | no |
| P2 | `#grid-ops` | no | Jira | yes | no |
| P3 | `#monitoring` | no | none | no | no |

The LangGraph node receives this matrix as input alongside the
classified severity. The LLM generates the *narratives* for each
channel; the routing is deterministic.

**Override path.** The LLM CAN override the matrix in unusual cases
(e.g., a P2 with cascading-failure context might escalate to P1
routing). When it does, the override is logged as a `RoutingOverride`
metric event with the LLM's reasoning. Auditable.

**Why data, not code.**
- Operations teams change routing all the time (new on-call rotation,
  re-tiered severity, new Slack channel). Editing data is faster than
  redeploying code.
- The decision rationale (severity → channels) is more readable as a
  table than as nested if/else.
- The override path makes LLM judgment a *strict supplement* to
  declarative rules, not a replacement.

**Cost lens.** Zero. Configuration approach.

**Tradeoff accepted.** Two sources of truth (declarative table +
LLM override). Mitigation: every override is logged; if overrides
become frequent, the matrix needs updating.

---

## P9 pre-flight 5 — Cross-system case linkage

**Concept.** When an operator clicks the Jira ticket, they should be
able to find the related Slack thread. When they ack via Slack, the
Jira ticket should reflect that.

**Decision.** The cases table stores all external IDs for a given
alert in one row:

```
{
  pk: 'sensor-002#2026-05-09T14:00:00Z#voltage',
  sk: '__metadata__',
  sensorId: 'sensor-002',
  severity: 'P1',
  channels: {
    slack: { channelId: '...', threadTs: '...', url: '...' },
    jira: { project: 'GRID', ticketId: 'GRID-1234', url: '...' },
    pagerduty: { serviceId: '...', incidentId: '...', url: '...' },
    email: { messageId: '...', deliveredAt: '...' },
  },
  createdAt: '...',
  resolvedAt: null
}
```

Each tool call appends to this record (write through the dedup layer
from pre-flight 2). When generating per-channel narratives, the
LangGraph node reads this record and includes cross-references in
each narrative ("see also: Slack #grid-ops thread, PagerDuty incident
#1234").

**Why one record per alert (not one per channel).**
- Operator-facing question: "what's the status of the breach at
  sensor-002 at 14:00?" The answer is one record.
- Cross-references are first-class: each channel's narrative can
  link to the others.
- Resolved-at is one timestamp on one record, not five.

**Cost lens.** Slightly larger DynamoDB items (~2KB each). Negligible
cost.

**Tradeoff accepted.** Schema migration if we add a new channel
later — needs an ADD to the `channels` map, which DynamoDB does
without ceremony. Acceptable.

---

## P9 pre-flight 6 — SES sender identity + verification

**Decision.** SES sender: a verified address chosen at deploy time
via CDK context `senderEmail` (default: same as `alertEmail`). SES
sandbox mode means both sender and recipient must be verified —
sending to your own Gmail+alias means the same address verifies both
sides.

**Production migration.** Out-of-sandbox SES requires AWS support
approval. Once granted, sender remains verified-domain only;
recipient list opens up. Documented in the learning note.

**Cost lens.** SES is $0.10 per 1k emails. POC volume is well under
1k/month — fractional cents.

---

## Cross-cutting framing for Phase 9

Three durable patterns this phase encodes:

1. **Stubs preserve architecture; reality lives behind one channel.**
   Five stubbed integrations with one real channel demonstrate the
   pattern correctly without operational complexity. The stubs are
   not less-architected than reality; they're the same shape with a
   different I/O endpoint.

2. **Idempotency follows the natural key, wherever the action
   happens.** Phase 2 dedups DynamoDB writes; Phase 9 dedups case
   creation across external systems. Same conceptual key
   (`sensorId + timestamp + readingType`); different scope (single
   table vs five external systems).

3. **Routing as data, LLM as override.** Configuration tables drive
   the deterministic routing; LLM judgment supplements rather than
   replaces. When the LLM overrides, the override is auditable. This
   is how "decisioning systems" should work in regulated industries
   — explainable defaults, judged exceptions.
