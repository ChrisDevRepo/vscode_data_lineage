/**
 * {@link NavigationEngine.requiredNeighborIds} (smBase.ts) demands an account (route or prune) for
 * every admittable current-hop neighbor, whether or not it has already entered scope — the demand
 * is derived from `admitsRoute` alone, never gated on prior scope membership. Under
 * `depthEnforcement: 'silent'` (the production default for an omitted depth — see
 * `depth-derivation-silent.test.ts`), `admitsRoute` never refuses on depth, so an admittable
 * neighbor one hop past the initial BFS seed is exactly the shape this guards: a finding that names
 * such a neighbor as a source without routing or pruning it must be refused, not silently dropped.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

// n0 → n1 → n2 → n3 → n4 → n5, one schema, downstream direction. `default_start` seeds depth 3
// (n0..n3, matching DEFAULT_SM_START_DEPTH); n4 sits one hop past the seed — same shape as
// `vwraworders` one hop past `sploadsalesstaging`'s reached scope.
function buildChain(withColumns: boolean): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const col = (name: string) => (withColumns ? [{ name, type: 'int', nullable: 'NULL' as const, extra: '' }] : undefined);
  const nodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view', columns: col(i === 0 ? 'X' : 'Y') }),
  );
  const edges: Array<[string, string]> = [
    ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'],
  ];
  return { model: makeModel(nodes, edges, ['dbo']), graph: makeGraph(nodes, edges) };
}

/** Walks the engine hop-by-hop from `path[0]` to `path[path.length - 1]`, routing forward one node at a time. */
function advanceTo(engine: NavigationEngine, path: string[]): void {
  for (let i = 0; i < path.length - 1; i++) {
    const ctx = engine.getHopContext() as { focus_node?: { id: string } };
    expect(ctx.focus_node?.id === path[i], `focus at step ${i} is ${path[i]}, got ${ctx.focus_node?.id}`).toBe(true);
    const result = engine.submitFindings({
      focus_node_id: path[i],
      sections: [{ angle: 'business' as const, text: `analysis for ${path[i]}` }],
      summary: path[i],
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: path[i + 1], question: 'follow the chain forward' }],
    }) as { error?: string };
    expect(!('error' in result), `hop for ${path[i]} commits: ${JSON.stringify(result)}`).toBe(true);
  }
  const finalCtx = engine.getHopContext() as { focus_node?: { id: string } };
  expect(finalCtx.focus_node?.id === path[path.length - 1], `final focus is ${path[path.length - 1]}`).toBe(true);
}

describe('required-neighbor completeness reaches an admittable out-of-scope neighbor (BB)', () => {
  it('a finding naming n4 as a source but not routing it is refused — the obligation fires', () => {
    const { model, graph } = buildChain(false);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });
    advanceTo(engine, ['n0', 'n1', 'n2', 'n3']);

    const before = engine.toJSON();
    expect(!before.scopeNodeIds.includes('n4'), 'n4 has not yet entered scope at n3').toBe(true);

    const rejection = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [{ angle: 'business' as const, text: 'n3 reads its rows from n4, the upstream source' }],
      summary: 'n3 sources from n4 but nothing routes it',
      verdict: 'analyze',
      // route_requests deliberately omits n4, the neighbor the prose just named.
      route_requests: [],
    }) as { error?: string; detail?: Array<{ id?: string }> };

    expect('error' in rejection, `naming n4 without routing it must be rejected, got ${JSON.stringify(rejection)}`).toBe(true);
    expect(rejection.error === 'missing_required_route', `rejection code is missing_required_route, got ${rejection.error}`).toBe(true);
    const ids = (rejection.detail ?? []).map(d => d.id);
    expect(ids.includes('n4'), `n4 is named in the rejection detail, got ${JSON.stringify(ids)}`).toBe(true);
  });

  it('a finding that routes what it names commits normally — unaffected', () => {
    const { model, graph } = buildChain(false);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });
    advanceTo(engine, ['n0', 'n1', 'n2', 'n3']);

    const committed = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [{ angle: 'business' as const, text: 'n3 reads its rows from n4, the upstream source' }],
      summary: 'n3 sources from n4 and routes it',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'n4', question: 'what does n4 supply to n3?' }],
    }) as { error?: string };

    expect(!('error' in committed), `routing the named neighbor commits, got ${JSON.stringify(committed)}`).toBe(true);
    const after = engine.toJSON();
    expect(after.scopeNodeIds.includes('n4'), 'n4 enters scope once routed').toBe(true);
  });
});

describe('required-neighbor completeness reaches an admittable out-of-scope neighbor (CT)', () => {
  it('CT: a finding naming n4 as a source but not routing it is refused — the obligation fires unconditionally', () => {
    const { model, graph } = buildChain(true);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'n0', question: 'trace X', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['X'],
      depthIntent: { kind: 'default_start' },
    });
    expect('ok' in init, `CT init succeeds, got ${JSON.stringify(init)}`).toBe(true);

    const focus0 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus0.focus_node?.id === 'n0', 'first focus is origin n0').toBe(true);
    // n0 is the only node declaring X; ending the column chain here (upstream_columns: []) keeps
    // every later hop's active-column set empty, so only route completeness is under test below.
    const hop0 = engine.submitFindings({
      focus_node_id: 'n0',
      sections: [{ angle: 'business' as const, text: 'n0 is the source of X' }],
      summary: 'n0 sources X',
      verdict: 'analyze',
      column_flow: [{ out_col: 'X', upstream_columns: [] }],
      route_requests: [{ nodeId: 'n1', question: 'follow the chain forward' }],
    }) as { error?: string };
    expect(!('error' in hop0), `hop0 commits: ${JSON.stringify(hop0)}`).toBe(true);
    advanceTo(engine, ['n1', 'n2', 'n3']);

    const before = engine.toJSON();
    expect(!before.scopeNodeIds.includes('n4'), 'n4 has not yet entered scope at n3').toBe(true);

    const rejection = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [{ angle: 'business' as const, text: 'n3 reads its rows from n4, the upstream source' }],
      summary: 'n3 sources from n4 but nothing routes it',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [],
    }) as { error?: string; detail?: Array<{ id?: string }> };

    expect('error' in rejection, `naming n4 without routing it must be rejected in CT too, got ${JSON.stringify(rejection)}`).toBe(true);
    expect(rejection.error === 'missing_required_route', `rejection code is missing_required_route, got ${rejection.error}`).toBe(true);
    const ids = (rejection.detail ?? []).map(d => d.id);
    expect(ids.includes('n4'), `n4 is named in the rejection detail, got ${JSON.stringify(ids)}`).toBe(true);
  });

  it('CT: a finding that routes what it names commits normally — unaffected', () => {
    const { model, graph } = buildChain(true);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'n0', question: 'trace X', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['X'],
      depthIntent: { kind: 'default_start' },
    });
    expect('ok' in init, `CT init succeeds, got ${JSON.stringify(init)}`).toBe(true);
    const focus0 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus0.focus_node?.id === 'n0', 'first focus is origin n0').toBe(true);
    const hop0 = engine.submitFindings({
      focus_node_id: 'n0',
      sections: [{ angle: 'business' as const, text: 'n0 is the source of X' }],
      summary: 'n0 sources X',
      verdict: 'analyze',
      column_flow: [{ out_col: 'X', upstream_columns: [] }],
      route_requests: [{ nodeId: 'n1', question: 'follow the chain forward' }],
    }) as { error?: string };
    expect(!('error' in hop0), `hop0 commits: ${JSON.stringify(hop0)}`).toBe(true);
    advanceTo(engine, ['n1', 'n2', 'n3']);

    const committed = engine.submitFindings({
      focus_node_id: 'n3',
      sections: [{ angle: 'business' as const, text: 'n3 reads its rows from n4, the upstream source' }],
      summary: 'n3 sources from n4 and routes it',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: 'n4', question: 'what does n4 supply to n3?' }],
    }) as { error?: string };

    expect(!('error' in committed), `routing the named neighbor commits in CT too, got ${JSON.stringify(committed)}`).toBe(true);
    const after = engine.toJSON();
    expect(after.scopeNodeIds.includes('n4'), 'n4 enters scope once routed').toBe(true);
  });
});
