/**
 * A non-bodied carrier's contraction re-anchors the authored question only onto the neighbor that
 * continues the sender's column side (`carrierColumnContinuation`, smBase.ts). A same-side sibling —
 * a co-reader or co-writer that shares the carrier without continuing the chain — cannot answer a
 * question re-anchored to the sender's own logic, so it must receive the plain, unanchored question
 * instead. `continues` (smBase.ts:3413) already gates `neighborCarry`/`lineageQuestions`; this suite
 * pins that the same value also gates the re-anchor suffix built one line earlier (smBase.ts:3409-3412).
 *
 * World mirrors ct-carrier-sibling-column-carry.test.ts (same topology, same origin commit):
 * calc (origin view) reads staging.Amount and master.Tier.
 *   - `loader` is the opposite-side (continuing) bodied neighbor of `staging` (loader writes it).
 *   - `cleaner` is the same-side (non-continuing) bodied neighbor of `master` — a co-reader,
 *     not a producer behind it — reached via the deeper Amount chain, same as the sibling-carry test.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const col = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });
const REANCHOR_MARK = 'Inherited through passthrough';

function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'calc', schema: 'ct', name: 'calc', type: 'view', columns: [col('Discount')] }),
    makeNode({ id: 'staging', schema: 'ct', name: 'staging', type: 'table', columns: [col('Amount')] }),
    makeNode({ id: 'master', schema: 'ct', name: 'master', type: 'table', columns: [col('Tier')] }),
    makeNode({ id: 'loader', schema: 'ct', name: 'loader', type: 'procedure', columns: [] }),
    makeNode({ id: 'rawview', schema: 'ct', name: 'rawview', type: 'view', columns: [col('Amount')] }),
    makeNode({ id: 'cleaned', schema: 'ct', name: 'cleaned', type: 'table', columns: [col('Amount')] }),
    makeNode({ id: 'cleaner', schema: 'ct', name: 'cleaner', type: 'procedure', columns: [] }),
    makeNode({ id: 'rawsrc', schema: 'ct', name: 'rawsrc', type: 'table', columns: [col('RawAmount')] }),
  ];
  const edges: Array<[string, string]> = [
    ['staging', 'calc'],
    ['master', 'calc'],
    ['loader', 'staging'],
    ['rawview', 'loader'],
    ['cleaned', 'rawview'],
    ['cleaner', 'cleaned'],
    ['rawsrc', 'cleaner'],
    ['master', 'cleaner'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

function commitOrigin(mode: 'bb' | 'ct'): NavigationEngine {
  const { model, graph } = buildWorld();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: 'calc', question: 'trace Discount', direction: 'bidirectional',
    ...(mode === 'ct' ? { analysisMode: 'ct' as const, targetColumns: ['Discount'] } : {}),
  });
  expect('ok' in init, `${mode}: init succeeds`).toBe(true);
  engine.getHopContext();
  const routes = [
    { nodeId: 'staging', question: 'What does staging supply to calc?' },
    { nodeId: 'master', question: 'What does master supply to calc?' },
  ];
  const committed = engine.submitFindings({
    focus_node_id: 'calc',
    sections: [{ angle: 'business' as const, text: 'Discount is derived from staging.Amount and master.Tier' }],
    summary: 'ok',
    verdict: 'analyze',
    ...(mode === 'ct'
      ? { column_flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'staging', col: 'Amount' }, { node: 'master', col: 'Tier' }] }] }
      : {}),
    route_requests: routes,
  });
  expect(!('error' in committed), `${mode}: calc commits (${'error' in committed ? committed.error : ''})`).toBe(true);
  return engine;
}

function questionFor(engine: NavigationEngine, nodeId: string): string {
  const task = engine.investigationTasks.find(t => t.nodeId === nodeId && t.question.includes('supply to calc'));
  expect(task, `a route-forwarded task exists for ${nodeId}`).toBeDefined();
  return task!.question;
}

describe('CT carrier contraction — re-anchor follows the same-side test, not the bodied check alone', () => {
  it('CT: the opposite-side (continuing) neighbor still receives the re-anchored question', () => {
    const engine = commitOrigin('ct');
    const q = questionFor(engine, 'loader');
    expect(q.startsWith('What does staging supply to calc?'), 'plain question preserved verbatim').toBe(true);
    expect(q.includes(REANCHOR_MARK), `loader continues staging's Amount chain and must be re-anchored, got: ${q}`).toBe(true);
    expect(q.includes('re-anchor this question to loader'), 're-anchor names loader as the new focus').toBe(true);
  });

  it('CT: the same-side (non-continuing) sibling receives the plain question with no re-anchor', () => {
    const engine = commitOrigin('ct');
    const q = questionFor(engine, 'cleaner');
    expect(q, 'cleaner co-reads master and cannot answer a question anchored to its own logic — plain question only')
      .toBe('What does master supply to calc?');
    expect(q.includes(REANCHOR_MARK), `no re-anchor suffix for a same-side sibling, got: ${q}`).toBe(false);
  });

  it('BB parity: continues defaults true when columnContinuation is null, so every bodied neighbor is still re-anchored exactly as before', () => {
    const engine = commitOrigin('bb');
    const loaderQ = questionFor(engine, 'loader');
    const cleanerQ = questionFor(engine, 'cleaner');
    expect(loaderQ.includes(REANCHOR_MARK), `BB: loader re-anchored, got: ${loaderQ}`).toBe(true);
    expect(cleanerQ.includes(REANCHOR_MARK), `BB: cleaner re-anchored too — BB has no column side, so nothing narrows it, got: ${cleanerQ}`).toBe(true);
  });
});
