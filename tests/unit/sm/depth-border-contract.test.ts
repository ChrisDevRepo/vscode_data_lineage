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
import { assert, makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

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
    assert(
      engine.currentDepthEnforcement === 'strict',
      `explicit depth must enforce strictly, got '${engine.currentDepthEnforcement}'`,
    );
  });

  it('T11: an omitted depth stays silent — the soft path is untouched', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    assert(
      engine.currentDepthEnforcement === 'silent',
      `omitted depth must stay silent, got '${engine.currentDepthEnforcement}'`,
    );
  });

  it('T12: full_frontier leaves the budget unbounded', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'full_frontier' },
    });
    assert(engine.currentDepth === null, 'full_frontier must leave depthBudget null');
    drainChain(engine);
    assert(analyzedIds(engine).has('n5'), 'unbounded depth still reaches the far end of the chain');
    assert(!deferredIds(engine).includes('n5'), 'unbounded depth defers nothing on depth grounds');
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
    assert(analyzed.has('n2'), 'n2 is at the border (depth 2) and must still be analyzed');
    assert(!analyzed.has('n3'), 'n3 is depth 3 — beyond the stated 2 levels — and must not be analyzed');
    assert(!analyzed.has('n5'), 'n5 is depth 5 and must not be analyzed');
  });

  it('T5: the deferred frontier names the node and carries a depth reason', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    drainChain(engine);
    assert(
      deferredIds(engine).includes('n3'),
      'the first node past the border must surface as a deferred follow-up, not vanish',
    );
    const depthDeferred = engine.deferredQuestions.filter(
      d => d.reason === 'depth' || d.reason === 'schema_and_depth',
    );
    assert(
      depthDeferred.length > 0,
      'a depth breach must be recorded with a depth reason, not as a schema deferral',
    );
    assert(
      depthDeferred.every(d => typeof d.depth === 'number'),
      "DeferredQuestion.depth is documented as populated when reason includes 'depth'",
    );
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
    assert(!!deferredD, "'d' is 4 directed levels out and must be deferred past a 3-level border");
    assert(
      deferredD!.depth === 4,
      `'d' is 4 directed edges from origin; the undirected shortest path is 3. `
      + `Reported depth=${deferredD!.depth}`,
    );
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
    assert(analyzed.has('u2'), 'upstream cap of 2 still admits u2');
    assert(
      !analyzed.has('d2'),
      'downstream cap of 1 must refuse d2 — a max-collapsed scalar admits it',
    );
    assert(
      deferredIds(engine).includes('d2'),
      'd2 must surface as a deferred follow-up rather than vanish',
    );
  });

  // ── Resume: the border outlives the checkpoint the consent interrupt writes ──────
  it('T14: a stated border survives a toJSON/fromJSON round trip', () => {
    const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
    engine.init({
      origin: 'n0', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    const restored = NavigationEngine.fromJSON(engine.toJSON(), chainModel, chainGraph, () => {});
    assert(
      restored.currentDepthEnforcement === 'strict',
      `a restored engine must still enforce the stated border, got '${restored.currentDepthEnforcement}'`,
    );
    drainChain(restored);
    const analyzed = analyzedIds(restored);
    assert(!analyzed.has('n3'), 'the restored border still refuses the node past level 2');
    assert(deferredIds(restored).includes('n3'), 'n3 surfaces as a deferred follow-up after resume');
  });

  it('T15: an asymmetric border survives resume per side, and an unbounded side stays unbounded', () => {
    const engine = new NavigationEngine(forkModel, forkGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
    });
    const snapshot = engine.toJSON() as { engineInternals: { depthLimits?: { upstream: number | null; downstream: number | null } } };
    assert(
      snapshot.engineInternals.depthLimits?.upstream === null,
      'an unbounded side serializes as null, the only JSON form of no ceiling',
    );
    assert(
      snapshot.engineInternals.depthLimits?.downstream === 1,
      'the capped side serializes its own ceiling',
    );
    const restored = NavigationEngine.fromJSON(snapshot, forkModel, forkGraph, () => {});
    driveRoutes(restored, { origin: ['u1', 'd1'], u1: ['u2'], d1: ['d2'] });
    const analyzed = analyzedIds(restored);
    assert(analyzed.has('u2'), 'the unbounded side still reaches the far end after resume');
    assert(!analyzed.has('d2'), "the capped side keeps its ceiling after resume");
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
    assert(
      restored.currentDepthEnforcement === 'silent',
      'a v1 checkpoint is accepted, not discarded, and falls back to seed-only routing',
    );
  });

  it('T13: asymmetric with "all" on one side keeps the other side capped', () => {
    const engine = new NavigationEngine(forkModel, forkGraph, () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
    });
    driveRoutes(engine, { origin: ['u1', 'd1'], u1: ['u2'], d1: ['d2'] });
    const analyzed = analyzedIds(engine);
    assert(analyzed.has('u2'), 'upstream "all" reaches the far end');
    assert(
      !analyzed.has('d2'),
      "an 'all' on one side must not disable the other side's cap "
      + '(today the finite-pair filter drops the budget to null entirely)',
    );
  });
});
