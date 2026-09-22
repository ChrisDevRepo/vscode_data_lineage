import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * Carrier continuation contract (CT passthrough at a body-less focus).
 *
 * A focus with no body of its own (table) declares CONTINUATION — the tracked column passes
 * through to the neighbours on its carrier side — and attribution lands on the writer's own hop,
 * where the body is in view. CT stays BB plus the column aspect: continuation rides the existing
 * route machinery and never creates its own routing path.
 */
describe('CT carrier continuation', () => {
  const factTable: LineageNode = makeNode({
    id: 'facttable',
    schema: 'dbo',
    name: 'facttable',
    type: 'table',
    columns: [{ name: 'Margin', type: 'decimal', nullable: 'NULL', extra: '' }],
  });
  const writerA: LineageNode = makeNode({
    id: 'writera',
    schema: 'dbo',
    name: 'writera',
    type: 'procedure',
  });
  const writerB: LineageNode = makeNode({
    id: 'writerb',
    schema: 'dbo',
    name: 'writerb',
    type: 'procedure',
  });
  const stranger: LineageNode = makeNode({
    id: 'stranger',
    schema: 'dbo',
    name: 'stranger',
    type: 'table',
    columns: [{ name: 'Margin', type: 'decimal', nullable: 'NULL', extra: '' }],
  });
  const nodeMap = new Map<string, LineageNode>([
    ['facttable', factTable],
    ['writera', writerA],
    ['writerb', writerB],
    ['stranger', stranger],
  ]);
  const carrierModel: DatabaseModel = {
    ...makeModel([factTable, writerA, writerB, stranger], [], ['dbo']),
    neighborIndex: {
      facttable: { in: ['writera', 'writerb'], out: [] },
      writera: { in: [], out: ['facttable'] },
      writerb: { in: [], out: ['facttable'] },
      stranger: { in: [], out: [] },
    },
  };
  const tracer = new ColumnTracer(['Margin']);

  it('a body-less focus accepts continuation at its writer and stages the edge', () => {
    const result = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'writera', col: 'Margin' }],
      }],
    } as any, nodeMap, carrierModel, null);
    expect(result.invalidRoutes, 'continuation at the writer is not a rejection').toEqual([]);
    expect(result.stagedEdges.length, 'continuation stages exactly one edge').toBe(1);
    expect(result.stagedEdges[0], 'edge runs writer -> carrier with the tracked column').toMatchObject({
      from_node: 'writera', to_node: 'facttable', to_col: 'Margin', from_col: 'Margin',
    });
  });

  it('a body-less focus rejects continuation at a non-writer, naming the writers', () => {
    const result = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'stranger', col: 'Margin' }],
      }],
    } as any, nodeMap, carrierModel, null);
    expect(result.invalidRoutes.some((r) => r.kind === 'non_writer_continuation'), 'non-writer continuation rejected').toBe(true);
    const route = result.invalidRoutes.find((r) => r.kind === 'non_writer_continuation');
    expect(route?.available_routes, 'rejection lists the true writers').toEqual(['writera', 'writerb']);
    expect(result.stagedEdges.length, 'nothing staged for a non-writer').toBe(0);
  });

  it('continuation fans out to several writers in one entry', () => {
    const result = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [
          { node: 'writera', col: 'Margin' },
          { node: 'writerb', col: 'Margin' },
        ],
      }],
    } as any, nodeMap, carrierModel, null);
    expect(result.invalidRoutes, 'multi-writer fan-out is not a rejection').toEqual([]);
    expect(result.stagedEdges.length, 'one edge per writer').toBe(2);
  });

  it('a pruned writer reports pruned_contributor, not continuation', () => {
    const result = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'writera', col: 'Margin' }],
      }],
    } as any, nodeMap, carrierModel, null, undefined, new Set(['writera']));
    expect(result.invalidRoutes.some((r) => r.kind === 'pruned_contributor'), 'prune-before-demand wins').toBe(true);
    expect(result.invalidRoutes.some((r) => r.kind === 'non_writer_continuation'), 'no continuation kind alongside').toBe(false);
  });

  it('a downstream trace continues at consumers, not producers', () => {
    const reader: LineageNode = makeNode({
      id: 'readerproc', schema: 'dbo', name: 'readerproc', type: 'procedure',
    });
    const downstreamMap = new Map<string, LineageNode>([...nodeMap, ['readerproc', reader]]);
    const downstreamModel: DatabaseModel = {
      ...carrierModel,
      neighborIndex: {
        ...carrierModel.neighborIndex,
        facttable: { in: ['writera', 'writerb'], out: ['readerproc'] },
      },
    };
    const producer = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'writera', col: 'Margin' }],
      }],
    } as any, downstreamMap, downstreamModel, null, undefined, undefined, 'downstream');
    expect(producer.invalidRoutes.some((r) => r.kind === 'non_writer_continuation'), 'producer rejected on a downstream trace').toBe(true);
    expect(
      producer.invalidRoutes.find((r) => r.kind === 'non_writer_continuation')?.available_routes,
      'rejection names the consumer',
    ).toEqual(['readerproc']);
    const consumer = tracer.validateColumnFlow('facttable', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'readerproc', col: 'Margin' }],
      }],
    } as any, downstreamMap, downstreamModel, null, undefined, undefined, 'downstream');
    expect(consumer.invalidRoutes, 'consumer accepted on a downstream trace').toEqual([]);
  });

  it('a bodied focus still enforces real read columns on procedures', () => {
    const procModel: DatabaseModel = {
      ...makeModel([writerA, stranger], [], ['dbo']),
      neighborIndex: {
        writera: { in: ['stranger'], out: [] },
        stranger: { in: [], out: ['writera'] },
      },
    };
    const procTracer = new ColumnTracer(['Margin']);
    const procMap = new Map<string, LineageNode>([
      ['writera', writerA],
      ['stranger', stranger],
    ]);
    const result = procTracer.validateColumnFlow('writera', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{
        out_col: 'Margin',
        upstream_columns: [{ node: 'stranger', col: 'NoSuchColumn' }],
      }],
    } as any, procMap, procModel, null);
    expect(
      result.invalidRoutes.some((r) => r.kind === 'bad_contributor_col'),
      'invented inbound column on a bodied focus still rejected',
    ).toBe(true);
  });
});

describe('CT is BB plus columns: same trace, same node set', () => {
  const srcTable: LineageNode = makeNode({
    id: 'srctable',
    schema: 'dbo',
    name: 'srctable',
    type: 'table',
    columns: [{ name: 'raw', type: 'int', nullable: 'NOT NULL', extra: '' }],
  });
  const writerProc: LineageNode = makeNode({
    id: 'writerproc',
    schema: 'dbo',
    name: 'writerproc',
    type: 'procedure',
  });
  const factTable: LineageNode = makeNode({
    id: 'facttable',
    schema: 'dbo',
    name: 'facttable',
    type: 'table',
    columns: [{ name: 'Margin', type: 'decimal', nullable: 'NULL', extra: '' }],
  });
  const nodes = [srcTable, writerProc, factTable];
  const edges: Array<[string, string]> = [['srctable', 'writerproc'], ['writerproc', 'facttable']];

  function drive(mode: 'bb' | 'ct'): string[] {
    const model = makeModel(nodes, edges, ['dbo']);
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    if (mode === 'bb') {
      engine.init({ origin: 'facttable', question: 'test', direction: 'upstream', analysisMode: 'bb' });
    } else {
      engine.init({ origin: 'facttable', question: 'test', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Margin'] });
    }
    const visited: string[] = [];
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      visited.push(id);
      const routes = engine.requiredNeighborIds(id).map((nodeId) => ({
        nodeId, question: `what does ${nodeId} contribute?`, columns: ['Margin'],
      }));
      engine.submitFindings({
        focus_node_id: id,
        sections: [{ angle: 'business' as const, text: `analysis for ${id}` }],
        summary: id,
        verdict: 'analyze',
        route_requests: routes,
        ...(mode === 'ct'
          ? {
              column_flow: id === 'facttable'
                ? [{ out_col: 'Margin', upstream_columns: [{ node: 'writerproc', col: 'Margin' }] }]
                : [{ out_col: 'Margin', upstream_columns: [{ node: 'srctable', col: 'raw' }] }],
            }
          : {}),
      });
    }
    return visited;
  }

  it('BB and CT visit the identical node set in the identical order', () => {
    const bb = drive('bb');
    const ct = drive('ct');
    // The terminal source table contracts (no analyzable hop) in both modes — the engine's
    // non-bodied contraction, not a CT rule — so both stop after the writer hop, where the
    // Margin attribution lands with the body in view.
    expect(bb, 'BB reaches the writer hop').toEqual(['facttable', 'writerproc']);
    expect(ct, 'CT graph equals BB graph').toEqual(bb);
  });
});

describe('CT carrier continuation on a bidirectional trace', () => {
  const writerProc: LineageNode = makeNode({ id: 'writerproc', schema: 'dbo', name: 'writerproc', type: 'procedure' });
  const readerProc: LineageNode = makeNode({ id: 'readerproc', schema: 'dbo', name: 'readerproc', type: 'procedure' });
  const strangerProc: LineageNode = makeNode({ id: 'strangerproc', schema: 'dbo', name: 'strangerproc', type: 'procedure' });
  const factTable: LineageNode = makeNode({
    id: 'facttable', schema: 'dbo', name: 'facttable', type: 'table',
    columns: [{ name: 'Margin', type: 'decimal', nullable: 'NULL', extra: '' }],
  });
  const nodes = [writerProc, factTable, readerProc, strangerProc];
  const edges: Array<[string, string]> = [['writerproc', 'facttable'], ['facttable', 'readerproc']];
  const model: DatabaseModel = {
    ...makeModel(nodes, edges, ['dbo']),
    neighborIndex: {
      writerproc: { in: [], out: ['facttable'] },
      facttable: { in: ['writerproc'], out: ['readerproc'] },
      readerproc: { in: ['facttable'], out: [] },
      strangerproc: { in: [], out: [] },
    },
  };

  function originEngine(): NavigationEngine {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'facttable', question: 'trace Margin both ways', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Margin'] });
    const hop = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    expect(hop.focus_node?.id, 'the table origin is the first focus').toBe('facttable');
    return engine;
  }

  it('a table origin continues at its writer in column_flow and reaches its reader through route carry', () => {
    const engine = originEngine();
    const result = engine.submitFindings({
      focus_node_id: 'facttable',
      sections: [{ angle: 'business' as const, text: 'Margin is written by writerproc and read by readerproc' }],
      summary: 'ok',
      verdict: 'analyze',
      route_requests: [
        { nodeId: 'writerproc', question: 'how is Margin written?', columns: ['Margin'] },
        { nodeId: 'readerproc', question: 'how is Margin consumed?', columns: ['Margin'] },
      ],
      column_flow: [{ out_col: 'Margin', upstream_columns: [{ node: 'writerproc', col: 'Margin' }] }],
    });
    expect('error' in result ? result : null, 'producing-side continuation plus a carried reader route is accepted').toBeNull();
    const seen = new Map<string, string[]>();
    for (let hop = 0; hop < 4; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      seen.set(id, [...(engine.columnAspect?.active_columns ?? [])]);
      engine.submitFindings({
        focus_node_id: id,
        sections: [{ angle: 'business' as const, text: id }],
        summary: id,
        verdict: 'analyze',
        column_flow: [{ out_col: 'Margin', upstream_columns: [] }],
      });
    }
    expect(seen.get('writerproc'), 'the writer is dispatched carrying Margin').toEqual(['Margin']);
    expect(seen.get('readerproc'), 'the reader is dispatched carrying Margin — downstream continues through route carry').toEqual(['Margin']);
  });

  it('a table origin refuses a reader named in column_flow: that side continues through route carry', () => {
    const engine = originEngine();
    const result = engine.submitFindings({
      focus_node_id: 'facttable',
      sections: [{ angle: 'business' as const, text: 'Margin' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Margin', upstream_columns: [{ node: 'readerproc', col: 'Margin' }] }],
    });
    expect(JSON.stringify(result), 'a reader-side continuation edge is refused').toContain('continuation_not_writer');
  });
});
