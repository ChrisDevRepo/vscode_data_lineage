/**
 * GATE — CT committed column edges form one connected structure reaching the origin.
 *
 * Every existing orphan/connectivity test (`prune-would-orphan-endpoint.test.ts`,
 * `prune-orphans-undispositioned-node.test.ts`, `bidirectional-route-border-closure.test.ts`)
 * checks NODE topology: that the result's node set stays reachable from the origin under the
 * structural graph. None of them walk `engine.columnAspect.edges` — the committed column-lineage
 * chain is a separate graph over the same node ids, and a node can be structurally reachable from
 * the origin while its own column edges attach to nothing in that chain.
 *
 * Case 1 pins the invariant on a plain chain: every committed column edge's endpoints resolve to
 * one connected component, and that component contains the origin.
 *
 * Case 2 pins the fix for the defect this file was written to catch. `route_requests[].columns` is
 * now required on the CT submit schema — an omission cannot reach `submitFindings` through the tool
 * boundary at all. This case still exercises the engine's own defense one layer in, by calling
 * `submitFindings` directly (as every test in this file does) with a route that omits `columns`.
 * `routeCarryFor` (smBase.ts) reads that omission as `row_role_only`, never as "the session's traced
 * targets apply": the routed neighbor is dispatched with no active column at all, so a `column_flow`
 * entry it submits for the traced column name is rejected as `out_col_not_tracked` before any edge
 * stages. No detached component can form, because the node that would have anchored it is never
 * allowed to commit an edge in the first place.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ColumnEdge, HopFinding } from '../../../src/ai/sm/smTypes';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

/** One connected component of an undirected graph built from `edge.from_node`/`edge.to_node` pairs. */
function connectedComponents(edges: readonly ColumnEdge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const edge of edges) {
    find(edge.from_node);
    find(edge.to_node);
    union(edge.from_node, edge.to_node);
  }
  const groups = new Map<string, Set<string>>();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(node);
  }
  return [...groups.values()].map(members => [...members]);
}

function submit(
  engine: NavigationEngine,
  id: string,
  rest: Omit<HopFinding, 'focus_node_id' | 'sections' | 'summary'>,
): void {
  const outcome = engine.submitFindings({
    focus_node_id: id,
    sections: [{ angle: 'business' as const, text: `${id} body` }],
    summary: `${id} body`,
    ...rest,
  });
  expect((outcome as { error?: string }).error, `hop on ${id} must commit`).toBeUndefined();
}

describe('CT chain connectivity — the committed column-edge graph, not the node graph', () => {
  // report <- carrier <- vendor, all tracing `amount`. A plain three-hop chain.
  const CHAIN_NODES: LineageNode[] = ['report', 'carrier', 'vendor'].map(id =>
    makeNode({
      id, schema: 'dbo', name: id, type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    }),
  );
  const CHAIN_EDGES: Array<[string, string]> = [['carrier', 'report'], ['vendor', 'carrier']];
  const CHAIN_MODEL: DatabaseModel = makeModel(CHAIN_NODES, CHAIN_EDGES, ['dbo']);

  it('case 1: a plain CT chain commits one connected component containing the origin', () => {
    const engine = new NavigationEngine(CHAIN_MODEL, makeGraph(CHAIN_NODES, CHAIN_EDGES), () => {}, {});
    const init = engine.init({
      origin: 'report', question: 'trace amount', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['amount'],
      depthIntent: { kind: 'explicit', levels: 3 },
    });
    expect('ok' in init, `init must succeed (${'error' in init ? init.error : ''})`).toBe(true);

    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      if (id === 'report') {
        submit(engine, id, {
          verdict: 'passthrough',
          column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
        });
      } else if (id === 'carrier') {
        submit(engine, id, {
          verdict: 'passthrough',
          column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'vendor', col: 'amount' }] }],
        });
      } else if (id === 'vendor') {
        submit(engine, id, {
          verdict: 'passthrough',
          column_flow: [{ out_col: 'amount', upstream_columns: [] }],
        });
      } else {
        throw new Error(`unexpected focus ${id}`);
      }
    }

    const result = engine.getResult();
    const edges = result.columnAspect?.edges ?? [];
    expect(edges.length, 'the chain commits an edge at report and at carrier').toBe(2);
    const components = connectedComponents(edges);
    expect(components.length, `committed column edges must form one component, found ${components.length}`).toBe(1);
    expect(components[0], 'the single component must contain the origin').toContain('report');
  });

  // report <- carrier (the traced chain) with carrier separately routing `gadget` with NO `columns`
  // field. `gadget` declares its own `amount` column and, once dispatched, commits its own edge to
  // `gadgetSource` — a supplier `carrier`'s column_flow never named.
  const DETACH_NODES: LineageNode[] = ['report', 'carrier', 'gadget', 'gadgetSource'].map(id =>
    makeNode({
      id, schema: 'dbo', name: id, type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    }),
  );
  const DETACH_EDGES: Array<[string, string]> = [
    ['carrier', 'report'],
    ['gadget', 'carrier'],
    ['gadgetSource', 'gadget'],
  ];
  const DETACH_MODEL: DatabaseModel = makeModel(DETACH_NODES, DETACH_EDGES, ['dbo']);

  it('case 2: an omitted route carry is rejected as out_col_not_tracked, so a detached component can never commit', () => {
    const engine = new NavigationEngine(DETACH_MODEL, makeGraph(DETACH_NODES, DETACH_EDGES), () => {}, {});
    const init = engine.init({
      origin: 'report', question: 'trace amount', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['amount'],
      depthIntent: { kind: 'explicit', levels: 4 },
    });
    expect('ok' in init, `init must succeed (${'error' in init ? init.error : ''})`).toBe(true);

    let ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'first focus is report').toBe('report');
    submit(engine, 'report', {
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
    });

    ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'second focus is carrier').toBe('carrier');
    // Terminates its own upstream account (no supplier named) and routes `gadget` as a plain
    // object — `columns` is omitted, not `'none'` — while this hop's own mode is `ct`.
    submit(engine, 'carrier', {
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [] }],
      route_requests: [{ nodeId: 'gadget', question: 'what feeds this' }],
    });

    ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'gadget is dispatched next').toBe('gadget');
    // gadget was routed with no column decision, so `routeCarryFor` resolves it as `row_role_only`
    // and it dispatches with no active column — it cannot declare a tracked-column edge for
    // `amount`, which is exactly what forecloses the detached component this case used to
    // construct before `columns` became a required, two-state decision.
    const outcome = engine.submitFindings({
      focus_node_id: 'gadget',
      sections: [{ angle: 'business' as const, text: 'gadget body' }],
      summary: 'gadget body',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'gadgetSource', col: 'amount' }] }],
    }) as { error?: string };
    expect(outcome.error, 'the omitted-carry route leaves gadget with no active column to declare').toBe('out_col_not_tracked');

    const result = engine.getResult();
    const edges = result.columnAspect?.edges ?? [];
    // Only report's own edge to carrier ever committed; carrier named no supplier, and gadget's
    // rejected submission never staged one — no detached component exists to find.
    expect(edges.length, 'gadget never commits an edge').toBe(1);
    const components = connectedComponents(edges);
    expect(components.length, 'the sole committed edge is one component').toBe(1);
    expect(components[0], 'that component contains the origin').toContain('report');
  });
});
