/**
 * LangGraph assembly for the alert flow (P8.5 + P9.4).
 *
 * Wires the four plain-function nodes from P8.3 + P8.4 + P9.4 into a
 * single `StateGraph` that runs inside the alert handler Lambda:
 *
 *   START
 *     → classifySeverity     (P8.3 — Bedrock + Zod)
 *     → determineRouting     (P8.4 — Bedrock + routing matrix override)
 *     → generateNarratives   (P8.5 — per-channel narratives)
 *     → executeTools         (P9.4 — partial-success dispatcher,
 *                              cases-table persistence)
 *     → END
 *
 * Each node is a thin wrapper that:
 *   1. Reads the relevant fields from the graph state.
 *   2. Calls the lib function (which uses `invokeStructured` against
 *      Bedrock) or, in the case of executeTools, the channel adapters
 *      via the CHANNEL_HANDLERS registry.
 *   3. Returns a partial state update with just the field it produced.
 *
 * **P9.4 contribution.** The `executeTools` node is where every Phase 9
 * design decision exercises at runtime:
 *
 *   - **Uniform adapter interface**: every channel adapter implements
 *     `Promise<ChannelResult>`; the dispatcher doesn't know which is
 *     real (email via SNS) and which is stubbed (SMS).
 *   - **Conditional-write idempotency** at the cases-table layer
 *     (`docs/decisions/phase-09-agentic-case-routing.md` pre-flight 2):
 *     the dispatcher's contract is to catch `ConditionalCheckFailedException`
 *     from `createChannelCase` as the "this is a retry" signal and fall
 *     back to `updateChannelCase`. Same primitive as P2 readings dedup,
 *     applied at a new boundary.
 *   - **Partial-success failure isolation** (pre-flight 3): each
 *     channel runs through `Promise.allSettled`, so one channel failing
 *     doesn't block the others. Result is structured as
 *     `{ delivered[], failed[], skipped[] }`.
 *   - **Per-channel input mapping** (the uniform-adapter interface's
 *     payoff): a per-channel function converts the breach context +
 *     narratives into the channel-specific input shape every adapter
 *     expects. Future channels add a `case` here and a registry entry
 *     in `cases/channels/index.ts`; nothing else changes.
 *
 * Why a compiled singleton at module load (not per-invocation):
 *   `StateGraph.compile()` is non-trivial work (typechecks the graph,
 *   builds the runtime). Lambda cold start absorbs this once; warm
 *   invocations reuse the compiled graph. Per-invocation compile would
 *   add ~50-200ms to every alert.
 *
 * Failure model:
 *   Any node throw propagates out of `alertGraph.invoke()`. The alert
 *   handler's outer try/catch routes to the Phase 5 deterministic JSON
 *   fallback so the alert always reaches SNS. See
 *   `docs/decisions/phase-08-ai-ml-integration.md` pre-flight 6.
 *
 *   The `executeTools` node uses `Promise.allSettled` internally for
 *   per-channel isolation, but the node itself can still throw on
 *   wiring errors (missing state, missing CASES_TABLE_NAME env var).
 *   Wiring errors are bugs and should fail loud, not silently fall back.
 */

import {
  Annotation,
  StateGraph,
  START,
  END,
} from '@langchain/langgraph';
import { classifySeverity, type Severity } from './severity-classifier';
import { determineRouting, type RoutingPlan } from './routing-strategy';
import { generateNarratives, type Narratives } from './narrative-generator';
import { evaluateThreshold } from './threshold';
import type { SensorEvent } from './types';
import { logger } from './logger';
import { metrics, MetricUnit } from './metrics';
import { CaseRepository, type CaseNaturalKey } from './cases/case-repository';
import {
  CHANNEL_HANDLERS,
  type EmailCallInput,
  type SmsCallInput,
} from './cases/channels';
import type { CaseSystem, ChannelResult } from './cases/types';

// =============================================================================
//  Types specific to the dispatcher (P9.4)
// =============================================================================

/**
 * Reason a channel was skipped instead of dispatched. Each case is a
 * deliberate branch in `dispatchChannel`; the enum is exhaustive
 * because we want compile-time coverage if a new skip cause is added.
 */
export type SkipReason =
  | 'retry_already_delivered'  // existing row at status='delivered'; idempotent skip
  | 'no_handler_registered'    // routing selected a channel CHANNEL_HANDLERS doesn't have
  | 'narrative_missing';       // routing selected a channel narrative-generator omitted

export interface DispatchSkip {
  channel: CaseSystem;
  reason: SkipReason;
}

/**
 * Partial-success result shape — pre-flight 3 of the decision log.
 * Returned from `executeToolsNode` as a field on the final graph state.
 *
 *   - delivered: channels whose adapter call succeeded.
 *   - failed:    channels whose adapter call returned status='failed'
 *                (or rejected — caught and converted to a failed result).
 *   - skipped:   channels selected by routing but not dispatched, with
 *                an explicit reason from the SkipReason enum.
 */
export interface DispatchResult {
  delivered: ChannelResult[];
  failed: ChannelResult[];
  skipped: DispatchSkip[];
}

/**
 * Internal: the per-channel outcome before aggregation. Tagged-union
 * so the aggregator can route each outcome to the right bucket without
 * inferring kind from field presence.
 */
type DispatchOutcome =
  | { kind: 'delivered'; result: ChannelResult }
  | { kind: 'failed'; result: ChannelResult }
  | { kind: 'skipped'; skip: DispatchSkip };

// =============================================================================
//  Module-level singletons (lazy-init; reused across warm Lambda invokes)
// =============================================================================

/**
 * Graph state shape. Each `Annotation<T>()` declares a field with the
 * default *replace* reducer — when a node returns a value for the
 * field, it overwrites whatever was there.
 *
 * Every field in this graph is written by exactly one node (linear
 * flow), so replace semantics are correct everywhere. If we ever add
 * parallel fan-out (e.g., two enrichment nodes both writing to a
 * `context` field), we'd switch that field to an append/merge reducer.
 */
const AlertGraphAnnotation = Annotation.Root({
  event: Annotation<SensorEvent>(),
  severity: Annotation<Severity | undefined>(),
  routing: Annotation<RoutingPlan | undefined>(),
  narratives: Annotation<Narratives | undefined>(),
  dispatchResult: Annotation<DispatchResult | undefined>(),
});

/**
 * Final shape returned by `alertGraph.invoke()`. Same fields as the
 * annotation but with `event` always present (was the input) and the
 * four flow-produced fields guaranteed populated on success.
 */
export type AlertGraphState = {
  event: SensorEvent;
  severity: Severity;
  routing: RoutingPlan;
  narratives: Narratives;
  dispatchResult: DispatchResult;
};

let _graph: ReturnType<typeof buildGraph> | undefined;
let _caseRepo: CaseRepository | undefined;

const getGraph = (): ReturnType<typeof buildGraph> => {
  if (_graph === undefined) {
    _graph = buildGraph();
  }
  return _graph;
};

/**
 * Lazy-init the CaseRepository singleton. Reads `CASES_TABLE_NAME`
 * from env on first call; matches the pattern used elsewhere in the
 * project (`ALERT_TOPIC_ARN` in alert-handler.ts, env-var-validated
 * singletons in repository.ts).
 */
const getCaseRepository = (): CaseRepository => {
  if (_caseRepo === undefined) {
    const tableName = process.env.CASES_TABLE_NAME;
    if (!tableName) {
      throw new Error('CASES_TABLE_NAME env var is required');
    }
    _caseRepo = new CaseRepository(tableName);
  }
  return _caseRepo;
};

/**
 * Test-only seam — resets the compiled-graph singleton AND the
 * CaseRepository singleton so a test can mock module-level
 * dependencies and reinitialize cleanly. Production code never calls.
 */
export const __resetGraph = (): void => {
  _graph = undefined;
};

export const __resetCaseRepo = (): void => {
  _caseRepo = undefined;
};

// =============================================================================
//  Nodes 1-3 (P8.3 / P8.4 / P8.5)
// =============================================================================

/**
 * Node 1 — classify severity. Evaluates the threshold locally (pure
 * function; no I/O) and hands it to the classifier alongside the
 * event. Severity classification only makes sense for breaches; the
 * classifier asserts `threshold.exceeded` defensively.
 */
const classifySeverityNode = async (
  state: typeof AlertGraphAnnotation.State,
): Promise<Partial<typeof AlertGraphAnnotation.State>> => {
  const threshold = evaluateThreshold(state.event);
  const severity = await classifySeverity(state.event, threshold);
  return { severity };
};

/**
 * Node 2 — determine routing. Reads the severity from state; calls the
 * routing-strategy node which consults the baseline matrix and may
 * override based on cross-cutting context.
 */
const determineRoutingNode = async (
  state: typeof AlertGraphAnnotation.State,
): Promise<Partial<typeof AlertGraphAnnotation.State>> => {
  if (state.severity === undefined) {
    throw new Error(
      'determineRoutingNode invoked without severity — graph wiring error.',
    );
  }
  const routing = await determineRouting(state.event, state.severity);
  return { routing };
};

/**
 * Node 3 — generate narratives. Reads severity + routing from state;
 * calls the narrative generator which emits one narrative per channel
 * the routing plan selected.
 */
const generateNarrativesNode = async (
  state: typeof AlertGraphAnnotation.State,
): Promise<Partial<typeof AlertGraphAnnotation.State>> => {
  if (state.severity === undefined || state.routing === undefined) {
    throw new Error(
      'generateNarrativesNode invoked without severity/routing — graph wiring error.',
    );
  }
  const narratives = await generateNarratives(
    state.event,
    state.severity,
    state.routing,
  );
  return { narratives };
};

// =============================================================================
//  Node 4 (P9.4) — executeTools, plus its supporting helpers
// =============================================================================

/**
 * Detect the AWS SDK's `ConditionalCheckFailedException`. The error's
 * `.name` field is the stable contract; we check that rather than
 * `instanceof` because the SDK wraps the underlying class differently
 * across versions.
 */
const isConditionalCheckFailed = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException';

/**
 * Per-channel input mapper. Converts the breach context + the per-
 * channel narrative into the input shape every adapter expects.
 *
 * Returns `null` when the narrative for the channel is missing — the
 * dispatcher treats that as `skipped['narrative_missing']`. This is
 * the only failure mode of this function; everything else is
 * structurally deterministic.
 *
 * **Adding a future channel** (Slack, PagerDuty, etc.) is a matching
 * `case` clause here + a registry entry in `cases/channels/index.ts`
 * + the new adapter file. No other file in the project changes. This
 * is the "one-file extension" claim from pre-flight 7.
 */
const buildChannelInput = (
  channel: CaseSystem,
  event: SensorEvent,
  severity: Severity,
  narratives: Narratives,
): unknown | null => {
  switch (channel) {
    case 'email': {
      const body = narratives.narratives.email;
      if (!body) return null;
      const input: EmailCallInput = {
        subject: `[${severity.severity}] ${event.sensorId} ${event.readingType} breach`,
        body,
        sensorId: event.sensorId,
      };
      return input;
    }
    case 'sms': {
      const body = narratives.narratives.sms;
      if (!body) return null;
      const input: SmsCallInput = {
        // SMS is stubbed — recipient phone is read from env for
        // configurability, but the stub doesn't actually contact the
        // number. Default is a reserved test number (+1-555 block).
        phoneNumber: process.env.SMS_RECIPIENT_PHONE ?? '+15555550100',
        body,
      };
      return input;
    }
  }
};

/**
 * Emit per-channel metrics from the aggregated dispatch result.
 *
 *   - `CasesCreated`           Count, dimensioned by Channel — first-encounter dispatches.
 *   - `CasesRetried`           Count, dimensioned by Channel — Step Functions retry encounters.
 *   - `AlertChannelFailures`   Count, dimensioned by Channel — adapter rejection or status='failed'.
 *   - `DispatchLatencyMs`      Milliseconds, dimensioned by Channel — per-channel wall-clock.
 *
 * Each metric needs its own `singleMetric()` instance so per-channel
 * dimensions don't bleed across calls via the default Metrics
 * instance. The repetition is the price of correct dimensioning;
 * an attempted helper that took the unit as a parameter ran into the
 * `MetricUnit` value-vs-type ambiguity in Powertools' type exports
 * (it's a const-enum-like value, not a TypeScript type).
 *
 * Metrics are buffered by the Powertools EMF emitter and flushed by
 * the handler's `metrics.publishStoredMetrics()` in its finally block.
 */
const emitDispatchMetrics = (result: DispatchResult): void => {
  for (const r of result.delivered) {
    const created = metrics.singleMetric();
    created.addDimension('Channel', r.channel);
    created.addMetric('CasesCreated', MetricUnit.Count, 1);

    const latency = metrics.singleMetric();
    latency.addDimension('Channel', r.channel);
    latency.addMetric('DispatchLatencyMs', MetricUnit.Milliseconds, r.latencyMs);
  }
  for (const r of result.failed) {
    const failed = metrics.singleMetric();
    failed.addDimension('Channel', r.channel);
    failed.addMetric('AlertChannelFailures', MetricUnit.Count, 1);

    const latency = metrics.singleMetric();
    latency.addDimension('Channel', r.channel);
    latency.addMetric('DispatchLatencyMs', MetricUnit.Milliseconds, r.latencyMs);
  }
  for (const s of result.skipped) {
    if (s.reason === 'retry_already_delivered') {
      const retried = metrics.singleMetric();
      retried.addDimension('Channel', s.channel);
      retried.addMetric('CasesRetried', MetricUnit.Count, 1);
    }
  }
};

/**
 * Ensure the per-breach metadata row exists. Idempotent under
 * Step Functions retries: first call creates; subsequent calls catch
 * `ConditionalCheckFailedException` and update only `updatedAt`.
 *
 * Severity is NOT overwritten on retry — the first-encounter
 * classification is canonical. If the LLM reclassifies on retry (rare;
 * deterministic Bedrock prompts), the second classification is
 * discarded for the metadata row but still drives that retry's
 * dispatch decisions.
 */
const ensureMetadata = async (
  repo: CaseRepository,
  key: CaseNaturalKey,
  severity: Severity,
): Promise<void> => {
  const now = new Date().toISOString();
  try {
    await repo.createMetadata(key, {
      severity: severity.severity,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      await repo.updateMetadata(key, { updatedAt: now });
      return;
    }
    throw err;
  }
};

/**
 * Per-channel dispatch flow — check → skip-or-send → persist.
 *
 *   1. Build the per-channel input. Missing narrative → skip.
 *   2. Look up the registered handler. Missing handler → skip.
 *   3. findChannelCase. If row exists with status='delivered' → skip
 *      ('retry_already_delivered'); bump updatedAt for audit.
 *   4. Invoke the adapter via `CHANNEL_HANDLERS[channel](input)`.
 *      Wrapped in try/catch — adapters by contract resolve (never
 *      reject) with `ChannelResult{status:'failed'}`, but the catch
 *      handles violations defensively.
 *   5. Persist the result:
 *      - First write: createChannelCase. On
 *        ConditionalCheckFailedException (race with concurrent retry)
 *        → fall back to updateChannelCase with the same result fields.
 *   6. Return tagged outcome (delivered / failed / skipped).
 */
const dispatchChannel = async (
  repo: CaseRepository,
  key: CaseNaturalKey,
  channel: CaseSystem,
  event: SensorEvent,
  severity: Severity,
  narratives: Narratives,
): Promise<DispatchOutcome> => {
  const input = buildChannelInput(channel, event, severity, narratives);
  if (input === null) {
    return { kind: 'skipped', skip: { channel, reason: 'narrative_missing' } };
  }

  const handler = CHANNEL_HANDLERS[channel];
  if (!handler) {
    return { kind: 'skipped', skip: { channel, reason: 'no_handler_registered' } };
  }

  // Retry-safety check — does a confirmed-delivered row already exist?
  const existing = await repo.findChannelCase(key, channel);
  if (existing && existing.status === 'delivered') {
    // Idempotent skip: bump audit timestamp without re-firing the adapter.
    await repo.updateChannelCase(key, channel, {
      updatedAt: new Date().toISOString(),
    });
    return {
      kind: 'skipped',
      skip: { channel, reason: 'retry_already_delivered' },
    };
  }

  // Dispatch.
  let result: ChannelResult;
  try {
    result = await handler(input);
  } catch (err) {
    // Defense-in-depth: adapter contract says always resolve, but a
    // contract violation shouldn't break the dispatcher.
    result = {
      channel,
      status: 'failed',
      caseId: '',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }

  // Persist the outcome — create if first encounter, update if a
  // concurrent retry beat us to the create.
  const now = new Date().toISOString();
  const row = {
    channel,
    caseId: result.caseId,
    status: result.status,
    externalUrl: result.externalUrl,
    error: result.error,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await repo.createChannelCase(key, row);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Race condition with a parallel write. Fall back to update.
      await repo.updateChannelCase(key, channel, {
        status: result.status,
        caseId: result.caseId,
        externalUrl: result.externalUrl,
        error: result.error,
        updatedAt: now,
      });
    } else {
      throw err;
    }
  }

  return result.status === 'delivered'
    ? { kind: 'delivered', result }
    : { kind: 'failed', result };
};

/**
 * Node 4 — execute tools. Reads event/severity/routing/narratives;
 * orchestrates per-channel dispatch via `Promise.allSettled` for
 * failure isolation; aggregates outcomes into `DispatchResult`; emits
 * metrics.
 *
 * The repository singleton + the per-channel registry are read at
 * call time so test seams (`__resetCaseRepo`, jest.mock on
 * CHANNEL_HANDLERS) can swap them cleanly.
 */
const executeToolsNode = async (
  state: typeof AlertGraphAnnotation.State,
): Promise<Partial<typeof AlertGraphAnnotation.State>> => {
  if (
    state.severity === undefined ||
    state.routing === undefined ||
    state.narratives === undefined
  ) {
    throw new Error(
      'executeToolsNode invoked without severity/routing/narratives — graph wiring error.',
    );
  }

  const key: CaseNaturalKey = {
    sensorId: state.event.sensorId,
    timestamp: state.event.timestamp,
    readingType: state.event.readingType,
  };

  const repo = getCaseRepository();

  // Ensure the metadata row exists. Idempotent — safe under retries.
  await ensureMetadata(repo, key, state.severity);

  // Determine which channels routing selected.
  const selectedChannels = (
    Object.entries(state.routing.channels) as Array<[CaseSystem, boolean]>
  )
    .filter(([, selected]) => selected)
    .map(([channel]) => channel);

  // Dispatch all channels in parallel with per-channel failure isolation.
  const settled = await Promise.allSettled(
    selectedChannels.map((channel) =>
      dispatchChannel(
        repo,
        key,
        channel,
        state.event,
        state.severity as Severity,
        state.narratives as Narratives,
      ),
    ),
  );

  // Aggregate outcomes.
  const dispatchResult: DispatchResult = {
    delivered: [],
    failed: [],
    skipped: [],
  };

  settled.forEach((settledOutcome, i) => {
    if (settledOutcome.status === 'fulfilled') {
      const outcome = settledOutcome.value;
      switch (outcome.kind) {
        case 'delivered':
          dispatchResult.delivered.push(outcome.result);
          break;
        case 'failed':
          dispatchResult.failed.push(outcome.result);
          break;
        case 'skipped':
          dispatchResult.skipped.push(outcome.skip);
          break;
      }
    } else {
      // dispatchChannel itself rejected. Defense-in-depth path —
      // dispatchChannel's contract is to always resolve, so this is a
      // bug-level path. Capture as a failed result + log.
      const channel = selectedChannels[i];
      logger.error('dispatchChannel rejected unexpectedly', {
        channel,
        sensorId: state.event.sensorId,
        error:
          settledOutcome.reason instanceof Error
            ? settledOutcome.reason.message
            : String(settledOutcome.reason),
      });
      dispatchResult.failed.push({
        channel,
        status: 'failed',
        caseId: '',
        error:
          settledOutcome.reason instanceof Error
            ? settledOutcome.reason.message
            : String(settledOutcome.reason),
        latencyMs: 0,
      });
    }
  });

  emitDispatchMetrics(dispatchResult);

  logger.info('Alert dispatch complete', {
    sensorId: state.event.sensorId,
    delivered: dispatchResult.delivered.map((r) => r.channel),
    failed: dispatchResult.failed.map((r) => r.channel),
    skipped: dispatchResult.skipped.map((s) => `${s.channel}:${s.reason}`),
  });

  return { dispatchResult };
};

// =============================================================================
//  Graph assembly + runtime entry point
// =============================================================================

/**
 * Compile the graph once at module load. Reused across warm
 * invocations of the alert handler.
 */
function buildGraph() {
  const graph = new StateGraph(AlertGraphAnnotation)
    .addNode('classifySeverity', classifySeverityNode)
    .addNode('determineRouting', determineRoutingNode)
    .addNode('generateNarratives', generateNarrativesNode)
    .addNode('executeTools', executeToolsNode)
    .addEdge(START, 'classifySeverity')
    .addEdge('classifySeverity', 'determineRouting')
    .addEdge('determineRouting', 'generateNarratives')
    .addEdge('generateNarratives', 'executeTools')
    .addEdge('executeTools', END);

  return graph.compile();
}

/**
 * Run the alert graph end-to-end. Returns the final state with all
 * fields populated; throws if any node throws.
 *
 * @param event The validated SensorEvent that breached a threshold.
 * @returns Final graph state — event, severity, routing, narratives,
 *          dispatchResult.
 * @throws Whatever Bedrock / parse / wiring error propagated from a
 *         node. Caller handles fail-soft fallback.
 */
export const runAlertGraph = async (
  event: SensorEvent,
): Promise<AlertGraphState> => {
  const graph = getGraph();
  const result = await graph.invoke({ event });

  if (
    result.severity === undefined ||
    result.routing === undefined ||
    result.narratives === undefined ||
    result.dispatchResult === undefined
  ) {
    throw new Error(
      'alertGraph completed but final state is incomplete — graph runtime error.',
    );
  }

  return {
    event: result.event,
    severity: result.severity,
    routing: result.routing,
    narratives: result.narratives,
    dispatchResult: result.dispatchResult,
  };
};
