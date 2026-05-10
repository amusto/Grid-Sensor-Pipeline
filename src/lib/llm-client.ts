/**
 * LangChain wrapper around AWS Bedrock for the LangGraph alert flow.
 *
 * Why this lives in `lib/`, not in a handler:
 *   1. CLAUDE.md invariant #2 — handlers orchestrate; lib executes.
 *   2. The same client wraps every LangGraph node call (P8.3, P8.4),
 *      so it has to be a shared utility.
 *   3. Cost guardrails (max-retries cap, token-usage metric emission)
 *      are correctness concerns that belong with the LLM I/O, not at
 *      the call site.
 *
 * Public surface: `invokeStructured(schema, messages)` returns a
 * Zod-typed parsed object. Bedrock errors propagate to the caller —
 * the alert handler's outer fail-soft fallback (P8 pre-flight 6)
 * decides whether to swallow them.
 *
 * Cost guardrails embedded here:
 *   - `maxRetries: 1` caps parse-failure retry spirals. Without it, a
 *     malformed-output bug could 10× the bill in one bad deploy hour.
 *   - `BedrockTokensUsed` metric emitted per invocation as the SUM of
 *     input + output tokens. The `BedrockTokens-Runaway` CloudWatch
 *     alarm in `observability-stack.ts` fires on that metric exceeding
 *     1M tokens in any 60-minute window.
 *   - `BedrockFallback` metric emitted on every error so the alert
 *     handler's fail-soft path is countable.
 *
 * Why `ChatBedrockConverse` (not `BedrockChat`):
 *   `@langchain/aws@^1.x` exports the Converse API wrapper as the
 *   canonical client. Converse uses Bedrock's unified `Converse`
 *   endpoint, which abstracts away model-family-specific request body
 *   formats (no need to wrap requests in `anthropic_version` etc.).
 *   This lets us swap the underlying model id at deploy time without
 *   reworking the request shape.
 */

import { ChatBedrockConverse } from '@langchain/aws';
import type { BaseMessageLike } from '@langchain/core/messages';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { ZodType } from 'zod';
import { logger } from './logger';
import { metrics } from './metrics';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? '';

if (!MODEL_ID) {
  throw new Error('BEDROCK_MODEL_ID env var is required');
}

/**
 * Hard cap on LangChain retries. Cost guardrail — see file header.
 * Bumping this knowingly should be paired with a re-evaluation of the
 * runaway-cost alarm threshold.
 */
const MAX_RETRIES = 1;

/**
 * Lazily initialized Bedrock client. Lazy so that:
 *   1. Lambda cold-start cost — only pay client construction time when
 *      the alert flow actually runs.
 *   2. Tests mock `ChatBedrockConverse` cleanly without the module
 *      load triggering a real AWS SDK init.
 */
let _client: ChatBedrockConverse | undefined;

const getClient = (): ChatBedrockConverse => {
  if (_client === undefined) {
    _client = new ChatBedrockConverse({
      region: REGION,
      model: MODEL_ID,
      maxRetries: MAX_RETRIES,
    });
  }
  return _client;
};

/**
 * Reset cached client — test-only seam. Production code never calls.
 */
export const __resetClient = (): void => {
  _client = undefined;
};

/**
 * Token usage shape from ChatBedrockConverse's AIMessage. Defined
 * defensively because LangChain's `usage_metadata` field has evolved
 * across minor releases — both `usage_metadata` (v1+) and
 * `response_metadata.usage` (older) have been observed.
 */
type UsageMetadata = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

const extractTokens = (raw: unknown): UsageMetadata => {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const metaCandidates: unknown[] = [
    r.usage_metadata,
    (r.response_metadata as Record<string, unknown> | undefined)?.usage,
  ];
  for (const m of metaCandidates) {
    if (m && typeof m === 'object') {
      const meta = m as UsageMetadata;
      if (
        typeof meta.input_tokens === 'number' ||
        typeof meta.output_tokens === 'number' ||
        typeof meta.total_tokens === 'number'
      ) {
        return meta;
      }
    }
  }
  return {};
};

/**
 * Invoke Bedrock with a structured-output schema. Returns the parsed
 * Zod-typed object; emits per-call metrics; throws on Bedrock or
 * parser failure (caller decides fallback).
 *
 * @param schema   Zod schema describing the desired output shape.
 *                 LangChain converts this to Bedrock tool-use schema
 *                 under the hood for Anthropic models.
 * @param messages BaseMessageLike[] — typically a single user message,
 *                 sometimes preceded by a system message.
 */
export const invokeStructured = async <T>(
  schema: ZodType<T>,
  messages: BaseMessageLike[],
): Promise<T> => {
  const startedAt = Date.now();
  const client = getClient();
  const structured = client.withStructuredOutput(schema, {
    includeRaw: true,
  });

  try {
    const result = await structured.invoke(messages);
    const elapsedMs = Date.now() - startedAt;

    // `withStructuredOutput({ includeRaw: true })` returns
    // `{ raw: AIMessage, parsed: T }`. Asserted at runtime because
    // LangChain's overload typing is permissive.
    const { raw, parsed } = result as { raw: unknown; parsed: T };
    const tokens = extractTokens(raw);
    const totalTokens =
      tokens.total_tokens ??
      (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);

    metrics.addMetric('BedrockInvocations', MetricUnit.Count, 1);
    metrics.addMetric('BedrockLatencyMs', MetricUnit.Milliseconds, elapsedMs);
    metrics.addMetric('BedrockTokensUsed', MetricUnit.Count, totalTokens);

    logger.info('Bedrock invoke succeeded', {
      modelId: MODEL_ID,
      elapsedMs,
      inputTokens: tokens.input_tokens,
      outputTokens: tokens.output_tokens,
      totalTokens,
    });

    return parsed;
  } catch (err) {
    metrics.addMetric('BedrockFallback', MetricUnit.Count, 1);
    logger.error('Bedrock invoke failed', {
      modelId: MODEL_ID,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};

/**
 * Read-only handle to the configured model id. Useful for prompts
 * that need to include the model name in a narrative ("classified by
 * $modelId"), and for tests that want to assert wiring.
 */
export const getModelId = (): string => MODEL_ID;
