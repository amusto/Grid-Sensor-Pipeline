# Learning notes

Cheatsheets and grounding material for the AWS services this project uses.
Each note is structured the same way:

1. **Mental model** — the one-paragraph "what this thing actually is" framing.
2. **Core concepts** — the vocabulary you need to read AWS docs without
   getting lost.
3. **Service-specific tuning knobs** — the parameters that matter, with
   our project's values and rationale.
4. **Pitfalls** — the four-or-so mistakes most newcomers make.
5. **Cost levers** — what costs what, ordered by impact.
6. **Learning resources** — official docs, hands-on workshops, deeper reads.
7. **When to revisit this note** — the triggers that should bring you back.
8. **Did I actually learn this? — self-test** — 5-7 questions you can
   answer without looking at the note. Tests *understanding*, not
   memorization. Last section in every filled note.

These are working-engineer cheatsheets, not exhaustive references. The
goal is fast recall, not comprehensive coverage. When you need the full
picture, the linked AWS docs are the source of truth.

**The self-test is the actual learning gate.** Reading a note tells you
*what's covered*; the self-test tells you *what stuck*. Run it after the
first read, again a week later, again a month later. Anything you trip
up on is the section to revisit. If a note doesn't have a self-test
yet, it's still a stub — the self-test is what marks it as fully
filled.

## Index

| Note | Phase introduced | Status | What it covers |
|---|---|---|---|
| [`_design-patterns-index.md`](_design-patterns-index.md) | recurring | ✅ living index | Consolidated catalog of every design pattern used in the project, organized by category, with anchors back to where each is defined and applied. **Read this periodically — patterns are durable across projects.** |
| [`aws-kinesis.md`](aws-kinesis.md) | P3 | ✅ filled | Data Streams, Firehose, Lambda ESM tuning, partition keys, sequence numbers |
| [`aws-iot-core.md`](aws-iot-core.md) | P4 | ✅ filled | MQTT topics, X.509 device auth, IoT Rules engine SQL, device shadows |
| [`synthetic-data-and-simulation.md`](synthetic-data-and-simulation.md) | P4 | ✅ filled | Gaussian distributions, Box-Muller transform, organic vs adversarial generation, fault injection patterns |
| [`aws-step-functions.md`](aws-step-functions.md) | P5 | ✅ filled | Standard vs Express workflows, state types, error handling, JSONPath |
| [`cdk-as-typed-model.md`](cdk-as-typed-model.md) | P5 | ✅ filled | CDK's defining property vs Terraform/CloudFormation; typed cross-stack contracts; pitfalls (predicate duplication, deploy ordering, L2 interface drift); CDK vs Pulumi vs CDKTF vs Terraform |
| [`langchain-langgraph.md`](langchain-langgraph.md) | P8 | 🚧 partial (P8.2 patterns filled; LangGraph assembly added at P8.5) | LangChain vs LangGraph layering; `ChatBedrockConverse` over `BedrockChat`; `withStructuredOutput` + Zod for typed JSON; Bedrock model lifecycle + inference profiles; LLM cost guardrails at three time horizons; hybrid Step Functions + LangGraph composition |
| [`bridge-brokers-at-boundaries.md`](bridge-brokers-at-boundaries.md) | recurring | ✅ filled | Pattern: external protocol meets bridge layer meets internal protocol. Applied in this project as MQTT (IoT Core) → IoT Rules Engine → Kinesis. Discusses translation-at-the-boundary, dedup placement as scale-dependent, when NOT to use the pattern. |
| _(AWS Bedrock)_ | P8 | ⬜ planned | Foundation models vs inference profiles; Converse API; pricing; model lifecycle |
| _(Model Context Protocol)_ | P8 | ⬜ planned | MCP server architecture; stdio vs HTTP/SSE transports; tool schema; Claude Desktop / Code integration |
| _(Lambda Powertools)_ | recurring | ⬜ planned | Logger, Tracer, Metrics, Idempotency utilities |
| _(DynamoDB)_ | P3 | ⬜ planned | Single-table design, partition keys, GSIs, on-demand vs provisioned |

**Stub vs filled.** A 🚧 stub note has the conceptual content,
service-specific tuning knobs framework, pitfalls, cost levers, and
learning resources — everything that's stable up-front. The TODO
sections (project-specific code anchors, CLI commands tested against
real deploys) are filled when the corresponding phase ships.

## Convention

When a phase introduces a new service, a learning note is added (or
expanded) at the same time the decision log is written. The decision log
captures *why we picked this option*; the learning note captures *what
the option even means.* Together they give future-you (and any code
reviewer) the full context.
