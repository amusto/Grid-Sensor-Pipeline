# Homelab Refactor Plan — Self-Hosted Fork

**Goal.** Fork this AWS-serverless pipeline into a self-hosted project that runs
entirely on a homelab via **Docker Compose**, with **Ollama (GPU)** for local LLM
inference. Optimized for the **fastest path to a working forked starter repo** —
full replacement of AWS, no dual-target abstraction layer.

**Date:** 2026-06-18 · **Status:** plan, not yet executed.

---

## 1. Guiding strategy — why this is fast, not a rewrite

The project's architectural invariants are what make this cheap. Three of them
do the heavy lifting:

- **"No I/O in `lib/`" (invariant #2)** means `types.ts`, `validator.ts`,
  `threshold.ts`, and the whole LangGraph reasoning core (`severity-classifier`,
  `routing-strategy`, `narrative-generator`, `alert-graph`) have **zero AWS
  imports**. They copy over untouched.
- **Singleton + interface seams.** `logger`, `metrics`, `tracer`, the
  `SensorRepository` class, the `llm-client.invokeStructured()` surface, and the
  `CHANNEL_HANDLERS` registry are all imported by their public shape. **Swap the
  internals, keep the export signature, and the call sites don't change.**
- **"Validate at the I/O boundary only" (invariant #1)** means the AWS coupling
  is concentrated at the edges (handlers, repository, SNS adapter) — not smeared
  through the business logic.

So the work splits cleanly into *copy as-is*, *reimplement behind the same
interface*, and *rewrite the thin entry shell*. The reasoning engine — the part
that took the most effort to build — is in the first bucket.

---

## 2. Target stack — AWS → Docker Compose

| Concern | Current (AWS) | Homelab (Compose) | Why this pick (fastest path) |
|---|---|---|---|
| Device ingest / MQTT | IoT Core | **EMQX** (or Mosquitto) | Single OSS container, real MQTT broker. Keeps the device-auth + topic story. |
| Rules routing | IoT Rules Engine SQL | **`ingest-bridge` Node service** | ~60-line MQTT→Kafka producer that *reuses `threshold.ts`* to split telemetry vs. breaches. Replaces both IoT rules and reuses the pure function. |
| Streaming backbone | Kinesis Data Streams | **Redpanda** | Kafka-API compatible, single binary, no ZooKeeper. Far lighter than Kafka for Compose. Replayable, partitioned — same semantics as Kinesis. |
| Stream consumer | Lambda + ESM (`bisectOnError`, `batchItemFailures`) | **KafkaJS consumer** in `processor` service | Consumer-group offsets replace ESM. Partial-failure handling becomes per-message try/catch + dead-letter produce. |
| Hot storage | DynamoDB (readings, idempotency, cases) | **Postgres + pgvector** | One database for all three tables. `pgvector` extension primes the RAG/vector-store review items. Consolidation = fewer moving parts. |
| Idempotency | Powertools + DynamoDB conditional write | **Postgres `UNIQUE` + `ON CONFLICT DO NOTHING`** | The readings unique constraint gives exactly-once *effect* for free; the separate idempotency table becomes optional. |
| Alert orchestration | Step Functions Standard | **`alert-worker` service** (v1) → **Temporal** (upgrade) | v1: a Node worker consuming the `breaches` topic, persisting state in Postgres, using a scheduled-wake row for the ack-wait. Temporal is the faithful, auditable upgrade (README already names it). |
| LLM inference | Bedrock (`ChatBedrockConverse`) | **Ollama (GPU)** via `ChatOllama` | Local, zero per-call cost. Refactor `llm-client` into a provider factory (ollama/openai/anthropic) — this *is* the model-adapter review item. |
| Notifications | SNS topic + email subscription | **SMTP** (nodemailer) → **MailHog** (dev) / real SMTP | Email adapter's own header says the swap is single-file. SMS stub unchanged. |
| Cold archive | Firehose → S3 (Parquet) | **MinIO** + small archiver consumer | S3-compatible. Optional for v1. |
| DLQ | SQS | **Redpanda `*.dlq` topic** + `dlq-inspector` consumer | Dead-letter topic; inspector logic ports nearly as-is. |
| Query API | API Gateway + Lambda | **Fastify** HTTP service | Wraps the existing `query.ts` logic in a route handler. |
| Observability | CloudWatch EMF via Powertools | **pino** (logs) + **prom-client** (metrics) + **Prometheus + Grafana** | Reimplement the three obs singletons behind the same API. Grafana is the README's stated equivalent. |
| Tracing | X-Ray via Powertools | **OpenTelemetry** → Tempo/Jaeger (optional) | Defer for v1; the `tracer` singleton becomes a no-op shim. |
| Secrets | Secrets Manager | **`.env` file** (dev) / Docker secrets | Fastest path; Vault is the documented upgrade. |
| IaC | AWS CDK (`infra/`) | **`docker-compose.yml` + `db/schema.sql`** | The entire `infra/` tree is deleted and replaced. |
| MCP server | Resolves config from CloudFormation outputs | **Env-var config**, queries Postgres/HTTP directly | Drop the `@aws-sdk/client-cloudformation` resolution; otherwise mostly unchanged. |

---

## 3. Code refactor surface — file by file

### 3a. Copy as-is (zero or near-zero change)

These have no AWS imports and port directly, with their tests:

- `src/lib/types.ts`
- `src/lib/validator.ts` (Zod)
- `src/lib/threshold.ts` (pure function — also reused by the new `ingest-bridge`)
- `src/lib/severity-classifier.ts`
- `src/lib/routing-strategy.ts`
- `src/lib/narrative-generator.ts`
- `src/lib/alert-graph.ts` ← **the LangGraph engine ports untouched**
- `src/lib/cases/case-id.ts`, `src/lib/cases/types.ts`, `src/lib/cases/channels/sms-stub.ts`
- All the matching `__tests__/*` for the above.

### 3b. Reimplement behind the same interface (internals swap, signature stays)

| File | Change |
|---|---|
| `src/lib/repository.ts` | Replace DynamoDB `PutCommand`/`QueryCommand` with `pg` queries. `putReading` → `INSERT ... ON CONFLICT DO NOTHING` (rowCount 0 = the old `ConditionalCheckFailedException` no-op). `queryReadings` → parameterized `SELECT ... WHERE pk = $1 AND sk BETWEEN ...`. **Keep the class API identical** so handlers don't change. |
| `src/lib/cases/case-repository.ts` | Same DynamoDB→`pg` swap; conditional-write idempotency becomes `ON CONFLICT`. |
| `src/lib/llm-client.ts` | Turn `getClient()` into a **provider factory** keyed on `LLM_PROVIDER` env (`ollama`\|`openai`\|`anthropic`). `ChatOllama` from `@langchain/ollama`, `ChatOpenAI` from `@langchain/openai`. **`invokeStructured()` signature unchanged** — every LangGraph node keeps working. |
| `src/lib/logger.ts` | `pino` instance exposing `.info/.warn/.error` + `addContext`. |
| `src/lib/metrics.ts` | `prom-client` counters/histograms behind `addMetric(name, unit, value)` + a no-op `publishStoredMetrics()`/`singleMetric()`. Expose a `/metrics` registry for Prometheus scrape. |
| `src/lib/tracer.ts` | OTEL span helpers, or a no-op shim returning a fake subsegment so `processor.ts`'s `tracer.getSegment()?.addNewSubsegment()` keeps compiling. |
| `src/lib/cases/channels/email.ts` | Replace `SNSClient.send(PublishCommand)` body with `nodemailer.sendMail(...)`. Always-resolve `ChannelResult` contract preserved (the file's own comment predicts this swap). |
| `src/lib/cases/channels/index.ts` | No change — registry pattern is transport-agnostic. |

### 3c. Rewrite as long-running services (logic reused, entry shell new)

Lambda handlers become container processes. The body logic is largely lifted;
the AWS event-shape wrapper is replaced.

| Current handler | Becomes | Entry-shell change |
|---|---|---|
| `handlers/processor.ts` | `services/processor` | `KinesisStreamEvent` loop → KafkaJS `eachBatch`. Powertools idempotency wrapper → Postgres `ON CONFLICT`. `batchItemFailures` → produce failures to `telemetry.dlq`. Core validate→persist→metrics block unchanged. |
| `handlers/alert-handler.ts` + `alert-workflow-stack` | `services/alert-worker` | Consume `breaches` topic → `runAlertGraph()` (unchanged) → dispatch. The Step Functions Notify→Wait→Escalate becomes worker state in Postgres + a wake-timer (or Temporal workflow in the upgrade). |
| `handlers/query.ts` | `services/query-api` | API Gateway proxy → Fastify route `GET /sensors/:id/readings`. Zod param validation + `repo.queryReadings()` reused verbatim. |
| `handlers/dlq-inspector.ts` | `services/dlq-inspector` | SQS trigger → Kafka `*.dlq` consumer. Parsing + structured-log + alert logic ports. |
| `handlers/simulator.ts` | `services/simulator` (or CLI) | `@aws-sdk/client-iot-data-plane` publish → `mqtt.js` publish to EMQX. Gaussian generator + breach mode unchanged. |
| `mcp-server/server.ts` | `services/mcp-server` | Drop CloudFormation output resolution; read `QUERY_API_URL` + DB creds from env. Tool bodies query Postgres/HTTP. |

### 3d. Delete

- Entire `infra/` CDK tree (`bin/app.ts`, all `lib/*-stack.ts`, `__tests__`).
- `infra/lib/datadog-instrumentation.ts`.
- `@aws-sdk/*` and `@aws-lambda-powertools/*` from `package.json`.
- `scripts/post-destroy-check.sh`, `add-demo-recipient.sh` (AWS-specific).

---

## 4. Fork repo layout

```
grid-sensor-homelab/
├── docker-compose.yml          # the whole stack
├── .env.example                # LLM_PROVIDER, DB creds, MQTT/Kafka hosts, SMTP
├── db/
│   ├── schema.sql              # readings, cases, (optional) idempotency + pgvector
│   └── 01-init.sql             # CREATE EXTENSION vector; indexes
├── services/
│   ├── ingest-bridge/          # MQTT subscribe → threshold split → Kafka produce
│   ├── processor/              # Kafka consumer → Postgres
│   ├── alert-worker/           # breaches → LangGraph → dispatch + ack-wait state
│   ├── query-api/              # Fastify HTTP
│   ├── simulator/              # MQTT publisher (Gaussian + breach mode)
│   ├── dlq-inspector/          # *.dlq consumer
│   └── mcp-server/             # stdio MCP, env-configured
├── src/lib/                    # shared domain logic — bucket 3a + 3b
│   ├── types.ts validator.ts threshold.ts        # as-is
│   ├── severity-classifier.ts routing-strategy.ts narrative-generator.ts alert-graph.ts   # as-is
│   ├── repository.ts           # Postgres impl, same class API
│   ├── llm-client.ts           # provider factory
│   ├── obs/{logger,metrics,tracer}.ts            # pino / prom-client / otel
│   └── cases/...               # email → SMTP
├── observability/
│   ├── prometheus.yml
│   └── grafana/                # provisioned dashboards (port the CloudWatch widgets)
└── README.md
```

A monorepo with one shared `src/lib` and thin per-service entrypoints keeps the
"build once, import everywhere" ergonomics. Each service gets a tiny Dockerfile
(`node:22-alpine`, `tsc` build, `node dist/<service>.js`).

---

## 5. docker-compose.yml — service inventory

```yaml
# Sketch — names + roles, not final tuning.
services:
  emqx:          # MQTT broker (ports 1883, 18083 dashboard)
  redpanda:      # Kafka-API streaming backbone (port 9092)
  postgres:      # pgvector/pgvector image — readings + cases + vectors
  ollama:        # GPU inference; deploy.resources.reservations.devices → nvidia
  mailhog:       # dev SMTP sink + web UI (port 8025)
  minio:         # optional cold archive (S3-compatible)
  prometheus:    # scrapes /metrics from each service
  grafana:       # dashboards (port 3000)

  ingest-bridge: # depends_on: emqx, redpanda
  processor:     # depends_on: redpanda, postgres
  alert-worker:  # depends_on: redpanda, postgres, ollama, mailhog
  query-api:     # depends_on: postgres (port 8080)
  simulator:     # depends_on: emqx  (run on demand: docker compose run simulator --count 50 --breach)
  dlq-inspector: # depends_on: redpanda
  mcp-server:    # depends_on: postgres, query-api
```

**Ollama GPU wiring** (the one non-obvious bit): the `ollama` service needs the
NVIDIA Container Toolkit on the host and a `deploy.resources.reservations.devices`
block requesting `capabilities: [gpu]`. Pull the model once
(`ollama pull llama3.1` or a tool-use-capable model) — LangGraph's structured
output needs a model that supports tool/function calling, so verify the chosen
model handles `withStructuredOutput` before wiring the alert path.

---

## 6. Postgres schema (replaces 3 DynamoDB tables)

```sql
CREATE TABLE readings (
  pk           text NOT NULL,                 -- sensorId
  sk           text NOT NULL,                 -- timestamp#readingType
  sensor_id    text NOT NULL,
  timestamp    timestamptz NOT NULL,
  reading_type text NOT NULL,
  value        double precision NOT NULL,
  unit         text NOT NULL,
  grid_zone    text,
  ttl          timestamptz NOT NULL,          -- prune via cron/pg_partman, not DynamoDB TTL
  PRIMARY KEY (pk, sk)                         -- UNIQUE = idempotent insert
);
-- queryReadings range scan rides the PK; add GSI-equivalent index:
CREATE INDEX ON readings (reading_type, timestamp);

CREATE TABLE cases ( ... pk text, sk text, ..., PRIMARY KEY (pk, sk) );

CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector, for the RAG review item
-- e.g. incident_embeddings (case_id, embedding vector(768), ...)
```

`INSERT ... ON CONFLICT (pk, sk) DO NOTHING` + checking `rowCount === 0`
reproduces the `attribute_not_exists(pk)` → `ConditionalCheckFailedException`
no-op contract exactly. DynamoDB TTL auto-expiry becomes a scheduled
`DELETE WHERE ttl < now()` (cron container or `pg_cron`).

---

## 7. Phased execution — fastest path to "it runs"

Ordered to get a vertical slice live early, then fill in. Each phase ends green.

1. **Compose skeleton + Postgres.** Stand up `postgres` (pgvector image),
   `redpanda`, `emqx`. Apply `schema.sql`. Verify connectivity. *(no app code)*
2. **Port `lib/` buckets 3a + 3b.** Copy the pure modules. Rewrite
   `repository.ts` on `pg`, swap the obs singletons to pino/prom-client, make
   `tracer` a shim. Run the existing unit tests against the new repository
   (mock `pg`). **Gate:** `npm test` green.
3. **Ingest + processor vertical slice.** Build `ingest-bridge` (MQTT→Kafka,
   reusing `threshold.ts`) and `processor` (Kafka→Postgres). Build `simulator`
   on `mqtt.js`. **Gate:** `simulator --count 50` → 50 rows in Postgres.
4. **LLM provider factory + Ollama.** Refactor `llm-client.ts`; pull a
   tool-use model; verify `invokeStructured` returns valid structured output
   from Ollama. **Gate:** a one-off `classifySeverity` call returns a parsed
   `Severity`.
5. **Alert path.** Build `alert-worker` (consume `breaches` → `runAlertGraph`
   unchanged → dispatch). Swap email adapter to nodemailer→MailHog. Implement
   the v1 ack-wait as worker state + wake-timer. **Gate:**
   `simulator --count 5 --breach` → alert email in MailHog with LLM narrative.
6. **Query API + MCP.** Fastify wrap of `query.ts`; re-point MCP server to env
   config. **Gate:** `curl` returns readings; MCP `tools/list` works.
7. **Observability.** Wire Prometheus scrape + Grafana dashboards (port the
   CloudWatch widget set). **Gate:** metrics visible in Grafana after a sim run.
8. **Optional / upgrades.** MinIO cold archive; DLQ inspector; Temporal swap for
   the alert workflow; OTEL tracing.

Phases 1–5 are the minimum for a working forked POC. 6–8 reach feature parity.

---

## 8. Effort & risk notes

- **Biggest single rewrite:** the alert workflow. Step Functions' durable
  Wait-for-ack has no one-container equivalent. The v1 worker-state approach is
  fast but you own the durability; **Temporal** is the honest parity answer and
  is worth the extra containers if the ack/escalation audit trail matters
  (it's a CLAUDE.md invariant in the original). Flag this as the deliberate
  scope call, same way P12 was scoped to docs-only.
- **Model capability risk:** not every Ollama model supports tool-use /
  structured output well. Validate `withStructuredOutput` against the chosen
  model in Phase 4 *before* building the alert path on it. Keep the provider
  factory so you can fall back to a cloud model per-call if local output is
  flaky.
- **Lowest risk, highest reuse:** the LangGraph reasoning core, the Zod schemas,
  and `threshold.ts`. The thing that's hardest to rebuild is the thing you don't
  touch.
- **Idempotency simplification:** dropping the dedicated idempotency table in
  favor of the readings `UNIQUE` constraint is a real simplification, but note
  it only covers the readings write. If you want replay-safety on the *alert*
  side, the cases-table `ON CONFLICT` (ported from P9.3) still carries it.
- **Three review-backlog items get satisfied for free by this port:** the
  **model adapter** (Phase 4), **pgvector** (Phase 1 schema), and a foundation
  for **RAG** (incident embeddings in Postgres). Worth sequencing the fork
  ahead of those if you want them.

---

## 9. What you lose vs. the AWS version

Honest trade-offs to keep in the README of the fork:

- **Managed scaling & durability.** Redpanda/Postgres on one box ≠ Kinesis +
  DynamoDB multi-AZ. Fine for a homelab POC; name it.
- **Auditability of the alert workflow** until/unless Temporal lands.
- **Datadog bridge** (P10) — replaced by self-hosted Grafana; the "zero-code
  EMF forwarding" story doesn't carry over.
- **The AWS deployable itself** — this is a full replacement per your call. The
  original repo stays as the cloud reference; this fork is the self-hosted line.
```
