# Grid Sensor Pipeline — Portfolio Entry

Three sizes — pick whichever fits your site layout. Tone is honest about the *in active development* status; the project is being built deliberately as a focused engineering effort, which is itself a strong signal.

---

## One-line tagline

Serverless event-driven pipeline for IoT grid sensor telemetry on AWS — TypeScript + CDK + IoT Core + Step Functions, with Bedrock-powered alert narratives and an MCP server interface.

---

## Short card (~100 words, suitable for a tile / grid layout)

**Grid Sensor Pipeline** — *AWS serverless · TypeScript · IoT*

Event-driven telemetry pipeline for IoT grid sensors, modeled on the kind of mesh energy infrastructure powering distributed clean-energy systems. Devices publish over MQTT to AWS IoT Core; readings stream through Kinesis to a Lambda processor with idempotent writes to DynamoDB, while threshold violations route to a Step Functions workflow that enriches alerts with Bedrock-generated narratives. Built on AWS CDK with full observability via Lambda Powertools and Datadog. Includes an MCP server exposing the data API to LLM clients. *Currently in active development; design ADRs and architecture available below.*

---

## Full project page

# Grid Sensor Pipeline

**Serverless event-driven pipeline for IoT grid sensor telemetry on AWS.**

Devices publish readings via MQTT to AWS IoT Core; the pipeline processes, stores, and alerts in real time with full observability and zero data loss under failure. Built end-to-end in TypeScript with AWS CDK as a focused engineering exercise on event-driven architecture for clean-energy / IoT domains.

> **Status:** In active development — May 2026. Design and architectural decision records are complete; implementation in progress. Repo and live demo links will be added as the deploy lands.

---

## Why this project

Mesh energy infrastructure — the kind of distributed, resilient power systems being built around clean-energy generation, batteries, and community grids — runs on streams of telemetry from physical hardware. The engineering problem is the same shape as the streaming pipelines I shipped at Aireon (real-time aircraft telemetry, Kafka + AWS Lambda) and the serverless ETL platforms I built at uExamS and College Board: bounded latency, ordered per-source, idempotent under retry, with partial-failure isolation that doesn't compromise the rest of the stream.

This project models that pattern on AWS-native serverless primitives, with deliberate attention to the architectural decisions an engineer should be able to defend in design review or interview: idempotency keys, partition strategy, alert orchestration tradeoffs, observability boundaries.

---

## Architecture

```
                     ┌───────────────────────────┐
                     │  IoT Device (simulator)   │
                     │  publishes MQTT to:       │
                     │  sensors/{id}/telemetry   │
                     └────────────┬──────────────┘
                                  │
                     ┌────────────▼──────────────┐
                     │       AWS IoT Core        │
                     │  X.509 auth · Rules SQL   │
                     └────────────┬──────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
       Rule 1: all telemetry           Rule 2: threshold violations
                │                                   │
                ▼                                   ▼
     ┌──────────────────┐              ┌────────────────────────┐
     │  Kinesis Stream  │              │  Step Functions        │
     │  PK = sensorId   │              │  Standard Workflow     │
     └────────┬─────────┘              │  ┌──────────────────┐  │
              │                        │  │ Compute breach   │  │
              ▼                        │  │ Bedrock narrate  │  │
     ┌──────────────────┐              │  │ Notify ops       │  │
     │ Processor Lambda │              │  │ Wait 15min ack   │  │
     │ bisectOnError    │              │  │ Choice → Escalate│  │
     │ batchItemFails   │              │  └──────────────────┘  │
     │ Powertools EMF   │              └────────────┬───────────┘
     └─────┬───────┬────┘                           │
           │       │                                ▼
           ▼       ▼                          ┌──────────┐
    ┌──────────┐ ┌──────────────┐             │   SNS    │
    │ DynamoDB │ │ SQS DLQ      │             │ + Bedrock│
    │ TTL 30d  │ │ → Inspector  │             │ narrative│
    └──────────┘ └──────────────┘             └──────────┘
           │
           ▼
    ┌──────────────────┐    ┌──────────────────┐
    │  Query API       │    │   MCP Server     │
    │  API GW + Lambda │    │  (TypeScript)    │
    └──────────────────┘    └──────────────────┘
                                     ▲
                                     │
                            LLM clients (Claude
                            Desktop, Cursor, etc.)

    Cold archive: Kinesis Firehose → S3 (Parquet)
    Observability: Powertools EMF → CloudWatch + Datadog
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Language | TypeScript (Node.js 20) | Type safety end-to-end, same language as IaC |
| IaC | AWS CDK v2 | Type-safe infrastructure in the application language; L3 constructs enforce architectural patterns at the call site |
| Device ingest | AWS IoT Core | X.509 device auth, MQTT broker, Rules Engine for SQL-based routing |
| Streaming | Kinesis Data Streams | Serverless, replayable, ordered per partition key |
| Processing | AWS Lambda (Kinesis ESM) | `bisectOnError` + `batchItemFailures` for partial-failure isolation |
| Alert orchestration | Step Functions Standard Workflow | Auditable execution history, native Wait state for ack window |
| AI/ML | AWS Bedrock (Claude Sonnet) | LLM-generated alert narratives in the Step Functions workflow |
| LLM interface | Model Context Protocol (MCP) server | Exposes the query API as MCP tools for LLM clients |
| Validation | Zod | Runtime type safety at the I/O boundary |
| Idempotency | Lambda Powertools Idempotency + DynamoDB | Idempotency key = Kinesis sequence number |
| Hot storage | DynamoDB | PK: `sensorId`, SK: `timestamp`, TTL 30 days |
| Cold archive | Kinesis Firehose → S3 (Parquet) | Zero-code raw event archival |
| Query API | API Gateway + Lambda | Range queries by sensor and time window |
| Observability | Lambda Powertools (Logger, Tracer, Metrics via EMF) → CloudWatch + Datadog | Structured logs, X-Ray tracing, EMF metrics; Datadog Lambda Extension forwards with zero application code changes |

---

## Engineering decisions worth defending

A short selection of architectural choices, each with a full ADR in `docs/adr/`:

**Idempotency key = Kinesis sequence number.** The sequence number is globally unique per shard and stable across Lambda retries. Combined with a DynamoDB conditional write (`attribute_not_exists(pk)`), the processor is safe to retry without duplicates. Idempotency at the consumer is cheaper and simpler than transactional semantics across the boundary.

**`bisectOnError: true` + `batchItemFailures` together.** Kinesis ESM splits a failing batch in half to isolate the bad record, while `batchItemFailures` ensures only the bad record retries and eventually routes to the DLQ. This is the correct pattern for any at-least-once Kinesis consumer; failing the whole batch wastes work and silently dropping records is unacceptable.

**Step Functions Standard Workflow, not Lambda chain, for alert escalation.** Three reasons: (1) auditable execution history retained 90 days — every step input, output, and transition is inspectable, which matters for safety-critical grid events; (2) native Wait state for the 15-minute acknowledgment window without a running Lambda; (3) per-step retry configuration so a transient notification failure retries that step only, not the whole escalation. A Lambda chain provides none of these.

**DynamoDB partition key = `sensorId`, not `gridZone`.** Grid events cause correlated spikes — all sensors in a zone emit simultaneously when something upstream goes wrong. `gridZone` partitioning creates hot shards under exactly the load that matters. `sensorId` distributes evenly and preserves per-sensor event ordering.

**IoT Rules Engine routes telemetry and alerts separately at the edge.** The threshold condition is simple SQL, evaluable in the rules engine without a Lambda invocation; this decouples the alert path from the data path, so a Lambda cold start cannot delay a safety alert. Threshold violations are a small fraction of total telemetry volume, making the dedicated rule operationally cheap.

**Bedrock alert narratives as a Step Functions Task state.** When a threshold violation triggers the workflow, an LLM-enrichment step generates a plain-English summary of the breach for the SNS notification, grounded in the structured breach details from the previous step. Demonstrates the prompt-design and cost-aware retry/timeout patterns required for production LLM integration.

---

## Phase 15 — Factory Floor Mapping & Asset Intelligence

> *Draft framing (2026-06-18) — pending a voice pass before publication.*

Grid-Sensor-Pipeline began as an event-driven IoT telemetry pipeline. Phase 15 extends it with factory-floor mapping so sensor alerts become location-aware operational incidents tied to real equipment, production zones, and response workflows. This mirrors how the ERIP POC uses GIS/routing for emergency response, but adapts the concept to indoor manufacturing through asset registries, floor maps, zones, and deterministic location enrichment.

The architectural through-line is the same discipline the rest of the project leads with: **deterministic services own all factual mapping; the LLM/LangGraph layer only summarizes and reasons over the structured location context it's handed — it never invents physical locations.** A sensor event resolves to its asset, the asset's indoor `(x, y)` coordinates, and its floor/zone context through pure registry lookups before the AI layer ever sees it, so location facts stay correct even when the model is unavailable.

---

## What this project demonstrates

- **Event-driven architecture on AWS serverless** — Lambda, Kinesis, Step Functions, IoT Core, all wired through CDK.
- **Production-grade patterns for streaming consumers** — idempotency, partial batch failure handling, DLQ + replay, structured observability.
- **Modern AWS infrastructure-as-code** — CDK with multi-stack composition, type-safe construct properties across stack boundaries.
- **LLM integration in a real workflow** — Bedrock-powered alert narratives, MCP server interface for LLM clients.
- **Observability as a first-class concern** — Lambda Powertools EMF metrics, X-Ray tracing, CloudWatch dashboards with Datadog bridge.
- **Engineering rigor as a deliverable** — architectural decision records, architectural invariants enforced via test suite, full unit test coverage on pure logic.

---

## Repository

- **GitHub:** `github.com/amusto/grid-sensor-pipeline` *(link goes live at end of build)*
- **Architectural Decision Records:** `docs/adr/`
- **Phase recaps & design log:** `docs/phase-recaps/` and `docs/design-log.md`

## Build status

| Phase | Focus | Status |
|---|---|---|
| 0 | Skeleton + CDK bootstrap | Pending |
| 1 | Pure TypeScript core (lib/) + unit tests | Pending |
| 2 | Storage stack + Processor Lambda — first AWS deploy | Pending |
| 3 | Kinesis stream + Lambda ESM (partial-failure deep dive) | Pending |
| 4 | IoT Core: Things, certs, Rules, simulator | Pending |
| 5 | Step Functions alert workflow + Bedrock narrative | Pending |
| 6 | DLQ inspector + Observability (CloudWatch + alarms) | Pending |
| 7 | Query API (API Gateway + Lambda) | Pending |
| 8 | MCP server wrapping query API | Pending |
| 9 | Datadog wired + study guide + interview prep | Pending |

---

*Built deliberately as a focused engineering exercise. Domain inspiration: distributed clean-energy / mesh-grid infrastructure.*
