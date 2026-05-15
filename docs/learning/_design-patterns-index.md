# Design Patterns — Review Index

> **Status: living index** — updated as new patterns are introduced
> across phases. Underscore prefix sorts this near the top of
> `docs/learning/`.

A consolidated catalog of the conceptual patterns used in this project,
with anchors back to where each is defined and where each is applied.
Patterns are durable across projects and tech stacks; the
implementations are specific to this one.

---

## Why a design-patterns index exists

A design pattern is **a named solution to a recurring problem**, with
the trade-offs documented. The reason patterns matter:

1. **Recognition shortcut.** When you encounter a new problem, asking
   "is this a known pattern?" beats reinventing.
2. **Vocabulary for code review.** Saying "this is the *parse-don't-
   validate* pattern" is faster and clearer than describing it from
   scratch every time.
3. **Defensible architecture.** In an interview or design review, the
   ability to name the pattern, explain its forces, and cite the
   trade-offs you accepted is the difference between "I built X" and
   "I chose X knowing Y and Z were the alternatives."

A pattern you **understand** > a pattern you've **used**. Reviewing the
index periodically reinforces the conceptual model independent of the
specific code.

---

## When to revisit this index

| Trigger | What to look at |
|---|---|
| **Start of a new phase** | Skim the categories the phase touches; reread one pattern note in depth |
| **Before a technical interview** | Read the full index; pick 3-5 patterns you'd lead with as talking points |
| **Quarterly refresh** | Read every linked source; verify you can still explain each pattern in one breath |
| **When a code review asks "why did we do X?"** | Find the pattern; cite it by name in the response |
| **When you notice you're solving a problem that feels familiar** | Consult the index *before* writing code; you may already have a name for it |

---

## Index by category

### I/O boundary patterns

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Parse-don't-validate** | Narrow the type from `unknown` to a domain type once at the entry point; downstream code trusts the type | `docs/decisions/phase-02-processor.md` "Zod follow-up"; `docs/_private/interview-prep.md` |
| **Functional core, imperative shell** | Pure logic separated from side effects; lib/ has no I/O, handlers orchestrate I/O | `CLAUDE.md` invariants #2 + #3; applied in `src/lib/threshold.ts` |

### Idempotency and failure handling

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Defense-in-depth idempotency** | Consumer-side dedup on a stable identifier + server-side dedup on the natural key | `docs/decisions/phase-02-processor.md` pre-flight 2; `docs/_private/interview-prep.md` |
| **Fail-loud / fail-quiet asymmetry** | Fail loud on unknown errors; fail quiet only on the one error that legitimately means no-op success | `docs/decisions/phase-02-processor.md` pre-flight 2 |
| **Layered failure isolation** | Bisection + partial-failure response + retry budget + DLQ — each handles a distinct failure regime | `docs/decisions/phase-03-storage-processing.md` pre-flight 5; `docs/learning/aws-kinesis.md` ESM tuning section |
| **State outlives delivery jitter** | Idempotency / dedup state's TTL must exceed the longest possible duplicate-delivery interval | `docs/decisions/phase-02-processor.md` pre-flight 1 |
| **Belt-and-suspenders for invariants you can't afford to break** | Two independent mechanisms preserving the same invariant | `docs/decisions/phase-02-processor.md` (the conditional write on top of Powertools) |
| **Conditional-write idempotency at a new boundary** | A single DynamoDB `attribute_not_exists(pk)` primitive deployed at two boundaries (Kinesis processor + agentic-tool dispatcher); the natural-key triple is the contract; the exception is the retry signal | `docs/learning/case-management-patterns.md` pattern 1; applied in `src/lib/repository.ts` + `src/lib/cases/case-repository.ts` |
| **Partial-success failure isolation (fan-out)** | `Promise.allSettled` over N downstream targets returning a structured `{delivered, failed, skipped}` record with named buckets; one target failing never fails the operation | `docs/learning/case-management-patterns.md` pattern 2; applied in `src/lib/alert-graph.ts` `executeToolsNode` |
| **Exception-as-information (catch-and-fall-back)** | A specific exception type (e.g., `ConditionalCheckFailedException`) carries semantic content; the caller catches it as control flow into a deliberate alternate path, never as a swallowed error | `docs/learning/case-management-patterns.md` pattern 3; applied in `src/lib/alert-graph.ts` `ensureMetadata` + `dispatchChannel` |

### Cost-aware engineering

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Bounded low-cardinality dimensions** | Metric dimensions for slices, not for identifiers | `docs/decisions/phase-02-processor.md` pre-flight 3 |
| **Smallest correctness-safe TTL** | Pick the smallest TTL that satisfies correctness, not the most-conservative-feeling one | `docs/decisions/phase-02-processor.md` pre-flight 1 |
| **Right-size by load shape, not intuition** | Billing mode, shard count, memory follows load shape — bursty vs steady-state | `docs/decisions/phase-03-storage-processing.md` pre-flight 1, 2, 4 |
| **Correctness is cheaper than incident response** | Bias toward fail-loud; silent failure costs more than spurious noise | `docs/decisions/phase-02-processor.md`; `docs/_private/interview-prep.md` cost framing |
| **Cost guardrails at three time horizons** | Per-call retry cap + per-window aggregate alarm + per-output schema bounds together bound LLM (or any usage-priced) cost across short, medium, and long horizons | `docs/learning/langchain-langgraph.md` "cost guardrails"; applied in `src/lib/llm-client.ts` + `infra/lib/observability-stack.ts` `BedrockTokens-Runaway` |

### Type system & IaC patterns

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Codify invariants at the highest level the language can express them** | The defining property of typed-model IaC (CDK, Pulumi) over config-language IaC (Terraform, CFN) | `docs/learning/cdk-as-typed-model.md` "deeper concept" |
| **Single typed model spanning runtime + infrastructure** | The same TS symbol describes both runtime data shape and infrastructure inputs | `docs/learning/cdk-as-typed-model.md` |
| **Cross-stack composition via constructor props** | Not stringly-typed CFN exports — typed TS interfaces | `docs/learning/cdk-as-typed-model.md`; applied in `infra/bin/app.ts` |
| **Conditional infrastructure via optional typed props** | The "should this resource exist?" question encoded as an optional TS prop | `docs/decisions/phase-05-alert-workflow.md` pre-flight 6; applied in `infra/lib/iot-stack.ts` |
| **Inline policies for create-time auth** | When a service needs IAM permissions to call another resource at create-time, prefer inline policies in role constructor over post-hoc `grant*` calls | `docs/decisions/phase-03-storage-processing.md` "Deploy lessons" #3 |

### Simulation & testing patterns

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Organic vs adversarial generation** | A simulator should support both realistic distributions and deliberately constructed edge cases — same generator, one flag | `docs/learning/synthetic-data-and-simulation.md`; applied in `src/handlers/simulator.ts` |
| **Fault injection** | Adversarial generation generalized to any failure mode (out-of-range value, malformed payload, stale timestamp, burst, etc.) | `docs/learning/synthetic-data-and-simulation.md` "Generalizing — fault injection" |
| **Bounded fixed-pool identifiers** | Fixed pool of test IDs (sensor-001 ... sensor-005) preserves ordering and per-key behavior under test; random UUIDs would defeat the test | `docs/decisions/phase-04-iot-simulator.md` pre-flight 5 |
| **Predicate parity across implementations** | When the same predicate exists in multiple places (TS + SQL), they must stay in lockstep — code-review smell, contract-test mitigation | `docs/decisions/phase-04-iot-simulator.md`; `docs/decisions/phase-05-alert-workflow.md` cross-cutting framing |

### Stack composition & lifecycle

| Pattern | One-sentence definition | Where defined |
|---|---|---|
| **Stack boundaries follow lifecycle** | Not technology category — what fails together, deploys together, rolls back together | `docs/decisions/phase-03-storage-processing.md` pre-flight 7 |
| **Document what's deferred, don't pretend it's done** | When a feature is intentionally out of scope, say so explicitly rather than building a placeholder | `docs/decisions/phase-05-alert-workflow.md` pre-flight 3 (default-false ack); `src/handlers/dlq-inspector.ts` REPLAY_TO_KINESIS stub |
| **Self-bootstrapping infrastructure** | No manual shell steps to wire account-specific values; discovery happens at deploy via custom resources | `docs/decisions/phase-04-iot-simulator.md` pre-flight 3 |
| **Composition over replacement at the right layer** | When two technologies cover similar ground at different abstraction levels, compose rather than choose — each at the layer where it's strongest | `docs/decisions/phase-08-ai-ml-integration.md` pre-flight 1 (Step Functions outer + LangGraph inner); `docs/learning/langchain-langgraph.md` |
| **Recurring-failure promotion** | When the same defect class hits N times, promote the documentation from "captured edge case" to "recurring class of failure" with a recurrence log + automated detection | `docs/decisions/phase-03-storage-processing.md` Deploy lesson #4 (Kinesis CFN orphan, 4× as of Day 3); `scripts/post-destroy-check.sh` |
| **Bridge brokers at trust / operational boundaries** | External communication uses one protocol/broker (constrained by the partner / device ecosystem); internal uses another (chosen for your throughput and microservice topology); a bridge layer translates between them. Don't let the external protocol dictate your internal architecture. | `docs/learning/bridge-brokers-at-boundaries.md`; applied in `infra/lib/iot-stack.ts` (IoT Rules Engine as the MQTT→Kinesis bridge) |
| **Uniform adapter interface as extension point** | Heterogeneous downstream targets behind a single `Promise<Result>` shape registered in a type-checked map; adding a future target is one new file + one map entry + one type-union literal — no changes to the dispatcher, the data layer, or the orchestration | `docs/learning/case-management-patterns.md` extension-point section; applied in `src/lib/cases/channels/index.ts` (`CHANNEL_HANDLERS satisfies Record<CaseSystem, ChannelHandler>`) |

---

## Patterns by phase introduced

| Phase | Patterns introduced |
|---|---|
| **P1** | Parse-don't-validate; Functional core / imperative shell |
| **P2** | Defense-in-depth idempotency; Fail-loud / fail-quiet asymmetry; Bounded low-cardinality dimensions; State outlives delivery jitter; Belt-and-suspenders |
| **P3** | Layered failure isolation; Right-size by load shape; Stack boundaries follow lifecycle; Inline policies for create-time auth |
| **P4** | Organic vs adversarial generation; Fault injection; Bounded fixed-pool identifiers; Self-bootstrapping infrastructure |
| **P5** | Codify invariants at the highest level the language can express; Single typed model spanning runtime + infra; Cross-stack composition via constructor props; Conditional infrastructure via optional typed props; Predicate parity across implementations; Document what's deferred |
| **P6** | _(to come — likely: chaos verification patterns, alarm threshold tuning, dimensioned vs aggregated metrics)_ |
| **P7** | _(API boundary patterns — separate Zod schemas per surface; read-only IAM grants as defense in depth)_ |
| **P8** | _(to come — hybrid Step Functions + LangGraph pattern; AI as best-effort enhancement with deterministic fallback; MCP as platform thinking)_ |
| **P9** | Conditional-write idempotency at a new boundary; Partial-success failure isolation (fan-out); Exception-as-information (catch-and-fall-back); Uniform adapter interface as extension point |

---

## How to use this index in practice

### As a study aid

1. Pick a category that interests you.
2. Read every linked source for that category in one sitting.
3. For each pattern, ask yourself: "Could I name another project where I'd
   apply this?" If you can, the pattern is sticking. If you can't, that
   pattern is the one to revisit next time.

### As a code-review tool

When you encounter unfamiliar code in this project, ask: "Which patterns
from the index apply here?" The answer should be visible by reading the
file plus its decision log.

### As an interview preparation tool

Pick **5 patterns** you can speak about for 60 seconds each:
- Name them.
- State the problem they solve.
- Cite the alternative you considered.
- Cite the tradeoff you accepted.
- Reference where this project applies them.

That set of 5 becomes the spine of any technical interview about this
project.

### As a "did I actually learn this?" check

Read the pattern's name aloud. Without looking at the link, can you:
1. State the pattern in one breath?
2. Name a recurring problem it solves?
3. Cite a place this project uses it?

If yes to all three for every pattern in the index, you've internalized
the conceptual layer of the project. If not, those are the patterns to
revisit.
