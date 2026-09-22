/**
 * One submission, one rejection: every fault a payload carries is named at once.
 *
 * `submitFindings` computes two independent faults from one payload at a script-type (no
 * declared-column) focus: a column-reference fault (`column_flow[].out_col` names a column the
 * trace does not follow) and a CT completeness fault (the tracked column left unaccounted —
 * `column_chain_incomplete`, deferred half: the focus declares none of the active columns, so
 * `contradicted` is empty).
 *
 * These two used to cascade. The reference fault owned an immediate `return` ahead of the
 * completeness guard, so the model repaired the column name, resubmitted, and was told about the
 * chain — two generations for one payload the engine had fully evaluated the first time. Both
 * faults must now reach the same envelope, and because both are field-scoped the authored prose
 * stays held across the co-report: a second fault riding along must not cost a re-author.
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
// A column the focus could plausibly carry but the trace does not follow: the reference fault.
const UNTRACKED = 'Rebate';

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
      }],
      route_requests: [...new Set([...engine.requiredNeighborIds(ORIGIN), CONSUMER])].map(id => ({
        nodeId: id, question: `What does ${id} do with ${DECLARED}?`,
        columns: id === CONSUMER ? [DECLARED] : ['OrderAmount'],
      })),
    });
    expect('error' in outcome, `the origin hop is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not reach the consumer within 10 hops');
}

describe('CT completeness and column-reference faults share one envelope', () => {
  it('one payload carrying both faults is rejected once, naming both — not a reference-only envelope', () => {
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

    // Both faults true in one payload: the single column_flow entry names an out_col outside the
    // tracked set (a reference fault), and because no entry accounts for the tracked column, the
    // chain is left incomplete at a focus that declares none of the active columns.
    const rejection = engine.submitFindings({
      focus_node_id: CONSUMER,
      sections: [{ angle: 'business' as const, text: `capture for ${CONSUMER}` }],
      summary: `${CONSUMER} inspected`,
      verdict: 'analyze',
      column_flow: [{ out_col: UNTRACKED, upstream_columns: [] }],
      route_requests: [{ nodeId: SINK, question: `What does ${SINK} do with ${DECLARED}?` }],
    });

    expect('error' in rejection, 'the two-fault payload is rejected').toBe(true);
    if (!('error' in rejection)) return;
    const hint = String(rejection.hint ?? '');
    const detail = JSON.stringify(rejection.detail ?? '');
    // The reference fault is named — this alone already passed before the collapse.
    expect(detail.includes(UNTRACKED), 'the column-reference fault is named').toBe(true);
    // The completeness fault must reach this SAME envelope rather than being hidden behind the
    // reference fault's early return — this is the repair.
    expect(detail.includes(DECLARED), 'the completeness fault is named in the SAME envelope, not discarded').toBe(true);
    // Both families report their own detail under their own key, so neither substitutes for the other.
    const keyed = rejection.detail as { route?: unknown; column_chain?: unknown };
    expect(keyed.route !== undefined && keyed.column_chain !== undefined, 'each family keeps its own detail key').toBe(true);
    // Field-scoped on both sides, so the prose survives the co-report.
    expect(hint.includes('Your analysis is held'), 'a co-reported field-scoped set still holds the authored sections').toBe(true);
    expect(engine.heldFindingFocus, 'the draft is held at the focus for the sections:[] retry').toBe(CONSUMER);
  });
});
