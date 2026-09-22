/**
 * Depth-border contract: an explicit user-stated depth is a hard border; an omitted
 * depth stays a soft seed the model may grow.
 *
 * These tests pin the CONTRACT, never a captured answer. They are written to fail
 * against the pre-fix engine (depth is a growable seed) and pass once the engine
 * enforces the border and defers the frontier through the existing `deferQuestion`
 * path — the path the active-hop prompt already promises every hop.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Depth border — explicit depth is hard, omitted depth is soft', () => {
  // n0 → n1 → n2 → n3 → n4 → n5, all in one schema so no schema border can mask the
  // depth border: anything refused here was refused on depth alone.
  const chainNodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const chainEdges: Array<[string, string]> = [
    ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'],
  ];
  const chainModel: DatabaseModel = makeModel(chainNodes, chainEdges, ['dbo']);
  const chainGraph = makeGraph(chainNodes, chainEdges);
  const succ: Record<string, string | undefined> = {
    n0: 'n1', n1: 'n2', n2: 'n3', n3: 'n4', n4: 'n5',
  };

  /** Drives the chain to completion, routing one hop further at every focus. */
  function drainChain(engine: NavigationEngine): void {
    driveEngine(engine, { succ, limit: 30 });
  }

  function analyzedIds(engine: NavigationEngine): Set<string> {
    return new Set(engine.getResult().detail_slots.map(s => s.nodeId.toLowerCase()));
  }

  function deferredIds(engine: NavigationEngine): string[] {
    return engine.deferredQuestions.map(d => d.nodeId.toLowerCase());
  }

  // ── T1: the enforcement mode is actually produced ───────────────────────────────
  it('T1: an explicit depth produces strict enforcement, not silent', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    expect(engine.currentDepthEnforcement === 'strict', `explicit depth must enforce strictly, got '${engine.currentDepthEnforcement}'`).toBe(true);
  });

  it('T11: an omitted depth stays silent — the soft path is untouched', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    expect(engine.currentDepthEnforcement === 'silent', `omitted depth must stay silent, got '${engine.currentDepthEnforcement}'`).toBe(true);
  });

  it('T12: full_frontier leaves the budget unbounded', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'full_frontier' },
    });
    expect(engine.currentDepth === null, 'full_frontier must leave depthBudget null').toBe(true);
    drainChain(engine);
    expect(analyzedIds(engine).has('n5'), 'unbounded depth still reaches the far end of the chain').toBe(true);
    expect(!deferredIds(engine).includes('n5'), 'unbounded depth defers nothing on depth grounds').toBe(true);
  });

  // ── T4/T5: the border actually holds, and the frontier is deferred not dropped ───
  it('T4: a route beyond an explicit depth is deferred, not admitted', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    drainChain(engine);
    const analyzed = analyzedIds(engine);
    expect(analyzed.has('n2'), 'n2 is at the border (depth 2) and must still be analyzed').toBe(true);
    expect(!analyzed.has('n3'), 'n3 is depth 3 — beyond the stated 2 levels — and must not be analyzed').toBe(true);
    expect(!analyzed.has('n5'), 'n5 is depth 5 and must not be analyzed').toBe(true);
  });

  it('T5: the deferred frontier names the node and carries a depth reason', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    drainChain(engine);
    expect(deferredIds(engine).includes('n3'), 'the first node past the border must surface as a deferred follow-up, not vanish').toBe(true);
    const depthDeferred = engine.deferredQuestions.filter(
      d => d.reason === 'depth' || d.reason === 'schema_and_depth',
    );
    expect(depthDeferred.length > 0, 'a depth breach must be recorded with a depth reason, not as a schema deferral').toBe(true);
    expect(depthDeferred.every(d => typeof d.depth === 'number'), "DeferredQuestion.depth is documented as populated when reason includes 'depth'").toBe(true);
  });

  // ── T2: the border must be enforced against the DIRECTED distance ────────────────
  // origin → a → b → c → d, plus a shared audit sink both a and d write to. The
  // undirected path origin–a–audit–d is 3 hops; the directed one is 4. A border
  // enforced on the undirected distance therefore lets d in one level early.
  const skewNodes: LineageNode[] = ['origin', 'a', 'b', 'c', 'd', 'audit'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const skewEdges: Array<[string, string]> = [
    ['origin', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'],
    ['a', 'audit'], ['d', 'audit'],
  ];
  const skewModel: DatabaseModel = makeModel(skewNodes, skewEdges, ['dbo']);
  const skewGraph = makeGraph(skewNodes, skewEdges);

  it('T2: the deferred depth is the directed distance, not the undirected shortest path', () => {
    const engine = new NavigationEngine(skewModel, skewGraph, () => {}, {});
    // Cap 3 is the discriminating value: 'd' is 4 directed edges out (must be refused) but only
    // 3 undirected edges out via the audit sink (would have been admitted).
    engine.init({
      origin: 'origin', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 3 },
    });
    let safety = 20;
    // 'a' fans out to both 'b' and the audit sink; the BB guard requires every in-scope
    // directional neighbour to be accounted for, so both are routed.
    const nextOf: Record<string, string[]> = {
      origin: ['a'], a: ['b', 'audit'], b: ['c'], c: ['d'],
    };
    while (safety-- > 0) {
      const ctx = engine.getHopContext() as any;
      if (ctx.done || !ctx.focus_node) break;
      const targets = nextOf[ctx.focus_node.id] ?? [];
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: 'x' }],
        summary: 'x',
        verdict: 'analyze',
        route_requests: targets.map(t => ({ nodeId: t, question: 'continue downstream' })),
      });
    }
    const deferredD = engine.deferredQuestions.find(q => q.nodeId.toLowerCase() === 'd');
    expect(!!deferredD, "'d' is 4 directed levels out and must be deferred past a 3-level border").toBe(true);
    expect(deferredD!.depth === 4, `'d' is 4 directed edges from origin; the undirected shortest path is 3. `
      + `Reported depth=${deferredD!.depth}`).toBe(true);
  });

  // ── T3/T13: asymmetric depth must be ENFORCED per side, not collapsed ────────────
  // The initial BFS seed already caps each side independently (computeBfsScope walks
  // inbound and outbound with separate limits). What collapses to a single scalar is
  // `depthBudget` — the value route-time enforcement reads — so these tests drive a
  // route BEYOND the seed, which is exactly where the collapse becomes observable.
  // u2 ← u1 ← origin → d1 → d2
  const forkNodes: LineageNode[] = ['origin', 'u1', 'u2', 'd1', 'd2'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const forkEdges: Array<[string, string]> = [
    ['u2', 'u1'], ['u1', 'origin'], ['origin', 'd1'], ['d1', 'd2'],
  ];
  const forkModel: DatabaseModel = makeModel(forkNodes, forkEdges, ['dbo']);
  const forkGraph = makeGraph(forkNodes, forkEdges);

  /** Routes every listed target from whichever node is currently in focus. */
  function driveRoutes(engine: NavigationEngine, routes: Record<string, string[]>): void {
    driveEngine(engine, { routes, limit: 20 });
  }

  it('T3: asymmetric caps are enforced per side, not collapsed to their maximum', () => {
    const engine = new NavigationEngine(forkModel, forkGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 2, downstream: 1 },
    });
    // d1 sits at the downstream border; routing on to d2 breaches a cap of 1. A
    // Math.max(2,1)=2 scalar would wave d2 through on the upstream side's allowance.
    driveRoutes(engine, { origin: ['u1', 'd1'], u1: ['u2'], d1: ['d2'] });
    const analyzed = analyzedIds(engine);
    expect(analyzed.has('u2'), 'upstream cap of 2 still admits u2').toBe(true);
    expect(!analyzed.has('d2'), 'downstream cap of 1 must refuse d2 — a max-collapsed scalar admits it').toBe(true);
    expect(deferredIds(engine).includes('d2'), 'd2 must surface as a deferred follow-up rather than vanish').toBe(true);
  });

  // ── Resume: the border outlives the checkpoint the consent interrupt writes ──────
  it('T14: a stated border survives a toJSON/fromJSON round trip', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    const restored = NavigationEngine.fromJSON(engine.toJSON(), chainModel, chainGraph, () => {});
    expect(restored.currentDepthEnforcement === 'strict', `a restored engine must still enforce the stated border, got '${restored.currentDepthEnforcement}'`).toBe(true);
    drainChain(restored);
    const analyzed = analyzedIds(restored);
    expect(!analyzed.has('n3'), 'the restored border still refuses the node past level 2').toBe(true);
    expect(deferredIds(restored).includes('n3'), 'n3 surfaces as a deferred follow-up after resume').toBe(true);
  });

  it('T15: an asymmetric border survives resume per side, and an unbounded side stays unbounded', () => {
    const engine = new NavigationEngine(forkModel, forkGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
    });
    const snapshot = engine.toJSON() as { engineInternals: { depthLimits?: { upstream: number | null; downstream: number | null } } };
    expect(snapshot.engineInternals.depthLimits?.upstream === null, 'an unbounded side serializes as null, the only JSON form of no ceiling').toBe(true);
    expect(snapshot.engineInternals.depthLimits?.downstream === 1, 'the capped side serializes its own ceiling').toBe(true);
    const restored = NavigationEngine.fromJSON(snapshot, forkModel, forkGraph, () => {});
    driveRoutes(restored, { origin: ['u1', 'd1'], u1: ['u2'], d1: ['d2'] });
    const analyzed = analyzedIds(restored);
    expect(analyzed.has('u2'), 'the unbounded side still reaches the far end after resume').toBe(true);
    expect(!analyzed.has('d2'), "the capped side keeps its ceiling after resume").toBe(true);
  });

  it('T16: a checkpoint without depthLimits still restores, as seed-only routing', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    const snapshot = engine.toJSON();
    delete snapshot.engineInternals.depthLimits;
    const restored = NavigationEngine.fromJSON(snapshot, chainModel, chainGraph, () => {});
    expect(restored.currentDepthEnforcement === 'silent', 'a v1 checkpoint is accepted, not discarded, and falls back to seed-only routing').toBe(true);
  });

  it('T13: asymmetric with "all" on one side keeps the other side capped', () => {
    const engine = new NavigationEngine(forkModel, forkGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
    });
    driveRoutes(engine, { origin: ['u1', 'd1'], u1: ['u2'], d1: ['d2'] });
    const analyzed = analyzedIds(engine);
    expect(analyzed.has('u2'), 'upstream "all" reaches the far end').toBe(true);
    expect(!analyzed.has('d2'), "an 'all' on one side must not disable the other side's cap "
      + '(today the finite-pair filter drops the budget to null entirely)').toBe(true);
  });

  // ── T17: a two-sided node is judged against the side that admits it ──────────────
  // T sits 3 edges upstream of the origin and 4 edges downstream of it. Under
  // {upstream:1, downstream:5} exactly one side fits, so the node belongs inside the
  // border the user stated. Keeping only the smaller side judges it on the upstream
  // ceiling it was never asked to satisfy.
  //   T → p2 → p1 → origin   (upstream distance 3)
  //   origin → q1 → q2 → q3 → T   (downstream distance 4)
  const twoSidedNodes: LineageNode[] = ['origin', 'p1', 'p2', 'T', 'q1', 'q2', 'q3'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const twoSidedEdges: Array<[string, string]> = [
    ['T', 'p2'], ['p2', 'p1'], ['p1', 'origin'],
    ['origin', 'q1'], ['q1', 'q2'], ['q2', 'q3'], ['q3', 'T'],
  ];
  const twoSidedModel: DatabaseModel = makeModel(twoSidedNodes, twoSidedEdges, ['dbo']);
  const twoSidedGraph = makeGraph(twoSidedNodes, twoSidedEdges);
  const twoSidedRoutes: Record<string, string[]> = {
    origin: ['p1', 'q1'], p1: ['p2'], p2: ['T'], q1: ['q2'], q2: ['q3'], q3: ['T'], T: [],
  };

  it('T17: a node that fits one side of an asymmetric border is admitted on that side', () => {
    const engine = new NavigationEngine(twoSidedModel, twoSidedGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 1, downstream: 5 },
    });
    driveRoutes(engine, twoSidedRoutes);
    const analyzed = analyzedIds(engine);
    expect(analyzed.has('t'), 'T is 4 downstream levels out against a downstream ceiling of 5, so it is inside the stated border').toBe(true);
    expect(!deferredIds(engine).includes('t'), 'a node admitted on its own side is not also recorded as a deferral').toBe(true);
  });

  // ── T18: CT contraction through a carrier obeys the same border ──────────────────
  // vwsrc → stg → vworders, tracing Amount upstream with a stated ceiling of 1. The
  // carrier `stg` sits at the border; the bodied node behind it is one level past it.
  const ctNodes: LineageNode[] = [
    makeNode({ id: '[ct].[vworders]', schema: 'ct', name: 'vworders', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ct].[stg]', schema: 'ct', name: 'stg', type: 'table', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ct].[vwsrc]', schema: 'ct', name: 'vwsrc', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const ctEdges: Array<[string, string]> = [['[ct].[vwsrc]', '[ct].[stg]'], ['[ct].[stg]', '[ct].[vworders]']];
  const ctModel: DatabaseModel = makeModel(ctNodes, ctEdges, ['ct']);
  const ctGraph = makeGraph(ctNodes, ctEdges);

  /** Drives the CT chain, forwarding Amount to the single upstream supplier at each focus. */
  function driveCtChain(engine: NavigationEngine): string[] {
    const supplier: Record<string, string | undefined> = {
      '[ct].[vworders]': '[ct].[stg]',
      '[ct].[vwsrc]': undefined,
    };
    const dispatched: string[] = [];
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const focusId = ctx.focus_node.id;
      dispatched.push(focusId);
      const upstream = supplier[focusId];
      engine.submitFindings({
        focus_node_id: focusId,
        sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
        summary: focusId,
        verdict: 'analyze',
        column_flow: upstream
          ? [{ out_col: 'Amount', upstream_columns: [{ node: upstream, col: 'Amount' }] }]
          : [],
      });
    }
    return dispatched;
  }

  it('T18: a CT contraction past the stated border is deferred as a contracted lead', () => {
    const engine = new NavigationEngine(ctModel, ctGraph, () => {}, {});
    const init = engine.init({
      origin: '[ct].[vworders]', question: 'trace Amount', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);
    const dispatched = driveCtChain(engine);
    expect(!dispatched.includes('[ct].[vwsrc]'), 'the node behind the carrier is one level past the stated ceiling and must not be analysed').toBe(true);
    expect(!engine.toJSON().scopeNodeIds.includes('[ct].[vwsrc]'), 'a refused contraction never joins the scope').toBe(true);
    const lead = engine.pendingLeads.find(l => l.nodeId === '[ct].[vwsrc]');
    expect(lead?.reason === 'contracted_scope', `the refused contraction surfaces as a contracted lead (got ${lead?.reason})`).toBe(true);
  });

  // ── T19: depth measurement costs a fixed number of traversals per scope seed ─────
  // `bfsFromNode` calls `graph.getNodeAttributes` exactly once per traversal it starts
  // (graphology-traversal/bfs.js seeds its queue from that one read), so counting that
  // call counts traversals. A callback returning `true` prunes one branch only — it
  // never aborts the walk — so a per-target measurement is a full walk every time.
  const hubNodes: LineageNode[] = ['n0', 'n1', 'h', 'l1', 'l2', 'l3', 'l4'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const hubEdges: Array<[string, string]> = [
    ['n0', 'n1'], ['n1', 'h'], ['h', 'l1'], ['h', 'l2'], ['h', 'l3'], ['h', 'l4'],
  ];
  const hubModel: DatabaseModel = makeModel(hubNodes, hubEdges, ['dbo']);

  /** Runs a seed-depth-2 walk that routes `leaves` nodes past the border, and counts traversals. */
  function traversalsForLeafCount(leaves: number): number {
    const graph = makeGraph(hubNodes, hubEdges);
    let traversals = 0;
    const readAttributes = graph.getNodeAttributes.bind(graph);
    graph.getNodeAttributes = ((node: string) => {
      traversals++;
      return readAttributes(node);
    }) as typeof graph.getNodeAttributes;
    const engine = new NavigationEngine(hubModel, graph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    driveRoutes(engine, {
      n0: ['n1'], n1: ['h'], h: ['l1', 'l2', 'l3', 'l4'].slice(0, leaves),
    });
    return traversals;
  }

  it('T19: the traversal count does not grow with the number of nodes measured', () => {
    const two = traversalsForLeafCount(2);
    const four = traversalsForLeafCount(4);
    expect(four === two, `measuring four out-of-seed nodes must cost the same as measuring two — got ${two} and ${four}`).toBe(true);
    expect(two === 3, `one capped seed walk plus one two-sided depth fill is three traversals, got ${two}`).toBe(true);
  });
});
