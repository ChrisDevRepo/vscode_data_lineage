/**
 * Supplement-agenda flow — post-synthesis follow-up extension.
 *
 * Asserts:
 *  - `supplementAgenda` rejects when the engine is not in `status === 'complete'`.
 *  - After a completed run, supplementing with an unknown id reports it as `skipped`.
 *  - After a completed run, supplementing with a bodied id enqueues it and flips
 *    status back to `awaiting_findings` with inline mode forced on.
 *  - New `submit_findings` for the supplemented id merges a slot into the existing
 *    memory archive (prior slots survive, not reset).
 *  - After the supplement drains, status returns to `complete` and `getResult`
 *    contains both the original and the supplemented slot.
 */

import { NavigationEngine } from '../../src/ai/smBase';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Supplement Agenda');
console.log('='.repeat(40));
resetCounters();

// Topology: origin proc `sp` reads two tables (tA, tB). Each table has a downstream
// view (viewa, viewb). A third view `viewc` is out of the initial scope but reachable.
const nodes: LineageNode[] = [
  { id: 'sp',    schema: 'dbo', name: 'sp',    type: 'procedure' },
  { id: 'ta',    schema: 'dbo', name: 'ta',    type: 'table' },
  { id: 'tb',    schema: 'dbo', name: 'tb',    type: 'table' },
  { id: 'viewa', schema: 'dbo', name: 'viewa', type: 'view' },
  { id: 'viewb', schema: 'dbo', name: 'viewb', type: 'view' },
  { id: 'viewc', schema: 'dbo', name: 'viewc', type: 'view' },
];
const edges: Array<[string, string]> = [
  ['sp', 'ta'],
  ['sp', 'tb'],
  ['ta', 'viewa'],
  ['tb', 'viewb'],
  ['sp', 'viewc'],
];
const model: DatabaseModel = {
  nodes,
  edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
  schemas: ['dbo'],
  dbPlatform: 'SQL Server',
};
const graph = makeGraph(nodes, edges);

// Helper: drain the engine by submitting trivial findings for every focus.
// Handles both SM mode (single focus_node) and inline mode (batch of focus nodes).
function drain(engine: NavigationEngine, tag: string): void {
  let safety = 20;
  while (safety-- > 0) {
    const ctx = engine.getHopContext() as any;
    if (ctx.done) break;
    if (!ctx.focus_node) break;
    const targets: Array<{ id: string }> = Array.isArray(ctx.focus_node) ? ctx.focus_node : [ctx.focus_node];
    if (targets.length === 0) break;
    for (const t of targets) {
      engine.submitFindings({
        focus_node_id: t.id,
        sections: [{ angle: 'business' as const, text: `${tag}: analysis for ${t.id}` }],
        summary: `${tag}: ${t.id}`,
        verdict: 'analyze',
      });
    }
  }
}

// Test 1: rejects when engine has not completed yet
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depth: 3 });
  const res = engine.supplementAgenda(['viewc']);
  assert('error' in res, 'supplementAgenda rejects while engine is not complete');
  if ('error' in res) {
    assert(res.error === 'supplement_requires_complete_engine', 'error code is supplement_requires_complete_engine');
  }
}

// Test 2: after completion, supplement with an unknown id is reported as skipped
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depth: 3 });
  drain(engine, 'initial');
  assert(engine.status === 'complete', 'engine reaches complete after initial drain');

  const slotsBefore = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  const res = engine.supplementAgenda(['[dbo].[doesNotExist]']);
  assert('ok' in res && (res as any).ok === true, 'supplementAgenda returns ok even when all ids are unknown');
  if ('ok' in res) {
    assert(res.skipped === 1, 'unknown id counted in skipped');
    assert(res.agendaed === 0, 'nothing agendaed');
    assert(res.contracted === 0, 'nothing contracted');
  }
  // After an all-skipped supplement we still flip status back because the caller
  // expected to resume; the next getHopContext will re-drain immediately to 'complete'.
  assert(engine.inlineMode === true, 'inline mode forced after supplement');
  drain(engine, 'no-op-supplement');
  assert(engine.status === 'complete', 'engine returns to complete after empty-supplement drain');
  const slotsAfter = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  assert(slotsAfter === slotsBefore, 'archive is unchanged when supplement ids are all skipped');
}

// Test 3: supplement a bodied id that was deferred in the initial narrow scope
{
  // Use upstream direction from viewa (depth 1) so only {viewa, ta, sp} are in scope —
  // viewc is reachable only via sp's downstream neighbors, which the upstream BFS misses.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depth: 2 });
  drain(engine, 'narrow');
  assert(engine.status === 'complete', 'narrow engine complete');
  const narrowSlots = engine.getResult().detail_slots.map(s => s.nodeId);
  assert(!narrowSlots.includes('viewc'), 'viewc not yet in narrow archive');

  const r = engine.supplementAgenda(['viewc']);
  assert('ok' in r && (r as any).ok === true, 'supplementAgenda ok on bodied id');
  if ('ok' in r) {
    assert(r.agendaed >= 1, `at least one id agendaed (got ${r.agendaed})`);
    assert(r.skipped === 0, 'no ids skipped for valid bodied id');
  }
  assert(engine.status === 'awaiting_findings', 'status returns to awaiting_findings after supplement');
  assert(engine.inlineMode === true, 'inline mode forced on for supplement');

  drain(engine, 'supplement');
  assert(engine.status === 'complete', 'engine completes again after supplement drain');

  const after = engine.getResult().detail_slots;
  const afterIds = new Set(after.map(s => s.nodeId));
  assert(afterIds.has('viewc'), 'viewc slot present in archive after supplement');
  for (const originalId of narrowSlots) {
    assert(afterIds.has(originalId), `prior slot ${originalId} survived supplement merge`);
  }
}

printSummary('Supplement Agenda');
