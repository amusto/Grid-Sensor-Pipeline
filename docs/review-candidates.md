# Review Candidates

Items to review for possible roadmap inclusion. Captured 2026-06-16 — not yet
scoped, prioritized, or committed. Discuss before promoting to ROADMAP.md.

---

## 1. AI Model adapter — abstract provider interface

Introduce a model-provider abstraction so the pipeline isn't bound to a single
LLM backend. One uniform interface, swappable implementations:

- **OpenAI**
- **Anthropic** (current — via Bedrock `ChatBedrockConverse`)
- **Ollama** (local dev — no cloud cost, offline iteration)

Same shape as the existing `CHANNEL_HANDLERS` adapter pattern: one interface,
a registry of implementations, provider selected by config. Open questions to
work through: where the seam sits relative to `lib/llm-client.ts`, how
`invokeStructured(schema, messages)` stays provider-agnostic, and how
per-provider auth/config is injected.

## 2. RAG use cases

Identify where retrieval-augmented generation adds value to the pipeline.
Candidate angles to evaluate: grounding alert narratives in historical breach
context, operator runbook / remediation lookup, querying past incidents for
similar-event correlation. Decide what the corpus is, where it lives (S3 cold
archive? DynamoDB? vector store?), and whether it's worth the added surface for
a POC.

## 3. Vector stores — pgvector

Evaluate vector store options to back the RAG work above (item 2). Lead
candidate: **pgvector** (Postgres extension) — keeps embeddings in a familiar
relational store, no separate vector-DB service to operate. Compare against
managed/serverless alternatives (OpenSearch Serverless, Pinecone, S3 Vectors)
on cost, ops surface, and POC fit. Decide where it runs (RDS/Aurora vs. local
Postgres for dev) and how embeddings get generated + indexed from the telemetry
/ incident corpus.

## 4. Compliance support — IoT telemetry data use cases

Explore compliance angles for grid sensor telemetry. Candidate areas: data
retention/residency (already partly addressed via TTL + US inference profile),
audit trails (Step Functions history, cases table), NERC/regulatory reporting
from the telemetry record, and access controls on the query path (ties into
P13 auth hardening). Define which compliance frameworks actually apply before
scoping.

---

**Next step:** discuss each, decide scope/priority, then promote the keepers
into ROADMAP.md (likely as new phases or stretch items).
