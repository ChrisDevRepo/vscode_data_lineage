/**
 * A traced column handed to a non-bodied carrier continues only on the carrier's far side from the
 * node that handed it over — never onto a sibling that reads (or writes) the same carrier. A
 * co-reader served the wrong active column can answer for it alone and prune a table that its own
 * separate producer chain still needs, silently dropping that chain's reopen. Producers keep the
 * column; the BB walk (which nodes are enqueued) is unchanged.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const col = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });

/**
 * calc (origin view) ← staging ← loader ← rawview ← cleaned ← cleaner ← rawsrc, and
 * calc ← master → cleaner: `cleaner` is on the Amount chain as the producer of `cleaned`, and a
 * co-reader of `master`, the carrier of the traced `Tier`.
 */
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

function startEngine(mode: 'bb' | 'ct'): NavigationEngine {
  const { model, graph } = buildWorld();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: 'calc', question: 'trace Discount', direction: 'bidirectional',
    ...(mode === 'ct' ? { analysisMode: 'ct' as const, targetColumns: ['Discount'] } : {}),
  });
  expect('ok' in init, `${mode}: init succeeds`).toBe(true);
  const hop = engine.getHopContext() as { done?: boolean };
  expect(!hop.done && engine.currentFocus === 'calc', `${mode}: first focus is calc`).toBe(true);
  const routes = engine.requiredNeighborIds('calc').map(id => ({ nodeId: id, question: `What does ${id} supply to calc?` }));
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

/** Terminal hop: accounts for every active column and routes the required neighbours. */
function terminalSubmit(engine: NavigationEngine, focusId: string, mode: 'bb' | 'ct') {
  const cols = engine.columnAspect?.active_columns ?? [];
  return engine.submitFindings({
    focus_node_id: focusId,
    sections: [{ angle: 'business' as const, text: 'terminal' }],
    summary: 'ok',
    verdict: 'passthrough',
    ...(mode === 'ct' ? { column_flow: cols.map(c => ({ out_col: c, upstream_columns: [] })) } : {}),
    route_requests: engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: `What does ${id} decide for ${focusId}?` })),
  });
}

describe('CT carrier contraction — the traced column continues on the far side only', () => {
  it('CT: a co-reader of the carrier is enqueued with no traced column and no lineage question; the producer keeps its column', () => {
    const engine = startEngine('ct');
    const agenda = engine.toJSON().agenda;
    const cleaner = agenda.find(e => e.nodeId === 'cleaner');
    const loader = agenda.find(e => e.nodeId === 'loader');
    expect(cleaner, 'cleaner is still enqueued through master — the walk is unchanged').toBeDefined();
    expect(loader, 'loader is enqueued through staging').toBeDefined();
    expect([...(loader?.activeColumns ?? [])].join(','), 'loader writes staging, so it produces the traced Amount').toBe('Amount');
    expect(
      [...(cleaner?.activeColumns ?? [])].join(','),
      `cleaner only reads master, so master.Tier has no continuation there — got [${(cleaner?.activeColumns ?? []).join(',')}]`,
    ).toBe('');
    expect(cleaner?.lineageQuestions ?? [], 'no Tier continuation question renders at a co-reader').toEqual([]);

    // Dispatch reaches cleaner with an empty active set, so the hop is served as a row-set hop.
    for (let i = 0; i < 4; i++) {
      const ctx = engine.getHopContext() as { done?: boolean };
      expect(!ctx.done, 'exploration does not complete before cleaner').toBe(true);
      if (engine.currentFocus === 'cleaner') break;
      const focusId = engine.currentFocus!;
      const r = terminalSubmit(engine, focusId, 'ct');
      expect(!('error' in r), `terminal submit at ${focusId} (${'error' in r ? r.error : ''})`).toBe(true);
    }
    expect(engine.currentFocus, 'cleaner is dispatched').toBe('cleaner');
    expect(engine.columnAspect?.active_columns ?? [], 'cleaner dispatches with no traced column').toEqual([]);
  });

  it('CT downstream: a carrier the focus writes forwards the traced column to its consumers', () => {
    const nodes: LineageNode[] = [
      makeNode({ id: 'calc', schema: 'ct', name: 'calc', type: 'view', columns: [col('Discount')] }),
      makeNode({ id: 'report', schema: 'ct', name: 'report', type: 'procedure', columns: [] }),
      makeNode({ id: 'fact', schema: 'ct', name: 'fact', type: 'table', columns: [col('Discount')] }),
      makeNode({ id: 'factview', schema: 'ct', name: 'factview', type: 'view', columns: [col('Discount')] }),
    ];
    const edges: Array<[string, string]> = [['calc', 'report'], ['report', 'fact'], ['fact', 'factview']];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
    expect('ok' in engine.init({ origin: 'calc', question: 'trace Discount', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Discount'] })).toBe(true);
    engine.getHopContext();
    expect(terminalSubmit(engine, 'calc', 'ct')).not.toHaveProperty('error');
    engine.getHopContext();
    expect(engine.currentFocus).toBe('report');
    const hop = engine.submitFindings({
      focus_node_id: 'report',
      sections: [{ angle: 'business' as const, text: 'report copies calc.Discount into fact' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'Discount', writes_to: { node: 'fact', col: 'Discount' }, upstream_columns: [{ node: 'calc', col: 'Discount' }] }],
      route_requests: [{ nodeId: 'fact', question: 'Which objects read fact.Discount?', columns: ['Discount'] }],
    });
    expect(hop).not.toHaveProperty('error');
    const factview = engine.toJSON().agenda.find(e => e.nodeId === 'factview');
    expect([...(factview?.activeColumns ?? [])].join(','), 'factview reads the carrier report writes').toBe('Discount');
  });

  it('BB parity: the same nodes are enqueued after the origin hop in both modes', () => {
    const ids = (engine: NavigationEngine) => engine.toJSON().agenda.map(e => e.nodeId).sort().join(',');
    expect(ids(startEngine('ct'))).toBe(ids(startEngine('bb')));
  });
});
