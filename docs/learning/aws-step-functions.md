# AWS Step Functions — Cheatsheet

> **Status: STUB** — Phase 5 hasn't shipped yet. Pre-populated with the
> conceptual scaffolding and resource links. Project-anchor sections are
> marked TODO and get filled when `infra/lib/alert-workflow-stack.ts`
> and `src/handlers/alert-handler.ts` land.

> **Where this will be used in the project:**
> `infra/lib/alert-workflow-stack.ts` (Standard workflow definition),
> `src/handlers/alert-handler.ts` (the Lambda task targets). Decision
> rationale will live in `docs/decisions/phase-05-alert-workflow.md`.

---

## Mental model

AWS Step Functions is a managed **workflow engine**. You define a state
machine — a directed graph of states (`Task`, `Choice`, `Wait`,
`Parallel`, `Map`, `Pass`, `Succeed`, `Fail`) — and Step Functions
executes the graph durably, with full audit history, per-state retry,
and state transitions that survive consumer crashes.

If you've ever found yourself wiring multiple Lambdas together with SQS
queues and "now wait 15 minutes for an ack" timers, Step Functions is
the managed answer. The mental shift: stop thinking about "Lambdas
calling Lambdas" and start thinking about a graph of states whose
transitions are durable.

---

## The Standard vs Express decision

This is the single most important Step Functions decision you'll make.

| | Standard | Express |
|---|---|---|
| **Use case** | Long-running, auditable workflows | High-volume, short-lived |
| **Max duration** | 1 year | 5 minutes |
| **Execution history** | Retained 90 days | Logged to CloudWatch |
| **Pricing** | Per state transition (~$25/M) | Per request + duration (~$1/M plus duration) |
| **Wait state** | Free, no compute charged | Same, but bounded by 5 min total |
| **Idempotency** | Yes, executions have unique IDs | Yes |
| **At-least-once / exactly-once** | Exactly-once execution | At-least-once |

**Rule of thumb.** Standard for anything you'd want to audit later,
anything that needs a Wait state longer than a few minutes, or anything
with a regulatory requirement. Express for high-throughput, short
fan-out workflows where you only care about "did it succeed?"

This project uses **Standard** for alert escalation because:

1. Grid alerts need an audit trail (regulatory).
2. The workflow has a 15-minute Wait for human acknowledgment.
3. Per-step retry of the notification step is a hard requirement.

---

## Core concepts

### State Machine
The directed graph definition. Defined in **Amazon States Language**
(ASL) JSON, but you'll write it in CDK using the L2 constructs
(`sfn.StateMachine`, `tasks.LambdaInvoke`, etc.) which generate the
ASL for you.

### State types

| State | What it does | Used in this project? |
|---|---|---|
| `Task` | Invokes work (Lambda, ECS task, AWS API call, activity) | Yes — `LambdaInvoke` for the alert handler |
| `Choice` | Branches on input data using JSONPath conditions | Yes — `IsAcknowledged` check |
| `Wait` | Pauses execution for a duration or until a timestamp | Yes — `WaitForAck` (15 min) |
| `Parallel` | Runs multiple branches concurrently | No |
| `Map` | Iterates over an array (in parallel or sequence) | No |
| `Pass` | Manipulates JSON without invoking work | No |
| `Succeed` | Terminal state, success | Yes — `AlertResolved` |
| `Fail` | Terminal state, failure | No |

### Input / Output / Result paths
Each state has three JSON-path filters that determine how data flows:

- **InputPath** — what subset of the incoming JSON the state sees.
- **ResultPath** — where in the output JSON the state's result is
  inserted.
- **OutputPath** — what subset of the resulting JSON gets passed to the
  next state.

Default behavior (no filters) passes the whole JSON through and
overwrites it with the task result. For most cases you want
`ResultPath: '$.notifyResult'` so the result is added to the input
without erasing it.

### Error handling: Retry and Catch
Each `Task` state can declare:

- **Retry** — retry on specific error types with backoff. Configurable
  per-error-type, per-attempt count, per-backoff-rate.
- **Catch** — route to a different state on specific errors.

This is the killer feature compared to a Lambda chain — a transient
notification failure retries that step only, not the whole workflow.

### Activities vs service integrations
- **Lambda invocation** — most common. The state invokes a Lambda
  function and waits for its return.
- **AWS service direct integration** — call DynamoDB, SNS, SQS, etc.
  directly without a Lambda glue function. Less code, faster, cheaper.
- **Activities** — for self-hosted workers. Niche, mostly legacy.

---

## TODO — Project-specific anchors (fill on Phase 5)

When the alert workflow lands, fill in:

- [ ] `infra/lib/alert-workflow-stack.ts` — the state machine
      definition. Standard workflow type, tracingEnabled, 1-hour
      timeout.
- [ ] `src/handlers/alert-handler.ts` — Lambda for both `NotifyOps`
      and `EscalateToOnCall` paths.
- [ ] Workflow ASCII diagram in this note:
      `NotifyOps → WaitForAck (15m) → IsAcknowledged → AlertResolved | EscalateToOnCall → AlertResolved`
- [ ] IoT rule wiring — the `ThresholdAlertRule` from P4 needs the
      state machine ARN to call `StartExecution`. Cross-stack
      reference.

---

## TODO — Tuning knobs (fill on Phase 5)

- [ ] Workflow timeout — currently 1 hour. Long enough for the 15-min
      wait + retries, short enough to not pay for orphaned executions.
- [ ] Per-step retry policy — exponential backoff parameters for the
      `NotifyOps` step.
- [ ] X-Ray tracing enabled — yes for the audit trail.
- [ ] Logging level — `ALL` (every state transition) for the POC,
      `ERROR` for production cost control.

---

## Pitfalls (general knowledge — verify during P5)

1. **Standard vs Express cost surprise at scale.** Standard pricing is
   ~$25 per million state transitions. A workflow with 10 states
   running 1M times/month = $250/month. Express is ~$1/M for the same
   pattern but loses execution history. Audit *each workflow's
   pricing model* against expected volume before committing.

2. **JSONPath gotchas.** Step Functions JSONPath is a subset:
   `$.field`, `$.field[0]`, `$..deep`. No filters, no functions like
   `$.field.length()`. If your input is awkward, use a `Pass` state
   with `Parameters` to reshape it before the next `Task`.

3. **Wait state vs Lambda polling.** A Step Functions `Wait` is *free*
   (no compute charged during the wait). A Lambda that sleeps for 15
   minutes costs 15 minutes of Lambda execution time. This is one of
   the strongest economic arguments for Step Functions.

4. **Execution history retention.** Standard retains 90 days. Express
   logs to CloudWatch with whatever retention you set. If you need
   audit history beyond 90 days, archive executions to S3 via
   CloudTrail or a periodic export.

5. **CDK ASL synthesis is opaque.** When CDK generates the state
   machine ASL, it's verbose JSON. Use `cdk synth` and inspect the
   actual ASL when debugging — it's often clearer than the CDK code.

6. **The `Parameters` vs `ResultPath` confusion.** `Parameters`
   reshapes the *input* to the task; `ResultPath` says where to put
   the *output*. Easy to mix up.

---

## Cost levers, ordered by impact

1. **Workflow type (Standard vs Express).** ~25× difference per
   transition. The single biggest cost driver.
2. **State count per workflow.** Each transition is billable in
   Standard. Combining states with `Pass` reshaping where possible
   saves transitions.
3. **Logging level.** `ALL` logs every state transition; `ERROR` logs
   only failures. CloudWatch Logs cost can dominate at scale.
4. **X-Ray tracing.** Per-trace cost. Negligible unless you're at
   millions of executions.

For this project's safety-critical workflow with low frequency, cost
is rounding-error.

---

## TODO — CLI cheatsheet (fill during P5 smoke test)

```bash
# Start an execution manually
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:...:stateMachine:GridSensorAlertWorkflow \
  --input '{"sensorId":"sensor-001",...}'

# List recent executions
aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-east-1:...:stateMachine:GridSensorAlertWorkflow \
  --max-results 10

# Get execution history
aws stepfunctions get-execution-history --execution-arn ...

# Send acknowledgment (for the manual ack flow during smoke test)
aws stepfunctions send-task-success --task-token ... --output '{"acknowledged":true}'
```

---

## Learning resources

Ordered by what's most useful first.

### Official docs
- **[Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/latest/dg/)**
  — read the "Concepts" and "States" sections.
- **[Amazon States Language Specification](https://states-language.net/)**
  — short, well-written. The complete reference for the JSON DSL Step
  Functions executes.
- **[Standard vs Express comparison](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-standard-vs-express.html)**
  — the canonical decision matrix.

### Hands-on workshops
- **[Step Functions Workshop](https://catalog.workshops.aws/stepfunctions/)**
  — official self-paced. Covers both Standard and Express.
- **[Serverless Patterns Collection — Step Functions](https://serverlessland.com/patterns?services=step-functions)**
  — copy-paste-able CDK examples.

### Conceptual depth
- **AWS re:Invent talks** — search YouTube for *"Step Functions Deep
  Dive"*. The 2023 version covers the Express/Standard decision in
  detail.
- **["Step Functions Anti-Patterns"](https://serverlessland.com/blog)**
  — Yan Cui's blog has multiple posts on what *not* to do.
- **[Workflows in Practice (Temporal)](https://temporal.io/blog)** —
  Temporal's blog covers durable workflow concepts that map onto Step
  Functions. Good for understanding the underlying patterns.

### Comparison context
- **Step Functions vs Temporal** — the two leading durable workflow
  engines. Step Functions is managed and AWS-locked; Temporal is
  multi-cloud but operationally heavier.
- **Step Functions vs Lambda chain with SQS** — when *not* to use Step
  Functions: high-throughput simple fan-out, no audit need, no Wait
  requirement.

---

## When to revisit this note

- During Phase 5 implementation — fill the TODO sections from real
  experience.
- Before any conversation about workflow durability, audit
  requirements, or "Lambda chain vs workflow engine" decisions.
- When evaluating Express for a high-volume use case.
- Before writing a workflow with more than ~5 states (the JSONPath
  shape complexity grows fast).
