# AWS Step Functions — Cheatsheet

> **Status: filled** — Phase 5 implemented. Project anchors below
> reference the actual code.

> **Where this is used in the project:**
> `infra/lib/alert-workflow-stack.ts` (Standard workflow definition),
> `src/handlers/alert-handler.ts` (NotifyOps + EscalateToOnCall
> Lambda), `infra/lib/iot-stack.ts` (`ThresholdAlertRule` that starts
> executions). Decision rationale lives in
> [`docs/decisions/phase-05-alert-workflow.md`](../decisions/phase-05-alert-workflow.md).

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

## Project-specific anchors

- **`infra/lib/alert-workflow-stack.ts`** — the state machine. Standard
  workflow, X-Ray tracing on, ALL-level CloudWatch logging with
  execution data, 1-hour timeout. Defined via CDK L2 constructs
  (`sfn.StateMachine`, `tasks.LambdaInvoke`, `sfn.Wait`,
  `sfn.Choice`, `sfn.Succeed`).
- **`src/handlers/alert-handler.ts`** — single handler for both
  `NotifyOps` (P2 initial notification) and `EscalateToOnCall` (P1
  escalation). Differentiation by `escalated: true` flag on input.
  Validates the source event with the existing Zod validator,
  evaluates the threshold, publishes to SNS with a JSON body
  including severity and threshold context.
- **`infra/lib/iot-stack.ts`** — `ThresholdAlertRule` is added when
  `props.alertStateMachine` is provided (Phase 5+). SQL filter mirrors
  the `DEFAULT_THRESHOLDS` in `src/lib/threshold.ts` exactly. The
  IoT Rules role gets a conditional `StepFunctionsStart` inline policy
  granting `states:StartExecution` on the state machine ARN.

### Workflow diagram

```
[ThresholdAlertRule fires]
        │
        ▼
   ┌──────────┐
   │ NotifyOps│ ──► alert-handler Lambda
   └──────────┘     ──► SNS publish (P2 [<sensorId>])
        │            returns { acknowledged: false }
        ▼
   ┌────────────┐
   │ WaitForAck │  15 minutes (configurable: -c ackWaitMinutes=N)
   └────────────┘
        │
        ▼
   ┌─────────────────┐
   │ IsAcknowledged? │ Choice on $.alert.acknowledged
   └─────────────────┘
        │              │
   true │              │ false (always, in MVP)
        ▼              ▼
  AlertResolved  ┌──────────────────┐
   (Succeed)     │ EscalateToOnCall │ ──► alert-handler Lambda
                 └──────────────────┘     ──► SNS publish (P1 ESCALATED)
                        │
                        ▼
                  AlertResolved
                   (Succeed)
```

The MVP handler always returns `acknowledged: false` — see decision
log P5 pre-flight 3 for the production extension path
(task-token callback or DynamoDB ack table polling).

---

## Tuning knobs in this project

- **Workflow timeout:** 1 hour. Long enough for the 15-min wait +
  retries; short enough that orphaned executions don't accrue cost.
- **Wait state:** 15 minutes default; `cdk deploy -c ackWaitMinutes=1`
  for fast iteration during development.
- **X-Ray tracing:** enabled. Adds a Trace ID to every execution that
  threads back through Lambda invocations and downstream AWS SDK
  calls.
- **Logging level:** `ALL` with `IncludeExecutionData: true`. Every
  state transition logged with full input/output. Costly at scale;
  appropriate for safety-critical workflows where audit is required.
  Production-at-scale would tune to `ERROR` and rely on the 90-day
  execution history for routine inspection.
- **`resultSelector` + `resultPath` on NodifyOps:** pulls just
  `acknowledged` out of the Lambda's response and stores at
  `$.alert.acknowledged`. Keeps the Choice predicate readable
  (`booleanEquals('$.alert.acknowledged', true)`) without surfacing
  the full Lambda response shape (`$.Payload.acknowledged`).
- **`sfn.JsonPath.entirePayload` on EscalateToOnCall:** the
  escalation invocation passes the *entire* current state to the
  handler under `context`, so the handler can re-render the original
  notification with escalated severity.

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

## CLI cheatsheet

```bash
# Trigger a breach (drives ThresholdAlertRule, starts the workflow)
npm run simulate -- --count 5 --breach

# List the most recent executions
ARN=$(aws cloudformation describe-stacks \
  --stack-name GridSensorAlertWorkflowStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlertWorkflowArn'].OutputValue" \
  --output text)
aws stepfunctions list-executions \
  --state-machine-arn $ARN \
  --max-results 10

# Inspect one execution's history
aws stepfunctions get-execution-history --execution-arn <execution-arn>

# Tail the alert handler's logs in real time
aws logs tail /aws/lambda/grid-sensor-pipeline-alert-handler --since 5m --follow

# Check the SNS topic for published messages count
aws sns get-topic-attributes \
  --topic-arn $(aws cloudformation describe-stacks \
    --stack-name GridSensorAlertWorkflowStack \
    --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue" \
    --output text) \
  --query "Attributes.PublishedMessages"
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
