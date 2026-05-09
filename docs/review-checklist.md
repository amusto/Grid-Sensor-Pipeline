# Review Checklist

Running list of what's been implemented, what still needs verification, and
what's a known open question.

**Legend:** `[x]` done & verified · `[ ]` pending · `[?]` decision still open
· `[!]` known tradeoff / tech-debt to revisit

---

## Phase 1 — Lib & test foundation (Types · Validator · Threshold · Repository)

### Implemented

- [x] `src/lib/types.ts` — `SensorEvent`, `SensorReading`, `AlertContext`,
      `ReadingType` (no AWS SDK imports — invariant #2).
- [x] `src/lib/validator.ts` — Zod schema, `validateSensorEvent()` at the I/O
      boundary, strict mode, sensorId regex `^sensor-[a-z0-9-]+$`.
- [x] `src/lib/threshold.ts` — pure `evaluateThreshold()` with NERC ±0.5 Hz
      and 120 V ±5 % defaults, no I/O (invariant #3).
- [x] `src/lib/repository.ts` — `SensorRepository` with `attribute_not_exists(pk)`
      conditional writes, range queries via composite SK, optional doc-client
      injection for tests.
- [x] `src/lib/{logger,tracer,metrics}.ts` — Powertools singletons, namespace
      `GridSensorPipeline`.
- [x] `src/__tests__/{validator,threshold,repository}.test.ts` — boundary
      matrices, mocked DynamoDB Doc Client, purity assertions on threshold.
- [x] Project scaffold — `package.json` (npm, Node ≥20), `tsconfig.json`
      (strict mode, no implicit returns, no unused locals), `jest.config.js`
      (ts-jest preset), `eslint.config.mjs` (ESLint 9 flat config, no-explicit-any
      enforced in src, relaxed in tests).
- [x] `.gitignore` extended for `dist/`, `coverage/`, CDK, `.DS_Store`, `.env`.

### Verify locally before moving to Day 2

- [ ] `npm install` succeeds (sandbox couldn't reach the registry — verify on
      your machine).
- [ ] `npm test` — three suites green, ~30+ assertions.
- [ ] `npm run build` — `tsc --noEmit` clean.
- [ ] `npm run lint` — clean against ESLint flat config.

### Open decisions / tradeoffs to revisit

- [?] **Zod schema strictness — `.strict()` vs `.passthrough()`.** Currently
      strict — extra fields throw. Defensible (signals discipline, fails loud
      on schema drift) but breaks if device firmware adds a benign field.
      Decide before Day 4 (IoT Core stack), since that's when devices start
      publishing real telemetry shapes.
- [?] **Timestamp offset acceptance.** Validator accepts `+HH:MM` offsets via
      `z.string().datetime({ offset: true })`. Devices typically publish UTC
      `Z`. Tighten if your operational answer is "all devices stamp UTC."
- [?] **`sensorId` regex permissiveness.** `^sensor-[a-z0-9-]+$` accepts edge
      cases like `sensor--foo` and `sensor-foo-`. If your IoT Thing naming
      convention forbids consecutive/trailing dashes, tighten to
      `^sensor-[a-z0-9](?:-?[a-z0-9])*$`.
- [!] **Threshold predicate duplicated.** `threshold.ts` mirrors the IoT Rules
      Engine SQL filter literally. Two places, one predicate — tag both with
      cross-references in the SQL when `iot-stack.ts` lands (Day 4).
- [!] **`ConditionalCheckFailedException` — Day 2 task.** Repository writes
      throw on duplicate. Processor must catch this specific error and treat
      as no-op success, otherwise duplicates become permanent
      `batchItemFailures` and march straight to the DLQ.
- [ ] **`'￿'` SK upper-bound sentinel.** Confirm DynamoDB `BETWEEN`
      handles the byte-order comparison as expected with one round-trip
      integration check on Day 3 (after the storage stack is deployable).

### Test coverage notes

- `validator.test.ts` covers happy path, every regex rejection class, ISO
  timestamp variants, readingType enum edges, NaN/Infinity, missing fields,
  extra fields (strict-mode rejection), non-object input.
- `threshold.test.ts` covers in-range / below / above / boundary for voltage
  and frequency, non-thresholded readingTypes, custom config injection,
  purity (no input or config mutation).
- `repository.test.ts` covers ctor validation, `PutCommand` shape including
  `ConditionExpression` and TTL math, optional `gridZone` omission, error
  propagation, `QueryCommand` PK-only / `from`-only / `to`-only / both,
  `Limit` and `ScanIndexForward` honored, empty-result handling.
- **Gap (acceptable for Day 1):** no test that asserts the specific
  `ConditionalCheckFailedException` is propagated unwrapped — the generic
  error-propagation test covers the path. Tighten on Day 2 when the processor
  has to differentiate.

### Defensive talking points

See `decisions/day-01-lib-foundation.md`.

---

## Phase 2 — Processor Lambda

### Pre-flight decisions captured

- [x] **Idempotency expiry: 24-26 h.** Matches Kinesis retention + safety
      margin. State must outlive the replay window.
- [x] **`ConditionalCheckFailedException` swallow scope: strict (named-error
      only).** Fail-loud / fail-quiet asymmetry — only swallow the one error
      that legitimately means no-op success.
- [x] **`ReadingType` metric dimension: include.** Bounded low-cardinality
      slice; sensorId would be a high-cardinality footgun in Datadog.
- See `decisions/phase-02-processor.md` for full rationale + cost lens.

### To implement

- [ ] **P2.1** `src/handlers/processor.ts` — Kinesis ESM handler with
      Powertools idempotency, EMF metrics, partial-failure isolation.
- [ ] **P2.2** `src/__tests__/processor.test.ts` — happy path, mixed batch,
      conditional-swallow, full failure.

### Open review items (post-implementation)

- [ ] Verify `ConditionalCheckFailedException` is identified by `err.name`,
      not by `instanceof` (the AWS SDK v3 throws plain `Error` subclasses
      with the name set).
- [ ] Confirm `metrics.publishStoredMetrics()` reaches `finally` even on
      handler-level throws.
- [ ] Confirm per-record metric dimensioning uses `metrics.singleMetric()`
      so dimensions don't bleed across records in the same batch.
- [ ] Confirm `IDEMPOTENCY_TTL_SECONDS` constant is sourced from the same
      definition that drives the CDK env-var injection on Phase 3.

---

## Phase 3 — Storage + processing CDK stacks

### Pre-flight decisions captured

- [x] **DynamoDB billing: on-demand (PAY_PER_REQUEST).** Bursty grid event
      traffic; provisioned would either over-provision baseline or throttle
      the spike that matters most.
- [x] **Kinesis: 1 shard, 24h retention.** Coupled to processor's 25h
      idempotency TTL. Extending retention here REQUIRES extending the TTL.
- [x] **Firehose buffer: 5 min / 5 MB GZIP JSON.** Industry-default
      buffering; Parquet conversion deferred.
- [x] **Lambda: 512 MB, 30s timeout, ESM batch=10, window=1s.** Memory
      floor for Powertools without swap; small batches keep p99 down.
- [x] **ESM safety flags: bisectBatchOnError + reportBatchItemFailures
      + retry=5 + DLQ via SQS.** Each flag covers a distinct failure mode.
- [x] **RemovalPolicy.DESTROY everywhere** — POC posture. `cdk destroy`
      must actually remove resources to keep AWS bills clean.
- [x] **Three separate stacks** — boundaries follow lifecycle (storage
      persists, kinesis is stable, processing changes most often).
- See `decisions/phase-03-storage-processing.md` for full rationale + cost lens.

### Implemented

- [x] **P3.1** `cdk.json` + `infra/bin/app.ts` — three stacks composed via props
- [x] **P3.2** `infra/lib/storage-stack.ts` — readings table (+GSI on
      readingType+timestamp) + idempotency table
- [x] **P3.3** `infra/lib/kinesis-stack.ts` — Kinesis Data Stream + Firehose
      → S3 archive (lifecycle: IA@30d → Glacier@90d → expire@365d)
- [x] **P3.4** `infra/lib/processing-stack.ts` — Processor Lambda (Node 20,
      512 MB, X-Ray active) + Kinesis ESM with all four safety flags +
      SQS DLQ (7-day retention)
- [x] **CDK template assertions** — `infra/__tests__/processing-stack.test.ts`
      locks bisectBatchOnError, ReportBatchItemFailures, retry cap, DLQ wiring

### Run on local machine — completed

- [x] **P3.5** `npm install` — new devDeps installed
- [x] **P3.5** `npm test` — all 5 suites green (validator, threshold, repository, processor, processing-stack)
- [x] **P3.5** `cdk bootstrap` — `bootstrapped (no changes)` against existing bootstrap
- [x] **P3.5** `cdk synth` — all three stacks render
- [x] **P3.5** `cdk deploy --all` — three stacks live (with four in-flight fixes; see decision log addendum)
- [x] **P3.6** Smoke test — Kinesis put-record → DynamoDB row verified
- [x] **P3.6** Idempotency — duplicate Kinesis put → one row in DynamoDB; `Duplicate write swallowed (server-side dedup)` log line confirms `attribute_not_exists(pk)` path fired
- [x] **P3.6** Poison pill → DLQ — invalid payload reaches DLQ after retries (depth ≥ 1)

### Open review items (post-deploy)

- [ ] Verify the GSI on readings table returns expected results for a
      cross-sensor time-window query (real test before Phase 7's query API).
- [ ] Confirm the `'￿'` SK upper-bound sentinel works with DynamoDB's
      `BETWEEN` against real data.
- [ ] Consider adding CDK snapshot tests on `storage-stack` and
      `kinesis-stack` for completeness (deferred from Phase 3).
- [ ] Once steady-state traffic is known, revisit DynamoDB billing mode
      (provisioned + autoscaling may cross over).

---

## Phase 4 — IoT Core + simulator

### Pre-flight decisions captured

- [x] **No device certificates.** Simulator uses IAM-authorized Data
      Plane SDK publishes; Fleet Provisioning is the documented prod path.
- [x] **Topic policy: per-Thing wildcards.** `iot:Publish` scoped to
      `arn:aws:iot:.../topic/sensors/*/telemetry` — same access pattern
      a production device would receive.
- [x] **IoT data endpoint via CDK custom resource** — self-bootstrapping;
      no manual shell step to inject the endpoint into env vars.
- [x] **`ThresholdAlertRule` deferred to Phase 5.** Avoids a placeholder
      Step Functions ARN dependency.
- [x] **Simulator payload: Box-Muller Gaussian, 5-sensor pool, optional
      `--breach` flag** for guaranteed out-of-range voltage/frequency.
- [x] **Single IoT stack** for Rules engine + simulator.
- See `decisions/phase-04-iot-simulator.md` for full rationale + cost lens.

### Implemented

- [x] **P4.1** `infra/lib/iot-stack.ts` — endpoint discovery, Rules role
      with inline Kinesis policy, `AllTelemetryRule`, simulator Lambda.
- [x] **P4.2** `src/handlers/simulator.ts` — Gaussian payload generator,
      breach mode, EMF metrics.
- [x] **P4.3** `scripts/simulate.ts` — local CLI driver invoking the
      simulator Lambda. Supports `--count`, `--breach`, `--function`,
      `--region`. Run via `npm run simulate -- --count 50`.
- [x] **P4.4** Endpoint wiring — `IOT_ENDPOINT` env injected from
      `iot:DescribeEndpoint` custom resource at deploy time.
- [x] CDK template assertions — `infra/__tests__/iot-stack.test.ts`
      locks the rule SQL, partition key, role inline policy, simulator
      env vars, and the `iot:Publish` ARN scope.

### To run on local machine

- [ ] **P4** `npm install` — picks up `@aws-sdk/client-lambda` for the script.
- [ ] **P4** `npm test` — six suites green (validator, threshold,
      repository, processor, processing-stack, kinesis-stack, iot-stack).
- [ ] **P4** `npm run synth` — verify all four stacks render.
- [ ] **P4** `npm run deploy` — provisions `GridSensorIotStack`
      alongside the existing three.
- [ ] **P4** Smoke test happy path:
      ```bash
      npm run simulate -- --count 50
      sleep 10
      aws dynamodb scan \
        --table-name grid-sensor-pipeline-readings \
        --limit 10 \
        --query "Items[*].[pk.S, sk.S, value.N, readingType.S]" --output table
      ```
      Expected: ~50 rows in DynamoDB after a few seconds.
- [ ] **P4** Smoke test breach path:
      ```bash
      npm run simulate -- --count 5 --breach
      ```
      Records should reach DynamoDB; Phase 5 alert workflow not yet wired,
      so no Step Functions execution to verify (yet).

### Open review items

- [ ] Confirm the `topic(2) AS sensorId` SQL extracts the right segment
      (the second `/`-delimited piece) at runtime — verify a stored
      reading's `pk` matches the sensor ID in the original topic.
- [ ] Decide on rule `errorAction` for Phase 6 — drop vs SQS for
      Kinesis put failures.
- [ ] Run `npm run lint` to make sure scripts/ + simulator / iot-stack
      are clean (linting was deferred behind the scripts/ exemption).

---

## Phase 5 — Alert workflow

### Pre-flight decisions captured

- [x] **Standard Workflow** (CLAUDE.md hard rule #10) — 90-day audit
      retention, free Wait state, per-step retry.
- [x] **Wait state: 15 minutes** — configurable via
      `cdk deploy -c ackWaitMinutes=N`.
- [x] **Acknowledgment: default-false (no ack mechanism in MVP).**
      Workflow always escalates after the wait. Production extension
      paths documented (task-token callback or DynamoDB ack table).
- [x] **Escalation: same Lambda, different invocation payload.** P1 vs
      P2 differentiated by `escalated: true` flag.
- [x] **Single SNS topic, no subscriptions.** Subscriptions are an
      operational decision per environment.
- [x] **Cross-stack: AlertWorkflowStack → IotStack via constructor
      prop.** IotStack accepts optional `alertStateMachine`; when
      provided, adds `ThresholdAlertRule` and the `StepFunctionsStart`
      inline policy.
- See `decisions/phase-05-alert-workflow.md` for full rationale + cost lens.

### Implemented

- [x] **P5.1** `src/handlers/alert-handler.ts` — single Lambda for both
      NotifyOps and EscalateToOnCall paths; reuses validator and
      threshold modules; per-record metric dimensioning via
      `singleMetric()`.
- [x] **P5.2** `infra/lib/alert-workflow-stack.ts` — Standard Workflow
      with `NotifyOps → WaitForAck → IsAcknowledged → AlertResolved |
      EscalateToOnCall → AlertResolved`. X-Ray + ALL-level logging.
- [x] **P5.3** IoT rule wiring — `infra/lib/iot-stack.ts` extended with
      conditional `ThresholdAlertRule` when `alertStateMachine` prop is
      provided. SQL filter mirrors `src/lib/threshold.ts` exactly.
- [x] **P5.4** Cross-stack composition — `infra/bin/app.ts` instantiates
      `AlertWorkflowStack` before `IotStack`, passes the state machine
      via constructor prop.
- [x] CDK template assertions — `infra/__tests__/alert-workflow-stack.test.ts`
      locks Standard type, X-Ray, ALL-level logging, runtime, env vars,
      SNS topic + grant.

### Run on local machine — completed

- [x] **P5** `npm install` — `@aws-sdk/client-sns` installed
- [x] **P5** `npm test` — all 8 suites green
- [x] **P5** `npm run synth` — all 5 stacks render
- [x] **P5** `npm run deploy` — `GridSensorAlertWorkflowStack` provisioned;
      `GridSensorIotStack` updated with `ThresholdAlertRule` and
      `StepFunctionsStart` inline policy. L2 interface drift fix landed
      in flight (`stateMachineName` exposed as separate prop on
      `AlertWorkflowStack`)
- [x] **P5** Smoke test — `npm run simulate -- --count 5 --breach`
      started 4 Step Functions executions (all `RUNNING` in
      `WaitForAck` state). Bimodal Gaussian distribution as designed:
      frequency 59.092 Hz, voltage 109.876/111.25/129.411 V across
      sensor-002/sensor-003
- [x] **P5** Alert handler logs confirmed all 4 executions reached
      `Alert notified` with `severity: P2`, `thresholdBreached: true`,
      and EMF metrics emitted with `ReadingType` dimension

### Open review items

- [ ] Verify the threshold predicate in `iot-stack.ts`'s SQL matches
      `src/lib/threshold.ts` byte-for-byte. If you tune the thresholds
      in either place, update both. Production hardening: generate
      one from the other.
- [ ] Add an SNS email subscription before any real demo — otherwise
      alerts disappear into the void (only visible in the SNS console
      / CloudWatch metric counts).
- [ ] Consider lowering `ackWaitMinutes` to 1 for faster smoke
      iteration during demo prep, then redeploy with the default 15
      for the portfolio version.

---

## Phase 6 — DLQ + observability

### Pre-flight decisions captured

- [x] **DLQ inspector: log + alert + metric, NO auto-replay.** Replay is
      env-flag-opt-in (`REPLAY_TO_KINESIS=true`); default off prevents
      poison-pill retry storms.
- [x] **Single observability stack, one dashboard URL.** Cross-stack
      refs from ProcessingStack + AlertWorkflowStack via constructor props.
- [x] **Alarm thresholds verbatim from CLAUDE.md.** DLQ ≥ 1, P99 > 2000ms
      × 3 min, SF failures ≥ 1.
- [x] **Separate `${projectName}-ops-alerts` SNS topic.** Different
      audience from P5's grid-event topic.
- [x] **Manual chaos verification for P6.6.** AWS FIS / continuous chaos
      is Phase 11+ scope.
- [x] **Dashboard reads CloudWatch metrics directly, not Logs Insights
      queries.** EMF metrics already wired by P1-P5.
- See `decisions/phase-06-dlq-observability.md` for full rationale + cost lens.

### Implemented

- [x] **P6.1** `src/handlers/dlq-inspector.ts` — SQS-triggered Lambda;
      parses Kinesis failure envelope; structured-logs sequence range
      and failure reason; emits `DlqMessagesReceived` metric;
      publishes to ops-alerts SNS.
- [x] **P6.2** `infra/lib/observability-stack.ts` — DLQ inspector
      Lambda + log group, ops-alerts SNS topic, three CloudWatch
      alarms with SNS actions, single dashboard with throughput +
      latency + failure-mode + DLQ + alert + Step Functions widgets.
- [x] **P6.3** Three alarms (`GridSensor-DLQ-Messages`,
      `GridSensor-P99-Latency`, `AlertWorkflow-Failures`) all
      publishing to the new ops-alerts topic.
- [x] **P6.4** DLQ inspector wired to `processing.dlq` via
      `SqsEventSource`; `processorDlq.grantConsumeMessages()` issued.
- [x] CDK template assertions —
      `infra/__tests__/observability-stack.test.ts` locks alarm
      thresholds, evaluation periods, comparison operators, replay
      default, dashboard count, ops-alerts topic name.

### To run on local machine

- [ ] **P6** `npm install` — no new deps
- [ ] **P6** `npm test` — 9 suites green (validator, threshold,
      repository, processor, processing-stack, kinesis-stack, iot-stack,
      alert-workflow-stack, observability-stack)
- [ ] **P6** `npm run synth` — all 6 stacks render
- [ ] **P6** `npm run deploy` — provisions
      `GridSensorObservabilityStack`; updates none of the others
- [ ] **P6.5** Verify dashboard URL renders with live data:
      ```bash
      DASHBOARD=$(aws cloudformation describe-stacks \
        --stack-name GridSensorObservabilityStack \
        --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
        --output text)
      echo $DASHBOARD
      # Open in browser; should render all widgets with empty data initially
      ```
- [ ] **P6.5** Generate traffic to populate widgets:
      ```bash
      npm run simulate -- --count 100
      sleep 60   # wait for EMF metrics to surface in CloudWatch
      ```
- [ ] **P6.6** Forced-failure verification — drive each alarm path:
      - **DLQ alarm:** put a poison-pill record on Kinesis directly:
        ```bash
        aws kinesis put-record \
          --stream-name grid-sensor-pipeline-telemetry \
          --partition-key sensor-bad \
          --data '{"this":"is","not":"valid"}' \
          --cli-binary-format raw-in-base64-out
        # After ~60s of ESM retries + bisection, alarm fires
        ```
      - **SF failures alarm:** force a failed alert workflow execution
        via console: edit alert-handler env to break it, then trigger
        a breach. (Reset after.)

### Open review items

- [ ] Confirm DLQ inspector log shows the parsed failure envelope
      (sequence range + reason) when a real DLQ message arrives.
- [ ] Confirm dashboard widgets render correctly with traffic flowing.
- [ ] Decide whether to add an SNS email subscription on the ops-alerts
      topic before any portfolio demo (otherwise alarms fire silently).
- [ ] Phase 9 polish: revisit Kinesis stream rollback orphan pattern —
      either move stream to its own micro-stack or set
      `RemovalPolicy.RETAIN` explicitly to avoid the third-time orphan
      we hit this morning.

---

## Phase 7 — Query API (pending)

## Phase 8 — Datadog bridge (pending)

## Phase 9 — Polish & teardown (pending)
