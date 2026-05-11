# Grid Sensor Pipeline — MCP Server

A local stdio-transport MCP server exposing three read-only tools
against the deployed pipeline. Connect it to Claude Desktop or Claude
Code to ask natural-language questions about pipeline state.

---

## What it exposes

| Tool | What it does |
|---|---|
| `query_sensor_readings` | Recent readings for a specific sensor. Wraps the deployed Query API. Use for *"show me sensor-005's last hour"*. |
| `query_recent_breaches` | Readings that exceeded voltage / frequency thresholds in a time window. Use for *"are there any problems right now?"*. |
| `get_alert_history` | Recent alert workflow executions from Step Functions. Use for *"what alerts have fired today?"*. |

All three are **read-only**. Phase 9 adds write-capable tools for case
management.

---

## Prerequisites

1. The pipeline must be deployed (`npm run deploy` from project root).
2. AWS credentials available to the local shell that match the account
   the pipeline is deployed in. The server uses the standard
   `~/.aws/credentials` or `AWS_PROFILE` resolution chain.
3. Node ≥ 20.

---

## Run standalone (for debugging)

From the project root:

```bash
npm run mcp
```

The server reads stdin and writes stdout per the MCP protocol — it
won't display anything on its own. Useful when paired with an MCP
client; not useful as a standalone CLI.

For a sanity check that the server initializes correctly without
hanging, run with a quick close:

```bash
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | npm run mcp 2>&1 | head -20
```

You should see a JSON-RPC response with the server's capabilities.

---

## Wire it into Claude Desktop

1. Open the Claude Desktop config file:

   ```
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```

   (Create it if it doesn't exist.)

2. Add the `grid-sensor-pipeline` server stanza:

   ```json
   {
     "mcpServers": {
       "grid-sensor-pipeline": {
         "command": "npx",
         "args": [
           "ts-node",
           "--prefer-ts-exts",
           "/ABSOLUTE/PATH/TO/Grid-Sensor-Pipeline/mcp-server/server.ts"
         ],
         "env": {
           "AWS_REGION": "us-east-1",
           "AWS_PROFILE": "default"
         }
       }
     }
   }
   ```

   Replace `/ABSOLUTE/PATH/TO/Grid-Sensor-Pipeline/` with the project's
   actual path. Replace `AWS_PROFILE` with whichever profile has the
   credentials.

3. Quit and reopen Claude Desktop. The server should appear in the
   tools list when you start a new conversation.

4. Try a query:

   > *"Are there any active breaches in the grid sensor pipeline right now?"*

   Claude will call `query_recent_breaches`, the MCP server will
   scan the readings table, and the response will come back as
   structured text.

---

## Wire it into Claude Code

Add the same stanza to:

```
~/.config/claude/mcp_servers.json
```

…or use the Claude Code MCP configuration UI (Settings → Tools →
MCP Servers). The `command` and `args` shape is identical to the
Desktop config above.

---

## Environment variables

The server resolves most configuration automatically from CloudFormation
stack outputs. The full set of overridable env vars:

| Variable | Default | Purpose |
|---|---|---|
| `AWS_REGION` | `us-east-1` | AWS region for all SDK clients |
| `READINGS_TABLE` | `grid-sensor-pipeline-readings` | DynamoDB table for breach scan |
| `QUERY_API_URL` | resolved from CFN | Phase 7 Query API endpoint |
| `ALERT_STATE_MACHINE_ARN` | resolved from CFN | Step Functions ARN for alert history |
| `AWS_PROFILE` | `default` | Credentials profile |

Resolution from CloudFormation happens lazily on first tool invocation
and is cached for the server's lifetime. If the pipeline is redeployed
in a different region or under different stack names, set the env vars
explicitly.

---

## Production migration path

This is a **local stdio-transport** server — appropriate for Claude
Desktop / Code on the developer's machine. Production deployment for
a shared MCP service would be:

1. Re-package the server as a Lambda + API Gateway HTTP/SSE endpoint.
2. Add an MCP-aware authentication layer (signed-request, OAuth, etc.).
3. Add per-tool rate-limiting and cost tracking.

These are deliberately out of scope for the POC. See
`docs/decisions/phase-08-ai-ml-integration.md` pre-flight 5 for the
full rationale.

---

## Troubleshooting

**"Could not resolve QUERY_API_URL"** — the GridSensorQueryStack
isn't deployed in the configured region, or your AWS credentials
don't have `cloudformation:DescribeStacks` permission. Either deploy
or set the env var explicitly.

**Claude Desktop shows no tools after restart** — verify the absolute
path in the config is correct (relative paths don't work), and that
`npm run mcp` works standalone. Then check Claude Desktop's logs at
`~/Library/Logs/Claude/`.

**Tool calls return AccessDenied** — your AWS credentials need
read-only permissions on DynamoDB (Scan), Step Functions
(ListExecutions), and CloudFormation (DescribeStacks), plus the
public API Gateway URL is reachable. The `ReadOnlyAccess` managed
policy is sufficient.

**Threshold predicate seems off** — the breach predicate in
`query_recent_breaches` is duplicated from `src/lib/threshold.ts`.
If thresholds change in the project, update both. Known smell;
documented in `docs/decisions/phase-04-iot-simulator.md`
cross-cutting framing.
