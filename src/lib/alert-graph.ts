/**
 * LangGraph assembly for the alert flow (P8.5).
 *
 * Wires the three plain-function nodes from P8.3 + P8.4 into a single
 * `StateGraph` that runs inside the alert handler Lambda:
 *
 *   START → classifySeverity → determineRouting → generateNarratives → END
 *
 * Each node is a thin wrapper that:
 *   1. Reads the relevant fields from the graph state.
 *   2. Calls the lib function (which uses `invokeStructured` against
 *      Bedrock).
 *   3. Returns a partial state update with just the field it produced.
 *
 * Why linear (no conditional edges) right now:
 *   The 3-node flow is intentionally simple at P8.5. P9 expands this
 *   with conditional branching (severity-driven tool-call selection)
 *   and an "execute tools" node. The linear shape demonstrates the
 *   primitive cleanly; the conditional shape demonstrates the
 *   primitive's payoff. Establishing the framework now means the P9
 *   additions are additive, not a refactor.
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
});

/**
 * Final shape returned by `alertGraph.invoke()`. Same fields as the
 * annotation but with `event` always present (was the input) and the
 * three LLM-produced fields guaranteed populated on success.
 */
export type AlertGraphState = {
  event: SensorEvent;
  severity: Severity;
  routing: RoutingPlan;
  narratives: Narratives;
};

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

/**
 * Compile the graph once at module load. Reused across warm
 * invocations of the alert handler.
 */
const buildGraph = () => {
  const graph = new StateGraph(AlertGraphAnnotation)
    .addNode('classifySeverity', classifySeverityNode)
    .addNode('determineRouting', determineRoutingNode)
    .addNode('generateNarratives', generateNarrativesNode)
    .addEdge(START, 'classifySeverity')
    .addEdge('classifySeverity', 'determineRouting')
    .addEdge('determineRouting', 'generateNarratives')
    .addEdge('generateNarratives', END);

  return graph.compile();
};

let _graph: ReturnType<typeof buildGraph> | undefined;

const getGraph = (): ReturnType<typeof buildGraph> => {
  if (_graph === undefined) {
    _graph = buildGraph();
  }
  return _graph;
};

/**
 * Test-only seam — resets the compiled-graph singleton so a test can
 * mock module-level dependencies and reinitialize cleanly. Production
 * code never calls.
 */
export const __resetGraph = (): void => {
  _graph = undefined;
};

/**
 * Run the alert graph end-to-end. Returns the final state with all
 * fields populated; throws if any node throws.
 *
 * @param event The validated SensorEvent that breached a threshold.
 * @returns Final graph state — event, severity, routing, narratives.
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
    result.narratives === undefined
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
  };
};
