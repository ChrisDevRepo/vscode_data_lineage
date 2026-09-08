/**
 * F1 — two routes, one queued node: a later `columns: "none"` must not subtract a proven column.
 *
 * A CT node two siblings both reach consumes one hop, so both routes land on one agenda entry. One
 * sibling commits a `column_flow` edge naming the node as the supplier of a traced column; the
 * other reaches the same node on a row-filtering branch and states `columns: "none"`. The absence
 * claim must not overturn the committed assertion, or the node is dispatched with no column
 * question, the completeness guard demands no `column_flow` there, and the chain ends at a node
 * already proven to carry the value — a subtraction with no counterpart in BB.
 *
 * The boundary is evidence, not order: a `none` the committed spine says nothing about still
 * dispatches a plain whole-object hop (pinned below, and on the seeded route in
 * `ct-retention-differential.test.ts`).
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('F1 — a filter sibling routing "none" and a carrier meeting on one agenda entry', () => {
  const col = (name: string) => ({ name, type: 'int' as const, nullable: 'NOT NULL' as const, extra: '' });
  const nodes: LineageNode[] = [
    makeNode({ id: 'f1_origin', schema: 'dbo', name: 'f1_origin', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1_carrier', schema: 'dbo', name: 'f1_carrier', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1_filter', schema: 'dbo', name: 'f1_filter', type: 'view', columns: [col('FilterKey')] }),
    makeNode({ id: 'f1_shared', schema: 'dbo', name: 'f1_shared', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1_gate', schema: 'dbo', name: 'f1_gate', type: 'view', columns: [col('TargetCol')] }),
  ];
  const edges: Array<[string, string]> = [
    ['f1_carrier', 'f1_origin'],
    ['f1_filter', 'f1_origin'],
    ['f1_shared', 'f1_carrier'],
    ['f1_shared', 'f1_filter'],
    ['f1_gate', 'f1_filter'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  interface SnapshotAgendaEntry { nodeId: string; activeColumns?: string[]; columnCarry?: { kind: string } }
  const agendaOf = (engine: NavigationEngine, nodeId: string): SnapshotAgendaEntry | undefined =>
    (JSON.parse(JSON.stringify(engine.toJSON())) as { agenda: SnapshotAgendaEntry[] })
      .agenda.find(entry => entry.nodeId === nodeId);

  /**
   * Runs the fork to the point where both routes to `f1_shared` have been submitted.
   *
   * @param log - Captures the engine's log stream.
   * @returns The engine, parked before the shared node is dispatched.
   */
  function drivenFork(log: (level: string, message: string) => void = () => {}): NavigationEngine {
    const engine = new NavigationEngine(model, graph, log, {});
    const init = engine.init({
      origin: 'f1_origin',
      question: 'trace TargetCol upstream',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['TargetCol'],
    });
    expect('ok' in init, 'F1: the upstream CT session initializes').toBe(true);
    engine.getHopContext();

    // Hop 1 — the origin: the carrier supplies TargetCol, the filter branch only shapes rows.
    const originResult = engine.submitFindings({
      focus_node_id: 'f1_origin',
      sections: [{ angle: 'business' as const, text: 'origin' }],
      summary: 'origin',
      verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1_carrier', col: 'TargetCol' }] }],
      route_requests: [
        { nodeId: 'f1_carrier', question: 'where does TargetCol come from?', columns: ['TargetCol'] },
        { nodeId: 'f1_filter', question: 'which rows does this admit?', columns: 'none' as const },
      ],
    });
    expect('error' in originResult, 'F1: the origin hop commits').toBe(false);

    // Hop 2 — the carrier commits the edge naming f1_shared as the supplier of TargetCol.
    engine.getHopContext();
    expect(engine.currentFocus, 'F1: the carrier dequeues first').toBe('f1_carrier');
    const carrierResult = engine.submitFindings({
      focus_node_id: 'f1_carrier',
      sections: [{ angle: 'business' as const, text: 'carrier' }],
      summary: 'carrier',
      verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1_shared', col: 'TargetCol' }] }],
      route_requests: [{ nodeId: 'f1_shared', question: 'where does TargetCol come from?', columns: ['TargetCol'] }],
    });
    expect('error' in carrierResult, 'F1: the carrier hop commits').toBe(false);
    expect(agendaOf(engine, 'f1_shared')?.activeColumns?.join(','), 'F1: the carrier queues f1_shared with the traced column').toBe('TargetCol');

    // Hop 3 — the filter branch reaches the same node and states it carries no traced value.
    engine.getHopContext();
    expect(engine.currentFocus, 'F1: the filter branch dequeues next').toBe('f1_filter');
    const filterResult = engine.submitFindings({
      focus_node_id: 'f1_filter',
      sections: [{ angle: 'business' as const, text: 'filter' }],
      summary: 'filter',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [
        { nodeId: 'f1_shared', question: 'which rows does this admit?', columns: 'none' as const },
        { nodeId: 'f1_gate', question: 'which rows does this admit?', columns: 'none' as const },
      ],
    });
    expect('error' in filterResult, 'F1: the filter hop commits').toBe(false);
    return engine;
  }

  it('F1: the row-role route does not subtract the column question a committed edge opened', () => {
    const engine = drivenFork();

    const shared = agendaOf(engine, 'f1_shared');
    expect(shared?.activeColumns?.join(','), 'F1: the queued entry keeps the proven column').toBe('TargetCol');
    expect(shared?.columnCarry?.kind, 'F1: and stays a carrier, so dispatch asks the column question').toBe('carry');

    engine.getHopContext();
    expect(engine.currentFocus, 'F1: the shared node dispatches').toBe('f1_shared');
    expect(engine.columnAspect?.active_columns.join(','), 'F1: the hop is asked about TargetCol').toBe('TargetCol');
  });

  it('F1: a row-role route the committed spine says nothing about still dispatches with no column', () => {
    const engine = drivenFork();

    const gate = agendaOf(engine, 'f1_gate');
    expect(gate?.columnCarry?.kind, 'F1: no committed edge names f1_gate, so its stated row role stands').toBe('row_role_only');
    expect(gate?.activeColumns?.length, 'F1: and no target set is padded back onto it').toBe(0);
  });

  it('F1: the overturned absence claim is logged, never applied silently', () => {
    const logs: string[] = [];
    drivenFork((_level, message) => logs.push(message));
    expect(
      logs.some(line => line.includes('[Normalize] route carry') && line.includes('f1_shared') && line.includes('from=none')),
      'F1: the normalization names the node and the claim it overturned',
    ).toBe(true);
    expect(
      logs.some(line => line.includes('[Normalize] route carry') && line.includes('f1_gate')),
      'F1: an unevidenced row role is not normalized, so it is not logged',
    ).toBe(false);
  });
});

/**
 * F1b — the same absence claim, made about a NON-BODIED carrier and forwarded behind it.
 *
 * A route naming a table states a row role about that table. The table is never analysed, so the
 * engine contracts through it and hands the claim to every bodied node behind it — including a node
 * an earlier hop already committed a `column_flow` edge for. The invariant is evidence over
 * assertion, independent of which path the claim travelled: a node the committed spine names as the
 * supplier of a traced column is dispatched with that column active, and only a node the spine says
 * nothing about is dispatched as a plain whole-object hop.
 *
 * Without it the chain terminated at a node the engine itself had proven carries the value, the
 * completeness guard had no active column left to demand, and `column_flow: []` was admitted with
 * `active=0` while the answer's prose continued past that node.
 */
describe('F1b — a row role stated about a non-bodied carrier, forwarded to the node behind it', () => {
  const col = (name: string) => ({ name, type: 'int' as const, nullable: 'NOT NULL' as const, extra: '' });
  const nodes: LineageNode[] = [
    makeNode({ id: 'f1b_origin', schema: 'dbo', name: 'f1b_origin', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1b_carrier', schema: 'dbo', name: 'f1b_carrier', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1b_filter', schema: 'dbo', name: 'f1b_filter', type: 'view', columns: [col('FilterKey')] }),
    makeNode({ id: 'f1b_bridge', schema: 'dbo', name: 'f1b_bridge', type: 'table', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1b_proven', schema: 'dbo', name: 'f1b_proven', type: 'view', columns: [col('TargetCol')] }),
    makeNode({ id: 'f1b_unproven', schema: 'dbo', name: 'f1b_unproven', type: 'view', columns: [col('TargetCol')] }),
  ];
  const edges: Array<[string, string]> = [
    ['f1b_carrier', 'f1b_origin'],
    ['f1b_filter', 'f1b_origin'],
    ['f1b_proven', 'f1b_carrier'],
    ['f1b_bridge', 'f1b_filter'],
    ['f1b_proven', 'f1b_bridge'],
    ['f1b_unproven', 'f1b_bridge'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  /**
   * Drives the trace to the point where the row-role claim has been contracted through the table.
   *
   * @param log - Captures the engine's log stream.
   * @returns The engine, parked before the node behind the table is dispatched.
   */
  function drivenContraction(log: (level: string, message: string) => void = () => {}): NavigationEngine {
    const engine = new NavigationEngine(model, graph, log, {});
    const init = engine.init({
      origin: 'f1b_origin',
      question: 'trace TargetCol upstream',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['TargetCol'],
    });
    expect('ok' in init, 'F1b: the upstream CT session initializes').toBe(true);
    engine.getHopContext();

    const originResult = engine.submitFindings({
      focus_node_id: 'f1b_origin',
      sections: [{ angle: 'business' as const, text: 'origin' }],
      summary: 'origin',
      verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1b_carrier', col: 'TargetCol' }] }],
      route_requests: [
        { nodeId: 'f1b_carrier', question: 'where does TargetCol come from?', columns: ['TargetCol'] },
        { nodeId: 'f1b_filter', question: 'which rows does this admit?', columns: 'none' as const },
      ],
    });
    expect('error' in originResult, 'F1b: the origin hop commits').toBe(false);

    // The carrier commits the edge naming f1b_proven as the supplier of TargetCol.
    engine.getHopContext();
    expect(engine.currentFocus, 'F1b: the carrier dequeues first').toBe('f1b_carrier');
    const carrierResult = engine.submitFindings({
      focus_node_id: 'f1b_carrier',
      sections: [{ angle: 'business' as const, text: 'carrier' }],
      summary: 'carrier',
      verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1b_proven', col: 'TargetCol' }] }],
      route_requests: [{ nodeId: 'f1b_proven', question: 'where does TargetCol come from?', columns: ['TargetCol'] }],
    });
    expect('error' in carrierResult, 'F1b: the carrier hop commits').toBe(false);

    // The filter branch states the row role about the TABLE. The table is never analysed, so the
    // claim is contracted onto both bodied nodes behind it — one proven, one not.
    engine.getHopContext();
    expect(engine.currentFocus, 'F1b: the filter branch dequeues next').toBe('f1b_filter');
    const filterResult = engine.submitFindings({
      focus_node_id: 'f1b_filter',
      sections: [{ angle: 'business' as const, text: 'filter' }],
      summary: 'filter',
      verdict: 'passthrough',
      column_flow: [],
      route_requests: [{ nodeId: 'f1b_bridge', question: 'which rows does this admit?', columns: 'none' as const }],
    });
    expect('error' in filterResult, 'F1b: the filter hop commits').toBe(false);
    return engine;
  }

  it('F1b: the contracted row role does not subtract the column question a committed edge opened', () => {
    const engine = drivenContraction();

    engine.getHopContext();
    expect(engine.currentFocus, 'F1b: the proven node dispatches').toBe('f1b_proven');
    expect(
      engine.columnAspect?.active_columns.join(','),
      'F1b: the hop is asked about the column the committed edge attributes to it',
    ).toBe('TargetCol');
  });

  it('F1b: the completeness guard then refuses an empty column_flow at that node', () => {
    const engine = drivenContraction();
    engine.getHopContext();

    const result = engine.submitFindings({
      focus_node_id: 'f1b_proven',
      sections: [{ angle: 'business' as const, text: 'proven' }],
      summary: 'proven',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [],
    });
    expect(
      'error' in result ? result.error : undefined,
      'F1b: a node declaring the active column may not end the chain with column_flow: []',
    ).toBe('column_chain_incomplete');
  });

  it('F1b: a node the committed spine says nothing about still dispatches with no column', () => {
    const engine = drivenContraction();
    engine.getHopContext();

    const provenResult = engine.submitFindings({
      focus_node_id: 'f1b_proven',
      sections: [{ angle: 'business' as const, text: 'proven' }],
      summary: 'proven',
      verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [] }],
      route_requests: [],
    });
    expect('error' in provenResult, 'F1b: the proven node terminates its own column').toBe(false);

    engine.getHopContext();
    expect(engine.currentFocus, 'F1b: the unproven node dispatches next').toBe('f1b_unproven');
    expect(
      engine.columnAspect?.active_columns.length,
      'F1b: no committed edge names it, so the stated row role stands and no target set is padded back on',
    ).toBe(0);
  });

  it('F1b: the overturned absence claim is logged, never applied silently', () => {
    const logs: string[] = [];
    const engine = drivenContraction((_level, message) => logs.push(message));
    engine.getHopContext();
    expect(
      logs.some(line => line.includes('[Normalize] dispatch carry') && line.includes('f1b_proven') && line.includes('from=none')),
      'F1b: the normalization names the node and the claim it overturned',
    ).toBe(true);
  });
});
