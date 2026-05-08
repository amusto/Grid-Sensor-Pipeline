# Roadmap

Source of truth for the build sequence and current status. Updated at the end
of each phase. **Phases are units of work, not calendar days** — actual
elapsed time depends on focus and velocity.

---

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | Complete & verified |
| 🚧 | In progress |
| ⏭️ | Next up |
| ⏸️ | Blocked / paused |
| ⬜ | Not started |

---

## Current state

**Today:** Day 1 (2026-05-08)
**Active phase:** Phase 2 — Processor Lambda (next up)
**Last shipped:** Phase 1 — Lib & test foundation
**Local verification pending:** `npm install && npm test && npm run build && npm run lint` on the user's machine (sandbox npm registry blocked).

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
| 2 | Processor Lambda | ⏭️ | Kinesis ESM handler with Powertools idempotency, EMF metrics, partial-failure isolation | _pending_ |
| 3 | Storage + processing stacks | ⬜ | CDK: Kinesis · DynamoDB · processor Lambda + ESM · DLQ — pipeline live | _pending_ |
| 4 | IoT Core + simulator | ⬜ | IoT Rules: telemetry → Kinesis · threshold breaches → Step Functions · simulator Lambda | _pending_ |
| 5 | Alert workflow | ⬜ | Step Functions Standard: NotifyOps → Wait → IsAcknowledged → Escalate · alert-handler Lambda | _pending_ |
| 6 | DLQ + observability | ⬜ | DLQ inspector Lambda · CloudWatch dashboard · alarms (DLQ depth, P99, SF failures) | _pending_ |
| 7 | Query API | ⬜ | API Gateway + query Lambda · `GET /sensors/{id}/readings?from=&to=` | _pending_ |
| 8 | Datadog bridge | ⬜ | Datadog Lambda Extension layer wired (or design-doc-only if not deployed) | _pending_ |
| 9 | Polish & teardown | ⬜ | README revision · architecture diagram · cost analysis · `cdk destroy` verification | _pending_ |

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

## Phase 2 — Processor Lambda ⏭️

**Goal.** Wire the Kinesis Event Source Mapping → handler → repository path
with idempotency, partial-failure isolation, and structured observability.

**Sub-phases & deliverables:**
- ⬜ **P2.1** Processor handler — `src/handlers/processor.ts`
  - Decode Kinesis record → `validateSensorEvent()` → `repo.putReading()`
  - Wrapped: `tracer.captureLambdaHandler` + `logger.injectLambdaContext`
  - Per-record `makeIdempotent` keyed on `record.kinesis.sequenceNumber`
  - Catch `ConditionalCheckFailedException` → treat as no-op success
  - All other errors → push to `batchItemFailures`
  - EMF metrics: `EventsProcessed`, `ProcessingLatencyMs`, `ValidationErrors`, `PartialBatchFailures`
  - `metrics.publishStoredMetrics()` in `finally` (hard rule #8)
- ⬜ **P2.2** Processor unit tests — `src/__tests__/processor.test.ts`
  - Happy path — full batch processed
  - One bad record — only that record fails, rest succeed
  - Duplicate-write — `ConditionalCheckFailedException` swallowed as success
  - Full batch failure — every record in `batchItemFailures`
  - Idempotency cache hit — second invocation is a no-op
- ⬜ **P2.3** Decision log — `docs/decisions/phase-02-processor.md`
- ⬜ **P2.4** Review checklist & interview-prep updates for Phase 2

**Acceptance criteria:**
- All processor test cases green
- Structured errors include sensorId or sequence number
- `metrics.publishStoredMetrics()` reachable on every code path

**Open decisions to resolve at start:**
1. Idempotency expiry window — recommend 24-26 h to match Kinesis retention
2. Conditional-failure swallow scope — recommend: only `ConditionalCheckFailedException` name match
3. `ReadingType` metric dimension — recommend: include (5 cardinality, cheap on CloudWatch)

---

## Phase 3 — Storage + processing CDK stacks ⬜

**Goal.** First infrastructure phase. Stand up the storage and streaming
backbone, deploy the processor Lambda with the ESM, accept live events.

**Sub-phases & deliverables:**
- ⬜ **P3.1** CDK app entrypoint — `infra/bin/app.ts`, `cdk.json`
- ⬜ **P3.2** Storage stack — `infra/lib/storage-stack.ts` (readings table with `pk`/`sk`/TTL + GSI on `readingType + timestamp`, idempotency table)
- ⬜ **P3.3** Kinesis stack — `infra/lib/kinesis-stack.ts` (Data Stream 1 shard / 24 h retention + Firehose → S3 cold archive, Parquet by date/sensorId)
- ⬜ **P3.4** Processing stack — `infra/lib/processing-stack.ts` (Processor Lambda · ESM with `bisectOnError: true` + `batchItemFailures` · SQS DLQ · IAM grants)
- ⬜ **P3.5** Bootstrap + first deploy — `cdk bootstrap`, `cdk deploy --all`
- ⬜ **P3.6** Smoke test — `aws kinesis put-record` → DynamoDB row, idempotent retry verified, DLQ poison-pill verified

**Acceptance criteria:**
- Full pipeline accepts a record from Kinesis to DynamoDB
- Idempotent retry verified (put twice, see one item)
- DLQ receives a deliberately invalid record after retries
- Cost teardown: `cdk destroy --all` removes all resources

**Dependencies:** Phase 2 complete.

---

## Phase 4 — IoT Core + simulator ⬜

**Goal.** Replace the manual `put-record` with the real device path —
MQTT publish to IoT Core, Rules Engine routing to Kinesis and Step Functions.

**Sub-phases & deliverables:**
- ⬜ **P4.1** IoT stack — `infra/lib/iot-stack.ts`
  - IoT Thing type + policy + test certificate (CDK custom resource)
  - `AllTelemetryRule` — `SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'` → Kinesis (partition key `${sensorId}`)
  - `ThresholdAlertRule` — SQL filter on out-of-range frequency/voltage → Step Functions `StartExecution`
- ⬜ **P4.2** Simulator handler — `src/handlers/simulator.ts` (using `@aws-sdk/client-iot-data-plane`)
- ⬜ **P4.3** Simulate script — `scripts/simulate.ts` (invoke simulator Lambda N times with synthetic payload distribution)
- ⬜ **P4.4** Endpoint wiring — `IOT_ENDPOINT` env from `aws iot describe-endpoint`

**Acceptance criteria:**
- `npx ts-node scripts/simulate.ts --count 50` results in 50 items in DynamoDB
- IoT Rules SQL filter matches `threshold.ts` predicate exactly (cross-referenced)
- Threshold breach in simulator triggers a Step Functions execution

**Dependencies:** Phase 3 deployed; Phase 5 stack at least defined (alert state machine ARN must exist for the IoT rule to reference).

---

## Phase 5 — Alert workflow ⬜

**Goal.** Auditable, long-running alert escalation backed by Step Functions
Standard.

**Sub-phases & deliverables:**
- ⬜ **P5.1** Alert handler — `src/handlers/alert-handler.ts`
  - `NotifyOps` step — SNS notification with sensor reading + threshold context
  - `EscalateToOnCall` path — same handler, `escalated: true` flag
- ⬜ **P5.2** Alert workflow stack — `infra/lib/alert-workflow-stack.ts`
  - Step Functions Standard: `NotifyOps` → `WaitForAck` (15 min) → `IsAcknowledged` → (`AlertResolved` | `EscalateToOnCall` → `AlertResolved`)
  - Tracing enabled, 1 hour timeout
- ⬜ **P5.3** IoT rule wiring — thread the state machine ARN back to `iot-stack.ts` for `ThresholdAlertRule`
- ⬜ **P5.4** End-to-end alert test — simulator emits OOR reading → state machine executes → mocked ack via SDK resolves it

**Acceptance criteria:**
- Triggering a threshold breach via simulator runs the full state machine
- Execution history retained, viewable in console
- Mocked ack via SDK call resolves the workflow without escalation

**Dependencies:** Phase 4 IoT rule needs the state machine ARN.

---

## Phase 6 — DLQ + observability ⬜

**Goal.** Production-grade visibility — dashboards, alarms, DLQ inspection.

**Sub-phases & deliverables:**
- ⬜ **P6.1** DLQ inspector — `src/handlers/dlq-inspector.ts`
  - SQS-triggered Lambda
  - Structured log with original Kinesis sequence number + error context
  - SNS alert
  - Optional Kinesis replay (env-flagged)
- ⬜ **P6.2** Observability stack — `infra/lib/observability-stack.ts`
  - CloudWatch Dashboard: `EventsProcessed`, `ProcessingLatencyMs` (p50/p95/p99), `ValidationErrors`, `DlqMessagesReceived`, Step Functions execution count + failures
- ⬜ **P6.3** Alarms — SNS-routed:
  - `GridSensor-DLQ-Messages` — DLQ depth ≥ 1
  - `GridSensor-P99-Latency` — p99 > 2000 ms for 3 min
  - `AlertWorkflow-Failures` — Step Functions ExecutionsFailed ≥ 1
- ⬜ **P6.4** Forced-failure verification — manually trigger each alarm path

**Acceptance criteria:**
- Dashboard renders with non-empty data after a simulator run
- Each alarm fires under a forced failure scenario
- DLQ inspector logs include enough context for debugging

**Dependencies:** Phase 5.

---

## Phase 7 — Query API ⬜

**Goal.** External read API surface over the readings table.

**Sub-phases & deliverables:**
- ⬜ **P7.1** Query handler — `src/handlers/query.ts`
  - `GET /sensors/{id}/readings?from=&to=&limit=`
  - Validates path/query params with Zod
  - Calls `repo.queryReadings()`
  - Returns 200 with array, 400 on bad input, 404 if sensor unknown
- ⬜ **P7.2** Query stack — `infra/lib/query-stack.ts`
  - API Gateway REST API
  - Lambda integration
  - IAM: read-only DynamoDB grant, no write permissions
- ⬜ **P7.3** Live curl verification against deployed endpoint

**Acceptance criteria:**
- `curl` against the deployed endpoint returns simulator-emitted readings
- Bad timestamps return 400
- Pagination via `Limit` is exposed (consider a cursor for future enhancement)

**Dependencies:** Phase 3.

---

## Phase 8 — Datadog bridge ⬜

**Goal.** Production observability path. Either deploy or document the
zero-app-code Datadog forwarding.

**Sub-phases & deliverables (deploy path):**
- ⬜ **P8.1** Datadog Lambda Extension layer ARN added to processor Lambda
- ⬜ **P8.2** `DD_API_KEY_SECRET_ARN`, `DD_SITE`, `DD_SERVERLESS_LOGS_ENABLED` env vars wired
- ⬜ **P8.3** Verification screenshot — same EMF metrics visible in Datadog

**Sub-phases & deliverables (design-doc path, if no Datadog account available):**
- ⬜ **P8.D1** `docs/decisions/phase-08-datadog-bridge.md` — full integration design
- ⬜ **P8.D2** README section showing the exact CDK code to add

**Acceptance criteria:**
- Either: metric visible in both CloudWatch and Datadog
- Or: design doc walks through the integration step-by-step with verification commands

**Dependencies:** Phase 6.

---

## Phase 9 — Polish & teardown ⬜

**Goal.** Make the repo presentable for portfolio/interview review.

**Sub-phases & deliverables:**
- ⬜ **P9.1** README revision — updated quickstart (post-deploy commands), architecture diagram (Mermaid or PNG), costs reconciled against actual dev-week spend
- ⬜ **P9.2** Decision-log index — chronological link list across `docs/decisions/`
- ⬜ **P9.3** Final scrub — `_private/` confirmed gitignored, no JD/recruiter notes in tracked files, history squash decision (fresh repo vs. `git filter-repo`)
- ⬜ **P9.4** Teardown verified — `cdk destroy --all` clean, no orphaned resources, no per-hour charges left running, AWS Cost Explorer confirmed

**Acceptance criteria:**
- A reviewer can clone, read README, and understand the architecture in 10 minutes
- All decision logs cross-link from the README
- Cost teardown confirmed by AWS Cost Explorer

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
3. Move the "Active phase" pointer in **Current state** if it advanced.
4. Append an entry to the **Daily log** below.
5. Confirm any new decision log files are linked from the phase section.

### Daily log

Format: `**Day N** (YYYY-MM-DD) — completed P<N>.<M>: <brief summary>. Started P<N>.<M>: <brief summary>.`

- **Day 1** (2026-05-08) — completed **P1.1**–**P1.9**: full Phase 1 shipped.
  Domain types, Zod validator at the I/O boundary, pure threshold module,
  `SensorRepository` with conditional writes, three Powertools singletons,
  unit-test suites for validator/threshold/repository, npm/TS-strict/Jest/
  ESLint scaffold, docs foundation (`docs/README.md`,
  `docs/review-checklist.md`, `docs/decisions/day-01-lib-foundation.md`,
  `docs/_private/interview-prep.md`), and this `ROADMAP.md`. **Open:** local
  verification of `npm install && npm test && npm run build && npm run lint`.
