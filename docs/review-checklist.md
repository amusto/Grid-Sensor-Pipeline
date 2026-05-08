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

## Phase 3 — Storage + processing CDK stacks (pending)

## Phase 4 — IoT Core stack + simulator (pending)

## Phase 5 — Alert workflow (pending)

## Phase 6 — DLQ + observability (pending)

## Phase 7 — Query API (pending)

## Phase 8 — Datadog bridge (pending)

## Phase 9 — Polish & teardown (pending)
