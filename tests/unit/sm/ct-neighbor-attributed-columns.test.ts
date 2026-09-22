/**
 * A hop's neighbour list discloses what committed `column_flow` edges already attribute to each
 * neighbour, before the model states a `route_requests[].columns` decision for it.
 *
 * `routeCarryFor` (src/ai/sm/smBase.ts) silently upgrades a stated `columns: 'none'` to a carry
 * when a committed `column_flow` edge already attributes a traced column to that node — the model
 * cannot see the conflict coming because the attributed set was never on the hop context it
 * decided from. `neighbors[].attributed_columns` makes that set visible: the same spine read
 * `routeCarryFor` uses (`ColumnTracer.determineActiveColumnsForCandidate`), surfaced per neighbour
 * instead of applied only at the moment a route is accepted.
 *
 * Purely additive disclosure — this file does not exercise the override itself, only that the
 * fact the override later acts on is now visible one hop earlier.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/** The neighbour shape this file asserts on: the published fields plus the new disclosure. */
interface DisclosedNeighbor {
  id: string;
  attributed_columns?: string[];
}

const ORIGIN = '[dbo].[origin]';
const HUB = '[dbo].[hub]';
const SUP = '[dbo].[sup]';
const OTHER = '[dbo].[other]';
const OUT_COL = 'Amount';
const SUP_COL = 'RawAmount';

/**
 * origin <- hub <- sup, hub <- other. `sup` supplies `origin`'s traced column directly in the
 * origin hop's own `column_flow`, naming a node one hop further out than the focus — a real CT
 * shape (the model may know the ultimate source before visiting the node between). `other` is an
 * ordinary sibling upstream of `hub` that no hop ever names.
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: ORIGIN, schema: 'dbo', name: 'origin', type: 'view', columns: [{ name: OUT_COL, type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: HUB, schema: 'dbo', name: 'hub', type: 'view' }),
    makeNode({ id: SUP, schema: 'dbo', name: 'sup', type: 'table', columns: [{ name: SUP_COL, type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: OTHER, schema: 'dbo', name: 'other', type: 'view' }),
  ];
  const edgePairs: Array<[string, string]> = [[HUB, ORIGIN], [SUP, HUB], [OTHER, HUB]];
  return { model: makeModel(nodes, edgePairs, ['dbo']), graph: makeGraph(nodes, edgePairs) };
}

/** Initializes a CT engine at `ORIGIN` and drives it to the `HUB` hop, `sup`'s attribution staged. */
function engineAtHub(): NavigationEngine {
  const { model, graph } = buildWorld();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({
    origin: ORIGIN,
    question: `Trace the ${OUT_COL} column in ${ORIGIN} back to its original sources`,
    direction: 'upstream',
    analysisMode: 'ct',
    targetColumns: [`${ORIGIN}.[${OUT_COL}]`],
    depthIntent: { kind: 'explicit', levels: 3 },
  });

  const ctx = engine.getHopContext() as { focus_node?: { id: string } };
  expect(ctx.focus_node?.id, 'first focus is the seed').toBe(ORIGIN);

  const outcome = engine.submitFindings({
    focus_node_id: ORIGIN,
    sections: [{ angle: 'business' as const, text: `${ORIGIN} computes ${OUT_COL} from ${SUP}` }],
    summary: 'origin',
    verdict: 'analyze',
    column_flow: [{
      out_col: OUT_COL,
      upstream_columns: [{ node: SUP, col: SUP_COL }],
    }],
    route_requests: [{ nodeId: HUB, question: 'what does hub do with the value?', columns: 'none' }],
  });
  expect('error' in outcome, `the origin hop is accepted: ${JSON.stringify(outcome)}`).toBe(false);

  return engine;
}

describe('hop_context.neighbors[] discloses columns a committed column_flow edge already attributed', () => {
  it('shows the attributed column on the named neighbour, and nothing on an untouched sibling', () => {
    const engine = engineAtHub();
    const ctx = engine.getHopContext() as { focus_node?: { id: string }; neighbors?: DisclosedNeighbor[] };
    expect(ctx.focus_node?.id, 'second focus is hub, the sole explicit route').toBe(HUB);

    const byId = new Map((ctx.neighbors ?? []).map((n) => [n.id, n]));
    expect(Array.from(byId.keys()).sort(), 'hub offers sup, other, and origin (now visited)').toEqual([ORIGIN, OTHER, SUP].sort());

    const sup = byId.get(SUP)!;
    expect(sup.attributed_columns, "origin's column_flow named sup as the supplier of Amount before this hop").toEqual([SUP_COL]);

    const other = byId.get(OTHER)!;
    expect(other.attributed_columns, 'no hop has ever named other in a column_flow entry').toBeUndefined();

    const origin = byId.get(ORIGIN)!;
    expect(origin.attributed_columns, 'origin is the edge\'s to_node, not a from_node supplier, so it carries nothing here').toBeUndefined();
  });

  it('discloses nothing in BB mode — no column channel to read from', () => {
    const nodes: LineageNode[] = [
      makeNode({ id: ORIGIN, schema: 'dbo', name: 'origin', type: 'view' }),
      makeNode({ id: HUB, schema: 'dbo', name: 'hub', type: 'view' }),
    ];
    const edgePairs: Array<[string, string]> = [[HUB, ORIGIN]];
    const model = makeModel(nodes, edgePairs, ['dbo']);
    const graph = makeGraph(nodes, edgePairs);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: ORIGIN,
      question: 'Trace origin back to its sources',
      direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });

    const ctx = engine.getHopContext() as { neighbors?: DisclosedNeighbor[] };
    expect((ctx.neighbors ?? []).length, 'hub is a neighbour of the BB seed').toBeGreaterThan(0);
    for (const neighbor of ctx.neighbors ?? []) {
      expect(neighbor.attributed_columns, `BB neighbour ${neighbor.id} carries no column channel at all`).toBeUndefined();
    }
  });
});
