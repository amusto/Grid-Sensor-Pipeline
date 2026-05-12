# LangGraph Flow (Inside the Alert Handler)

> [ ↩ Back to System Overview ](./system-overview.md)

> Inside the alert handler Lambda, a three-node LangGraph state
> machine runs over Bedrock Claude Sonnet 4.6. Each node is a plain
> async function that uses Zod-typed structured output. The graph
> assembly is mechanical; the architectural decisions worth noticing
> are the layer separation (Step Functions outer + LangGraph inner)
> and the fail-soft fallback (AI is best-effort, never load-bearing).

## The three-node graph

```mermaid
flowchart TD
  Start([Alert handler invocation<br/>SensorEvent + threshold result])
  Classify["classifySeverity<br/>Bedrock + Zod<br/>output: { severity, confidence, reasoning }"]
  Route["determineRouting<br/>Bedrock + Zod<br/>output: { channels, pageOnCall, overrideApplied }"]
  Narrate["generateNarratives<br/>Bedrock + Zod<br/>output: per-channel narratives"]
  Done([Return enriched payload<br/>publish to SNS])

  Start --> Classify
  Classify --> Route
  Route --> Narrate
  Narrate --> Done
```

## Fail-soft fallback

```mermaid
flowchart TD
  Invoke["alertGraph.invoke(event)"]
  Try{"any node throws?"}
  Success["Enriched SNS payload<br/>severity + routing + narratives"]
  Fallback["BedrockFallback metric +1<br/>Phase 5 deterministic JSON<br/>(structured fields only)"]
  SNS([SNS publish — always happens])

  Invoke --> Try
  Try -->|no| Success
  Try -->|yes| Fallback
  Success --> SNS
  Fallback --> SNS

  classDef emph fill:#fef2f2,stroke:#dc2626,stroke-width:2px
  class Fallback emph
```

## What's interesting about this view

> - **Step Functions outer + LangGraph inner.** Step Functions for the
>   durable workflow (audit + Wait + retry across long timescales);
>   LangGraph for the agentic decisioning inside one Lambda invocation
>   (low-latency, ephemeral, multi-LLM-call). Composition at different
>   layers — each at the layer where it's strongest.
> - **Each node is a plain async function.** No special LangGraph
>   plumbing inside the nodes; they wrap calls to `invokeStructured`
>   from `lib/llm-client.ts`. Easy to unit-test in isolation; LangGraph
>   only does the orchestration.
> - **Zod-typed structured output.** Every LLM call returns a parsed,
>   validated object. Schema bounds (severity enum, confidence in [0,1],
>   reasoning length 10-500 chars) act simultaneously as type contract,
>   runtime check, and *cost lever* (length bounds cap output tokens).
> - **Fail-soft is the load-bearing pattern.** If any node throws
>   (Bedrock error, parse failure, schema violation), the handler
>   increments `BedrockFallback` and emits Phase 5's deterministic JSON
>   payload. The alert ALWAYS reaches SNS. AI-generated content is a
>   quality improvement, not a precondition for notification.

## Cost guardrails at three time horizons

```mermaid
flowchart LR
  PerCall["Per-call cap<br/>maxRetries: 1 in LangChain client<br/>(spend bounded per invocation)"]
  PerWindow["Per-window alarm<br/>BedrockTokens-Runaway<br/>Sum > 1M tokens / 60min → SNS"]
  PerOutput["Per-output schema bound<br/>Zod length limits per channel narrative<br/>(slack ≤280, email ≤1200, etc.)"]

  PerCall --> Combined((Bounded LLM cost<br/>at three horizons))
  PerWindow --> Combined
  PerOutput --> Combined
```

## Related

- Decision log: [`../decisions/phase-08-ai-ml-integration.md`](../decisions/phase-08-ai-ml-integration.md) — the seven pre-flight decisions plus the Anthropic use-case-gate deploy lesson.
- Learning note: [`../learning/langchain-langgraph.md`](../learning/langchain-langgraph.md) — primitives, pitfalls, interview framing.
- Drill in next: [MCP server](./mcp-server.md) — how the same data is exposed to external LLM agents as read-only tools.
