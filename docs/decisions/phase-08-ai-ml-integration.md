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

## P8 pre-flight 2 — Claude Sonnet 4.6 via Bedrock (cross-region inference profile)

**Concept.** Pick the model whose cost/quality tradeoff fits the task,
not the cheapest or the most-capable. When the platform's invocation
surface evolves (bare model ID → inference profile), follow it
deliberately rather than fighting it.

**Decision.** Anthropic Claude Sonnet 4.6 via AWS Bedrock,
invoked through the **US cross-region inference profile**
(`us.anthropic.claude-sonnet-4-6`). The underlying foundation model is
`anthropic.claude-sonnet-4-6`. Used for both classification reasoning
and narrative generation in the LangGraph alert flow.

**Why an inference profile, not a bare model ID.** Current-generation
Anthropic models on Bedrock ship behind cross-region inference
profiles only — `InvokeModel` against the bare foundation-model ID
returns `ValidationException: ... isn't supported with on-demand
throughput`. The profile transparently routes calls among US regions
for resilience. Discovered during P8.1 invocation test; recorded so
the next person debugging this doesn't have to re-derive it.

**`us.` vs `global.` profile.** The `us.` prefix routes only among US
regions; `global.` routes worldwide. Chose `us.` for two reasons:
the workload is US grid telemetry (data-residency conservatism), and
our deploy region is `us-east-1` so the global profile would offer no
latency win.

**Alternatives.**
- **Claude Haiku 4.5** — cheaper, faster. Good for classification but
  loses some nuance on narrative quality. **Worth revisiting in P8.4
  as a cost optimization** — the pattern would be Sonnet for the
  narrative node, Haiku for classification + routing nodes (split by
  task complexity, not by uniform model choice). Captured as a
  future-state note; not the MVP shape.
- **Claude Opus 4.5 / 4.6 / 4.7** — flagship tier, higher quality on
  hard reasoning tasks but ~3-5× the cost of Sonnet. Overkill for
  threshold-breach narrative generation.
- **Claude Sonnet 4 / 4.5** — older Sonnet generations still active in
  Bedrock. Picked the latest because it's both current and uses the
  cleaner naming convention (no date suffix); easier to defend in
  interview as "current state" rather than "I locked in a version
  during the build."
- **Llama 3.1 70B Instruct** — open-weight, cheaper than Sonnet,
  competitive on many benchmarks. Less polished output.
- **Amazon Titan Text** — cheapest, AWS-native. Quality ceiling lower
  than Anthropic / Llama for narrative tasks.
- **GPT-4 / Claude direct (not via Bedrock)** — better models in some
  benchmarks; not relevant since we're committed to Bedrock for the
  JD requirement.

**Why Sonnet (the tier, regardless of generation).**
- The narrative task *is* the user-facing portion of the alert. Its
  quality is what an operator sees. Worth the marginal token cost.
- Sonnet is the default-good choice — the model an experienced
  engineer would pick *unless* a specific cost or latency constraint
  forced something cheaper.
- Demonstrates familiarity with Bedrock's flagship Anthropic model.

**Cost lens.** Sonnet 4.6 pricing on Bedrock should be verified at
deploy time against [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/);
order-of-magnitude estimate carried over from the prior generation
($3/MTok input + $15/MTok output) puts a typical breach narrative
(~500 input + ~300 output) at ~$0.006 per alert and ~$6/month at
1000 alerts/month. Even if the new-generation rates are 50% higher,
production-volume cost is still negligible. The runaway-cost alarm
in P8.2 (`BedrockTokens-Runaway`, > 1M tokens / hour → SNS) is the
real cost guardrail, not the per-token rate.

**Tradeoff accepted.** Sonnet is ~5× more expensive than Haiku. If
alert volume grew 100× (production scale), worth re-evaluating —
classification could move to Haiku 4.5, narrative could stay Sonnet
4.6. Captured for P8.4 review.

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

## P8 pre-flight 7 — IAM scope: minimum-privilege for Bedrock (inference profile pattern)

**Decision.** Alert handler's IAM role grants `bedrock:InvokeModel` on
**two** ARNs — the inference profile and the underlying foundation
model — and nothing else. No wildcards.

```
Effect: Allow
Action: bedrock:InvokeModel
Resource:
  - arn:aws:bedrock:us-east-1:<account>:inference-profile/us.anthropic.claude-sonnet-4-6
  - arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6
```

**Why two ARNs.** Invoking an inference profile dispatches to one of N
underlying foundation-model invocations (the profile chooses the
region at call time). The principal needs permission on both surfaces
or the call fails with `AccessDeniedException` mid-dispatch. This is
the IAM shape AWS docs prescribe for the inference-profile pattern;
it isn't us being defensive.

**Why the unusual ARN shapes.**
- **Inference profile ARN includes the account ID** — profiles are
  per-account resources.
- **Foundation model ARN has an empty account-id slot** (`::`) — the
  model itself is AWS-managed, not owned by any caller's account.
- **Region on the foundation model ARN is `*`** — required so the
  profile can route the call to whichever US region it picks at
  invoke time. Restricting to `us-east-1` would break the profile's
  cross-region failover.

The wildcard region on the foundation-model ARN looks lax at first
glance; it's actually still least-privilege because the *model ID*
is pinned. The principal can call this one model in any US region —
no other models, no other actions.

**Why specific (general principle).**
- A wildcard `bedrock:*` grant would also allow `CreateModel`,
  `DeleteModel`, `CreateGuardrail`, etc. Not needed; least privilege.
- A wildcard `bedrock:Invoke*` would allow invoking *any* foundation
  model in the account — silently expensive surprise if a future
  developer drops in `claude-opus-4-7` thinking the IAM grant covers
  it.
- The CDK `BEDROCK_MODEL_ID` constant + the IAM ARN derived from it
  are linked at synth time, so the "what we call" and "what we're
  allowed to call" can never silently drift.

**Test that locks this down.** A defense-in-depth template assertion
in `infra/__tests__/alert-workflow-stack.test.ts` walks every IAM
policy in the synthesized template and asserts that no `bedrock:*`
action other than `bedrock:InvokeModel` appears anywhere. If a future
edit accidentally widens the grant, the test fails.

**Cost lens.** No cost difference. Defense in depth.

---

## Deploy lessons — real-world snags captured at production-shape invocation

> Captured from the actual P8.5 deploy on Day 4. Each is a defensible
> interview talking point about Bedrock production-flow gotchas that
> aren't obvious from the AWS docs alone but surface immediately when
> real Lambda invocations hit the API.

### 1. Production-shape invocation surfaces use-case gates that exploratory invocation may bypass

**What happened.** Day 3 morning, an `aws bedrock-runtime invoke-model`
CLI test from the user's own IAM credentials succeeded — returned a
real Claude Sonnet 4.6 response. That looked like full account-wide
approval.

Day 4 afternoon, after P8.5 deployed and the simulator drove three
concurrent breaches into the alert handler Lambda, every Bedrock
invocation failed with:

```
Model use case details have not been submitted for this account.
Fill out the Anthropic use case details form before using the model.
If you have already filled out the form, try again in 15 minutes.
```

The IAM grant on the alert handler's role was correct (verified via
`aws iam get-role-policy` post-deploy). The model ID was correct
(invocable by the same user from CLI). What failed wasn't IAM and
wasn't model identification — it was **Anthropic's account-level
use-case gate**.

**Why CLI succeeded but Lambda failed.** Two plausible mechanisms,
neither documented clearly by AWS:

1. **First-call grace** — exploratory CLI invocations may get one
   pass before the formal gate kicks in. Production-shape repeated
   invocation triggers the formal review.
2. **Asynchronous review window** — the use-case form may have been
   auto-submitted on first CLI invocation but not yet approved by the
   time the Lambda fired hours later. The error's own hint —
   *"try again in 15 minutes"* — points at this.

Either way, the operational signal is: **a one-off CLI success is
not a guarantee that production-shape calls will succeed.** Anthropic
treats them differently.

**Fix.** In the Bedrock console, find and submit the Anthropic
use-case details form explicitly. The form is the same one we'd have
filled out in the old (pre-2025) Model Access flow:

- Industry: energy / IoT
- Use case: internal IoT sensor anomaly narratives
- Geography: US
- End users exposed to model output: no
- High-risk use cases (PII, decisions about people): no

Approval is typically minutes to a few hours for non-suspicious use
cases. Once approved, the next Lambda invocation succeeds and the
LangGraph happy path is live.

**The fail-soft path is what proved itself first.** Because the alert
handler wraps the LangGraph in try/catch with a deterministic-payload
fallback (per pre-flight 6), all three failed Bedrock invocations
still resulted in successful SNS notifications. `BedrockFallback`
metric incremented; `AlertsNotified` metric incremented; alerts
reached operators via the structured Phase 5 shape. **The hardest
path to test — fail-soft under real Bedrock failure — was verified
without us having to break anything deliberately.**

**Pattern lesson — adopt this as a default operational habit:**

> When wiring a managed model service into production code, submit
> the provider's use-case forms *before* the first production-shape
> invocation, not after. CLI exploratory testing is not a proxy for
> production-shape readiness. Plan for the gate to surface at deploy
> time, not at CLI test time.

**Recurrence prevention.** Document this gate alongside the IAM
grant in the alert workflow stack's CDK file (cross-reference the
Bedrock console form URL in a comment). Anyone redeploying the
project from scratch in a new AWS account will hit this gate and
needs the breadcrumb.

**Cost lens.** Form submission is free. The cost of *not* submitting
proactively is one to several hours of deploy delay between the
failed-Bedrock observation and the eventual approval — fine for a
POC, expensive for a production rollout where alerts may be queueing.

### 2. LangChain bundle is ~11× larger than the bare alert handler — measure cold-start before assuming it's fine

**What happened.** Pre-P8.5, the alert handler bundle was 93 KB
minified. Post-P8.5 (after importing `@langchain/core`,
`@langchain/aws`, and `@langchain/langgraph`), the bundle is 1.0 MB
minified. esbuild handled the bundling cleanly via the existing CJS
config — no errors, no warnings beyond CDK's informational "FYI this
is over 1MB" notice.

**Cold-start impact.** First-deploy invocations measured
`Init Duration: 541-587 ms` across three concurrent invocations.
That's well within reason (Lambda's 30-second default timeout leaves
plenty of headroom), but it is a measurable jump from the pre-P8.5
~150 ms cold start.

**Pattern lesson.** **The first cold start after a meaningful
dependency change is the moment to measure cold-start latency — not
the moment to assume it's fine.** Capture the number in the
ROADMAP daily log. If it ever regresses materially (~2× current
or beyond) on a future dependency bump, that's a deploy lesson in
its own right.

**Cost lens.** Cold start is billed wall-clock duration; the
init-duration increase from ~150 ms to ~550 ms adds ~400 ms of
billed time per cold container. At realistic alert volume (a few
per hour), the lifetime cost difference is fractional cents per
month. Not a concern; just worth measuring.

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
