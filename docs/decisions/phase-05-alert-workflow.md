# Phase 5 — Alert Workflow

Status: **pre-flight & implementation**. Wires the safety-critical alert
path: IoT Rules engine routes threshold breaches directly to Step
Functions; the alert handler Lambda sends SNS notifications and the
workflow waits for acknowledgment before escalating.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P5 pre-flight 1 — Standard Workflow over Express

**Concept.** Long-running, auditable workflows belong in a workflow
engine; the choice between Standard and Express is about durability vs
volume.

**Decision.** Standard. Locked by CLAUDE.md hard rule #10.

**Why.** Three properties Standard gives us that Express does not:
- 90-day execution history retention (regulatory / audit ask).
- Wait state without paying for compute (15-minute ack window costs
  zero between transitions).
- Per-step retry configuration so a transient SNS failure retries that
  step only.

**Cost lens.** Standard is ~25× more expensive *per state transition*
than Express. At alert volume (hundreds per day at most), the absolute
cost is negligible. At alert volume of millions per day, Express becomes
the right answer — but at that scale the audit retention requirement
would change too.

**Tradeoff accepted.** If alerts ever spike to hundreds-of-thousands per
day (cascading grid event), the cost-per-transition matters. Mitigation
documented but not implemented: route low-severity alerts to an Express
workflow, reserve Standard for P0/P1 escalations.

---

## P5 pre-flight 2 — Wait state duration: 15 minutes

**Concept.** The wait gives a human (or auto-ack mechanism) time to
respond before escalation; it sets the clock on incident severity.

**Decision.** 15 minutes. Per CLAUDE.md spec. Configurable via CDK
context (`-c ackWaitMinutes=N`) for testing.

**Why.** Industry-standard P2 ack window. Long enough that an on-call
engineer with a normal pager rotation has time to respond; short
enough that an unacknowledged P2 escalates to P1 within a single
shift.

**Cost lens.** Wait state itself is free (no compute charged during
the wait). The cost is downstream: if every alert escalates because no
one acks, you double your SNS publishes. Mitigated by the (out-of-
scope) ack mechanism.

**Tradeoff accepted.** The smoke test takes 15 minutes to see the
escalation path fire end-to-end. Mitigation: deploy with
`-c ackWaitMinutes=1` for development, redeploy with the default for
production.

---

## P5 pre-flight 3 — Acknowledgment: default-false (no ack mechanism in MVP)

**Concept.** A real on-call ack mechanism is out of scope for this POC;
we make that limitation visible and document the production extension
path.

**Decision.** The `NotifyOps` step's Lambda always returns
`{ acknowledged: false }`. The `IsAcknowledged` choice always routes
to escalation after the wait. There is no mechanism (yet) for a human
to set `$.alert.acknowledged = true`.

**Production extension paths** documented for later:
1. **Task-token callback pattern.** Replace `NotifyOps` with a
   `WaitForTaskToken` integration. The notification carries a task
   token; an ack endpoint (API Gateway → Lambda) calls
   `SendTaskSuccess` with `{ acknowledged: true }`.
2. **Heartbeat polling.** A side Lambda polls a DynamoDB ack table
   during the wait window and updates state.

**Why default-false rather than building the ack mechanism now.** The
ack endpoint, the auth model for who can ack, and the on-call rotation
integration are all separable concerns. Building them as part of P5
would triple the scope; deferring lets us ship the workflow itself
cleanly and demonstrate the *escalation path* — which is the harder
problem.

**Cost lens.** Every alert escalates → twice the SNS publishes per
alert → ~$0.50 per million publishes × 2 = effectively zero cost at
POC volumes. At scale, the real cost is operational (alert fatigue
from auto-escalation), not financial.

---

## P5 pre-flight 4 — Escalation: same Lambda, different invocation payload

**Concept.** Reuse the alert handler for both notification paths; differentiate via input flag.

**Decision.** Both `NotifyOps` and `EscalateToOnCall` invoke the same
`alert-handler` Lambda. The escalation invocation passes
`{ escalated: true, context: <original input> }`; the handler reads
`escalated` and adjusts severity (P2 → P1), subject prefix, and metric
namespace accordingly.

**Alternatives rejected.**
- **Two separate Lambdas** — duplicate boilerplate (Powertools setup,
  SNS client, env var reading, error handling).
- **Two separate SNS topics** — could route to different subscribers,
  but for POC we want one topic any subscriber can hear.

**Why one Lambda.** Single source of truth for "what an alert
notification looks like." The escalated/non-escalated branch is one
conditional, not two functions.

**Cost lens.** No measurable cost difference. Slightly fewer cold
starts in aggregate because the same Lambda handles both invocations
within a single workflow execution and may be warm.

---

## P5 pre-flight 5 — SNS topic created in this stack, no subscriptions

**Concept.** Build the notification fan-out, leave the rotation /
PagerDuty / email subscription decision to the operational owner of
the system.

**Decision.** Single SNS topic `${projectName}-alerts` lives in the
alert workflow stack. No subscriptions in CDK code.

**Why.** Subscriptions are environment-specific (real on-call rotations
differ from staging from dev). Hardcoding a subscriber in CDK ties the
infrastructure to one operational decision. Leaving it empty means the
SNS publishes show up in CloudWatch metrics (count of messages
published) — visible proof the alert path works — without any
notification spam during POC iteration.

**Cost lens.** SNS without subscribers costs $0.50 per million
publishes for the publishes themselves. Adding subscribers later is a
one-line CDK change.

**Tradeoff.** Without a subscription, alerts are invisible unless you
look at the SNS console or CloudWatch logs. For demo/portfolio
purposes that's fine; production would add an email or PagerDuty
subscriber.

---

## P5 pre-flight 6 — Cross-stack: AlertWorkflowStack → IotStack

**Concept.** The `ThresholdAlertRule` (an IoT rule) needs the Step
Functions state machine ARN. Stack composition needs to handle this
cleanly.

**Decision.** `IotStack` accepts `alertStateMachine?: sfn.IStateMachine`
as an optional constructor prop. When provided, `IotStack` adds:
- A new inline policy on the existing `iotRulesRole` granting
  `states:StartExecution` on the state machine ARN.
- A second IoT Rule (`ThresholdAlertRule`) with SQL filter mirroring
  `src/lib/threshold.ts` and a `stepFunctions` action.

`AlertWorkflowStack` is instantiated *before* `IotStack` in
`infra/bin/app.ts`. CDK's implicit cross-stack reference creates the
dependency.

**Alternatives rejected.**
- **Add ThresholdAlertRule in AlertWorkflowStack** — would require
  duplicating IoT Rules role construction; lifecycle weird (the rule
  belongs with the IoT layer).
- **Hardcode ARN via CFN ExportValue** — works but harder to test in
  isolation; CDK's prop-based wiring is cleaner.

**Why optional prop.** Lets `IotStack` deploy independently for Phase
4 (the existing happy path with only `AllTelemetryRule`) and for tests
that don't need the alert workflow.

**Tradeoff.** The IoT stack will *update* on Phase 5 deploy (adding
the threshold rule + the stepfunctions inline policy). CDK handles
this fine; the existing telemetry rule isn't affected.

---

## Cross-cutting framing for Phase 5

Three durable patterns this phase encodes:

1. **Predicate parity across implementations.** The threshold check
   lives in three places now: `src/lib/threshold.ts` (pure TS),
   `IotStack.ThresholdAlertRule` (IoT Rules SQL), and
   `alert-handler.ts` (TS again, for annotation). All three must
   match. Production hardening would generate them from a single
   source.

2. **Optional cross-stack composition.** Phase 4's `IotStack` was
   self-sufficient. Phase 5 extends it via an optional prop rather
   than refactoring it into a different shape. New phases compose with
   existing stacks via additive props.

3. **Document what's deferred, don't pretend it's done.** The ack
   mechanism is genuinely missing — the workflow always escalates.
   Saying so explicitly (in code comments, in this decision log, in
   the review checklist) is more honest than building a placeholder
   ack endpoint that no real system would use.
