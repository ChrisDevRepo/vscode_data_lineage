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
