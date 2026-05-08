# Day 1 — Lib & Test Foundation

Decisions made while building the four lib modules (`types`, `validator`,
`threshold`, `repository`), the three Powertools singletons, the test suites,
and the project scaffold.

For each decision: **what we picked · what we rejected · why this won ·
tradeoffs we knowingly accepted.**

---

## 1. Zod for runtime validation at the I/O boundary

**Decision.** Validate Kinesis-decoded payloads with Zod, exactly once, at the
processor's I/O boundary. Downstream `lib/` consumers receive a typed
`SensorEvent`, never `unknown`.

**Alternatives considered.**
- **AJV / JSON Schema** — fastest validator on Node, but adds a second source
  of truth (the schema file separate from the TS types).
- **Hand-rolled type guards** — zero dependency, but no inferred types and no
  detailed error messages.
- **io-ts** — more functional / FP-flavored, smaller community than Zod.

**Why Zod won.**
- Schema is the single source of truth — TS types inferred via `z.infer<...>`,
  one place to change.
- Errors include path + reason out of the box. The processor's
  `ValidationErrors` metric and the DLQ inspector benefit immediately.
- AWS Lambda Powertools v2 docs use Zod in their parser examples — keeps the
  whole stack idiomatic.

**Tradeoff knowingly accepted.** Zod parse on every event has overhead
(~10-100µs). At production volume (millions/day) this matters — we re-evaluate
if `ProcessingLatencyMs` p99 climbs. Mitigation already in place: schemas are
constructed at module load (cached), not per-invocation.

---

## 2. `.strict()` on the schema

**Decision.** Reject events that contain fields outside the schema.

**Alternatives.** `.strip()` (default — silently drop unknowns), `.passthrough()`
(keep unknowns).

**Why strict.** Signals discipline — a forward-compatible "let new fields slide"
posture would mask schema drift between firmware and pipeline. Strict makes
schema changes intentional.

**Tradeoff knowingly accepted.** If device firmware adds a benign field
(say, `batteryPct`), the entire pipeline rejects until the schema is updated.
Mitigation path documented: switch to `.passthrough()` (or reserve a `metadata`
free-form field) once the device contract is stable.

---

## 3. `sensorId` regex `^sensor-[a-z0-9-]+$`

**Decision.** Lowercase-only sensor IDs with the `sensor-` prefix.

**Why.** Per CLAUDE.md spec — keeps DynamoDB partition keys uniform and avoids
case-sensitivity bugs across IoT Thing names, MQTT topics, and stored items.

**Tradeoff.** The regex permits double dashes and trailing dashes (`sensor--x`,
`sensor-x-`). If the operational naming convention forbids those, tighten to
`^sensor-[a-z0-9](?:-?[a-z0-9])*$`. Flagged in `review-checklist.md`.

---

## 4. Pure-function threshold module

**Decision.** `threshold.ts` exports `evaluateThreshold(event, config?)` — no
AWS SDK calls, no logging, no metrics.

**Alternative.** Embed threshold logic directly in the processor handler.

**Why pure.** Per CLAUDE.md invariant #3, this predicate is also encoded in
the IoT Rules Engine SQL filter. Keeping it pure means we can unit-test the
boundary matrix exhaustively without deploying anything, and we get free
reusability for any future feature that wants to annotate a stored reading
with "this was out of range."

**Tradeoff.** The predicate now lives in two places (TS and IoT Rules SQL).
Mitigation: cross-reference comments in both directions when `iot-stack.ts`
lands on Day 4.

---

## 5. DynamoDB schema — `pk = sensorId`, `sk = timestamp#readingType`

**Decision.** Single-table design, composite SK.

**Alternatives.**
- `pk = gridZone, sk = ...` — bad: grid events cause correlated spikes per
  zone, creating hot shards under exactly the load that matters most.
- `pk = sensorId, sk = timestamp` (no readingType in SK) — collisions when
  the same sensor publishes multiple readingTypes at the same instant
  (it does — voltage, current, frequency arrive together).
- Two tables (one per access pattern) — over-engineered for the access
  patterns we have.

**Why this design.**
- `sensorId` distributes evenly under the load that matters (zone-wide events
  hit all sensors at once, all spreading across shards).
- Composite SK preserves time-ordering within a sensor and admits multiple
  readingTypes per timestamp without collision.
- `BETWEEN` queries on the SK answer all our time-range read patterns
  efficiently.

---

## 6. `attribute_not_exists(pk)` on every write

**Decision.** Belt-and-suspenders idempotency on top of the Powertools
idempotency utility.

**Why both.**
- Powertools idempotency is **consumer-side** dedup by Kinesis sequence
  number — fast and cheap.
- The conditional write is **server-side** dedup on the natural key
  `(sensorId, timestamp, readingType)`. Catches the case where Powertools'
  idempotency table is bypassed (early bootstrap, misconfiguration,
  out-of-band replay from the DLQ inspector).

**Day 2 task.** Processor must catch `ConditionalCheckFailedException`
specifically and treat as no-op success — otherwise legitimate duplicates
become permanent `batchItemFailures`.

---

## 7. SK upper-bound sentinel `'￿'`

**Decision.** When querying with a `to` upper bound, append `'￿'` to the
timestamp before sending.

**Why.** Stored SKs look like `2026-05-08T12:00:00Z#voltage`. A query bound
of `to = 2026-05-08T00:00:00Z` should *include* every reading from that
timestamp instant — including the `#readingType` suffixes. Plain `BETWEEN`
without the sentinel would miss those. `'￿'` is the highest BMP code
point; DynamoDB compares strings as byte arrays, so it sorts higher than any
expected `readingType` suffix.

**Verify.** Round-trip test on Day 3 once the storage stack is deployable.

---

## 8. Powertools singletons at module load

**Decision.** `new Logger()`, `new Tracer()`, `new Metrics()` instantiated at
module import time, exported as singletons.

**Why.** Lambda containers are reused; constructing per-invocation wastes
cold-start budget and re-reads env vars unnecessarily. Powertools instances
are designed for the singleton pattern — they read env vars once and cache.

**Tradeoff knowingly accepted.** Changing `POWERTOOLS_SERVICE_NAME` requires
a fresh deployment to take effect. Acceptable for serverless; we'd never want
that to be a hot-tunable.

---

## 9. TypeScript strict mode + ESLint `no-explicit-any: error`

**Decision.** `strict: true` plus `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`. ESLint enforces
`no-explicit-any` and `no-console` in `src/`, relaxed in `src/__tests__/`.

**Why.** Per CLAUDE.md hard rules. `any` defeats the value proposition of a
TS-throughout stack — and a runtime `unknown` from validator parsing makes it
cheap to keep types tight at the boundaries. Tests are allowed jest's natural
mock typing without castigation.

---

## 10. ESLint flat config (ESLint 9 + typescript-eslint 8)

**Decision.** `eslint.config.mjs`, flat config style.

**Alternative.** Legacy `.eslintrc.json` with `extends`.

**Why flat.** ESLint 9's default; `.eslintrc` is deprecated. Configuring it
once now avoids a migration later.

---

## 11. Repository takes optional `DynamoDBDocumentClient` for testability

**Decision.** Constructor accepts an optional `docClient` parameter; defaults
to a real `DynamoDBDocumentClient.from(new DynamoDBClient({}))`.

**Alternative.** Top-level `jest.mock('@aws-sdk/lib-dynamodb', ...)` in tests.

**Why DI over jest.mock.**
- The mock surface is one method (`send`), not the whole module — explicit
  and small.
- Tests assert command shapes by `instanceof PutCommand` and `cmd.input` —
  closer to the real contract than spying on the mocked module.
- One day we may want to plug in a different client (X-Ray-instrumented,
  custom retry strategy) at construction time — DI gives us that for free.

---

## 12. npm over yarn / pnpm

**Decision.** npm.

**Alternatives.** Yarn Berry (PnP), Yarn Classic (1.x), pnpm (symlinked store).

**Why npm.**
- AWS CDK's `cdk init` generates npm projects; AWS Lambda Powertools docs
  assume npm; `NodejsFunction` bundler shells out to npm by default for
  Lambda layer bundling.
- Yarn Berry's PnP and pnpm's symlinked store both require extra config to
  play nicely with Lambda bundling — friction we don't need for a portfolio
  POC.
- Yarn 1.x is in maintenance mode.

**If we ever switch.** pnpm > yarn — better install speed, stricter dep
resolution. We'd add `nodeModules` overrides where CDK bundles Lambdas.
Not recommended for this project.
