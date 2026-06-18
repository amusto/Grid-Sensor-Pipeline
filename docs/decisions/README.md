# Decision logs

Per-phase rationale for every meaningful engineering choice across
the Grid Sensor Pipeline build. Each entry captures the **decision**,
the **alternatives considered**, **why this option won**, and any
**knowingly accepted tradeoffs**.

Index is chronological in build order — the same order a reviewer
would read them to understand how the architecture evolved.

| # | Date | Phase | Title | What it covers |
|---|---|---|---|---|
| 1 | 2026-05-07 | Day 1 (foundation) | [Lib & test foundation](./day-01-lib-foundation.md) | Test-first foundation: domain types, Zod schemas, threshold logic, validator at the I/O boundary, AWS SDK v3 over v2, esbuild bundling strategy. Sets CLAUDE.md hard rule #1 (parse-don't-validate). |
| 2 | 2026-05-07 | Phase 2 | [Processor Lambda](./phase-02-processor.md) | Kinesis-triggered processor: handler shape, batch-item-failure response contract, partial-failure isolation, idempotency check pattern via DynamoDB conditional writes. |
| 3 | 2026-05-08 | Phase 3 | [Storage + processing stacks](./phase-03-storage-processing.md) | DynamoDB single-table design for readings + idempotency table; Kinesis ESM safety flags (`bisectBatchOnError`, `reportBatchItemFailures`, retry caps, DLQ on failure). CLAUDE.md hard rule #9. Documents the recurring "CFN destroy leaks Kinesis stream" gotcha. |
| 4 | 2026-05-09 | Phase 4 | [IoT Core + simulator](./phase-04-iot-simulator.md) | MQTT ingestion via AWS IoT Core: IoT rule → Kinesis pipeline, simulator script for generating realistic sensor events, breach injection mechanics, reading-type distribution model. |
| 5 | 2026-05-10 | Phase 5 | [Alert workflow](./phase-05-alert-workflow.md) | Step Functions Standard Workflow (not Express — CLAUDE.md hard rule #10) for the NotifyOps → WaitForAck → IsAcknowledged → EscalateToOnCall flow. Alert handler Lambda dual-mode (notification + escalation). |
| 6 | 2026-05-11 | Phase 6 | [DLQ + observability](./phase-06-dlq-observability.md) | Processor DLQ (7-day SQS retention), Powertools Metrics emitting EMF, Powertools Logger structured fields, X-Ray tracing, namespace conventions (`GridSensorPipeline`). The metric design this whole project's dashboards consume. |
| 7 | 2026-05-12 | Phase 7 | [Query API](./phase-07-query-api.md) | Read-side Lambda for sensor readings: GSI design, paginated query patterns, request validation, response shaping. The MCP server in Phase 8 calls these. |
| 8 | 2026-05-13 | Phase 8 | [AI/ML integration](./phase-08-ai-ml-integration.md) | Bedrock Claude Sonnet via cross-region inference profile, LangChain Bedrock client, LangGraph 3-node flow (classify severity → determine routing → generate narratives), MCP server exposure of the query API. IAM scoped to InvokeModel only (no wildcards). |
| 9 | 2026-05-13 | Phase 9 | [Agentic case routing](./phase-09-agentic-case-routing.md) | Cases table + uniform channel adapter pattern (`Promise<ChannelResult>` contract), CHANNEL_HANDLERS registry, partial-success failure isolation via `Promise.allSettled`, conditional-write idempotency reapplied at the case layer. Email via SNS subscription (not direct SES); SMS as a structured `would_call` stub. |
| 10 | 2026-05-15 | Phase 10 | [Datadog bridge](./phase-10-datadog-bridge.md) | Datadog Lambda Extension push path (sub-minute EMF forwarding to a us5 Datadog org) + AWS CloudFormation integration pull path. Secrets Manager over plaintext for the API key, layer version pinning for deploy reproducibility, APM tracing deferred as a stretch. |
| 11 | 2026-05-15 | Phase 12 | [Demo dashboard (design doc)](./phase-12-demo-dashboard.md) | Documentation-only path for the live demo dashboard: CloudWatch widget inventory, public sharing flow, Grafana three-option comparison (decided: local Docker + screenshots for cost permanence), simulator trigger button architecture, portfolio integration plan. Includes the explicit "documented not built" rationale. |
| 12 | 2026-06-18 | Phase 15 | [Factory floor mapping & asset intelligence](./phase-15-factory-floor-mapping.md) | Asset-centric evolution: sensor→asset→location→zone enrichment. The load-bearing call is **deterministic services own all factual mapping; the LLM only summarizes structured `locationContext` — never invents locations**. Indoor per-floor coordinate model (ERIP GPS/GIS adaptation), asset registry as versioned JSON seed data, missing-mapping fail-safe, and an explicit non-goals fence (no UI / routing / BLE-UWB / CAD-BIM / LLM-derived locations). |

## Conventions

**Naming.** `phase-NN-<short-name>.md` matches the ROADMAP phase
number. Day-01 is the exception — it covers foundational work that
preceded the formal phase structure.

**Cross-linking.** Decision logs link to one another when one decision
constrains or revisits another (e.g., Phase 9's case-table idempotency
contract reapplies the same primitive as Phase 3's processor
idempotency table). Use relative links — `./phase-NN-*.md` — so the
docs render correctly in both GitHub and local previews.

**Style.** Decisions read as engineering rationale, not personal
notes. Phrasing is in the candidate's voice (Armando's), shaped to be
read by interviewers and future-self equally well. Claude-drafted
content goes through a voice pass before publication; see
[`shared/practice/collaboration-mode.md`](../../../shared/practice/collaboration-mode.md)
for the collaboration norms.

**What goes here vs. learning/.** Decision logs cover **choices** —
why X over Y — anchored to a specific phase. Learning notes in
[`../learning/`](../learning/) cover **concepts** — what is X, when
does it apply — independent of any phase. A decision log might say
"used the bridge-broker pattern at the Kinesis → Lambda seam"; the
learning note explains what the bridge-broker pattern *is* and when
it applies.

## Missing decision logs (deliberate)

**Phase 1 — Lib & test foundation.** Captured under `day-01-lib-foundation.md`
because Phase 1 happened on Day 1 before the per-phase decision-log
naming convention solidified.

**Phase 11 — Polish & teardown.** No standalone decision log; the
polish work is mechanical and the calls (history squash vs. keep,
README structure, scrub list) are tracked directly in the ROADMAP
Phase 11 section.
