# Phase 8 — AI/ML Integration

Status: **pre-flight**. Adds AWS Bedrock, LangChain, LangGraph, and an
MCP server to the pipeline. Closes the gap between the portfolio
entry's claims (*"Bedrock-powered alert narratives and an MCP server
interface"*) and what's actually shipped.

Phase 8 is the **AI core**. Phase 9 extends it with agentic case
routing and external system tool calls. The split keeps each phase
focused.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P8 pre-flight 1 — Hybrid: Step Functions outer + LangGraph inner

**Concept.** Step Functions and LangGraph sit at different layers of
abstraction. Compose them at the layer each excels at; don't replace
one with the other.

**Decision.** Phase 5's Step Functions Standard Workflow stays as the
durable, auditable outer workflow (CLAUDE.md hard rule #10). Phase 8
adds LangGraph *inside* the alert handler Lambda — invoked by the
existing `NotifyOps` task — for the agentic decisioning logic
(severity classification, channel selection, narrative generation).

**Alternatives rejected.**
- **Replace Step Functions with LangGraph entirely.** Loses 90-day
  execution history, free wait state, per-step retry — all required
  for the safety-critical alert workflow.
- **Keep Step Functions; do all LLM work as raw `bedrock:InvokeModel`
  calls inside the Lambda.** Works, but loses the agentic-flow shape
  (multi-node graph with conditional edges, retry-aware nodes,
  structured output parsing). LangGraph IS the value-add.

**Why hybrid.**
- **Durability differs.** Step Functions execution state persists for
  90 days; LangGraph state is ephemeral (lives during one Lambda
  invocation). Audit needs the durable layer.
- **Cost shape differs.** Each Step Functions transition is billable.
  A 5-node LangGraph flow inside one Lambda invocation = 1 Step
  Functions transition, not 5.
- **Latency differs.** Step Functions transitions are 20-50ms each;
  LangGraph nodes are sub-millisecond between nodes.
- **Audit boundary alignment.** Step Functions logs *what* (workflow
  shape); LangGraph logs *how* (LLM reasoning at each node). Two
  layers at the right granularity.

**Cost lens.** No additional Step Functions cost (same one task
invocation). LangGraph is in-Lambda; cost is Lambda time + Bedrock
tokens. At alert volume (a few/hour), token cost is < $1/month.

**Tradeoff accepted.** Two technologies in one alert path adds
conceptual complexity. Mitigation: this decision log + the new
`langchain-langgraph.md` learning note + the cdk-as-typed-model note
all explain the layering explicitly.

---

## P8 pre-flight 2 — Claude 3.5 Sonnet via Bedrock

**Concept.** Pick the model whose cost/quality tradeoff fits the task,
not the cheapest or the most-capable.

**Decision.** Anthropic Claude 3.5 Sonnet via AWS Bedrock
(`anthropic.claude-3-5-sonnet-20241022-v2:0`). Used for both
classification reasoning and narrative generation.

**Alternatives.**
- **Claude Haiku** — cheaper (~5× less per token), faster. Good for
  classification but loses some nuance on narrative quality.
- **Llama 3.1 70B Instruct** — open-weight, cheaper than Sonnet,
  competitive on many benchmarks. Less polished output.
- **Amazon Titan Text** — cheapest, AWS-native. Quality ceiling lower
  than Anthropic / Llama for narrative tasks.
- **GPT-4 / Claude direct (not via Bedrock)** — better models in some
  benchmarks; not relevant since we're committed to Bedrock for the
  JD requirement.

**Why Sonnet.**
- The narrative task *is* the user-facing portion of the alert. Its
  quality is what an operator sees. Worth the marginal token cost.
- Sonnet is the default-good choice — the model an experienced
  engineer would pick *unless* a specific cost or latency constraint
  forced something cheaper.
- Demonstrates familiarity with Bedrock's flagship Anthropic model.

**Cost lens.** Sonnet on Bedrock: $3/MTok input + $15/MTok output. A
typical breach narrative: ~500 input tokens + ~300 output tokens =
$0.006 per alert. At 1000 alerts/month = $6/month. Negligible.

**Tradeoff accepted.** Sonnet is ~5× more expensive than Haiku. If
alert volume grew 100× (production scale), worth re-evaluating —
classification could move to Haiku, narrative could stay Sonnet.

---

## P8 pre-flight 3 — LangChain over raw SDK

**Concept.** Use the abstraction layer that gives you observable
structure when the underlying API is generic enough to obscure intent.

**Decision.** Wrap Bedrock calls in `langchain` (`@langchain/core`,
`@langchain/aws`) for prompt templates, output parsers, and retry
behavior. Don't call `BedrockRuntimeClient.send(InvokeModelCommand)`
directly.

**Alternatives.**
- **Raw `@aws-sdk/client-bedrock-runtime` SDK** — works, but every
  prompt becomes a string template hard-coded into the handler.
  Output parsing is per-call ad-hoc. Retry/timeout logic is
  hand-rolled.
- **Lighter-weight prompt libraries** (e.g., promptfoo) — none match
  LangChain's ecosystem maturity for the JD's specific naming.

**Why LangChain.**
- **Prompt templates as code.** A `PromptTemplate` is a TS object with
  named slots; substitution is type-checked. Prompts evolve under
  source control just like any other code.
- **Output parsers.** Structured JSON output (e.g., a Zod-validated
  classification result) goes through a parser that retries on
  malformed responses. Without LangChain, every call needs hand-
  rolled JSON parsing + validation + retry.
- **Observable surface.** LangChain emits trace events for every
  prompt/parse/retry step. Wires to LangSmith / OpenTelemetry / CloudWatch.
- **JD requires it.** *"Production experience with... LangChain/LangGraph"*
  literally names this library.

**Cost lens.** LangChain itself is free. Bundle size adds ~200KB to
the Lambda (acceptable; Lambda Node 20 has 250MB unpacked limit).

**Tradeoff accepted.** Adds an abstraction layer. For a single LLM
call, LangChain is overkill. For the project's planned multi-node
LangGraph flow with multiple prompts and structured outputs, the
ecosystem fit is strong.

---

## P8 pre-flight 4 — LangGraph for the agentic alert flow

**Concept.** When workflow logic includes LLM judgment with branching,
multiple iterations, or tool calls, use a graph framework. Don't
hand-roll the state machine.

**Decision.** Use `@langchain/langgraph` for the agentic flow inside
the alert handler. Five-node graph:

```
Node 1: Classify breach severity (LLM + tools)
        ↓
Node 2: Determine routing strategy (LLM, structured output)
        ↓
Node 3: Generate channel-specific narratives (LLM)
        ↓
Node 4: Execute tools (parallel where possible) ← Phase 9 expands this
        ↓
Node 5: Persist case linkage (idempotency-aware) ← Phase 9 ships
```

**Alternatives.**
- **Hand-rolled state machine in TS.** Works for a 3-node flow; gets
  tangled at 5+ nodes with conditional edges and retry policies.
- **Step Functions micro-states for the agentic flow.** Tried mentally
  — would 5x the per-alert state-transition cost and lose the in-
  Lambda speed advantage.
- **LangChain alone (no LangGraph).** LangChain handles single-prompt
  chains well; for graph-shaped logic with multiple LLM calls and
  state mutation, LangGraph is the right primitive.

**Why LangGraph specifically.**
- **State as first-class.** Node outputs flow into the graph state
  object; conditional edges read state to choose next node. Cleaner
  than passing variables.
- **Conditional edges.** "If severity == P0 then page; if severity
  == P3 then notify-only" maps directly to graph edges, not nested
  if/else.
- **Built-in retry per node.** A node that calls an LLM can have its
  own retry policy independent of other nodes.
- **Tracing.** LangGraph emits per-node events that thread into
  LangSmith/OTLP for forensic debugging.
- **JD requires it.**

**Cost lens.** LangGraph is free. Adds ~150KB to the bundle.

**Tradeoff accepted.** Graph state needs to be defined as a typed
schema (Zod or TypeScript interface) — adds a layer of definition
ceremony. Worth it for the resulting clarity.

---

## P8 pre-flight 5 — MCP server: read-only tools for query API

**Concept.** Expose the project's read APIs as MCP tools so any MCP
client (Claude Desktop, Claude Code, custom agents) can interact with
the system via natural language.

**Decision.** Build a stdio-transport MCP server (Node) that exposes
three tools:

| Tool | Purpose |
|---|---|
| `query_sensor_readings` | Wraps `GET /sensors/{id}/readings`. Path/query params as MCP arguments |
| `query_recent_breaches` | Composite: scans readings table for out-of-range values, returns recent breaches |
| `get_alert_history` | Lists Step Functions executions in a time window |

All three are **read-only**. Phase 9 adds write tools for case
management.

**Alternatives.**
- **HTTP/SSE transport** — production-grade for hosted MCP servers;
  more setup. Stdio is fine for local dev (Claude Desktop, Claude
  Code) and is the simplest demonstration.
- **Skip MCP entirely** — leaves the JD's *"tool integrations (Model
  Context Protocol)"* requirement unmet. Not an option.

**Why stdio for the POC.**
- Claude Desktop and Claude Code both connect to local stdio MCP
  servers via JSON config. Zero hosting infrastructure.
- Demonstrates the protocol correctly; production HTTP/SSE deployment
  is documented in the learning note.
- The MCP server is a Node script users run on demand; deploy is
  `npm run mcp`.

**Cost lens.** Zero AWS cost. Local CPU cycles only.

**Tradeoff accepted.** Local-only means no shared MCP server endpoint
for remote agents. Production migration path: deploy as Lambda
behind API Gateway with HTTP/SSE transport. Documented in
`mcp-protocol.md`.

---

## P8 pre-flight 6 — Fallback when Bedrock errors: emit JSON narrative

**Concept.** AI-generated content is best-effort, never load-bearing.
The alert must propagate even if Bedrock is unavailable.

**Decision.** If any LangGraph node throws (Bedrock unavailable,
LangChain parse error, model timeout), the alert handler logs the
failure, increments a `BedrockFallback` metric, and emits the
existing JSON SNS payload (from Phase 5).

**Why fail-soft.**
- The alert workflow's correctness contract is: *every breach
  produces a notification*. AI-generated narrative is a quality
  improvement, not a precondition.
- A Bedrock outage shouldn't block grid alerts.

**Cost lens.** Adds one CloudWatch metric and a few lines of
fallback code. Saves the cost of a missed alert.

**Tradeoff accepted.** Operators get a less-readable JSON payload
during Bedrock outages. Acceptable; the structured fields are still
machine-parseable.

---

## P8 pre-flight 7 — IAM scope: minimum-privilege for Bedrock

**Decision.** Alert handler's IAM role grants `bedrock:InvokeModel` on
exactly the model ARN we use (`arn:aws:bedrock:us-east-1::foundation-
model/anthropic.claude-3-5-sonnet-20241022-v2:0`). Not a wildcard.

**Why specific.**
- Enabling Bedrock on a new account requires explicit model access
  request. The IAM resource ARN reflects this.
- A wildcard `bedrock:*` grant would also allow `CreateModel`,
  `DeleteModel` etc. Not needed; least privilege.

**Cost lens.** No cost difference. Defense in depth.

---

## Cross-cutting framing for Phase 8

Three durable patterns this phase encodes:

1. **Use the right tool at the right layer.** Step Functions for
   durable workflows; LangGraph for agentic decisioning inside one
   workflow task. Composition over replacement.

2. **AI-generated content is best-effort.** Fall back to deterministic
   defaults when the AI layer is unavailable. The system's correctness
   contract doesn't depend on the AI working.

3. **MCP demonstrates platform thinking.** Exposing the system's data
   APIs as MCP tools turns the project into a platform that other
   agents can build on. That's the kind of design instinct the JD's
   *"developer-facing SDKs, service contracts, platform APIs"* line
   is asking about.
