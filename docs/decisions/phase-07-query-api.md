# Phase 7 — Query API

Status: **pre-flight & implementation**. Read-only HTTP API exposing
the readings table. Closes the loop — until now, querying readings
required AWS CLI access; Phase 7 makes them retrievable via plain
HTTP.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P7 pre-flight 1 — REST API over HTTP API

**Concept.** Pick the API Gateway flavor that gives you what the
project actually needs.

**Decision.** Use API Gateway REST API (v1), not HTTP API (v2).

**Alternatives.**
- **HTTP API (v2)** — cheaper per-request (~70% lower), faster cold
  start, simpler config. But fewer features: no request validation
  models, no response models, no usage plans, no API keys.

**Why REST over HTTP.**
- We use Zod for request validation in the Lambda handler. REST API's
  built-in request validators *also* exist as a back-up; HTTP API
  drops them entirely.
- Phase 12 (strong-stretch) is *Authentication & security
  hardening*, which includes API key + usage plan support. REST API
  has it natively; HTTP API requires Cognito or custom Lambda
  authorizers.
- Demonstrating familiarity with REST API (the more feature-rich
  variant) is a stronger portfolio signal than HTTP API.

**Cost lens.** REST API is $3.50 per million requests; HTTP API is
$1.00 per million. At POC volume (a few hundred requests during
testing), the difference is fractions of a penny. At production
volume, would be worth re-evaluating.

**Tradeoff knowingly accepted.** Slightly higher per-request cost in
exchange for native API key/usage plan support and a stronger
portfolio signal.

---

## P7 pre-flight 2 — No authentication (deferred to Phase 12)

**Concept.** POC scope; auth is a strong-stretch deliverable in
Phase 12.

**Decision.** Phase 7 ships an unauthenticated HTTP endpoint. No API
keys, no Cognito, no IAM authorizer.

**Why deferred.**
- API Gateway URLs are not enumerable — `https://abc123.execute-
  api.us-east-1.amazonaws.com/...` is effectively private-by-
  obscurity until advertised.
- DynamoDB on-demand billing caps per-request cost; even an
  aggressive attacker would generate small absolute dollar amounts.
- Lambda concurrency is account-capped at 1000 by default;
  upper-bounds attack-scenario throughput.
- Phase 12 captures the full security hardening agenda (throttling,
  API keys, Cognito, fleet provisioning, secrets, threat model).

**Cost lens.** Unauthenticated APIs are *cheaper* (no Cognito MAU
charges). The cost concern is the spike scenario — mitigated by
on-demand billing and Lambda concurrency caps. Adding auth in
Phase 12 brings the per-API-call cost up only marginally
(a few microseconds of authorizer evaluation).

**Tradeoff knowingly accepted.** Unauthenticated endpoint until
Phase 12 ships. Documented in the README and review checklist.
Migration path: API key + usage plan → Cognito user pool +
authorizer → IAM-based service-to-service auth, in increasing order
of complexity.

---

## P7 pre-flight 3 — Reuse `SensorRepository.queryReadings()` directly

**Concept.** The handler is orchestration, not logic. Lib code
already implements the data access pattern.

**Decision.** Query handler imports and calls
`SensorRepository.queryReadings(sensorId, opts)` from
`src/lib/repository.ts`. No SQL builders, no Dynamo expression
manipulation in the handler.

**Why.** Per CLAUDE.md invariant #4 ("no business logic in
handlers"), the handler validates input, calls the repo, formats
the response. The SK-range query logic with the `'￿'` upper-
bound sentinel was carefully designed in P1 — Phase 7 inherits it
without modification.

**Cost lens.** No code duplication; one source of truth for query
semantics across the read path (P7) and any future write path that
reads-before-write.

---

## P7 pre-flight 4 — Two parallel Zod schemas (one for events, one for query params)

**Concept.** Different I/O boundaries have different shape
requirements; each gets its own validator at the entry point.

**Decision.** New Zod schema in `src/lib/query-validator.ts` (or
inlined in the handler) for the path/query parameters of `GET
/sensors/{sensorId}/readings`. *Not* a reuse of `sensorEventSchema`.

**Why two schemas.**
- The event schema validates a complete `SensorEvent` object
  (sensorId, timestamp, readingType, value, unit, gridZone).
- The query param schema validates only the bits of a query string —
  `sensorId` (path param), and optional `from`, `to`, `limit` (query
  params).
- Path/query params arrive as **strings**, not typed values. Zod's
  `.coerce.number()` handles `limit`; date strings stay strings (the
  repo accepts ISO format).

**Why not reuse `sensorEventSchema`.** It would force optional-ifying
most fields and adding query-specific ones — the resulting schema
would describe neither shape cleanly. Two narrow schemas are clearer.

**Cost lens.** Two ~10-line schemas vs one ~30-line union schema;
neutral.

---

## P7 pre-flight 5 — Read-only IAM grant on the readings table

**Concept.** Principle of least privilege; the query Lambda needs
to read DynamoDB but never writes.

**Decision.** Use `props.readingsTable.grantReadData(queryFunction)`
— grants `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`,
`dynamodb:BatchGetItem`. NOT `grantReadWriteData` or
`grantFullAccess`.

**Why this matters.** A bug in the query handler that somehow tried
to call `PutItem` would *fail at IAM* rather than corrupt data. The
IAM denial is a defense-in-depth layer below the application code's
intent.

**Cost lens.** No cost difference; principle of least privilege at
the IAM layer.

---

## P7 pre-flight 6 — Permissive CORS for POC

**Concept.** CORS configuration always-too-loose vs always-too-tight
is a common source of friction in early-stage APIs.

**Decision.** Allow `*` origin, `GET` method only, common headers.
No credentials.

**Why permissive.** No browser consumer exists yet; Phase 10's demo
dashboard will drive from a hosted page where the origin is unknown
at deploy time. Permissive CORS lets any origin call the API while
the demo dashboard's hosting story is still TBD.

**Cost lens.** No cost difference. The only "cost" is the implicit
trust extended to any origin — mitigated by the read-only nature of
the endpoint and the future Phase 12 auth layer.

**Tightening path.** Once Phase 10's demo dashboard hosting is fixed
(e.g., specific S3 + CloudFront origin), narrow CORS to that origin
in Phase 12 alongside the auth work.

---

## Cross-cutting framing for Phase 7

Three durable patterns this phase encodes:

1. **Validate at every I/O boundary, including read APIs.** The
   query handler validates path/query params with Zod just as the
   processor validates Kinesis records. Different schemas, same
   pattern.

2. **Read APIs as thin orchestration over lib code.** The handler
   does no DynamoDB-specific work; it calls
   `SensorRepository.queryReadings()` and formats the response.
   Same pattern as the processor calling `repo.putReading()`.

3. **Defer auth honestly, document the migration path.** No-auth in
   Phase 7 is acceptable POC scope IF (a) it's documented as
   deferred, not omitted-by-accident, and (b) the migration path is
   sketched. Both are in this decision log; neither pretends the
   feature exists.
