/**
 * Grid Sensor Pipeline — MCP server (P8.6).
 *
 * Local stdio-transport MCP server exposing three read-only tools
 * against the deployed pipeline:
 *
 *   1. query_sensor_readings  — wraps the Phase 7 Query API.
 *   2. query_recent_breaches  — scans the readings table for
 *                               out-of-range values; returns recent breaches.
 *   3. get_alert_history      — lists Step Functions executions of the
 *                               alert workflow in a time window.
 *
 * Why MCP, why stdio:
 *   - MCP is the JD's named tool-integration protocol.
 *   - Stdio is the simplest transport — Claude Desktop / Code connect
 *     to local stdio servers via JSON config. Zero hosting needed.
 *   - Production migration path is HTTP/SSE behind API Gateway.
 *
 * Why these three tools, why read-only:
 *   - Mirrors the existing query surface (DynamoDB + Step Functions
 *     + Query API). Write tools (case management) ship at P9.
 *   - Demonstrates the protocol correctly with the most realistic POC
 *     usage pattern: an agent inspecting pipeline state to answer
 *     operator questions.
 *
 * Configuration:
 *   - AWS_REGION       (default: us-east-1)
 *   - READINGS_TABLE   (default: grid-sensor-pipeline-readings)
 *   - QUERY_API_URL    (resolved from CFN stack output if not set)
 *   - ALERT_STATE_MACHINE_ARN (resolved from CFN stack output if not set)
 *
 * Run locally:
 *   npm run mcp
 *
 * Run from Claude Desktop:
 *   Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 *   See mcp-server/README.md for the exact stanza.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  SFNClient,
  ListExecutionsCommand,
  type ExecutionStatus,
} from '@aws-sdk/client-sfn';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const READINGS_TABLE =
  process.env.READINGS_TABLE ?? 'grid-sensor-pipeline-readings';

const dynamo = new DynamoDBClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

/**
 * Lazily resolve the deployed Query API URL and Alert workflow ARN from
 * CloudFormation outputs. Avoids requiring the user to set env vars by
 * hand — `npm run deploy` writes the outputs, the MCP server reads
 * them. Cached for the server's lifetime.
 */
let _resolvedConfig: { queryApiUrl: string; alertStateMachineArn: string } | undefined;

const resolveConfig = async () => {
  if (_resolvedConfig) return _resolvedConfig;

  let queryApiUrl = process.env.QUERY_API_URL;
  let alertStateMachineArn = process.env.ALERT_STATE_MACHINE_ARN;

  if (!queryApiUrl) {
    const queryStack = await cfn.send(
      new DescribeStacksCommand({ StackName: 'GridSensorQueryStack' }),
    );
    queryApiUrl = queryStack.Stacks?.[0]?.Outputs?.find(
      (o) => o.OutputKey === 'QueryApiUrl',
    )?.OutputValue;
  }

  if (!alertStateMachineArn) {
    const alertStack = await cfn.send(
      new DescribeStacksCommand({
        StackName: 'GridSensorAlertWorkflowStack',
      }),
    );
    alertStateMachineArn = alertStack.Stacks?.[0]?.Outputs?.find(
      (o) => o.OutputKey === 'AlertWorkflowArn',
    )?.OutputValue;
  }

  if (!queryApiUrl) {
    throw new Error(
      'Could not resolve QUERY_API_URL — set env var or deploy GridSensorQueryStack',
    );
  }
  if (!alertStateMachineArn) {
    throw new Error(
      'Could not resolve ALERT_STATE_MACHINE_ARN — set env var or deploy GridSensorAlertWorkflowStack',
    );
  }

  _resolvedConfig = { queryApiUrl, alertStateMachineArn };
  return _resolvedConfig;
};

/* -------------------------------------------------------------------- */
/* Tool 1 — query_sensor_readings                                       */
/* -------------------------------------------------------------------- */

const queryToolSchema = {
  type: 'object',
  required: ['sensorId'],
  properties: {
    sensorId: {
      type: 'string',
      description: 'Sensor identifier matching the pattern sensor-[a-z0-9-]+',
    },
    from: {
      type: 'string',
      description:
        'ISO 8601 datetime lower bound (inclusive). Optional; omit for all readings.',
    },
    to: {
      type: 'string',
      description: 'ISO 8601 datetime upper bound (inclusive). Optional.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Maximum number of readings to return (default: 50).',
    },
  },
} as const;

const handleQuerySensorReadings = async (args: Record<string, unknown>) => {
  const sensorId = String(args.sensorId);
  const from = args.from ? String(args.from) : undefined;
  const to = args.to ? String(args.to) : undefined;
  const limit = args.limit ? Number(args.limit) : 50;

  const { queryApiUrl } = await resolveConfig();
  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);
  params.append('limit', String(limit));

  const url = `${queryApiUrl}sensors/${encodeURIComponent(sensorId)}/readings?${params}`;
  const res = await fetch(url);
  const body = await res.text();

  return {
    content: [
      {
        type: 'text',
        text:
          res.ok
            ? `Query OK (${res.status}). Response:\n\n${body}`
            : `Query failed (${res.status}). Response:\n\n${body}`,
      },
    ],
  };
};

/* -------------------------------------------------------------------- */
/* Tool 2 — query_recent_breaches                                       */
/* -------------------------------------------------------------------- */

const breachToolSchema = {
  type: 'object',
  properties: {
    sinceMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 10080, // one week
      description:
        'Lookback window in minutes. Default 60. Hard cap one week.',
    },
    readingType: {
      type: 'string',
      enum: ['voltage', 'frequency'],
      description:
        'Restrict to one reading type. Only voltage and frequency have thresholds.',
    },
  },
} as const;

/**
 * Threshold predicate mirrored from `src/lib/threshold.ts` —
 * deliberately duplicated for the MCP server because this is a
 * standalone tool that shouldn't import application code. Predicate
 * parity is a known smell; documented in
 * `docs/decisions/phase-04-iot-simulator.md` cross-cutting framing.
 */
const isBreached = (readingType: string, value: number): boolean => {
  if (readingType === 'voltage') return value < 114 || value > 126;
  if (readingType === 'frequency') return value < 59.5 || value > 60.5;
  return false;
};

const handleQueryRecentBreaches = async (args: Record<string, unknown>) => {
  const sinceMinutes = args.sinceMinutes ? Number(args.sinceMinutes) : 60;
  const readingTypeFilter = args.readingType
    ? String(args.readingType)
    : undefined;
  const sinceIso = new Date(
    Date.now() - sinceMinutes * 60 * 1000,
  ).toISOString();

  // Scan with a filter expression — efficient enough at POC volume,
  // expensive at scale. Production version would use a GSI on
  // (readingType, timestamp) and Query against it.
  const scan = await dynamo.send(
    new ScanCommand({
      TableName: READINGS_TABLE,
      FilterExpression: '#ts >= :since',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':since': { S: sinceIso } },
    }),
  );

  const breaches = (scan.Items ?? [])
    .map((item) => unmarshall(item))
    .filter(
      (r) =>
        typeof r.value === 'number' &&
        typeof r.readingType === 'string' &&
        (!readingTypeFilter || r.readingType === readingTypeFilter) &&
        isBreached(r.readingType, r.value),
    )
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  return {
    content: [
      {
        type: 'text',
        text:
          breaches.length === 0
            ? `No breaches in the last ${sinceMinutes} minutes.`
            : `Found ${breaches.length} breach(es) in the last ${sinceMinutes} minutes:\n\n${JSON.stringify(breaches, null, 2)}`,
      },
    ],
  };
};

/* -------------------------------------------------------------------- */
/* Tool 3 — get_alert_history                                           */
/* -------------------------------------------------------------------- */

const alertToolSchema = {
  type: 'object',
  properties: {
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of executions to return (default: 20).',
    },
    statusFilter: {
      type: 'string',
      enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'],
      description: 'Filter by Step Functions execution status.',
    },
  },
} as const;

const handleGetAlertHistory = async (args: Record<string, unknown>) => {
  const maxResults = args.maxResults ? Number(args.maxResults) : 20;
  const statusFilter = args.statusFilter
    ? (String(args.statusFilter) as ExecutionStatus)
    : undefined;

  const { alertStateMachineArn } = await resolveConfig();
  const list = await sfn.send(
    new ListExecutionsCommand({
      stateMachineArn: alertStateMachineArn,
      maxResults,
      statusFilter,
    }),
  );

  const executions = (list.executions ?? []).map((e) => ({
    name: e.name,
    status: e.status,
    startDate: e.startDate?.toISOString(),
    stopDate: e.stopDate?.toISOString(),
    executionArn: e.executionArn,
  }));

  return {
    content: [
      {
        type: 'text',
        text:
          executions.length === 0
            ? `No alert workflow executions match the filter.`
            : `Found ${executions.length} alert workflow execution(s):\n\n${JSON.stringify(executions, null, 2)}`,
      },
    ],
  };
};

/* -------------------------------------------------------------------- */
/* Server wiring                                                        */
/* -------------------------------------------------------------------- */

const server = new Server(
  { name: 'grid-sensor-pipeline', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'query_sensor_readings',
      description:
        'Return recent readings for a specific sensor. Wraps the deployed Query API; supports time-window and limit filters. Use this when the operator asks about a specific sensor by ID.',
      inputSchema: queryToolSchema,
    },
    {
      name: 'query_recent_breaches',
      description:
        'Find sensor readings that exceeded thresholds (voltage outside 114-126V or frequency outside 59.5-60.5Hz) in a recent time window. Use this when the operator asks "are there any problems right now" or "what breached today".',
      inputSchema: breachToolSchema,
    },
    {
      name: 'get_alert_history',
      description:
        'List recent alert workflow executions from Step Functions. Useful for "did an alert fire", "what alerts ran today", or auditing the alert escalation history. Each execution corresponds to one breach event.',
      inputSchema: alertToolSchema,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'query_sensor_readings':
        return await handleQuerySensorReadings(args);
      case 'query_recent_breaches':
        return await handleQueryRecentBreaches(args);
      case 'get_alert_history':
        return await handleGetAlertHistory(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Async IIFE rather than top-level await — the project's tsconfig
 * compiles to CJS (`module: commonjs`) for Lambda compatibility, and
 * top-level await needs `module: es2022+`. Local IIFE works under any
 * module setting.
 *
 * Errors go to stderr because stdout is reserved for the MCP protocol
 * framing; logging to stdout would corrupt the JSON-RPC stream and
 * confuse the client.
 */
const main = async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    `[mcp-server] fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
