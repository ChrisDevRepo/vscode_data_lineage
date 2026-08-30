/**
 * Approval contract: the plan shown at the consent gate is the plan the engine runs.
 *
 * @remarks
 * The gate is where a rule becomes binding, so display and enforcement are pinned as one
 * fact per rule kind: a hard rule renders as fixed and the engine refuses to pass it, a
 * soft rule renders as an estimate and stays growable, an approved filter renders as
 * chosen and the engine applies it at every border it checks. A divergence between what
 * the user approved and what the engine did fails here, in whichever half moved.
 *
 * These tests pin the CONTRACT, never a captured answer.
 */
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Approval binds the engine — hard vs soft, and every approved filter', () => {
  // n0 → n1 → n2 → n3, one schema, all bodied: anything refused below was refused on the
  // approved rule alone, never on a schema or non-bodied border.
  const nodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const edges: Array<[string, string]> = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  const succ: Record<string, string | undefined> = { n0: 'n1', n1: 'n2', n2: 'n3' };

  function newEngine(): NavigationEngine {
    return new NavigationEngine(model, graph, () => {}, {});
  }

  /** Drives the chain to completion, routing one hop further at every focus. */
  function drain(engine: NavigationEngine): void {
    driveEngine(engine, { succ, limit: 20 });
  }

  function analyzed(engine: NavigationEngine): Set<string> {
    return new Set(engine.getResult().detail_slots.map(s => s.nodeId.toLowerCase()));
  }

  function inScope(engine: NavigationEngine): Set<string> {
    const summary = engine.getScopeSummary();
    const ids = new Set<string>();
    for (const schema of Object.values(summary.bySchema)) {
      for (const leaf of Object.values(schema.byType)) {
        for (const name of leaf.nodeNames) ids.add(name.toLowerCase());
      }
    }
    return ids;
  }

  // ── A1/A2: the two rule strengths are distinguishable on the surface the user reads ──
  it('A1: a user-stated depth renders as fixed and the engine refuses to pass it', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace two levels down', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 2 },
    });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(!md.includes('≈'), `a stated depth must not render as an estimate:\n${md}`).toBe(true);
    expect(md.includes('I will not go past this'), `a stated depth must render as fixed:\n${md}`).toBe(true);
    expect(engine.currentDepthEnforcement === 'strict', 'a stated depth enforces strictly').toBe(true);
    drain(engine);
    expect(analyzed(engine).has('n2'), 'the node at the approved border is still analysed').toBe(true);
    expect(!analyzed(engine).has('n3'), 'nothing past the approved border is analysed').toBe(true);
  });

  it('A2: an assistant-chosen depth renders as an estimate and stays growable', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace downstream', direction: 'downstream',
      depthIntent: { kind: 'default_start' },
    });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(md.includes('≈'), `an inferred depth must render as an estimate:\n${md}`).toBe(true);
    expect(md.includes('my estimate'), `an inferred depth must say whose it is:\n${md}`).toBe(true);
    expect(engine.currentDepthEnforcement === 'silent', 'an inferred depth stays growable').toBe(true);
  });

  it('A2b: an unbounded plan states that it has no depth limit', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace every level downstream', direction: 'downstream',
      depthIntent: { kind: 'full_frontier' },
    });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(md.includes('Depth:'), `an unbounded plan must still state a depth:\n${md}`).toBe(true);
    expect(md.includes('no depth limit'), `an unbounded plan must say it has no limit:\n${md}`).toBe(true);
  });

  it('A2c: an unbounded side is never summarised as the other side\'s ceiling', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace all upstream and two down', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 2 },
    });
    const summary = engine.getScopeSummary();
    expect(summary.depth === null, `a scalar cap must not be claimed while a side is unbounded, got ${String(summary.depth)}`).toBe(true);
    const md = renderScopeSummaryMd(summary);
    expect(md.includes('no depth limit'), `the unbounded side must say so:\n${md}`).toBe(true);
    expect(md.includes('2 levels downstream'), `the capped side must keep its ceiling:\n${md}`).toBe(true);
  });

  // ── A3/A4: the two filters with opposite effects bind as approved, not as intended ───
  it('A3: an approved exclusion removes the node and what only it reaches', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace downstream, skip n2', direction: 'downstream',
      depthIntent: { kind: 'full_frontier' }, excludeNodeIds: ['n2'],
    });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(md.includes('removed from the graph'), `an exclusion must render as a removal:\n${md}`).toBe(true);
    expect(!inScope(engine).has('n2'), 'an excluded node is out of scope').toBe(true);
    drain(engine);
    expect(!analyzed(engine).has('n2'), 'an excluded node is never analysed').toBe(true);
    expect(!analyzed(engine).has('n3'), 'a node reachable only through an exclusion is not analysed').toBe(true);
  });

  it('A4: an approved passthrough keeps the node in the graph and keeps the path open', () => {
    const engine = newEngine();
    engine.init({
      origin: 'n0', question: 'trace downstream, keep n2 but do not analyse it',
      direction: 'downstream', depthIntent: { kind: 'full_frontier' }, passNodeIds: ['n2'],
    });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(md.includes('not analysed'), `a passthrough must render as kept-but-skipped:\n${md}`).toBe(true);
    expect(inScope(engine).has('n2'), 'a passthrough node stays in scope').toBe(true);
    drain(engine);
    expect(!analyzed(engine).has('n2'), 'a passthrough node is not analysed').toBe(true);
    expect(analyzed(engine).has('n3'), 'a passthrough keeps the path through it open').toBe(true);
  });

  // ── A5: the gate can never display a filter the engine did not accept ────────────────
  it('A5: an unresolvable filter fails init, so no plan reaches the gate', () => {
    const engine = newEngine();
    const result = engine.init({
      origin: 'n0', question: 'trace downstream', direction: 'downstream',
      depthIntent: { kind: 'full_frontier' }, excludeNodeIds: ['nowhere'],
    });
    expect('error' in result, 'an unknown filter id must reject rather than silently no-op').toBe(true);
    expect((result as { unresolved_excludeNodeIds?: string[] }).unresolved_excludeNodeIds?.includes('nowhere') === true, 'the rejection names the id that could not be resolved').toBe(true);
  });
});
