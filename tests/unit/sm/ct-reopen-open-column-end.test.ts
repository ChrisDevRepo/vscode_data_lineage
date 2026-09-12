/**
 * A column committed at one hop stays owed until some hop accounts for it — the T8 chain
 * termination, reproduced offline.
 *
 * On the recorded run (`test-results/e2e/ib-4-fireworks/run-T8`) the walk reached
 * `[ai].[spcleanorders]` early, carrying only the display column the hop that routed it named. The
 * amount column arrived three hops later, when `[ai].[vwraworders]` committed
 * `cleanedorders.OrderAmount` and routed the table it came from: that table is non-bodied, so the
 * question contracted onto its writer — already visited, therefore skipped. The column was dropped
 * at the one node that could say where it came from, `active_columns` emptied, and every node past
 * it (`spimportorders`, `vwexternalorders`) was accepted with `column_flow: []` because the
 * completeness check had nothing left to demand. Seven edges instead of eleven, and both delivered
 * channels still claimed the chain reached the external sources.
 *
 * The visited guard is a BB rule and correct for the same question; here the question is a new one.
 * The pin is the outcome, not the mechanism: the chain reaches the terminal source, and the hop
 * that reopens is dispatched with the amount column active so the completeness check demands it.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[ai].[vwdiscountcalc]';
const STAGING = '[ai].[salesstaging]';
const LOADER = '[ai].[sploadsalesstaging]';
const RAW_VIEW = '[ai].[vwraworders]';
const CLEANED = '[ai].[cleanedorders]';
/** Visited early for the display column, and the sole writer of {@link CLEANED}. */
const CLEANER = '[ai].[spcleanorders]';
/** The terminal source the delivered answer claimed to reach. */
const IMPORT = '[ai].[raworderimport]';
const CUSTOMER = '[ai].[customermaster]';

const TRACED = 'Discount';
const AMOUNT = 'OrderAmount';
const RAW_AMOUNT = 'RawAmount';
/** A display-only dead end — the column the early hop at {@link CLEANER} was dispatched with. */
const TIER = 'CustomerTier';

const NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  [ORIGIN, 'view', [TRACED]],
  [STAGING, 'table', [AMOUNT]],
  [LOADER, 'procedure', []],
  [RAW_VIEW, 'view', [AMOUNT]],
  [CLEANED, 'table', [AMOUNT]],
  [CLEANER, 'procedure', []],
  [IMPORT, 'table', [RAW_AMOUNT]],
  [CUSTOMER, 'table', [TIER]],
];

/** Producer → consumer, the direction the graph stores data flow in. */
const EDGES: ReadonlyArray<readonly [string, string]> = [
  [STAGING, ORIGIN],
  [CUSTOMER, ORIGIN],
  [LOADER, STAGING],
  [RAW_VIEW, LOADER],
  [CLEANED, RAW_VIEW],
  [CLEANER, CLEANED],
  [CUSTOMER, CLEANER],
  [IMPORT, CLEANER],
];

function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = NODES.map(([id, type, columns]) => {
    const [, schema, name] = /^\[([^\]]+)\]\.\[([^\]]+)\]$/.exec(id) ?? ['', 'ai', id];
    return makeNode({
      id, schema, name, type,
      columns: columns.map(columnName => ({ name: columnName, type: 'decimal', nullable: 'NULL', extra: '' })),
    });
  });
  const edgePairs = EDGES.map(([source, target]) => [source, target] as [string, string]);
  return { model: makeModel(nodes, edgePairs, ['ai']), graph: makeGraph(nodes, edgePairs) };
}

type Flow = NonNullable<Parameters<NavigationEngine['submitFindings']>[0]['column_flow']>;
type Routes = NonNullable<Parameters<NavigationEngine['submitFindings']>[0]['route_requests']>;

/** What each bodied focus states about the columns it is dispatched with. */
function scriptFor(focusId: string, active: readonly string[]): { flow: Flow; routes: Routes } {
  if (focusId === ORIGIN) {
    return {
      flow: [{
        out_col: TRACED,
        upstream_columns: [{ node: STAGING, col: AMOUNT }, { node: CUSTOMER, col: TIER }],
      }],
      routes: [
        { nodeId: STAGING, question: `Where does ${STAGING}.${AMOUNT} come from?`, columns: [AMOUNT] },
        { nodeId: CUSTOMER, question: `Where does ${CUSTOMER}.${TIER} come from?`, columns: [TIER] },
      ],
    };
  }
  if (focusId === LOADER) {
    return {
      flow: [{
        out_col: AMOUNT,
        upstream_columns: [{ node: RAW_VIEW, col: AMOUNT }],
        writes_to: { node: STAGING, col: AMOUNT },
      }],
      routes: [{ nodeId: RAW_VIEW, question: `Where does ${RAW_VIEW}.${AMOUNT} come from?`, columns: [AMOUNT] }],
    };
  }
  if (focusId === RAW_VIEW) {
    return {
      flow: [{ out_col: AMOUNT, upstream_columns: [{ node: CLEANED, col: AMOUNT }] }],
      routes: [{ nodeId: CLEANED, question: `Where does ${CLEANED}.${AMOUNT} come from?`, columns: [AMOUNT] }],
    };
  }
  if (focusId === CLEANER) {
    // The early visit carries the display column alone; the reopened one carries the amount and is
    // the only hop that can name its source.
    return active.includes(AMOUNT)
      ? {
        flow: [{
          out_col: AMOUNT,
          upstream_columns: [{ node: IMPORT, col: RAW_AMOUNT }],
          writes_to: { node: CLEANED, col: AMOUNT },
        }],
        routes: [{ nodeId: IMPORT, question: `Is ${IMPORT}.${RAW_AMOUNT} the terminal source?`, columns: [RAW_AMOUNT] }],
      }
      : {
        flow: [{ out_col: TIER, upstream_columns: [{ node: CUSTOMER, col: TIER }] }],
        routes: [{ nodeId: CUSTOMER, question: `Is ${CUSTOMER}.${TIER} a stored base value?`, columns: [TIER] }],
      };
  }
  throw new Error(`no script for focus ${focusId}`);
}

/** Runs the whole exploration, returning the active column set each hop was dispatched with. */
function walk(engine: NavigationEngine): Map<string, string[][]> {
  const dispatched = new Map<string, string[][]>();
  for (let hop = 0; hop < 30; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return dispatched;
    const focusId = ctx.focus_node.id;
    const active = [...(engine.columnAspect?.active_columns ?? [])];
    const seen = dispatched.get(focusId);
    if (seen) seen.push(active); else dispatched.set(focusId, [active]);

    const { flow, routes } = scriptFor(focusId, active);
    // BB neighbor completeness applies to every CT hop: account for the required neighbors the
    // script does not already name, with no column opinion.
    const named = new Set(routes.map(route => route.nodeId));
    for (const id of engine.requiredNeighborIds(focusId)) {
      if (!named.has(id)) routes.push({ nodeId: id, question: `What does ${id} do on this path?` });
    }
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} on the ${TRACED} path`,
      verdict: 'analyze',
      column_flow: flow,
      route_requests: routes,
    });
    expect('error' in outcome, `hop ${hop} at ${focusId} is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not complete within 30 hops');
}

function startEngine(): NavigationEngine {
  const { model, graph } = buildWorld();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: ORIGIN,
    question: `Trace the ${TRACED} column in ${ORIGIN} back to its original sources`,
    direction: 'bidirectional',
    analysisMode: 'ct',
    targetColumns: [TRACED],
    depthIntent: { kind: 'full_frontier' },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);
  return engine;
}

describe('CT chain — a committed column outranks the visited flag of the node that produces it', () => {
  it('reopens the producer visited before the column reached it, and reaches the terminal source', () => {
    const engine = startEngine();
    const dispatched = walk(engine);

    const dispatchesAtCleaner = dispatched.get(CLEANER) ?? [];
    expect(
      dispatchesAtCleaner.some(active => active.includes(AMOUNT)),
      `${CLEANER} is dispatched with the amount column active, so the completeness check demands it`
        + ` (dispatched with ${JSON.stringify(dispatchesAtCleaner)})`,
    ).toBe(true);

    const edges = engine.columnAspect?.edges ?? [];
    expect(
      edges.some(edge => edge.from_node === IMPORT && edge.from_col === RAW_AMOUNT),
      `the chain reaches ${IMPORT} (edges: ${JSON.stringify(edges.map(e => `${e.from_node}.${e.from_col}→${e.to_node}.${e.to_col}`))})`,
    ).toBe(true);
  });

  it('reopens each producer at most once per column, so the walk still terminates', () => {
    const engine = startEngine();
    const dispatched = walk(engine);

    for (const [nodeId, dispatches] of dispatched) {
      const distinct = new Set(dispatches.map(active => [...active].sort().join('|')));
      expect(distinct.size, `${nodeId} is never dispatched twice for the same column set`).toBe(dispatches.length);
      expect(dispatches.length, `${nodeId} is dispatched once per column question, not repeatedly`)
        .toBeLessThanOrEqual(2);
    }
  });
});
