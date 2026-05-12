# Architecture Diagrams

> Visual reference for the Grid Sensor Pipeline system. Start with
> [`system-overview.md`](./system-overview.md) — the boxes in that diagram
> are clickable hyperlinks that take you into the drill-down view for
> each subsystem.

## Diagrams in this directory

| File | What it shows |
|---|---|
| [`system-overview.md`](./system-overview.md) | The whole pipeline. Entry point — start here. Click any box in the diagram to drill into that subsystem. |
| [`data-ingestion-path.md`](./data-ingestion-path.md) | How sensor readings flow from IoT Core into DynamoDB. The partial-batch-failure + idempotency pattern lives here. |
| [`alert-workflow.md`](./alert-workflow.md) | The Step Functions state machine that drives alert notification and escalation. State-shape transformation through each step. |
| [`langgraph-flow.md`](./langgraph-flow.md) | The three-node LangGraph that runs inside the alert handler — severity classification, routing decision, narrative generation. |
| [`mcp-server.md`](./mcp-server.md) | The local stdio MCP server exposing read-only tools that any MCP client (Claude Desktop, Claude Code) can call to interrogate the live pipeline. |

## How to read these

Each diagram is paired with a short prose section explaining **what's
interesting about this view** — not a literal description of the boxes,
but the *load-bearing architectural decisions* that the diagram is
making visible. If you just want the picture, skim the Mermaid block;
if you want the reasoning, read the prose.

For the deeper rationale behind any decision shown here, see the
matching file under [`../decisions/`](../decisions/).
