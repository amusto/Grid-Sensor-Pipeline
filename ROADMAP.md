# Roadmap

Source of truth for the build sequence and current status. Updated at the end
of each phase. **Phases are units of work, not calendar days** — actual
elapsed time depends on focus and velocity.

---

## Status legend

| ✅ Complete | 🚧 In progress | ⏭️ Next up | ⏸️ Blocked | ⬜ Not started | 🎯 Stretch goal |
|---|---|---|---|---|---|

---

## Current state

**Today:** Day 2 (2026-05-09)
**Active phase:** Phase 6 — DLQ + observability (code shipped; deploy + chaos verification pending on user machine)
**Last shipped:** Phase 5 — Alert workflow (deployed Day 1, 4-execution breach smoke test verified ✅)
**Cost reminder:** Run `npm run destroy` at the end of each dev session — Kinesis shard time accrues at ~$0.36/day.

---

## Progress

### Overall

```
Core (P1-P12):     [███████████░░░░░░░░░] 57%   (39 / 68 sub-phases)
Stretch (P13-P14): [░░░░░░░░░░░░░░░░░░░░]  0%   ( 0 / 10 sub-phases)
Combined:          [██████████░░░░░░░░░░] 50%   (39 / 78 sub-phases)
```

> **Core** is the MVP — what reviewers expect to see for the JD scope.
> Phase 12 (Live demo dashboard) closes the core deliverable: pipeline
> live, observable, demonstrable. **Stretch** is what ships only if
> there's time and audience demand: P13 (auth & security hardening,
> *strong* stretch) and P14 (architecture & live visualizations,
> regular stretch). The core/stretch split matters because progress
> is honest only when "what's required to defend the project" is
> separated from "what's nice to have."
>
> *Day 2 evening scope expansion:* Two new CORE phases inserted to
> address JD's required AI/ML stack — Phase 8 (Bedrock + LangChain +
> LangGraph + MCP) and Phase 9 (Agentic case routing). Old P8-P12
> renumbered to P10-P14; P13 + P14 swapped so auth precedes viz in
> the stretch order.

### By phase

| # | Phase | Bar | % | Sub-phases | Status |
|---|---|---|---|---|---|
| 1 | Lib & test foundation        | `██████████` | 100% | 9/9 | ✅ |
| 2 | Processor Lambda             | `██████████` | 100% | 4/4 | ✅ |
| 3 | Storage + processing stacks  | `██████████` | 100% | 6/6 | ✅ |
| 4 | IoT Core + simulator         | `██████████` | 100% | 6/6 | ✅ |
| 5 | Alert workflow               | `██████████` | 100% | 6/6 | ✅ |
| 6 | DLQ + observability          | `███████░░░` |  67% | 4/6 | 🚧 |
| 7 | Query API                    | `███████░░░` |  67% | 4/6 | 🚧 |
| 8 | AI/ML Integration            | `░░░░░░░░░░` |   0% | 0/6 | ⏭️ |
| 9 | Agentic case routing         | `░░░░░░░░░░` |   0% | 0/6 | ⬜ |
| 10 | Datadog bridge              | `░░░░░░░░░░` |   0% | 0/3 | ⬜ |
| 11 | Polish & teardown           | `░░░░░░░░░░` |   0% | 0/4 | ⬜ |
| 12 | Live demo dashboard         | `░░░░░░░░░░` |   0% | 0/6 | ⬜ |
| 13 | Authentication & security hardening (strong stretch) | `░░░░░░░░░░` |   0% | 0/6 | 🎯 |
| 14 | Architecture & live visualizations (stretch) | `░░░░░░░░░░` |   0% | 0/4 | 🎯 |

### Gantt — phases on a timeline

GitHub renders this Mermaid block inline. For LinkedIn/decks, export with
`mmdc -i ROADMAP.md -o roadmap.png` or screenshot the rendered version.

```mermaid
gantt
    title Grid Sensor Pipeline Roadmap
    dateFormat YYYY-MM-DD
    axisFormat %m/%d
    section Foundation
    P1 Lib and tests              :done,   p1, 2026-05-08, 1d
    P2 Processor Lambda           :done,   p2, 2026-05-08, 1d
    section Infrastructure
    P3 Storage and processing     :done,   p3, 2026-05-08, 1d
    P4 IoT Core and simulator     :done,   p4, 2026-05-08, 1d
    P5 Alert workflow             :done,   p5, 2026-05-08, 1d
    P6 DLQ and observability      :active, p6, 2026-05-09, 1d
    section Application
    P7 Query API                  :active, p7, after p6, 1d
    section AI/ML
    P8 AI/ML Integration          :        p8, after p7, 2d
    P9 Agentic case routing       :        p9, after p8, 2d
    section Observability bridge
    P10 Datadog bridge            :        p10, after p9, 1d
    section Polish
    P11 Polish and teardown       :        p11, after p10, 1d
    section Demo
    P12 Live demo dashboard       :        p12, after p11, 2d
```

### Phase × Requirements matrix

Maps each phase to the CLAUDE.md architectural invariants and hard rules it
satisfies. This is the requirements-alignment view: progress isn't just
"code shipped" — it's "contract clauses honored."

| Phase | Status | CLAUDE.md invariants satisfied | CLAUDE.md hard rules satisfied | Notes |
|---|---|---|---|---|
| P1 | ✅ | #2 (no I/O in `lib/`), #3 (`threshold.ts` is pure) | #1 (no `any`), #2 (no `console.log`), #3 (no bare `catch`), #4 (no hardcoded names) | Foundation that subsequent invariants are enforced against |
| P2 | ✅ | #1 (validate at I/O boundary), #4 (no business logic in handler), #5 (idempotency = Kinesis seq#), #7 (always `batchItemFailures`), #8 (metrics in `finally`) | #1, #2, #3, #4 (continued) | Six contract clauses honored in 195 lines |
| P3 | ✅ | #6 (`attribute_not_exists(pk)` enforced at write time, **proven via "Duplicate write swallowed" log entry on duplicate Kinesis put**), #9 (`bisectBatchOnError: true` on ESM, locked by template assertions, **proven via poison-pill → DLQ smoke test**) | #4 (resource names from CDK context), #5 (no `--require-approval never` until stable) | All deployed and smoke-tested end-to-end |
| P4 | 🚧 | #1 (validation continues at I/O boundary — simulator emits well-formed events that the processor's validator accepts) | #4 (resource names from CDK context) | Code shipped; deploy + smoke test pending. `ThresholdAlertRule` SQL will mirror `threshold.ts` (P5 wires it) |
| P5 | ✅ | #10 (Step Functions Standard for alerting, locked by template assertions, **proven via 4 Step Functions executions started by simulator breach mode, all reaching `Alert notified` with bimodal threshold distribution**) | — | Same predicate as `lib/threshold.ts` mirrored into IoT Rules SQL — keep in lockstep |
| P6 | 🚧 | — | — | Code shipped: DLQ inspector + observability stack with 3 alarms (verbatim CLAUDE.md thresholds) + dashboard. Deploy + chaos verification pending |
| P7 | 🚧 | #1 (validate at the API boundary too — separate `queryParamsSchema` for the path/query params) | — | Read-only IAM via `grantReadData`; no PutItem/UpdateItem/DeleteItem in any policy (locked by template assertion). Auth deferred to Phase 14 |
| P8 | ⏭️ | #1 (Bedrock fallback to JSON narrative if LLM unavailable — alert never blocked on AI), #4 (alert handler stays orchestration; LangGraph reasoning lives inside one Step Functions task — hybrid pattern) | #1, #4 | AI/ML core: Bedrock + LangChain + LangGraph + MCP. Keeps Step Functions outer, adds agentic inner |
| P9 | ⬜ | #6 (case-tracker dedup via `attribute_not_exists(pk)` on the new cases table — same pattern as P2 readings dedup), #7 (partial-success result from tool execution; per-channel failures don't block other channels) | — | Stubbed external systems + one real SES email channel. Routing matrix as data; LLM as override |
| P10 | ⬜ | — | — | Pluggable observability via EMF (formerly P8) |
| P11 | ⬜ | — | #6 (`cdk destroy --all` after dev sessions) | Final teardown verification (formerly P9) |
| P12 | ⬜ | — | — | Demo surface only; reads existing metrics. Adds operational visibility for portfolio reviewers without changing pipeline contracts (formerly P10) |
| P13 | 🎯 | — | — | Strong stretch — auth & security hardening (prioritized over P14 since security has more portfolio + production weight than visualizations) |
| P14 | 🎯 | — | — | Stretch — architecture & live visualizations |

**Legend.** Invariants and rules numbered per `CLAUDE.md`. The matrix is
additive — once a clause is satisfied by an earlier phase, later phases
inherit and must not violate it.

## Notation

- **P<N>** — phase number (e.g., P2)
- **P<N>.<M>** — sub-phase within a phase (e.g., P1.2 = validator)
- **Day N (YYYY-MM-DD)** — calendar day reference in the daily log
- Each phase below numbers its sub-phases so the daily log can reference them
  precisely (`Day 3 (2026-05-10) — completed P2.1, started P2.2`).

---

## Phases at a glance

| # | Phase | Status | Primary deliverable | Decision log |
|---|---|---|---|---|
| 1 | Lib & test foundation | ✅ | Types · validator · threshold · repository · Powertools singletons · unit tests | [`docs/decisions/day-01-lib-foundation.md`](docs/decisions/day-01-lib-foundation.md) |
| 2 | Processor Lambda | ✅ | Kinesis ESM handler with Powertools idempotency, EMF metrics, partial-failure isolation | [`docs/decisions/phase-02-processor.md`](docs/decisions/phase-02-processor.md) |
| 3 | Storage + processing stacks | ✅ | CDK: Kinesis · DynamoDB · processor Lambda + ESM · DLQ — pipeline live | [`docs/decisions/phase-03-storage-processing.md`](docs/decisions/phase-03-storage-processing.md) |
| 4 | IoT Core + simulator | ✅ | IoT Rules: telemetry → Kinesis · simulator Lambda (threshold breaches deferred to P5) | [`docs/decisions/phase-04-iot-simulator.md`](docs/decisions/phase-04-iot-simulator.md) |
| 5 | Alert workflow | ✅ | Step Functions Standard: NotifyOps → Wait → IsAcknowledged → Escalate · alert-handler Lambda | [`docs/decisions/phase-05-alert-workflow.md`](docs/decisions/phase-05-alert-workflow.md) |
| 6 | DLQ + observability | 🚧 | DLQ inspector Lambda · CloudWatch dashboard · alarms (DLQ depth, P99, SF failures) | [`docs/decisions/phase-06-dlq-observability.md`](docs/decisions/phase-06-dlq-observability.md) |
| 7 | Query API | 🚧 | API Gateway + query Lambda · `GET /sensors/{id}/readings?from=&to=` | [`docs/decisions/phase-07-query-api.md`](docs/decisions/phase-07-query-api.md) |
| 8 | AI/ML Integration | ⏭️ | Bedrock-powered narratives · LangChain prompt templates · LangGraph agentic flow inside alert handler · MCP server with read-only query tools | [`docs/decisions/phase-08-ai-ml-integration.md`](docs/decisions/phase-08-ai-ml-integration.md) |
| 9 | Agentic case routing | ⬜ | Stubbed Slack/Jira/ServiceNow/PagerDuty/status-page tools · real SES email channel · idempotency-aware case persistence · routing matrix as data | [`docs/decisions/phase-09-agentic-case-routing.md`](docs/decisions/phase-09-agentic-case-routing.md) |
| 10 | Datadog bridge | ⬜ | Datadog Lambda Extension layer wired (or design-doc-only if not deployed) | _pending_ |
| 11 | Polish & teardown | ⬜ | README revision · architecture diagram · cost analysis · `cdk destroy` verification | _pending_ |
| 12 | Live demo dashboard | ⬜ | CloudWatch (CDK, quick win) · Grafana (depth + Aireon experience callback) · simulator trigger button · portfolio embed | _pending_ |
| 13 | Authentication & security hardening (strong stretch) | 🎯 | API Gateway throttling · API key + usage plan · Cognito user pool · IoT Fleet Provisioning · Secrets Manager · security model docs | _pending_ |
| 14 | Architecture & live visualizations (stretch) | 🎯 | Static architecture diagram suite · X-Ray service map embed · animated data flow · live event stream viewer | _pending_ |

---

## Phase 1 — Lib & test foundation ✅

**Goal.** Establish the typed I/O boundary, pure logic primitives, and the
DynamoDB abstraction with exhaustive unit tests. No infrastructure yet.

**Sub-phases & deliverables:**
- ✅ **P1.1** Domain types — `src/lib/types.ts` (`SensorEvent`, `SensorReading`, `AlertContext`, `ReadingType`)
- ✅ **P1.2** Validator — `src/lib/validator.ts` (Zod schema, `validateSensorEvent()`, strict, ISO 8601, sensorId regex)
- ✅ **P1.3** Threshold — `src/lib/threshold.ts` (pure `evaluateThreshold()`, NERC ±0.5 Hz / 120 V ±5 % defaults)
- ✅ **P1.4** Repository — `src/lib/repository.ts` (`SensorRepository`, `attribute_not_exists(pk)` writes, SK-range queries)
- ✅ **P1.5** Powertools singletons — `src/lib/{logger,tracer,metrics}.ts` under namespace `GridSensorPipeline`
- ✅ **P1.6** Unit tests — `src/__tests__/{validator,threshold,repository}.test.ts` (boundary matrix, mocked DocumentClient, purity assertions)
- ✅ **P1.7** Project scaffold — `package.json` (npm, Node ≥20), `tsconfig.json` (strict mode), `jest.config.js` (ts-jest), `eslint.config.mjs` (flat config), `.gitignore`
- ✅ **P1.8** Docs foundation — `docs/README.md`, `docs/review-checklist.md`, `docs/decisions/day-01-lib-foundation.md`, `docs/_private/interview-prep.md`
- ✅ **P1.9** Roadmap — `ROADMAP.md` (this file)

**Acceptance criteria:**
- [x] CLAUDE.md invariants 1-3 satisfied (validate at boundary, no I/O in lib, threshold is pure)
- [x] No `any`, no `console.log`, no bare `catch`
- [ ] `npm install && npm test && npm run build && npm run lint` clean on local machine

**Where to look:** [`docs/decisions/day-01-lib-foundation.md`](docs/decisions/day-01-lib-foundation.md), [`docs/review-checklist.md`](docs/review-checklist.md)

---

## Phase 2 — Processor Lambda ✅

**Goal.** Wire the Kinesis Event Source Mapping → handler → repository path
with idempotency, partial-failure isolation, and structured observability.

**Sub-phases & deliverables:**
- ✅ **P2.1** Processor handler — `src/handlers/processor.ts`
  - Decode Kinesis record → `validateSensorEvent()` → `repo.putReading()`
  - Wrapped: `tracer.captureLambdaHandler` + `logger.injectLambdaContext`
  - Per-record `makeIdempotent` keyed on `record.kinesis.sequenceNumber` via `eventKeyJmesPath`
  - Catches `ConditionalCheckFailedException` (by `err.name`) → no-op success
  - All other errors → `batchItemFailures` entry
  - EMF metrics: `EventsProcessed` + `ProcessingLatencyMs` (with `ReadingType` dimension via `metrics.singleMetric()`); `ValidationErrors`, `DuplicateWrites`, `PartialBatchFailures` on the shared instance
  - `metrics.publishStoredMetrics()` in `finally` (hard rule #8)
- ✅ **P2.2** Processor unit tests — `src/__tests__/processor.test.ts`
  - Happy path — full batch processed
  - Mixed batch — single bad record isolated
  - Full-failure batch — every record in `batchItemFailures`
  - Conditional swallow — `ConditionalCheckFailedException` returns success
  - Throttling does NOT get swallowed
  - Non-Error thrown values do NOT get swallowed
  - Mixed failure modes (validation + duplicate + throttle in one batch)
  - `isConditionalCheckFailed` helper unit tests (name match, similar names, non-Error values)
  - `IDEMPOTENCY_TTL_SECONDS` bounds check vs. Kinesis retention
- ✅ **P2.3** Decision log — `docs/decisions/phase-02-processor.md` (3 pre-flight decisions captured)
- ✅ **P2.4** Review checklist & interview-prep updates for Phase 2

**Acceptance criteria:**
- All processor test cases green
- Structured errors include sensorId or sequence number
- `metrics.publishStoredMetrics()` reachable on every code path

**Open decisions to resolve at start:**
1. Idempotency expiry window — recommend 24-26 h to match Kinesis retention
2. Conditional-failure swallow scope — recommend: only `ConditionalCheckFailedException` name match
3. `ReadingType` metric dimension — recommend: include (5 cardinality, cheap on CloudWatch)

---

## Phase 3 — Storage + processing CDK stacks ✅

**Goal.** First infrastructure phase. Stand up the storage and streaming
backbone, deploy the processor Lambda with the ESM, accept live events.

**Sub-phases & deliverables:**
- ✅ **P3.1** CDK app entrypoint — `infra/bin/app.ts`, `cdk.json`
- ✅ **P3.2** Storage stack — `infra/lib/storage-stack.ts` (readings table with `pk`/`sk`/TTL + GSI on `readingType + timestamp`, idempotency table)
- ✅ **P3.3** Kinesis stack — `infra/lib/kinesis-stack.ts` (Data Stream 1 shard / 24 h retention + Firehose → S3 cold archive with lifecycle IA→Glacier→expire; JSON+GZIP, Parquet deferred)
- ✅ **P3.4** Processing stack — `infra/lib/processing-stack.ts` (Processor Lambda · ESM with `bisectBatchOnError` + `reportBatchItemFailures` + retry=5 · SQS DLQ · IAM grants); CDK template assertions in `infra/__tests__/processing-stack.test.ts` lock the safety flags
- ✅ **P3.5** Bootstrap + first deploy — three stacks deployed (`GridSensorStorageStack`, `GridSensorKinesisStack`, `GridSensorProcessingStack`); four real-world snags surfaced and fixed in flight (see decision-log addendum below)
- ✅ **P3.6** Smoke test — Kinesis put-record → DynamoDB row verified, idempotent retry confirmed (`Duplicate write swallowed` log line), DLQ poison-pill confirmed (DLQ depth ≥ 1 after garbage payload)

**Acceptance criteria:**
- Full pipeline accepts a record from Kinesis to DynamoDB
- Idempotent retry verified (put twice, see one item)
- DLQ receives a deliberately invalid record after retries
- Cost teardown: `cdk destroy --all` removes all resources

**Dependencies:** Phase 2 complete.

---

## Phase 4 — IoT Core + simulator ✅

**Goal.** Replace the manual `put-record` with the real device path —
MQTT publish to IoT Core, Rules Engine routing to Kinesis and Step Functions.

**Sub-phases & deliverables:**
- ✅ **P4.1** IoT stack — `infra/lib/iot-stack.ts`
  - IoT data endpoint discovery via `AwsCustomResource`
  - IoT Rules role with inline `kinesis:PutRecord`/`PutRecords` policy
  - `AllTelemetryRule` — `SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'` → Kinesis (partition key `${sensorId}`)
  - Simulator Lambda (Node 20, 256 MB, X-Ray active) with `iot:Publish` scoped to `sensors/*/telemetry`
  - `ThresholdAlertRule` deferred to P5 (depends on Step Functions ARN)
  - Device certificates intentionally omitted (Fleet Provisioning is the prod path; simulator uses IAM auth via Data Plane SDK)
- ✅ **P4.2** Simulator handler — `src/handlers/simulator.ts` (Box-Muller Gaussian generator, 5-sensor pool, optional `--breach` mode, EMF metrics)
- ✅ **P4.3** Simulate script — `scripts/simulate.ts` (CLI driver: `--count`, `--breach`, `--function`, `--region`); `npm run simulate -- --count 50`
- ✅ **P4.4** Endpoint wiring — self-bootstrapping via `iot:DescribeEndpoint` custom resource at deploy time
- ✅ CDK template assertions — `infra/__tests__/iot-stack.test.ts` locks rule SQL, partition key, role policies, simulator IAM scope
- ✅ **P4.5** Deploy — `GridSensorIotStack` provisioned in account
- ✅ **P4.6** Smoke test — `npm run simulate -- --count 50` published 50 events; all reached DynamoDB through IoT → Kinesis → ESM → processor → repository path; breach mode tested (5 events, no failures)

**Acceptance criteria:**
- `npx ts-node scripts/simulate.ts --count 50` results in 50 items in DynamoDB
- IoT Rules SQL filter matches `threshold.ts` predicate exactly (cross-referenced)
- Threshold breach in simulator triggers a Step Functions execution

**Dependencies:** Phase 3 deployed; Phase 5 stack at least defined (alert state machine ARN must exist for the IoT rule to reference).

---

## Phase 5 — Alert workflow ✅

**Goal.** Auditable, long-running alert escalation backed by Step Functions
Standard.

**Sub-phases & deliverables:**
- ✅ **P5.1** Alert handler — `src/handlers/alert-handler.ts` (single Lambda for both NotifyOps and EscalateToOnCall, differentiated by `escalated: true` flag; reuses validator + threshold modules; per-record metric dimensioning via `singleMetric()`)
- ✅ **P5.2** Alert workflow stack — `infra/lib/alert-workflow-stack.ts` (Standard Workflow with `NotifyOps → WaitForAck → IsAcknowledged → AlertResolved | EscalateToOnCall → AlertResolved`; X-Ray active; ALL-level CloudWatch logging with execution data; 1-hour timeout; SNS topic with no subscriptions)
- ✅ **P5.3** IoT rule wiring — `infra/lib/iot-stack.ts` extended with conditional `ThresholdAlertRule` when `alertStateMachine` prop provided; conditional `StepFunctionsStart` inline policy on the IoT Rules role
- ✅ **P5.4** Cross-stack composition — `infra/bin/app.ts` instantiates `AlertWorkflowStack` before `IotStack`, passes state machine via constructor prop
- ✅ CDK template assertions — `infra/__tests__/alert-workflow-stack.test.ts` locks Standard type, X-Ray, ALL-level logging, runtime, env vars, SNS publish grant
- ✅ **P5.5** Deploy — `GridSensorAlertWorkflowStack` provisioned; `GridSensorIotStack` updated with `ThresholdAlertRule` + `StepFunctionsStart` inline policy. L2 interface drift fix landed (`stateMachineName` exposed as separate prop)
- ✅ **P5.6** Smoke test — `npm run simulate -- --count 5 --breach` started 4 Step Functions executions (4 breach readings of voltage/frequency out of 5 events; one was a non-thresholded readingType). Alert handler logs confirmed all 4 reaching `Alert notified` with bimodal distribution as designed (frequency 59.092 Hz, voltage 109.876/111.25/129.411 V across sensor-002 and sensor-003)

**Acceptance criteria:**
- Triggering a threshold breach via simulator runs the full state machine
- Execution history retained, viewable in console
- Mocked ack via SDK call resolves the workflow without escalation

**Dependencies:** Phase 4 IoT rule needs the state machine ARN.

---

## Phase 6 — DLQ + observability 🚧

**Goal.** Production-grade visibility — dashboards, alarms, DLQ inspection.

**Sub-phases & deliverables:**
- ✅ **P6.1** DLQ inspector — `src/handlers/dlq-inspector.ts`
  (SQS-triggered, parses Kinesis failure envelope, structured-logs
  sequence range + reason, emits `DlqMessagesReceived`, publishes to
  ops-alerts SNS; optional replay env-flagged off by default)
- ✅ **P6.2** Observability stack — `infra/lib/observability-stack.ts`
  (DLQ inspector Lambda + log group, ops-alerts SNS topic, single
  dashboard with throughput / latency p50-p95-p99 / validation errors /
  partial batch failures / duplicate writes / DLQ depth / alerts /
  Step Functions execution counts)
- ✅ **P6.3** Alarms — three with SNS actions:
  `GridSensor-DLQ-Messages` (≥ 1, 1 period),
  `GridSensor-P99-Latency` (> 2000 ms, 3 periods),
  `AlertWorkflow-Failures` (≥ 1, 1 period)
- ✅ **P6.4** DLQ inspector wired to `processing.dlq` via cross-stack
  prop; CDK template assertions in
  `infra/__tests__/observability-stack.test.ts`
- ⬜ **P6.5** Deploy — `npm run deploy` provisions
  `GridSensorObservabilityStack`; verify dashboard URL renders (user machine)
- ⬜ **P6.6** Chaos verification — drive each alarm path:
  poison-pill record → DLQ alarm; broken alert handler env → SF
  failures alarm; sustained traffic → P99 latency alarm (user machine)

**Acceptance criteria:**
- Dashboard renders with non-empty data after a simulator run
- Each alarm fires under a forced failure scenario
- DLQ inspector logs include enough context for debugging

**Dependencies:** Phase 5.

---

## Phase 7 — Query API 🚧

**Goal.** External read API surface over the readings table.

**Sub-phases & deliverables:**
- ✅ **P7.1** Query handler — `src/handlers/query.ts` (Zod-validated path/query params, calls `repo.queryReadings()`, returns `{sensorId, count, items}`, 400 on validation, 500 on unexpected; EMF metrics for queries, latency, items returned, validation errors, failures)
- ✅ **P7.2** Query stack — `infra/lib/query-stack.ts` (REST API with `GET /sensors/{sensorId}/readings`, X-Ray + access logging on, Lambda proxy integration, read-only DynamoDB grant, permissive CORS)
- ✅ **P7.3** CDK template assertions — `infra/__tests__/query-stack.test.ts` (locks REST-not-HTTP API type, route, env vars, tracing, IAM read-only-ness with explicit no-PutItem/UpdateItem/DeleteItem assertions)
- ✅ **P7.4** App wiring — `infra/bin/app.ts` instantiates `QueryStack` with `storage.readingsTable` cross-stack ref; Phase 7 decision log captures 6 pre-flight decisions (REST API choice, no-auth deferred to P12, repo reuse, two parallel Zod schemas, read-only IAM, permissive CORS)
- ⬜ **P7.5** Deploy — `npm run deploy` provisions `GridSensorQueryStack` (user machine)
- ⬜ **P7.6** Smoke test — `curl <api-url>sensors/sensor-001/readings?limit=5` returns 200 with stored items; bad sensorId returns 400 with Zod details (user machine)

**Acceptance criteria:**
- `curl` against the deployed endpoint returns simulator-emitted readings
- Bad timestamps return 400
- Pagination via `Limit` is exposed (consider a cursor for future enhancement)

**Dependencies:** Phase 3.

---

## Phase 8 — AI/ML Integration ⏭️

**Goal.** Bedrock-powered alert narratives, LangChain-templated prompts,
LangGraph-orchestrated agentic flow inside the alert handler, and an
MCP server exposing read-only query tools. Closes the gap between the
portfolio entry's claims and shipped reality. Addresses the JD's
*"Production experience with… AWS Bedrock, agentic workflows
(LangChain/LangGraph), and tool integrations (Model Context Protocol)"*
required skill verbatim.

**Architectural shape — hybrid Step Functions + LangGraph:**

Phase 5's Step Functions Standard Workflow stays as the durable,
auditable outer workflow (CLAUDE.md hard rule #10 unchanged). Phase 8
adds LangGraph **inside** the alert handler Lambda — invoked by the
existing `NotifyOps` task — for agentic decisioning.

```
[ThresholdAlertRule fires]
        ↓
   [NotifyOps Step Functions task → invokes alert-handler Lambda]
        ↓
   ┌───────────────────────────────────────────────────────┐
   │ LangGraph inside the Lambda:                          │
   │  Node 1: Classify breach severity (Bedrock + tools)   │
   │  Node 2: Determine routing strategy (LLM)             │
   │  Node 3: Generate channel narrative (Bedrock)         │
   │  Node 4: (Phase 9 expands this) Execute via tools     │
   └───────────────────────────────────────────────────────┘
        ↓
   [Returns to Step Functions; WaitForAck stays unchanged]
```

**Sub-phases & deliverables:**

- ⬜ **P8.1** LangChain + Bedrock for narratives — replace alert
  handler's JSON SNS payload with Claude 3.5 Sonnet-generated
  narrative; LangChain prompt templates and output parsers; fall
  back to JSON if Bedrock errors
- ⬜ **P8.2** LangGraph for the agentic flow — multi-node graph
  (classify → route → narrate); structured state with Zod schema;
  conditional edges for severity-driven routing
- ⬜ **P8.3** MCP server exposing query API as MCP tools
  (`query_sensor_readings`, `query_recent_breaches`,
  `get_alert_history`); stdio transport for local Claude
  Desktop/Claude Code clients
- ⬜ **P8.4** Three new learning notes — `aws-bedrock.md`,
  `langchain-langgraph.md`, `mcp-protocol.md`; each filled with
  project anchors + self-test gate. Design-patterns index updated
- ⬜ **P8.5** Decision log + portfolio-entry update — update
  `portfolio-entry.md` so its "Bedrock-powered alert narratives" and
  "MCP server exposing the data API" claims are finally accurate
- ⬜ **P8.6** Deploy + smoke test — breach simulation produces a
  Bedrock-generated narrative; MCP server responds to a Claude
  Desktop / Claude Code natural-language query

**Acceptance criteria:**
- Alert handler produces an LLM-generated narrative on breach.
- Bedrock outage falls back to JSON narrative; alert is never
  blocked.
- MCP server responds to `query_sensor_readings` from a real Claude
  client.
- LangGraph trace shows multi-node decision path.

**Dependencies:** Phase 5 (Step Functions outer workflow), Phase 7
(query API for the MCP server to wrap).

**Decision log:** [`docs/decisions/phase-08-ai-ml-integration.md`](docs/decisions/phase-08-ai-ml-integration.md)

---

## Phase 9 — Agentic case routing ⬜

**Goal.** Extend Phase 8's agentic flow with multi-channel routing
across Slack, Jira, ServiceNow, PagerDuty, and a status page (all
stubbed). Add **one real channel** — SES email — to demonstrate
production-shape integration end-to-end. Idempotency-aware case
persistence prevents duplicate tickets on Step Functions retry.

**Sub-phases & deliverables:**

- ⬜ **P9.1** Stub case-tracker tools — five MCP-style tools (Slack,
  Jira, ServiceNow, PagerDuty, status page); each writes to
  CloudWatch logs + a new DynamoDB cases table with synthetic IDs
- ⬜ **P9.2** Real SES email channel — `send_email` tool; SES sandbox
  with verified `armando.musto+alertreported@gmail.com` (configurable
  via CDK context `alertEmail`); HTML and plain-text bodies
- ⬜ **P9.3** Idempotency-aware case persistence — new cases table
  (pk: `${sensorId}#${timestamp}#${readingType}`, sk: caseSystem);
  `attribute_not_exists(pk)` write before tool execution; UPDATE on
  duplicate (e.g., Slack thread reply) instead of CREATE
- ⬜ **P9.4** Tool-call failure isolation — partial-success result
  from LangGraph "execute tools" node; `failed[]`/`delivered[]`/
  `skipped[]` arrays; Step Functions continues; channel failures
  emit `AlertChannelFailures` metric
- ⬜ **P9.5** Decision log + new learning note `case-management-
  patterns.md`; routing matrix as data (severity → channels);
  LLM-override pattern with audit logging
- ⬜ **P9.6** Deploy + smoke test — P0 breach triggers real email +
  stubbed Slack/Jira/PagerDuty entries with proper case IDs;
  duplicate breach reuses existing case (verified via DynamoDB
  cases table)

**Acceptance criteria:**
- A breach produces a real email at the configured address.
- Stubbed channels log structured "would-call" entries with mock
  case IDs.
- Same breach repeated produces UPDATEs, not duplicates.
- One channel failing (simulated) doesn't block the others.

**Dependencies:** Phase 8 (LangGraph node 4 is what calls these
tools).

**Decision log:** [`docs/decisions/phase-09-agentic-case-routing.md`](docs/decisions/phase-09-agentic-case-routing.md)

---

## Phase 10 — Datadog bridge ⬜

**Goal.** Production observability path. Either deploy or document the
zero-app-code Datadog forwarding.

**Sub-phases & deliverables (deploy path):**
- ⬜ **P10.1** Datadog Lambda Extension layer ARN added to processor Lambda
- ⬜ **P10.2** `DD_API_KEY_SECRET_ARN`, `DD_SITE`, `DD_SERVERLESS_LOGS_ENABLED` env vars wired
- ⬜ **P10.3** Verification screenshot — same EMF metrics visible in Datadog

**Sub-phases & deliverables (design-doc path, if no Datadog account available):**
- ⬜ **P10.D1** `docs/decisions/phase-10-datadog-bridge.md` — full integration design
- ⬜ **P10.D2** README section showing the exact CDK code to add

**Acceptance criteria:**
- Either: metric visible in both CloudWatch and Datadog
- Or: design doc walks through the integration step-by-step with verification commands

**Dependencies:** Phase 6.

---

## Phase 11 — Polish & teardown ⬜

**Goal.** Make the repo presentable for portfolio/interview review.

**Sub-phases & deliverables:**
- ⬜ **P14.1** README revision — updated quickstart (post-deploy commands), architecture diagram (Mermaid or PNG), costs reconciled against actual dev-week spend
- ⬜ **P14.2** Decision-log index — chronological link list across `docs/decisions/`
- ⬜ **P14.3** Final scrub — `_private/` confirmed gitignored, no JD/recruiter notes in tracked files, history squash decision (fresh repo vs. `git filter-repo`)
- ⬜ **P14.4** Teardown verified — `cdk destroy --all` clean, no orphaned resources, no per-hour charges left running, AWS Cost Explorer confirmed

**Acceptance criteria:**
- A reviewer can clone, read README, and understand the architecture in 10 minutes
- All decision logs cross-link from the README
- Cost teardown confirmed by AWS Cost Explorer

---

## Phase 12 — Live demo dashboard ⬜

**Goal.** A single shareable URL that gives a portfolio reviewer the
"oh, neat" moment in under 30 seconds — live operational metrics
flowing in real time, with a button to trigger more events on demand.
CloudWatch first for the quick win; Grafana to demonstrate the data-
source flexibility used at Aireon.

**Sub-phases & deliverables:**
- ⬜ **P12.1** CloudWatch dashboard via CDK — `infra/lib/dashboard-stack.ts`:
  - Per-sensor latest reading widget (Logs Insights query into
    structured logs from the processor).
  - Pipeline throughput timeline (`EventsProcessed` count by minute).
  - Latency p50 / p95 / p99 from `ProcessingLatencyMs`.
  - DLQ depth gauge (current queue length).
  - Alert workflow execution count (will populate once Phase 5 ships).
  - Dimensioned by `ReadingType` so reviewers can see voltage vs.
    frequency vs. others side-by-side.
- ⬜ **P12.2** Public sharing of the CloudWatch dashboard — flip the
  "Share dashboard" toggle, capture the public URL, embed in the
  portfolio README. Document the toggle in the decision log; CDK
  doesn't natively manage this state (post-deploy CLI step).
- ⬜ **P12.3** Grafana decision log + setup — three options compared
  with cost lens:
  - **Amazon Managed Grafana** (~$9/active-user/mo, fully managed,
    easy SSO) — best if multiple reviewers will explore the dashboard
    interactively.
  - **Self-hosted Grafana on a t3.micro EC2** (~$8/mo + storage,
    full control) — good for portfolio if you want it always-on with
    a fixed cost.
  - **Local Grafana via Docker, screenshots embedded** (free, less
    interactive) — minimum cost, highest portfolio-permanence (can't
    accidentally let it expire).
  Decision goes in `docs/decisions/phase-12-demo-dashboard.md`.
- ⬜ **P12.4** Grafana dashboard build — CloudWatch as primary data
  source; optional Athena over the S3 cold archive for historical
  panels; same data shape as the CloudWatch dashboard plus richer
  per-sensor / per-zone visualizations Grafana supports natively.
- ⬜ **P12.5** Simulator trigger button — Lambda Function URL
  exposing a small static HTML page with a "Send 50 events" button
  (and a `--breach` checkbox). Calls the simulator Lambda directly so
  reviewers can drive new traffic without an AWS account or CLI.
- ⬜ **P12.6** Portfolio integration — link/embed both surfaces from
  the project README and the user's portfolio site. Optional: 30-second
  screen-recording GIF inline so the demo works even if the live
  surfaces are torn down.

**Acceptance criteria:**
- A reviewer opening the project README can reach a working dashboard
  in two clicks.
- Clicking "Send events" produces visible new data within ~10 seconds.
- Both CloudWatch and Grafana surfaces render the same core metrics
  consistently.
- Cost stays under $15/month even in the most-on configuration
  (Managed Grafana with active session) — and zero when torn down.

**Dependencies:**
- **Phase 6** (observability stack) provides the metrics both
  dashboards consume. Phase 12 won't be useful until Phase 6 ships
  the EMF metrics into CloudWatch.
- **Phase 7** (query API) is optional but useful for any client-side
  data fetches in a richer custom UI.
- **Phase 4** (simulator) is what the trigger button calls — already
  shipped.

**Why CloudWatch before Grafana:**
- **Quick wins.** CloudWatch dashboard via CDK is ~50 lines of
  construct code; live data appears immediately after deploy. Grafana
  setup involves either signing up for Managed Grafana, provisioning
  EC2, or running Docker locally — non-trivial.
- **Cost-aware.** First three CloudWatch dashboards are free per
  region; the project will have one in P6 + one in P12 = both free.
  Grafana costs accrue regardless of whether anyone's watching.
- **Sequential storytelling for the interview.** "I started with
  CloudWatch's native dashboards because they were the lowest-effort
  way to validate the metric design, then layered Grafana on top
  because the team I came from at Aireon used Grafana and the
  flexibility matters at scale." Both decisions defensible.

---

## Phase 14 — Architecture & live visualizations 🎯

**Status: stretch goal.** Out of MVP scope; valuable add-ons for
portfolio depth and conference-talk material. Each sub-phase is
independently shippable — you can do P14.1 alone (huge value, ~2h)
without committing to P14.3 (animated GIF, ~1 day).

**Goal.** Make the system *legible* at multiple zoom levels:
- **Static architecture** for reviewers asking "what is this thing?"
- **Live service map** for "show me it working right now"
- **Animated data flow** for demos and recorded talks
- **Live event stream viewer** for "let me see records flow through
  without an AWS account"

**What's already in place that this phase composes:**
- **AWS X-Ray service map** — auto-generated from the tracing config
  shipped in P2. Already a real-time architecture diagram with edge-
  level latency. Just need to know it's there.
- **CloudWatch dashboard** (P6) — metric-level system health.
- **Step Functions execution graph** — auto-generated per execution.
- **Mermaid Gantt** (this file) — phase timeline.

**Sub-phases & deliverables:**

- ⬜ **P14.1** Static architecture diagram suite — `docs/diagrams/`
  - **Application diagram** — Mermaid C4 or flowchart of all 6 stacks
    and their constructs (DynamoDB tables, Kinesis stream, Lambdas,
    Step Functions, SNS topics)
  - **Data flow diagram** — sequence diagram showing the IoT publish
    → Kinesis → ESM → processor → DynamoDB path with the alert path
    branching off
  - **IAM relationship diagram** — Mermaid graph of which role can
    do what to which resource (highlights least-privilege design)
  - All embedded inline in README or linked from it; rendered by
    GitHub natively, exportable to PNG via `mmdc` for portfolio sites
- ⬜ **P14.2** X-Ray service map documentation — README screenshot +
  link to X-Ray console URL; instructions for reviewers with AWS
  access to view it live; explanation of what the map shows
  (real-time latency overlay) so it's not just a screenshot
- ⬜ **P14.3** Animated data flow — 30-second SVG animation or GIF
  showing a single event traverse the system. Built from the static
  data flow diagram with timed edge highlights. Embeddable in
  portfolio sites that don't render Mermaid
- ⬜ **P14.4** Live event stream viewer — Lambda Function URL hosting
  a small static HTML page with a WebSocket connection (via API
  Gateway WebSocket API) that renders events from Kinesis in real
  time. Reviewers can watch events flow without an AWS account.
  Most ambitious sub-phase; commit only if a portfolio reviewer would
  benefit

**Acceptance criteria:**
- A reviewer opening the project README can understand the
  architecture from diagrams alone, before reading any code.
- A reviewer with AWS access can click through to the X-Ray service
  map and see live data flow.
- *Optional* — a reviewer without AWS access can see live data flow
  via P14.4's hosted viewer.

**Dependencies:**
- P14.1 has no dependencies — could ship today.
- P14.2 requires X-Ray to have been used recently (any simulator run
  populates it for ~30 days).
- P14.3 builds on P14.1's static diagrams.
- P14.4 depends on P12's simulator trigger pattern (Lambda Function
  URL) and adds API Gateway WebSocket API on top.

**Why this is the lowest-priority stretch (after P13's auth):**
- The MVP (Phases 1-12) demonstrates engineering depth.
- Phase 12's CloudWatch dashboard is "the live system in production"
  for portfolio purposes.
- Phase 13's auth work is closer to "professional minimum for
  production" — ship that first if any stretch ships.
- Phase 14 is *audience expansion* — reaching reviewers who prefer
  visual storytelling, conference talks, or zero-friction demos.
- A reviewer who needs P14 has materially different evaluation
  criteria than one who'd be sold by Phases 1-13. Worth shipping
  earlier phases first and seeing which audience matters.

**Cost lens:**
- P14.1 + P14.2 + P14.3 — $0 incremental cost. Mermaid and X-Ray are
  free; animated GIF is one-time generation effort.
- P14.4 — API Gateway WebSocket API is ~$1.00 per million messages +
  $0.25 per million connection-minutes. At demo volumes, negligible.

**The "we already have it" answer to "is the system observable in
real time?":** Yes — the X-Ray service map and CloudWatch dashboard
*are* the real-time application diagrams. P14 makes that visibility
discoverable to audiences who don't know to look in those places.

---

## Cross-cutting items

These run alongside the phases, not as a phase of their own.

- **Pre-share scrub.** Before the repo goes public: see Phase 9 final scrub checklist; consider squash-to-fresh-repo over history rewrite.
- **Decision-log discipline.** Every meaningful CDK or runtime choice → `docs/decisions/phase-NN-<short>.md` entry with **decision · alternatives · why this won · tradeoffs accepted**.
- **Review-checklist hygiene.** End of each phase: flip implemented items to `[x]`, add new open items under the next phase's section.
- **Interview-prep updates.** End of each phase: append a Q&A section to `docs/_private/interview-prep.md` for that phase's likely questions.
- **CLAUDE.md as immutable contract.** Architectural invariants and hard rules in `CLAUDE.md` are not negotiable mid-build. If a phase needs to violate one, document the deviation in the phase's decision log and update CLAUDE.md explicitly.

---

## Maintenance

This file is updated at the end of each working day:
1. Flip the sub-phase status symbols (✅) for what got finished.
2. If a phase is fully done, flip the phase symbol in the **Phases at a glance** table.
3. Update the **Progress** section:
   - Recompute the overall percentage (`done / total` sub-phases).
   - Update the per-phase bars (each `█` = 10% done; e.g., 4/4 = `██████████`, 2/4 = `█████░░░░░`).
   - Flip the corresponding row's status icon and counts.
   - In the Mermaid Gantt, change the phase's keyword (`active` → `done`) and start the next phase's bar with `:active`.
   - Update the Phase × Requirements matrix status column.
4. Move the "Active phase" pointer in **Current state** if it advanced.
5. Append an entry to the **Daily log** below.
6. Confirm any new decision log files are linked from the phase section.

### Daily log

Format: `**Day N** (YYYY-MM-DD) — completed P<N>.<M>: <brief summary>. Started P<N>.<M>: <brief summary>.`

- **Day 1** (2026-05-08) — completed **P1.1**–**P1.9** (full Phase 1) and
  **P2.1**–**P2.4** (full Phase 2).
  - **Phase 1:** domain types, Zod validator at the I/O boundary, pure
    threshold module, `SensorRepository` with conditional writes, three
    Powertools singletons, unit-test suites for validator/threshold/
    repository, npm/TS-strict/Jest/ESLint scaffold, docs foundation
    (`docs/README.md`, `docs/review-checklist.md`,
    `docs/decisions/day-01-lib-foundation.md`,
    `docs/_private/interview-prep.md`), and `ROADMAP.md`.
  - **Phase 2:** three pre-flight decisions captured with cost-lens
    annotations (idempotency expiry 24-26 h, conditional-error swallow
    scope strict, ReadingType metric dimension included);
    `src/handlers/processor.ts` with Powertools idempotency keyed on the
    Kinesis sequence number, per-record dimensioned EMF metrics via
    `metrics.singleMetric()`, and `batchItemFailures` partial-failure
    response; `src/__tests__/processor.test.ts` covering happy path,
    mixed-failure batches, conditional-swallow, throttle non-swallow,
    helper unit tests, and TTL bounds. Phase 2 decision log at
    `docs/decisions/phase-02-processor.md`; cost-awareness framing added
    to `docs/_private/interview-prep.md`.
  - **Phase 3 (✅ shipped end-to-end):** seven pre-flight decisions
    captured with cost-lens annotations (DynamoDB on-demand, Kinesis
    1-shard/24h, Firehose 5min/5MB GZIP, Lambda 512MB, ESM safety flags,
    DESTROY everywhere, three-stack composition); CDK app entrypoint +
    cdk.json; `infra/lib/storage-stack.ts`, `infra/lib/kinesis-stack.ts`,
    `infra/lib/processing-stack.ts`; CDK template assertions in
    `infra/__tests__/processing-stack.test.ts` (CLAUDE.md hard rule #9)
    and `infra/__tests__/kinesis-stack.test.ts` (Firehose role policy
    includes `kinesis:DescribeStream`); `cdk bootstrap` + `cdk deploy
    --all` succeeded; smoke tested all three paths (happy path, layered
    idempotency, poison-pill → DLQ). Four real-world deploy snags hit
    and fixed in-flight, captured in
    `docs/decisions/phase-03-storage-processing.md` "Deploy lessons"
    addendum: (1) IAM rejects non-ASCII characters in role descriptions,
    (2) `Stream.grantRead()` doesn't include the legacy
    `kinesis:DescribeStream`, (3) `addToPolicy` creates a separate IAM
    Policy resource that can race against dependent-resource creation —
    use `inlinePolicies` in role constructor instead, (4) CFN rollback
    silently leaks Kinesis streams under failed-deploy conditions.
  - **Cost teardown reminder:** ~$0.36/day Kinesis shard while deployed.
    `npm run destroy` at end of session.

- **Day 2 evening** (2026-05-09) — JD audit triggered scope
  expansion. Original roadmap had zero AI/ML work; JD requires
  *"Production experience with… AWS Bedrock, agentic workflows
  (LangChain/LangGraph), and tool integrations (Model Context
  Protocol)."* Inserted two new CORE phases: **Phase 8 — AI/ML
  Integration** (Bedrock + LangChain + LangGraph + MCP server) and
  **Phase 9 — Agentic case routing** (stubbed Slack/Jira/ServiceNow/
  PagerDuty/status-page tools + one real SES email channel +
  idempotency-aware case persistence). Both decision logs written
  with cost lens. Old P8-P12 renumbered to P10-P14. JD saved to
  `docs/_private/job-description-torus.md` (gitignored). Honest
  scope accounting: progress drops from 59% to 50% as denominator
  grows from 66 to 78 sub-phases. Architecture decision worth
  highlighting: Phase 8 uses **hybrid Step Functions + LangGraph**
  rather than replacing one with the other — Step Functions stays as
  durable outer workflow (CLAUDE.md hard rule #10), LangGraph lives
  inside one task as agentic decisioning. *"Use the right tool at
  the right layer; composition over replacement."*

- **Day 2** (2026-05-09) — opened with the third recurrence of the
  Kinesis stream rollback orphan (cleanup recipe from
  `phase-03-storage-processing.md` Deploy lesson #4 applied);
  redeploy succeeded. Added
  `docs/learning/_design-patterns-index.md` — consolidated catalog of
  every design pattern used in the project across categories (I/O
  boundary, idempotency / failure handling, cost-aware engineering,
  type system & IaC, simulation & testing, stack composition &
  lifecycle), each linked back to where it's defined and applied.
  **Phase 6 (code shipped, deploy pending):** six pre-flight decisions
  captured (DLQ inspector log+alert+metric without auto-replay,
  single observability stack, alarm thresholds verbatim from
  CLAUDE.md, separate ops-alerts SNS topic, manual chaos
  verification, dashboard reads metrics not LI queries);
  `src/handlers/dlq-inspector.ts` (SQS-triggered, parses Kinesis
  failure envelope, structured-logs sequence range + reason,
  publishes to ops-alerts SNS, replay opt-in via env flag);
  `infra/lib/observability-stack.ts` (DLQ inspector Lambda +
  ops-alerts SNS topic + 3 alarms with SNS actions + single dashboard
  with throughput, latency p50/p95/p99, validation errors, partial
  batch failures, duplicate writes, DLQ depth, alerts, Step Functions
  executions); `infra/__tests__/observability-stack.test.ts`. **Open:**
  `npm test` (9 suites); `npm run synth`; `npm run deploy` provisions
  `GridSensorObservabilityStack`; chaos verification recipe in
  review checklist drives each alarm path.
  - **Phase 4 (✅ shipped end-to-end):** six pre-flight decisions
    captured; `infra/lib/iot-stack.ts` (endpoint discovery, Rules role
    with inline Kinesis policy, AllTelemetryRule, simulator Lambda with
    scoped iot:Publish); `src/handlers/simulator.ts` (Gaussian payload
    generator, breach mode, EMF metrics); `scripts/simulate.ts`;
    `infra/__tests__/iot-stack.test.ts`; learning note
    `docs/learning/aws-iot-core.md` and new
    `docs/learning/synthetic-data-and-simulation.md` filled.
    Deployed and smoke-tested: 50 events published in 1.5 s, all
    landed in DynamoDB through IoT → Kinesis → ESM → processor.
    `Duplicate write swallowed` log line verified P2's
    `attribute_not_exists(pk)` path on a duplicate Kinesis put.
  - **Phase 5 (✅ shipped end-to-end):** six pre-flight decisions
    captured; `src/handlers/alert-handler.ts` (single Lambda for
    NotifyOps and EscalateToOnCall, reuses validator + threshold);
    `infra/lib/alert-workflow-stack.ts` (Standard Workflow, X-Ray on,
    ALL-level CloudWatch logging, configurable wait);
    `infra/lib/iot-stack.ts` extended with conditional
    `ThresholdAlertRule` and `StepFunctionsStart` inline policy;
    `infra/__tests__/alert-workflow-stack.test.ts`; Step Functions
    learning note + new `cdk-as-typed-model.md` learning note (CDK's
    defining property as "single typed model spanning runtime + infra"
    with pitfalls including the L2 interface drift we hit).
    Deployed and smoke-tested: 4 Step Functions executions started by
    simulator breach mode, all reaching `Alert notified` in the alert
    handler. Bimodal Gaussian distribution worked exactly as designed
    in `synthetic-data-and-simulation.md`: frequency 59.092 Hz (below
    min); voltage 109.876, 111.25 V (below min) and 129.411 V (above
    max). One additional discovery: `IStateMachine.stateMachineName`
    was removed from the interface in newer aws-cdk-lib (only on
    concrete `StateMachine` class) — fixed by exposing
    `stateMachineName` as a separate `public readonly string` field on
    `AlertWorkflowStack`. Pattern captured in
    `docs/learning/cdk-as-typed-model.md` pitfall table for next
    interface-drift situation.
