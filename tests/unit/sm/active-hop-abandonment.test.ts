/**
 * Engine-level coverage for `src/ai/agent/graph.ts`'s active-hop abandonment: a single focus
 * racking up `MAX_TOOL_SEMANTIC_FAILURES` rejections must not abandon the whole run while the
 * agenda still holds other reachable nodes. `tryAbandonStuckFocus` force-prunes the stuck focus
 * through the same `verdict: 'prune'` path a model's own tool call uses, then dequeues the next
 * entry; `countAbandonedHops` + `MAX_ABANDONED_HOPS_PER_RUN` bound how many times this may happen
 * per run, read back from the engine's own pruned-detail archive.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import {
  ABANDONED_HOP_SUMMARY_PREFIX,
  countAbandonedHops,
  tryAbandonStuckFocus,
} from '../../../src/ai/agent/graph';
import { MAX_ABANDONED_HOPS_PER_RUN } from '../../../src/ai/agent/toolAttempt';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const col = (name: string) => ({ name, type: 'int' as const, nullable: 'NOT NULL' as const, extra: '' });

/**
 * Builds a BB-mode engine with one origin fanning out to `leafCount` sibling leaves, submits the
 * origin's own hop (queuing every leaf), and dequeues the first leaf as the current focus.
 */
function buildFanOutEngine(leafCount: number): NavigationEngine {
  const leaves = Array.from({ length: leafCount }, (_, i) => `leaf${i}`);
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'view', columns: [col('X')] }),
    ...leaves.map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view', columns: [col('X')] })),
  ];
  const edges: Array<[string, string]> = leaves.map(id => [id, 'origin']);
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({ origin: 'origin', question: 'trace X upstream', direction: 'upstream', analysisMode: 'bb' });
  expect('ok' in init, 'engine initializes').toBe(true);
  engine.getHopContext();
  expect(engine.currentFocus).toBe('origin');

  const originResult = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin analyzed' }],
    summary: 'origin analyzed',
    verdict: 'analyze',
    route_requests: leaves.map(id => ({ nodeId: id, question: `where does ${id} feed origin from?` })),
  });
  expect('error' in originResult, 'origin hop commits').toBe(false);
  engine.getHopContext();
  return engine;
}

describe('tryAbandonStuckFocus', () => {
  it('force-prunes the stuck focus and advances the agenda to the next node', () => {
    const engine = buildFanOutEngine(2);
    const stuck = engine.currentFocus!;
    expect(['leaf0', 'leaf1']).toContain(stuck);

    const abandoned = tryAbandonStuckFocus(engine, stuck, 'semantic_failures');

    expect(abandoned).toBe(true);
    // The agenda continues: the coordinator's next pass sees a DIFFERENT, still-reachable focus —
    // this is the "agenda still holds nodes" case from the defect, proven at the engine boundary.
    expect(engine.currentFocus).not.toBe(stuck);
    expect(engine.currentFocus).not.toBeNull();
  });

  it('refuses to abandon the immutable origin, leaving the focus untouched', () => {
    const nodes: LineageNode[] = [makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'view', columns: [col('X')] })];
    const model = makeModel(nodes, [], ['dbo']);
    const graph = makeGraph(nodes, []);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace X upstream', direction: 'upstream', analysisMode: 'bb' });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('origin');

    const abandoned = tryAbandonStuckFocus(engine, 'origin', 'semantic_failures');

    // `prune_origin_forbidden` is a structural refusal, not a retryable failure — the caller (the
    // active worker's stop-handling in `graph.ts`) falls back to the pre-existing salvage/fail
    // disposition instead of forcing progress the engine itself refuses.
    expect(abandoned).toBe(false);
    expect(engine.currentFocus).toBe('origin');
    expect(countAbandonedHops(engine)).toBe(0);
  });
});

describe('tryAbandonStuckFocus carries forward a stranded bridge', () => {
  /**
   * Builds a chain `successor -> focus -> origin` (upstream direction) where `focus` is the ONLY
   * agenda entry and `successor` is a bodied node no hop has visited or queued yet — the sole
   * surviving thread and the sole bridge to an unvisited bodied subtree.
   */
  function buildBridgeEngine(): NavigationEngine {
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'view', columns: [col('X')] }),
      makeNode({ id: 'focus', schema: 'dbo', name: 'focus', type: 'view', columns: [col('X')] }),
      makeNode({ id: 'successor', schema: 'dbo', name: 'successor', type: 'view', columns: [col('X')] }),
    ];
    const edges: Array<[string, string]> = [['focus', 'origin'], ['successor', 'focus']];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const graph = makeGraph(nodes, edges);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({ origin: 'origin', question: 'trace X upstream', direction: 'upstream', analysisMode: 'bb' });
    expect('ok' in init, 'engine initializes').toBe(true);
    engine.getHopContext();
    expect(engine.currentFocus).toBe('origin');

    const originResult = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin analyzed' }],
      summary: 'origin analyzed',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'focus', question: 'where does focus feed origin from?' }],
    });
    expect('error' in originResult, 'origin hop commits').toBe(false);
    engine.getHopContext();
    expect(engine.currentFocus).toBe('focus');
    return engine;
  }

  it('re-enqueues the stranded successor instead of draining the agenda to complete', () => {
    const engine = buildBridgeEngine();

    const abandoned = tryAbandonStuckFocus(engine, 'focus', 'semantic_failures');

    expect(abandoned).toBe(true);
    // The abandon must re-enqueue successor rather than let the agenda drain to complete with it
    // kept-but-never-hopped.
    expect(engine.status).toBe('awaiting_findings');
    expect(engine.currentFocus).toBe('successor');
  });
});

describe('countAbandonedHops', () => {
  it('records the abandoned node in the engine\'s own pruned-detail archive, marker and all', () => {
    const engine = buildFanOutEngine(2);
    const stuck = engine.currentFocus!;

    tryAbandonStuckFocus(engine, stuck, 'semantic_failures');

    expect(countAbandonedHops(engine)).toBe(1);
    const record = engine.getPrunedDetails().find(detail => detail.nodeId === stuck);
    expect(record).toBeDefined();
    expect(record!.summary.startsWith(ABANDONED_HOP_SUMMARY_PREFIX)).toBe(true);
    // Carried into the run record the same way any other pruned node is — `getResult()` is the
    // archive `advanceToSynthesis` hands to synthesis, so a dropped node is never silent.
    const nodeState = engine.getResult().node_states.find(state => state.nodeId === stuck);
    expect(nodeState?.action).toBe('prune');
  });

  it('the run-level governor is exhausted after MAX_ABANDONED_HOPS_PER_RUN abandonments', () => {
    const engine = buildFanOutEngine(MAX_ABANDONED_HOPS_PER_RUN + 1);

    for (let i = 0; i < MAX_ABANDONED_HOPS_PER_RUN; i++) {
      expect(countAbandonedHops(engine)).toBeLessThan(MAX_ABANDONED_HOPS_PER_RUN);
      const focus = engine.currentFocus!;
      expect(tryAbandonStuckFocus(engine, focus, 'semantic_failures')).toBe(true);
    }

    expect(countAbandonedHops(engine)).toBe(MAX_ABANDONED_HOPS_PER_RUN);
    // This is the exact comparison `activeWorkerNode` guards the abandon branch on
    // (`countAbandonedHops(engine) < MAX_ABANDONED_HOPS_PER_RUN`) — once it is false, a further
    // semantic-failure stop falls through to the pre-existing salvage/fail disposition instead of
    // forcing yet another prune, which is what stops an all-failing agenda from looping forever.
    expect(countAbandonedHops(engine) < MAX_ABANDONED_HOPS_PER_RUN).toBe(false);
    // One node is still reachable — proves the cap trips while real work remains, not because the
    // agenda happened to drain on its own.
    expect(engine.currentFocus).not.toBeNull();
  });
});
