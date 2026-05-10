# LangChain + LangGraph + Bedrock — Composing LLM Calls in a TypeScript Lambda

> **Status: filled (P8.2 complete; P8.3-P8.5 in progress)** — written
> alongside `src/lib/llm-client.ts` and `src/lib/severity-classifier.ts`.
> Updated as later P8 sub-phases ship LangGraph assembly + the alert
> handler integration.

> **Where this is anchored in the project:**
> - `src/lib/llm-client.ts` — the wrapper around `ChatBedrockConverse`.
> - `src/lib/severity-classifier.ts` — the first node, currently a plain
>   async function (graph assembly happens at P8.5).
> - `infra/lib/alert-workflow-stack.ts` — IAM grant + `BEDROCK_MODEL_ID`
>   env var as the single source of truth.
> - `infra/lib/observability-stack.ts` — `BedrockTokens-Runaway` alarm.
> - `docs/decisions/phase-08-ai-ml-integration.md` — the seven
>   pre-flight decisions this implementation realizes.

---

## Mental model

LangChain and LangGraph operate at **different layers of abstraction**
over the same underlying LLM API:

- **LangChain** is a "model-agnostic SDK" — it gives you typed wrappers
  over any LLM provider (Bedrock, Anthropic direct, OpenAI, Cohere,
  etc.) plus primitives like prompt templates, output parsers, and
  retry policies. *Single calls.*
- **LangGraph** is a "graph runtime over LangChain" — it gives you a
  way to compose multiple LangChain calls into a directed graph where
  state flows between nodes and edges can branch on that state.
  *Multi-call orchestration.*

The third layer — **Bedrock** — is the AWS-managed inference endpoint
underneath. Within Bedrock there are two further layers:
- **Foundation models** — the canonical model identifiers
  (`anthropic.claude-sonnet-4-6`).
- **Inference profiles** — cross-region routing wrappers
  (`us.anthropic.claude-sonnet-4-6`). Newer Anthropic models on Bedrock
  are *only* invocable through inference profiles.

Picture the stack:

```
┌────────────────────────────────────────────────┐
│ LangGraph: graph state, edges, multi-node flow │  ← P8.5 wires this
├────────────────────────────────────────────────┤
│ LangChain: prompt templates, parsers, retries  │  ← lib/llm-client.ts
├────────────────────────────────────────────────┤
│ Bedrock SDK: ChatBedrockConverse runtime       │  ← inside @langchain/aws
├────────────────────────────────────────────────┤
│ Inference profile: us.anthropic.claude-...     │  ← cross-region routing
├────────────────────────────────────────────────┤
│ Foundation model: anthropic.claude-sonnet-4-6  │  ← actual LLM
└────────────────────────────────────────────────┘
```

Each layer is independent: swapping the model is a constant change;
swapping the SDK requires a new client wrapper; swapping LangChain
for a hand-rolled SDK call would mean reimplementing prompt
templates + parsers + retries by hand.

---

## Core concepts

### `ChatBedrockConverse` — the right client class

`@langchain/aws@^1.x` exports several Bedrock client classes. The one
to use is `ChatBedrockConverse`, **not** `BedrockChat`.

| Class | Backing API | Status |
|---|---|---|
| `BedrockChat` | Per-model legacy invoke (with `anthropic_version` wrapper, model-family-specific request bodies) | Deprecated in @langchain/aws v1+ — not exported |
| `ChatBedrock` | Same as above, renamed | Same |
| `ChatBedrockConverse` | Bedrock Converse API — unified invoke, abstracts model-family request shapes | **Current** |

The Converse API was introduced in 2024 to give Bedrock callers a
single request shape that works across all model families. With it,
swapping `anthropic.claude-sonnet-4-6` for `meta.llama-3.3-...` or
`amazon.titan-...` is just an env-var change — no code modification
of the request body wrapper.

### `withStructuredOutput` + Zod — typed JSON from LLMs

LangChain's modern way to extract structured data from a chat model
is `withStructuredOutput(schema)`. Pass a Zod schema; LangChain
internally converts it to whatever the model needs (Anthropic
tool-use schema, OpenAI function-calling schema, etc.) and validates
the response against that schema.

```ts
import { z } from 'zod';

const severitySchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(10).max(500),
});

const model = new ChatBedrockConverse({
  region: 'us-east-1',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxRetries: 1,
});

// `includeRaw: true` returns { raw: AIMessage, parsed: T } so we can
// extract token usage from raw.usage_metadata for cost metrics.
const structured = model.withStructuredOutput(severitySchema, {
  includeRaw: true,
});

const { raw, parsed } = await structured.invoke([
  new SystemMessage('You are a severity classifier...'),
  new HumanMessage('Sensor: ... value: 109V ...'),
]);
// parsed is the typed Severity object
// raw.usage_metadata gives us { input_tokens, output_tokens, total_tokens }
```

The Zod schema serves three purposes simultaneously:
1. **Type generation** — `z.infer<typeof severitySchema>` gives us
   the TypeScript type, no separate interface needed.
2. **Runtime validation** — LangChain converts it to a model-side
   schema (tool-use schema for Anthropic) so the model is *constrained*
   to produce conforming output.
3. **Test bounds** — unit tests can reuse the same schema to assert
   that mock outputs fall within the contract.

### LangGraph state + nodes (preview, formalized at P8.5)

LangGraph nodes are functions that take a state object and return an
update to that state. Edges between nodes are either static (always
go from A to B) or conditional (read state, route accordingly).

Our graph (P8.5):

```
       ┌──────────────────────┐
       │ classifySeverity     │  → state.severity = 'P1'
       └──────────────────────┘
                  ↓
       ┌──────────────────────┐
       │ determineRouting     │  → state.routing = { channels: [...] }
       └──────────────────────┘
                  ↓
       ┌──────────────────────┐
       │ generateNarratives   │  → state.narratives = { slack: ..., email: ... }
       └──────────────────────┘
                  ↓
            (return to Step Functions)
```

LangGraph's value over a hand-rolled `await classify(); await route();
await narrate();` chain is:
- **State as first-class** — each node reads and writes to a typed
  state object, not function parameters.
- **Conditional edges** — *"if severity == P0 then go to pageOnCall;
  else go to slackOnly"* maps to a graph edge, not nested if/else.
- **Built-in retry per node** — independent of the maxRetries on the
  underlying model.
- **Tracing** — every node emits structured events, threadable into
  CloudWatch / OpenTelemetry.

### Cost guardrails — embedded at the right layer

Three cost guardrails, each at the layer where it can be enforced:

1. **`maxRetries: 1` at the LangChain client** — caps any single
   invocation's parse-failure spiral. A bug in the schema or a
   model returning malformed JSON can't 10× the spend.
2. **`BedrockTokens-Runaway` CloudWatch alarm** — sums token
   usage across the alert handler in a 60-minute window. Catches
   *aggregate* runaway (graph-level loop, traffic spike, prompt
   bloat) regardless of per-call retry caps.
3. **Bounded prompt + bounded output** in the schema (`reasoning:
   z.string().min(10).max(500)`) — caps per-call output token
   count. Defense in depth.

These three together bound cost at three time horizons: per call
(retry cap), per hour (alarm), per output (schema bounds).

---

## Why these tools, against alternatives

### Why LangChain instead of raw `@aws-sdk/client-bedrock-runtime`?

- **Prompt templates as code** — `PromptTemplate` is a TS object with
  named slots. Substitution is type-checked. Prompts evolve under
  source control like any other code.
- **Output parsers** — `withStructuredOutput(schema)` handles
  prompt augmentation + parsing + retry automatically. The raw SDK
  would require hand-rolled JSON parsing + Zod parsing + retry on
  every call.
- **Trace events** — LangChain emits per-step events; the raw SDK
  emits one event per `InvokeModel` call.
- **JD requires it.** The role specifically names "agentic workflows
  (LangChain/LangGraph)" as a required skill.

### Why LangGraph instead of a hand-rolled state machine in TypeScript?

- **Conditional edges read like the spec.** "If P0, page; if P3,
  slack only" maps cleanly to a graph edge, not a nested if-else
  chain.
- **State scaffolding** — typed state object, validated at each node
  boundary.
- **Per-node retry policies** — independent of the LLM client's retry.

For a 3-node flow, hand-rolling is feasible. For 5+ nodes with
conditional branching, LangGraph saves significant ceremony and
keeps the *shape* readable.

### Why hybrid Step Functions + LangGraph, not one or the other?

This is the architectural decision recorded in
`phase-08-ai-ml-integration.md` pre-flight 1. Summary:

| | Step Functions | LangGraph |
|---|---|---|
| Persistence | 90-day execution history | Ephemeral (one Lambda invocation) |
| Cost per node | Per-transition (~$0.025/1k transitions) | Free (in-Lambda) |
| Wait state | First-class (free) | Not supported — would need polling |
| Audit | Native (execution history is the audit log) | Requires explicit logging |
| Tooling | AWS console + CLI | LangSmith / OTLP |

**Step Functions is the durable outer workflow** (audit + Wait + retry
across long timescales). **LangGraph is the agentic decisioning
inside one task** (low-latency, ephemeral, multi-LLM-call).
Composition over replacement.

---

## Practical pitfalls

### 1. Bedrock model lifecycle — models retire

Anthropic publishes successive model generations on Bedrock. Older
models retire within ~12-18 months. Symptom: `ResourceNotFoundException:
This model version has reached the end of its life`. Recovery: list
active models, pick the current Sonnet/Opus/Haiku, update both
`BEDROCK_MODEL_ID` constant **and** the IAM ARN derived from it.

This was hit on Day 3 (May 2026) when the original
`anthropic.claude-3-5-sonnet-20241022-v2:0` was retired. The
single-source-of-truth pattern in `alert-workflow-stack.ts` (one
constant powering both env var and ARN) made the swap a one-place
change.

### 2. Inference profiles — bare model IDs may not work

Newer Anthropic models on Bedrock require invocation through
**cross-region inference profiles**. Symptom: `ValidationException:
... isn't supported with on-demand throughput. Retry your request
with the ID or ARN of an inference profile that contains this model.`

Recovery: list inference profiles, use the matching `us.*` (or
`global.*`) profile id. The IAM grant needs **two ARNs**: the
profile ARN + the foundation-model ARN with `*` for region (the
profile may route to any US region; the principal needs permission
on the model in any of them).

### 3. `usage_metadata` field-name drift

LangChain's typing on the AIMessage's usage field has changed across
minor releases. Both `usage_metadata` (v1+) and
`response_metadata.usage` (older) have been observed. `lib/llm-client.ts`
handles both via a `extractTokens(raw)` helper that tries each in
order. If you see `BedrockTokensUsed = 0` despite real invocations
landing, something else has changed about the shape — log `raw` for
one call and update the helper.

### 4. Lambda bundle-size jump at integration

`@langchain/core` + `@langchain/aws` add ~1-2 MB to the bundle
unminified, ~400-600 KB after esbuild minification. Lambda's hard
limit is 250 MB unzipped, so we're nowhere near a ceiling, but cold
start latency goes up by ~200-500 ms. Worth measuring at P8.5
(post-deploy) and adding to the deploy lessons if it regresses
materially.

### 5. ESM vs CJS bundling

LangChain v1+ ships dual ESM/CJS exports. esbuild handles this
correctly with `format: nodejs.OutputFormat.CJS` and Node 20 runtime
(both already set in `alert-workflow-stack.ts`). If you see "Cannot
use import statement outside a module" at deploy time, check that
the bundling config didn't drift to ESM-only.

### 6. Prompt rubric anchoring matters more than temperature

The system prompt for `severity-classifier.ts` has explicit deviation
magnitudes tied to NERC bands ("frequency >2 Hz outside band → P0").
Without those anchors, the model classifies inconsistently across
invocations on similar inputs — temperature tuning doesn't fix this,
prompt structure does. The pattern: **give the model the same
anchors a human expert would use.**

---

## Did I actually learn this?

Self-test gates — close the file and try to answer these from
memory before peeking:

1. *Why ChatBedrockConverse instead of BedrockChat?* (Answer: model-
   family-agnostic Converse API; current Sonnet wouldn't work via the
   legacy class anyway.)
2. *What does the `withStructuredOutput` `{ includeRaw: true }` flag
   give us that the default doesn't?* (Answer: access to the AIMessage
   for token-usage extraction.)
3. *Why does the IAM grant include the foundation-model ARN with `*`
   for region in addition to the inference-profile ARN?* (Answer: the
   profile dispatches to one of N US regions at invoke time; the
   principal needs permission on whichever region the call lands in.)
4. *What's the difference between `maxRetries: 1` on the LangChain
   client and the `BedrockTokens-Runaway` CloudWatch alarm?* (Answer:
   per-call vs aggregate-window cost guardrails. Different time
   horizons, different failure modes — graph-level retry loops can
   evade the per-call cap but trip the aggregate alarm.)
5. *Why is Step Functions the outer workflow with LangGraph inside,
   not the reverse?* (Answer: durability + Wait state + 90-day audit
   are first-class in Step Functions and ephemeral in LangGraph.
   Audit needs the durable layer.)
6. *Where does the `BEDROCK_MODEL_ID` env var come from, and why
   does its name say "model id" when it actually holds an inference
   profile id?* (Answer: it's the constant in
   `alert-workflow-stack.ts`; the InvokeModel API parameter is named
   `modelId` and accepts either form.)

---

## Cross-references

- `docs/decisions/phase-08-ai-ml-integration.md` — the seven
  pre-flight decisions this implementation realizes.
- `docs/_private/scope-alignment-reactive-vs-predictive.md` — what
  this AI layer does NOT cover (predictive forecasting), and three
  options to extend if scope opens.
- `docs/learning/cdk-as-typed-model.md` — the same single-source-of-
  truth pattern we use for `BEDROCK_MODEL_ID` (one constant powering
  both env var and IAM ARN — they can never silently drift).
- `docs/learning/_design-patterns-index.md` — should be updated with
  "LLM cost guardrails at three time horizons" when this note's
  patterns are linked across the catalog.
