/**
 * P1-104 / D-048 — the deferred CT completeness fault reaches the second-pass envelope.
 *
 * `submitFindings` computes two independent faults from one payload at a script-type (no
 * declared-column) focus: a topology fault (a required neighbor left unrouted, unpruned —
 * `missing_required_route`) and a CT completeness fault (a tracked column left unaccounted —
 * `column_chain_incomplete`, deferred half: the focus declares none of the active columns, so
 * `contradicted` is empty and the hoisted/contradicted branch never fires). Before the repair,
 * the second pass returned only the topology fault and discarded the already-computed CT fault,
 * so the model spent turn 5 on the topology repair and turn 6 re-deriving the CT fault from
 * scratch — one payload, two turns, exactly the D-048 T8S shape that ends a run `hollow` once a
 * third payload spends the last breaker trip. This test submits that one payload and asserts both
 * faults are named in the single envelope it produces.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[ai].[vwdiscountcalc]';
const SOURCE = '[ai].[salesstaging]';
// A procedure exposes no column surface, so `declaredActiveColumns` is empty at this focus and an
// unaccounted tracked column takes the deferred (uncontradicted) branch, not the hoisted one.
const CONSUMER = '[ai].[spbuildsalesreport]';
// Downstream of CONSUMER, so it is a required neighbor at CONSUMER's hop — left unrouted and
// unpruned, it is the topology fault riding along with the CT fault in the same payload.
const SINK = '[ai].[vwsalesreportsink]';
const DECLARED = 'Discount';

const NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  [ORIGIN, 'view', [DECLARED]],
  [SOURCE, 'table', ['OrderAmount']],
  [CONSUMER, 'procedure', []],
  [SINK, 'view', []],
];
const EDGES: ReadonlyArray<readonly [string, string]> = [
  [SOURCE, ORIGIN],
  [ORIGIN, CONSUMER],
  [CONSUMER, SINK],
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
      route_requests: [...new Set([...engine.requiredNeighborIds(ORIGIN), CONSUMER])].map(id => ({
        nodeId: id, question: `What does ${id} do with ${DECLARED}?`,
      })),
    });
    expect('error' in outcome, `the origin hop is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not reach the consumer within 10 hops');
}

describe('CT deferred completeness fault merges with a topology fault (P1-104 / D-048)', () => {
  it('one payload carrying both faults is rejected once, naming both — not a topology-only envelope', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: ORIGIN,
      question: `Trace the ${DECLARED} column in ${ORIGIN} back to its sources and list its direct consumers`,
      direction: 'bidirectional',
      analysisMode: 'ct',
      targetColumns: [DECLARED],
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    walkToConsumer(engine);

    // Sanity: CONSUMER really does have a required neighbor (SINK) at this hop, so leaving
    // route_requests empty is a real topology fault, not a vacuous one.
    expect(engine.requiredNeighborIds(CONSUMER), 'CONSUMER has SINK as a required neighbor').toContain(SINK);

    // Both faults true in one payload: column_flow:[] with verdict:'analyze' (not 'passthrough')
    // leaves the tracked column unaccounted without declaring it, and route_requests:[] leaves the
    // required neighbor SINK neither routed nor pruned.
    const rejection = engine.submitFindings({
      focus_node_id: CONSUMER,
      sections: [{ angle: 'business' as const, text: `capture for ${CONSUMER}` }],
      summary: `${CONSUMER} inspected`,
      verdict: 'analyze',
      column_flow: [],
      route_requests: [],
    });

    expect('error' in rejection, 'the two-fault payload is rejected').toBe(true);
    if (!('error' in rejection)) return;
    const hint = String(rejection.hint ?? '');
    const detail = JSON.stringify(rejection.detail ?? '');
    // The topology fault (SINK unaccounted) is named — this alone already passed before the fix.
    expect(hint.includes('route_requests') || detail.includes(SINK), 'the topology fault is named').toBe(true);
    // The CT completeness fault (the deferred, already-computed `ctUnaccountedColumns`) must reach
    // this SAME envelope rather than being discarded by the early return — this is the repair.
    expect(
      rejection.error === 'column_chain_incomplete' || hint.includes('column_flow') || detail.includes(DECLARED),
      'the deferred CT completeness fault is named in the SAME envelope as the topology fault, not discarded',
    ).toBe(true);
    // Precisely: both facts are present together, not one substituting for the other.
    expect(detail.includes(SINK) && detail.includes(DECLARED), 'both faults are present in one envelope').toBe(true);
  });
});
