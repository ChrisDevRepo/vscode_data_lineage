/**
 * One traced column, one active-column entry — the T8S hop-4 defect, reproduced offline.
 *
 * The entry classifier hands `start_exploration` the column as the user wrote it,
 * node-qualified (`[ai].[vwDiscountCalc].[Discount]`). The origin resolves that against its own
 * DDL and the agenda seed carries the declared name (`Discount`), but a later route onto the same
 * queued node arrives with no column opinion, so `agendaColumnsFor` pads the raw target spelling
 * back on and `AgendaManager.push` unions the two spellings by raw string identity. The next
 * bodied focus with no declared column surface — a procedure — passes both through unresolved and
 * `computeUnaccounted` then demands BOTH as an `out_col`, which no submission can satisfy: on the
 * recorded run (`test-results/e2e/m0-3b-fireworks/run-T8S`) every retry accounted for one spelling
 * and was rejected `column_chain_incomplete` for the other until the breaker fired.
 *
 * `[ai].[spBuildSalesReport]` has no `Discount` column of its own: it reads `dc.Discount` from the
 * view into a temp table, so the two entries are one column in two spellings, not two columns.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[ai].[vwdiscountcalc]';
const CONSUMER = '[ai].[spbuildsalesreport]';
const SOURCE = '[ai].[salesstaging]';
/** The spelling `detect_entry` extracted from "Trace the Discount column in [ai].[vwDiscountCalc]". */
const SEED_TARGET = '[ai].[vwDiscountCalc].[Discount]';
/** The name the origin's DDL declares — what every downstream comparison must use. */
const DECLARED = 'Discount';

const NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  [ORIGIN, 'view', [DECLARED]],
  [SOURCE, 'table', ['OrderAmount']],
  // A procedure exposes no column surface, so nothing bounds the set it is dispatched with.
  [CONSUMER, 'procedure', []],
];
const EDGES: ReadonlyArray<readonly [string, string]> = [
  [SOURCE, ORIGIN],
  [ORIGIN, CONSUMER],
];

function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = NODES.map(([id, type, columns]) => {
    const [, schema, name] = /^\[([^\]]+)\]\.\[([^\]]+)\]$/.exec(id) ?? ['', 'ai', id];
    return makeNode({
      id, schema, name, type,
      columns: columns.map(columnName => ({ name: columnName, type: 'int', nullable: 'NULL', extra: '' })),
    });
  });
  const edgePairs = EDGES.map(([source, target]) => [source, target] as [string, string]);
  return { model: makeModel(nodes, edgePairs, ['ai']), graph: makeGraph(nodes, edgePairs) };
}

/** Dispatches hops until `CONSUMER` is the focus, submitting the origin's scripted flow on the way. */
function walkToConsumer(engine: NavigationEngine): void {
  for (let hop = 0; hop < 10; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) throw new Error('the walk completed before reaching the consumer');
    if (ctx.focus_node.id === CONSUMER) return;
    expect(ctx.focus_node.id, 'only the origin precedes the consumer on this topology').toBe(ORIGIN);
    const outcome = engine.submitFindings({
      focus_node_id: ORIGIN,
      sections: [{ angle: 'business' as const, text: `capture for ${ORIGIN}` }],
      summary: `${ORIGIN} computes ${DECLARED}`,
      verdict: 'analyze',
      column_flow: [{
        out_col: DECLARED,
        upstream_columns: [{ node: SOURCE, col: 'OrderAmount' }],
        writes_to: { node: CONSUMER, col: DECLARED },
      }],
      // The consumer is routed explicitly and with no `columns` field, exactly as the recorded
      // run's model routed it — that is the `inherit` carry whose agenda pad re-adds the seed
      // spelling to an entry the origin already seeded with the declared name.
      route_requests: [...new Set([...engine.requiredNeighborIds(ORIGIN), CONSUMER])].map(id => ({
        nodeId: id, question: `What does ${id} do with ${DECLARED}?`,
      })),
    });
    expect('error' in outcome, `the origin hop is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not reach the consumer within 10 hops');
}

describe('CT active columns — a node-qualified seed and its declared name are one column', () => {
  it('dispatches the column-surface-less consumer with exactly one active column', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: ORIGIN,
      question: `Trace the ${DECLARED} column in ${SEED_TARGET} back to its original sources and list the objects that consume it`,
      direction: 'bidirectional',
      analysisMode: 'ct',
      targetColumns: [SEED_TARGET],
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    expect('ok' in init, 'CT init succeeds on the qualified seed spelling').toBe(true);

    walkToConsumer(engine);

    expect(
      engine.columnAspect?.active_columns,
      'the traced column is demanded once, under the name the origin declares',
    ).toEqual([DECLARED]);
  });

  it('accepts a flow that accounts for the traced column once', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: ORIGIN,
      question: `Trace the ${DECLARED} column in ${SEED_TARGET} back to its original sources and list the objects that consume it`,
      direction: 'bidirectional',
      analysisMode: 'ct',
      targetColumns: [SEED_TARGET],
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    walkToConsumer(engine);

    const outcome = engine.submitFindings({
      focus_node_id: CONSUMER,
      sections: [{ angle: 'business' as const, text: `capture for ${CONSUMER}` }],
      summary: `${CONSUMER} consumes ${DECLARED}`,
      verdict: 'analyze',
      column_flow: [{
        out_col: DECLARED,
        upstream_columns: [{ node: ORIGIN, col: DECLARED }],
      }],
      route_requests: engine.requiredNeighborIds(CONSUMER).map(id => ({
        nodeId: id, question: `What does ${id} decide about the rows ${CONSUMER} admits?`,
      })),
    });
    expect(outcome, 'one entry accounts for the one traced column').not.toHaveProperty('error');
  });
});
