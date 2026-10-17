// Owner: src/ai/sm/smBase.ts, columnTracer.ts and agendaManager.ts; supplied-message functional contracts.
/**
 * Runs column-flow rows from `tests/cases/lineage-cases.yaml`.
 * A row locks ids, columns, edges, and rejection kinds. Prompt sentences stay out of the catalog.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { AgendaManager } from '../../../src/ai/sm/agendaManager';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { ColumnEdge, ColumnFlowEntry, ScalarReturnTarget } from '../../../src/ai/sm/smTypes';
import { NavigationEngine, type HopNeighborDisclosure } from '../../../src/ai/sm/smBase';
import { findingRepairOrder, submitFindingsSchemaForMode, toHopFinding } from '../../../src/ai/tools/toolSchemas';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';

import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { buildColumnTraceView } from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { ColumnStore } from '../../../src/engine/columnStore';

const { loadCases } = createRequire(import.meta.url)('../../cases/loadCases.cjs') as {
  loadCases: (runner?: string) => CatalogRow[];
};

interface FlowColumn {
  readonly node: string;
  readonly col: string;
  readonly transforms?: readonly string[];
  readonly note?: string;
}

interface CaseNode {
  readonly id: string;
  readonly type: ObjectType;
  readonly columns?: readonly string[];
}

interface CaseExpect {
  readonly edges?: readonly string[];
  readonly invalid?: readonly unknown[];
  readonly invalid_kind?: string;
  readonly reason_contains?: string;
}

interface LineageCase {
  readonly id: string;
  readonly active: readonly string[];
  readonly nodes: readonly CaseNode[];
  readonly focus: string;
  readonly out: string;
  readonly direction: 'upstream' | 'downstream';
  readonly roots?: readonly { node: string; col: string }[];
  readonly upstream?: readonly FlowColumn[];
  readonly extra?: readonly { out: string; upstream?: readonly FlowColumn[] }[];
  readonly matrix?: readonly FlowColumn[];
  readonly expect: CaseExpect;
}

interface CatalogRow {
  readonly id: string;
  readonly contract?: 'stored-arrival' | 'self-prune';
  readonly runners?: readonly string[];
  readonly prompt?: string;
  readonly command?: string;
  readonly dacpac?: string;
  readonly expect?: CaseExpect & { graph?: boolean; terminal?: string; phase?: string };
}

interface StoredArrivalCase {
  id: string;
  receiver_type: 'procedure' | 'view';
  sql: string;
  receiver_columns: string[];
  sink_columns: string[];
  column_flow: ColumnFlowEntry[];
  terminated_inputs?: ScalarReturnTarget[];
  expect: {
    mapped_inputs: string[];
    receiver_rows: string[];
    sink_mode: 'ct' | 'bb';
    sink_columns: string[];
  };
}

interface SelfPruneCase {
  id: string;
  story: string;
  mode: 'bb' | 'ct' | Array<'bb' | 'ct'>;
  direction?: 'upstream' | 'downstream';
  route: 'inherited' | 'authored' | 'mapped' | 'root' | 'function' | 'mixed' | 'held-mapping' | 'pending-sender';
  through_storage?: boolean;
  /** Arbitrary topology: short object names are qualified in the synthetic d schema. */
  graph: { edges: Array<[string, string]> };
  expect: {
    eligible: boolean;
    /** Eligible, but the removal is rejected because committed column mappings name the node. */
    refused?: boolean;
    pruned: string[];
    unvisited?: string[];
    inspected?: string[];
    kept?: string[];
    edges?: Array<[string, string]>;
  };
}

const scriptedCatalog = loadCases('scripted');
const scriptedCases = scriptedCatalog.filter(row => row.contract === undefined) as unknown as LineageCase[];
const storedArrivalCases = scriptedCatalog.filter(row => row.contract === 'stored-arrival') as unknown as StoredArrivalCase[];
const selfPruneCases = (scriptedCatalog.filter(row => row.contract === 'self-prune') as unknown as SelfPruneCase[])
  .flatMap(row => [row.mode].flat().map(mode => ({ ...row, mode,
    id: Array.isArray(row.mode) ? `${mode}-${row.id}` : row.id,
  })));

function column(name: string) {
  return { name, type: 'int', nullable: 'NULL' as const, extra: '' };
}

/** Builds graph and neighbor metadata from one declared fixture topology. */
function navigationFor(nodes: LineageNode[], pairs: ReadonlyArray<readonly [string, string]>) {
  const model = makeIndexedModel(nodes, pairs);
  return new NavigationEngine(model, makeGraph(nodes, pairs.map(([from, to]) => [from, to])), () => {}, {});
}

/** Uses the same declared objects and topology to check delivered column rows. */
function columnViewFor(nodes: LineageNode[], pairs: ReadonlyArray<readonly [string, string]>, edges: readonly ColumnEdge[]) {
  return buildColumnTraceView({ config: DEFAULT_CONFIG,
    objects: new Map(nodes.map(node => [node.id.toLowerCase(), { id: node.id, label: node.name, schema: node.schema, objectType: node.type }])),
    objectEdges: pairs.map(([source, target]) => ({ source, target })),
    relations: edges.map(edge => ({ fromNode: edge.from_node, fromCol: edge.from_col, toNode: edge.to_node, toCol: edge.to_col, hopNode: edge.hop_node })),
  });
}

function run(row: LineageCase, upstream: readonly FlowColumn[]) {
  const nodes = row.nodes.map(node => makeNode({
    id: node.id, schema: 'dbo', name: node.id, type: node.type,
    columns: (node.columns ?? []).map(column),
  }));
  const result = new ColumnTracer([...row.active]).validateColumnFlow(
    row.focus,
    { summary: 's', sections: [], column_flow: [
      { out_col: row.out, upstream_columns: upstream },
      ...(row.extra ?? []).map(entry => ({ out_col: entry.out, upstream_columns: entry.upstream ?? [] })),
    ] } as never,
    new Map<string, LineageNode>(nodes.map(node => [node.id, node])),
    makeModel(nodes, [], ['dbo']),
    null,
    undefined,
    undefined,
    row.direction,
    undefined,
    [],
    [],
    [],
    row.roots ?? [],
  );
  return result;
}

function check(row: LineageCase, upstream: readonly FlowColumn[]) {
  const result = run(row, upstream);
  const wanted = row.expect;
  if (wanted.edges) expect(result.stagedEdges.map(edge => edge.from_col)).toEqual(wanted.edges);
  if (wanted.invalid) expect(result.invalidRoutes).toEqual(wanted.invalid);
  if (wanted.invalid_kind) expect(result.invalidRoutes[0]?.kind).toBe(wanted.invalid_kind);
  if (wanted.reason_contains) expect(result.invalidRoutes[0]?.reason).toContain(wanted.reason_contains);
}

describe('declared contributor identities', () => {
  it('stages a valid neighbor-column pair that does not sit on the requested chain', () => {
    const result = run({ id: 'detached-source-array', active: ['Tracked'], focus: 'writer', out: 'Other', direction: 'downstream',
      roots: [{ node: 'writer', col: 'Tracked' }],
      nodes: [{ id: 'writer', type: 'procedure' }, { id: 'source', type: 'table', columns: ['Other'] }], expect: {},
    }, [{ node: 'source', col: 'Other' }]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([expect.objectContaining({
      from_node: 'source', from_col: 'Other', to_node: 'writer', to_col: 'Other',
    })]);
  });

  it.each([false, true])('merges queued column aliases under the shared CS=%s policy without normalizing questions', caseSensitive => {
    const agenda = new AgendaManager(caseSensitive);
    for (const [index, name] of ['Value', '[Value]', ' "Value" ', 'value'].entries()) {
      agenda.push({ nodeId: 'focus', taskIds: [`task${index}`], priority: 0, depth: 1,
        activeColumns: [name], columnCarry: { kind: 'carry', columns: [name] }, lineageQuestions: [`Explain ${name}`] });
    }
    const expected = caseSensitive ? ['Value', 'value'] : ['Value'];
    expect(agenda.length).toBe(1);
    expect(agenda.get('focus')).toMatchObject({ taskIds: ['task0', 'task1', 'task2', 'task3'],
      activeColumns: expected, columnCarry: { kind: 'carry', columns: expected } });
    expect(agenda.get('focus')?.lineageQuestions).toEqual(['Explain Value', 'Explain [Value]', 'Explain  "Value" ', 'Explain value']);
  });

  it.each([
    { target: ' value ', caseSensitive: false, accepted: true },
    { target: ' Value ', caseSensitive: true, accepted: true },
    { target: '[Value]', caseSensitive: false, accepted: true },
    { target: '"Value"', caseSensitive: true, accepted: true },
    { target: ' value ', caseSensitive: true, accepted: false },
    { target: 'LTRIM(Value)', caseSensitive: false, accepted: false },
  ])('compares CT target $target under caseSensitive=$caseSensitive without interpreting SQL', ({ target, caseSensitive, accepted }) => {
    const nodes = [makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column('Value')] })];
    const model = { ...makeIndexedModel(nodes, []), identifierCaseSensitive: caseSensitive };
    const engine = new NavigationEngine(model, makeGraph(nodes, []), () => {}, {});
    const result = engine.init({ origin: 'root', question: 'Trace Value', direction: 'upstream', depthIntent: upstreamAll, analysisMode: 'ct', targetColumns: [target] });
    expect(result).toHaveProperty(accepted ? 'ok' : 'code', accepted ? true : 'unknown_columns');
    if (accepted) {
      expect(engine.columnAspect?.target_columns).toEqual([target]);
      expect(engine.columnAspect?.active_columns).toEqual(['Value']);
    } else {
      expect(result).toMatchObject({ detail: [{ path: 'targetColumns.0', allowed_values: ['Value'], when: { node: 'root' } }] });
      expect(result).toHaveProperty('hint', expect.not.stringContaining('Its columns are:'));
    }
  });
  it.each(['source.Value'])('rejects target column alias %s without rewriting it', target => {
    const nodes = [makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column('Value')] })];
    const engine = navigationFor(nodes, []);
    expect(engine.init({ origin: 'root', question: 'Trace Value', direction: 'upstream', depthIntent: upstreamAll, analysisMode: 'ct', targetColumns: [target] })).toHaveProperty('code', 'unknown_columns');
    expect(engine.init({ origin: 'root', question: 'Trace Value', direction: 'upstream', depthIntent: upstreamAll, analysisMode: 'ct', targetColumns: ['Value'] })).toHaveProperty('ok', true);
    expect(engine.columnAspect?.target_columns).toEqual(['Value']);
  });
  it('preserves a dotted procedure output when metadata cannot verify it', () => {
    const nodes = [makeNode({ id: 'proc', name: 'proc', schema: 'dbo', type: 'procedure', bodyScript: 'SELECT 1 AS [A.B];' })];
    const engine = navigationFor(nodes, []);
    expect(engine.init({ origin: 'proc', question: 'Trace the result', direction: 'upstream', depthIntent: upstreamAll, analysisMode: 'ct', targetColumns: ['A.B'] })).toHaveProperty('ok', true);
    expect(engine.columnAspect?.target_columns).toEqual(['A.B']);
    expect(engine.columnAspect?.active_columns).toEqual(['A.B']);
  });

  it.each(['123', "'quoted'"])('accepts metadata column %s without interpreting it as SQL', name => {
    const result = run({ id: 'declared-identity', active: ['Value'], focus: 'root', out: 'Value', direction: 'upstream', roots: [{ node: 'root', col: 'Value' }],
      nodes: [{ id: 'root', type: 'view', columns: ['Value'] }, { id: 'source', type: 'table', columns: [name] }], expect: {},
    }, [{ node: 'source', col: name }]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges.map(edge => edge.from_col)).toEqual([name]);
  });
  it.each(['Total', '123', "'quoted'"])('accepts unverified procedure output %s without inferring its meaning', output => {
    const nodes = [makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column(output)] }),
      makeNode({ id: 'proc', name: 'proc', schema: 'dbo', type: 'procedure', bodyScript: `SELECT SourceAmount * 2 AS [${output}] FROM source;` }),
      makeNode({ id: 'source', name: 'source', schema: 'dbo', type: 'table', columns: [column('SourceAmount')] })];
    const result = new ColumnTracer([output]).validateColumnFlow('root',
      { focus_node_id: 'root', summary: 'Calculated output', sections: [], column_flow: [{ out_col: output, upstream_columns: [{ node: 'proc', col: output }] }] },
      new Map(nodes.map(node => [node.id, node])), makeIndexedModel(nodes, [['source', 'proc'], ['proc', 'root']]), null, undefined, undefined, 'upstream', undefined, [], [], [], [{ node: 'root', col: output }]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges.map(edge => edge.from_col)).toEqual([output]);
  });
});

describe('lineage case catalog', () => {
  it('gives Playwright, Electron, and headless their own rows and expected output', () => {
    const rows = loadCases();
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(scriptedCases.length).toBeGreaterThan(0);
    expect(storedArrivalCases.length).toBeGreaterThan(0);
    for (const row of scriptedCases) {
      const keys = Object.keys(row.expect);
      expect(keys.length > 0 && keys.every(key => ['edges', 'invalid', 'invalid_kind', 'reason_contains'].includes(key)), row.id).toBe(true);
    }
    expect(selfPruneCases.length).toBeGreaterThan(0);
    expect(new Set(selfPruneCases.map(row => row.id)).size).toBe(selfPruneCases.length);
    expect(selfPruneCases.every(row => typeof row.story === 'string' && row.story.trim().length > 0)).toBe(true);
    for (const row of selfPruneCases.filter(row => row.expect.eligible && !row.expect.refused)) {
      expect(Object.keys(row.expect)).toEqual(expect.arrayContaining(['unvisited', 'pruned', 'inspected', 'kept', 'edges']));
    }
    expect(scriptedCatalog.every(row => row.contract === undefined || row.contract === 'stored-arrival' || row.contract === 'self-prune')).toBe(true);
    expect(loadCases('scripted').some(row => row.runners?.includes('playwright'))).toBe(false);
    for (const runner of ['playwright', 'electron', 'headless'] as const) {
      const rows = loadCases(runner);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.runners).toEqual([runner]);
        expect(row.id.length).toBeGreaterThan(0);
        if (runner === 'playwright') {
          expect(row.command?.length).toBeGreaterThan(0);
          expect(row.expect?.graph).toBe(true);
        } else {
          expect(row.prompt?.length).toBeGreaterThan(0);
        }
        if (runner === 'electron') expect(row.expect?.phase?.length).toBeGreaterThan(0);
        if (runner === 'headless') {
          expect(row.dacpac?.length).toBeGreaterThan(0);
          expect(['ok', 'error', 'cancelled']).toContain(row.expect?.terminal);
        }
      }
    }
  });

  it.each(scriptedCases)('$id', row => {
    const calls = row.matrix?.length ? row.matrix : [row.upstream ?? []];
    for (const upstream of calls) {
      check(row, Array.isArray(upstream) ? upstream : [upstream]);
    }
  });
});

describe('carrier value-edge orientation', () => {
  it('keeps a requested output available to its consumer when upstream suppliers are outside an exact zero limit', () => {
    const supplier = '[d].[Supplier]', focus = '[d].[Focus]', consumer = '[d].[Consumer]';
    const nodes = [
      makeNode({ id: supplier, schema: 'd', name: 'Supplier', type: 'table', columns: [column('Value')] }),
      makeNode({ id: focus, schema: 'd', name: 'Focus', type: 'view', columns: [column('Value')], bodyScript: `SELECT Value FROM ${supplier}` }),
      makeNode({ id: consumer, schema: 'd', name: 'Consumer', type: 'view', columns: [column('Result')], bodyScript: `SELECT Value AS Result FROM ${focus}` }),
    ];
    const engine = navigationFor(nodes, [[supplier, focus], [focus, consumer]]);
    expect(engine.init({ origin: focus, question: 'Trace Value downstream one level.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const sections = [{ angle: 'technical' as const, text: `Value comes from ${supplier}, outside the requested upstream limit.` }];
    expect(engine.submitFindings({ focus_node_id: focus, summary: 'Value is supplied from outside the requested trace.', sections,
      column_flow: [{ out_col: 'Value', upstream_columns: [] }], questions: [{ nodeId: consumer, question: 'Determine how Value supplies Result.' }],
    })).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: consumer }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ kind: 'column_lineage', sourceRefs: [{ node: focus, col: 'Value' }] }));
    expect(engine.submitFindings({ focus_node_id: consumer, summary: 'Result uses Value.', sections: [{ angle: 'technical', text: 'Value is renamed Result.' }],
      column_flow: [{ out_col: 'Result', upstream_columns: [{ node: focus, col: 'Value' }] }],
    })).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toMatchObject([{ from_node: focus, from_col: 'Value', to_node: consumer, to_col: 'Result' }]);
  });

  it.each([
    ...(['ordinary', 'delete-only', 'read-only', 'missing-index'] as const).map(metadata => ({ direction: 'upstream' as const, metadata })),
    { direction: 'downstream' as const, metadata: 'ordinary' as const },
  ])('automatically forwards storage candidates $direction/$metadata without inventing a value edge', ({ direction, metadata }) => {
    const origin = '[d].[Origin]', carrier = '[d].[Stored]', next = '[d].[Next]';
    const upstream = direction === 'upstream';
    const nodes = [
      makeNode({ id: origin, schema: 'd', name: 'Origin', type: upstream ? 'view' : 'procedure', columns: [column('Value')] }),
      makeNode({ id: carrier, schema: 'd', name: 'Stored', type: 'table', columns: [column('Value')] }),
      makeNode({ id: next, schema: 'd', name: 'Next', type: upstream && metadata !== 'read-only' ? 'procedure' : 'view', columns: upstream && metadata !== 'read-only' ? [] : [column('Value')] }),
    ];
    const pairs: Array<[string, string]> = upstream ? [[next, carrier], [carrier, origin]] : [[origin, carrier], [carrier, next]];
    const engine = engineFor(nodes, pairs, model => {
      if (metadata === 'delete-only') model.edges[0].deleteOnly = true;
      if (metadata === 'missing-index') model.neighborIndex = {};
    });
    expect(engine.init({ origin, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction,
      depthIntent: { upstream: { levels: upstream ? 'all' : 0, exactness: 'exact' }, downstream: { levels: upstream ? 0 : 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const question = 'Establish the stored Value contribution from actual SQL.';
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Value',
      upstream_columns: upstream ? [{ node: carrier, col: 'Value' }] : [], ...(!upstream ? { writes_to: { node: carrier, col: 'Value' } } : {}),
    }], questions: [{ nodeId: carrier, question }] })).toHaveProperty('ok', true);
    const edges = structuredClone(engine.columnAspect!.edges);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: next }, analysis_mode: 'ct', storage_context: [expect.objectContaining({ id: carrier })] });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ activeColumns: ['Value'],
      sourceRefs: [{ node: carrier, col: 'Value' }], traversalSide: direction, question, passthroughFromNodeId: carrier }));
    expect(engine.columnAspect!.edges).toEqual(edges);
    expect(engine.toJSON().nodeStates).toContainEqual(expect.objectContaining({ nodeId: carrier, action: 'passthrough', source: 'engine', reason: 'storage_passthrough' }));
    expect(engine.canPruneCurrent).toBe(true);
  });
  it.each(['upstream', 'downstream'] as const)('accepts adjacent inputs and rejects non-adjacent inputs while exploring %s', direction => {
    const writer = '[d].[Writer]', carrier = '[d].[Stored]', reader = '[d].[Reader]', other = '[d].[Other]';
    const nodes = [writer, carrier, reader, other].map(id => makeNode({ id, schema: 'd', name: id,
      type: id === carrier ? 'table' : 'view', columns: ['Value'].map(column) }));
    const model = makeModel(nodes, [[writer, carrier], [carrier, reader]], ['d']);
    model.neighborIndex = { '[d].[stored]': { in: [writer], out: [reader] } };
    const validate = (source: string) => new ColumnTracer(['Value']).validateColumnFlow(carrier,
      { focus_node_id: carrier, summary: 'Trace Value.', sections: [], column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Value' }] }] },
      new Map(nodes.map(node => [node.id, node])), model, null, undefined, undefined, direction,
      [{ node: carrier, col: 'Value' }], [], [], [], [{ node: carrier, col: 'Value' }], new Set([writer, reader]));
    const valid = validate(writer);
    expect(valid.invalidRoutes).toEqual([]);
    expect(valid.stagedEdges).toMatchObject([{ from_node: writer, to_node: carrier }]);
    const reversed = validate(other);
    expect(reversed.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'absent_contributor' }));
    expect(reversed.stagedEdges).toEqual([]);
  });
});

describe('stored-column arrival admission and delivery', () => {
  const producer = '[d].[Producer]', stored = '[d].[Stored]';
  const record = (focus_node_id: string) => ({ focus_node_id,
    summary: 'Inspect the supplied stored-column task.', sections: [{ angle: 'technical' as const, text: 'The supplied SQL establishes the input dispositions.' }] });

  function storedWorld(readers: LineageNode[], branches: Array<[string, string]>, question: string, storedColumns = ['X', 'Y']) {
    const nodes = [
      makeNode({ id: producer, schema: 'd', name: 'Producer', type: 'procedure', columns: [], bodyScript: 'INSERT d.Stored(X,Y) SELECT 10,20;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: storedColumns.map(column) }), ...readers,
    ];
    const pairs: Array<[string, string]> = [[producer, stored], ...branches];
    const engine = navigationFor(nodes, pairs);
    expect(engine.init({ origin: producer, question, analysisMode: 'ct', targetColumns: ['X', 'Y'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(producer), column_flow: ['X', 'Y'].map(out_col => ({ out_col,
      upstream_columns: [], writes_to: { node: stored, col: out_col } })), questions: [{ nodeId: stored, question }],
    })).toHaveProperty('ok', true);
    const producerEdges = structuredClone(engine.columnAspect!.edges);
    return { engine, nodes, pairs, producerEdges };
  }

  it('assigns each write destination its own renamed endpoints and other readers only producer outputs', () => {
    const left = '[d].[LeftTarget]', right = '[d].[RightTarget]', reader = '[d].[Reader]';
    const nodes = [
      makeNode({ id: producer, schema: 'd', name: 'Producer', type: 'procedure', columns: [],
        bodyScript: 'INSERT d.LeftTarget(SavedLeft) SELECT 1; INSERT d.RightTarget(SavedRight) SELECT 2;' }),
      makeNode({ id: left, schema: 'd', name: 'LeftTarget', type: 'table', columns: [column('SavedLeft')] }),
      makeNode({ id: right, schema: 'd', name: 'RightTarget', type: 'table', columns: [column('SavedRight')] }),
      makeNode({ id: reader, schema: 'd', name: 'Reader', type: 'view', columns: [column('Result')] }),
    ];
    const pairs: Array<[string, string]> = [left, right, reader].map(id => [producer, id]);
    const engine = navigationFor(nodes, pairs);
    expect(engine.init({ origin: producer, question: 'Trace both declared outputs.', analysisMode: 'ct', targetColumns: ['LeftPort', 'RightPort'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: producer, summary: 'Writes two separate destinations.',
      sections: [{ angle: 'technical', text: 'Each destination has its own qualified output.' }],
      column_flow: [
        { out_col: 'LeftPort', writes_to: { node: left, col: 'SavedLeft' }, upstream_columns: [] },
        { out_col: 'RightPort', writes_to: { node: right, col: 'SavedRight' }, upstream_columns: [] },
      ], questions: [left, right, reader].map(nodeId => ({ nodeId, question: 'Inspect this destination or reader.' })),
    })).toHaveProperty('ok', true);
    const arrivals = engine.toJSON().engineInternals.investigationTasks.filter(task => task.kind === 'column_lineage' && task.status === 'pending');
    expect(arrivals.find(task => task.nodeId === left)).toMatchObject({ activeColumns: ['SavedLeft'], sourceRefs: [{ node: left, col: 'SavedLeft' }] });
    expect(arrivals.find(task => task.nodeId === right)).toMatchObject({ activeColumns: ['SavedRight'], sourceRefs: [{ node: right, col: 'SavedRight' }] });
    expect(arrivals.find(task => task.nodeId === reader)).toMatchObject({ activeColumns: ['LeftPort', 'RightPort'],
      sourceRefs: [{ node: producer, col: 'LeftPort' }, { node: producer, col: 'RightPort' }] });
    expect(engine.columnAspect!.edges.map(edge => `${edge.from_node}.${edge.from_col}->${edge.to_node}.${edge.to_col}`)).toEqual([
      `${producer}.LeftPort->${left}.SavedLeft`, `${producer}.RightPort->${right}.SavedRight`,
    ]);
  });

  it('preserves an accepted neighbor mapping when its assigned endpoint is final', () => {
    const consumer = '[d].[Consumer]', source = '[d].[Source]';
    const nodes = [
      makeNode({ id: consumer, schema: 'd', name: 'Consumer', type: 'view', columns: [column('Total')],
        bodyScript: 'CREATE VIEW d.Consumer AS SELECT X AS Total FROM d.Source;' }),
      makeNode({ id: source, schema: 'd', name: 'Source', type: 'view', columns: [column('X')], bodyScript: 'CREATE VIEW d.Source AS SELECT 42 AS X;' }),
    ];
    const pairs: Array<[string, string]> = [[source, consumer]];
    const engine = navigationFor(nodes, pairs);
    const record = (focus_node_id: string) => ({ focus_node_id, summary: 'Resolve the assigned endpoint.',
      sections: [{ angle: 'technical' as const, text: 'The supplied definition establishes this endpoint.' }] });
    expect(engine.init({ origin: consumer, question: 'Trace Total to its source.', analysisMode: 'ct', targetColumns: ['Total'], direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(consumer), column_flow: [{ out_col: 'Total', upstream_columns: [{ node: source, col: 'X' }] }],
      questions: [{ nodeId: source, question: 'Resolve the definition of Source.X.' }],
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const task = engine.getCurrentTasks();
    expect(task).toContainEqual(expect.objectContaining({ nodeId: source, sourceRefs: [{ node: source, col: 'X' }], activeColumns: ['X'] }));
    const instruction = buildCurrentTaskBlock(task.map(item => ({ ...item, endpoints: engine.taskEndpoints(item) })), engine.columnAspect!.active_columns, engine.pendingLineageQuestions);
    expect(instruction).toContain('<assigned_endpoints>');
    expect(instruction).not.toContain('<candidate_inputs>');
    const accepted = structuredClone(engine.columnAspect!.edges);
    expect(engine.submitFindings({ ...record(source), column_flow: [{ out_col: 'X', upstream_columns: [] }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.getResult().columnAspect!.edges).toEqual(accepted);
    const view = columnViewFor(nodes, pairs, accepted);
    expect(view.nodes.find(node => node.id === source)!.rows.map(row => row.name)).toEqual(['X']);
  });

  it.each([false, true])('keeps four stored-column reader branches independent with optional self-pruning=%s', pruneUnused => {
    const readers = [
      { id: '[d].[One]', type: 'view' as const, used: ['X'], sql: 'CREATE VIEW d.One AS SELECT X AS ResultX FROM d.Stored;' },
      { id: '[d].[Both]', type: 'procedure' as const, used: ['X', 'Y'], sql: 'INSERT d.BothSink(ResultX,ResultY) SELECT X,Y FROM d.Stored;' },
      { id: '[d].[NeitherView]', type: 'view' as const, used: [], sql: 'CREATE VIEW d.NeitherView AS SELECT Z AS Unrelated FROM d.Stored;' },
      { id: '[d].[NeitherSp]', type: 'procedure' as const, used: [], sql: 'INSERT d.NeitherSpSink(Unrelated) SELECT Z FROM d.Stored;' },
    ].map(reader => ({ ...reader, sink: reader.id.replace(/\]$/, 'Sink]') }));
    const outputCols = (used: string[]) => used.length ? used.map(col => `Result${col}`) : ['Unrelated'];
    const { engine, nodes, pairs, producerEdges } = storedWorld(readers.flatMap(reader => [
      makeNode({ id: reader.id, schema: 'd', name: reader.id, type: reader.type, bodyScript: reader.sql,
        columns: (reader.type === 'procedure' ? [] : outputCols(reader.used)).map(column) }),
      makeNode({ id: reader.sink, schema: 'd', name: reader.sink, type: reader.type === 'procedure' ? 'table' : 'view',
        columns: outputCols(reader.used).map(column) }),
    ]), readers.flatMap(reader => [[stored, reader.id], [reader.id, reader.sink]] as Array<[string, string]>),
      'Check candidate consumption at each reader.', ['X', 'Y', 'Z']);
    const inspected = new Set<string>();
    for (let step = 0; step < nodes.length; step++) {
      const hop = engine.getHopContext();
      if (hop.done) break;
      const id = hop.focus_node!.id;
      if (typeof id !== 'string') throw new Error('Expected a canonical focus id');
      const reader = readers.find(entry => entry.id === id);
      if (reader) {
        inspected.add(id);
        expect(hop.analysis_mode).toBe('ct');
        expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ activeColumns: ['X', 'Y'],
          sourceRefs: [{ node: stored, col: 'X' }, { node: stored, col: 'Y' }] }));
        expect(engine.canPruneCurrent).toBe(true);
        const before = structuredClone(engine.columnAspect!.edges);
        if (pruneUnused && reader.used.length === 0) {
          expect(engine.pruneCurrent(id, 'This reader uses only Z and has no relevant role for the traced X or Y.')).toHaveProperty('ok', true);
          expect(engine.columnAspect!.edges).toEqual(before);
          continue;
        }
        expect(engine.submitFindings({ ...record(id),
          column_flow: reader.used.map(col => ({ out_col: `Result${col}`, upstream_columns: [{ node: stored, col }],
            ...(reader.type === 'procedure' ? { writes_to: { node: reader.sink, col: `Result${col}` } } : {}) })),
          questions: [{ nodeId: reader.sink, question: 'Follow confirmed outputs or explain the remaining object dependency.' }],
        })).toHaveProperty('ok', true);
        expect(engine.columnAspect!.edges.slice(0, before.length)).toEqual(before);
      } else {
        const owner = readers.find(entry => entry.sink === id)!;
        expect(hop.analysis_mode).toBe(owner.used.length ? 'ct' : 'bb');
        expect(engine.submitFindings({ ...record(id), ...(owner.used.length ? { column_flow: [] } : {}) })).toHaveProperty('ok', true);
      }
    }
    expect(inspected).toEqual(new Set(readers.map(reader => reader.id)));
    const result = engine.getResult();
    expect(result.columnAspect!.edges.filter(edge => edge.hop_node === producer)).toEqual(producerEdges);
    for (const reader of readers) {
      expect(result.columnAspect!.edges.filter(edge => edge.hop_node === reader.id && edge.from_node === stored).map(edge => edge.from_col)).toEqual(reader.used);
    }
    const view = columnViewFor(nodes, pairs, result.columnAspect!.edges);
    for (const reader of readers.filter(entry => entry.used.length === 0)) {
      if (pruneUnused) {
        expect(result.fullNodes.map(node => node.id)).not.toContain(reader.id);
        expect(result.fullNodes.map(node => node.id)).not.toContain(reader.sink);
        expect(result.node_states.find(state => state.nodeId === reader.id)).toMatchObject({ action: 'prune' });
      } else expect(view.nodes.find(node => node.id === reader.id)!.rows).toEqual([]);
    }
    expect(view.nodes.find(node => node.id === stored)!.rows.map(row => row.name)).toEqual(['X', 'Y']);
  });
  it.each(storedArrivalCases)('$id', row => {
    const receiver = '[d].[Receiver]', sink = '[d].[Sink]';
    const { engine, nodes, pairs, producerEdges } = storedWorld([
      makeNode({ id: receiver, schema: 'd', name: receiver, type: row.receiver_type, columns: row.receiver_columns.map(column), bodyScript: row.sql }),
      makeNode({ id: sink, schema: 'd', name: sink, type: row.receiver_type === 'procedure' ? 'table' : 'view', columns: row.sink_columns.map(column) }),
    ], [[stored, receiver], [receiver, sink]], 'Determine how the stored X and Y are used downstream.');
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: receiver }, analysis_mode: 'ct' });
    expect(engine.columnAspect!.edges).toEqual(producerEdges);
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({
      activeColumns: ['X', 'Y'], sourceRefs: [{ node: stored, col: 'X' }, { node: stored, col: 'Y' }],
      question: 'Determine how the stored X and Y are used downstream.',
    }));
    const submission = { ...record(receiver), column_flow: row.column_flow,
      questions: [{ nodeId: sink, question: 'Inspect the retained result, or explain the object dependency if no traced input is used.' }] };
    const admitted = engine.submitFindings({ ...submission,
      ...(row.terminated_inputs ? { terminated_inputs: row.terminated_inputs } : {}),
    });
    expect(admitted, JSON.stringify(admitted)).toHaveProperty('ok', true);
    const pending = engine.investigationTasks.find(task => task.nodeId === sink && task.status === 'pending')!;
    expect(pending).toMatchObject(row.expect.sink_mode === 'ct'
      ? { kind: 'column_lineage', activeColumns: row.expect.sink_columns }
      : { kind: 'analytical' });
    if (row.receiver_type === 'procedure') {
      expect(engine.getHopContext()).toHaveProperty('done', true);
      expect(engine.getResult().node_states.find(state => state.nodeId === sink)).toMatchObject({ action: 'passthrough', source: 'engine' });
    } else expect(engine.getHopContext()).toMatchObject({ focus_node: { id: sink }, analysis_mode: row.expect.sink_mode });
    const relations = engine.columnAspect!.edges;
    expect(relations.filter(edge => edge.hop_node === receiver && edge.from_node === stored).map(edge => edge.from_col)).toEqual(row.expect.mapped_inputs);
    expect(relations.filter(edge => edge.hop_node === producer)).toEqual(producerEdges);
    const view = columnViewFor(nodes, pairs, relations);
    expect(view.nodes.find(node => node.id === receiver)!.rows.map(row => row.name)).toEqual(row.expect.receiver_rows);
    expect(view.nodes.find(node => node.id === stored)!.rows.map(row => row.name)).toEqual(['X', 'Y']);
  });
});

describe('current-hop removal after unresolved passthrough', () => {
  it.each(selfPruneCases)('$id — $story', row => {
    const qualify = (name: string) => `[d].[${name}]`;
    const origin = '[d].[Origin]', current = '[d].[Current]', tail = '[d].[Tail]';
    const left = '[d].[Left]', right = '[d].[Right]';
    const mapped = row.route === 'mapped';
    const upstream = row.direction === 'upstream' || mapped || row.route === 'function';
    const storageOrigin = !mapped && row.route !== 'root'
      && ((row.route !== 'authored' && row.route !== 'function') || row.through_storage);
    const pairs = row.graph.edges.map(([from, to]) => [qualify(from), qualify(to)] as [string, string]);
    const ids = [...new Set(pairs.flat())];
    const nodes = ids.map(id => makeNode({ id, schema: 'd', name: id,
      type: (id === origin && storageOrigin) || (id === left && row.route === 'mixed') ? 'table'
        : id === current && row.route === 'function' ? 'function'
          : id === current && row.direction === 'upstream' ? 'procedure' : 'view',
      columns: id === current && (row.route === 'function' || row.direction === 'upstream') ? []
        : (id === origin && row.direction === 'upstream' ? ['X', 'Other'] : ['X']).map(name => ({ ...column(name),
          ...(id === origin && storageOrigin && row.route === 'function' ? { extra: 'COMPUTED', expressionDependencies: [{ reference: current, sourceElementType: 'SqlScalarFunction' }] } : {}) })),
      ...(id === current && row.direction === 'upstream' ? { bodyScript: 'UPDATE d.Origin SET Other = 42;' } : {}),
      ...(row.route === 'function' ? { bodyScript: id === origin
        ? storageOrigin ? `CREATE TABLE ${origin} (X AS ${current}(42));` : `CREATE VIEW ${origin} AS SELECT ${current}(42) AS X;`
        : `CREATE FUNCTION ${current}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END;` } : {}),
    }));
    const engine = navigationFor(nodes, pairs);
    const finding = (focus_node_id: string) => ({ focus_node_id,
      summary: 'Investigate the inherited purpose at the next SQL object.',
      sections: [{ angle: 'technical' as const, text: 'Topology supplies investigation candidates, not confirmed consumption.' }],
      ...(row.mode === 'ct' ? { column_flow: [] } : {}),
    });
    expect(engine.init({ origin, question: 'Investigate the production and use of X, including row conditions that govern its value.', analysisMode: row.mode,
      ...(row.mode === 'ct' ? { targetColumns: ['X'] } : {}), direction: upstream ? 'upstream' : 'downstream',
      depthIntent: { upstream: { levels: upstream ? 'all' : 0, exactness: 'exact' },
        downstream: { levels: upstream ? 0 : 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    let hop = engine.getHopContext();
    if (!storageOrigin) {
      expect(hop).toMatchObject({ focus_node: { id: origin } });
      if (row.route !== 'root') {
        expect(engine.submitFindings({ ...finding(origin),
          questions: [{ nodeId: current, question: 'Establish the contribution of this SQL object.',
            ...(row.route === 'function' ? { caller_context: { node: origin, col: 'X' } } : {}) }],
          ...(mapped ? { column_flow: [{ out_col: 'X', upstream_columns: [{ node: current, col: 'X' }] }] } : {}),
        })).toHaveProperty('ok', true);
        hop = engine.getHopContext();
      }
    }
    if (row.route === 'mixed') {
      expect(hop).toMatchObject({ focus_node: { id: right } });
      expect(engine.submitFindings({ ...finding(right),
        questions: [{ nodeId: current, question: 'Explain the independently established business rule.' }] })).toHaveProperty('ok', true);
      hop = engine.getHopContext();
    }
    if (row.route !== 'root') expect(hop).toMatchObject({ focus_node: { id: current } });
    if (row.route === 'held-mapping') {
      expect(engine.canPruneCurrent).toBe(true);
      expect(engine.submitFindings({ ...finding(current),
        column_flow: [{ out_col: 'X', upstream_columns: [{ node: origin, col: 'X' }] }],
      })).toMatchObject({ code: 'incomplete_task', issuePaths: ['questions.0'] });
      expect(engine.heldColumnFlow).toBe(true);
      expect(engine.columnAspect!.edges).toEqual([]);
    }
    const focus = row.route === 'root' ? origin : current;
    expect(engine.canPruneCurrent).toBe(row.expect.eligible);
    const before = engine.toJSON(), details = structuredClone(engine.getDetailSlots());
    for (const name of row.expect.unvisited ?? []) {
      const id = qualify(name);
      expect(before.scopeNodeIds).toContain(id);
      expect(before.visited).not.toContain(id);
      expect(before.removedSet).not.toContain(id);
    }
    if (row.route === 'mixed') expect(engine.getCurrentTasks()).toHaveLength(2);
    if (row.expect.eligible) {
      expect(engine.getCurrentTasks().some(task => task.passthroughFromNodeId)).toBe(true);
      expect(before.engineInternals.investigationTasks.filter(task => task.nodeId === current && task.status === 'active'))
        .toEqual(engine.getCurrentTasks());
      expect(engine.pruneCurrent(origin, 'Wrong focus must not mutate the run.')).toHaveProperty('code', 'focus_node_id_mismatch');
      expect(engine.pruneCurrent(current, '   ')).toHaveProperty('code', 'invalid_input');
      expect(engine.toJSON()).toEqual(before);
      expect(engine.getDetailSlots()).toEqual(details);
    }
    const pruned = engine.pruneCurrent(focus, 'This whole node is irrelevant to the investigation.');
    if (!row.expect.eligible || row.expect.refused) {
      expect(pruned).toHaveProperty('code', 'invalid_input');
      if (row.expect.refused) expect(pruned).toHaveProperty('reason', expect.stringContaining('Committed column mappings name [d].[Current]'));
      expect(engine.toJSON()).toEqual(before);
      expect(engine.getDetailSlots()).toEqual(details);
      if (mapped) {
        expect(engine.submitFindings({ ...finding(current),
          column_flow: [{ out_col: 'X', upstream_columns: [] }],
          prune_neighbors: [{ id: tail, reason: 'The assigned X is a literal at this source endpoint.' }],
        })).toHaveProperty('ok', true);
        expect(engine.getHopContext()).toMatchObject({ done: true });
        expect(engine.getResult().columnAspect!.edges).toEqual(before.columnAspect!.edges);
        expect(columnViewFor(nodes, pairs, engine.getResult().columnAspect!.edges).nodes.find(node => node.id === current)!.rows.map(row => row.name)).toEqual(['X']);
      }
      return;
    }
    const { cut_ids: cut = [], ...ack } = pruned as { ok: true; pruned: string[]; cut_ids?: string[] };
    expect(ack.pruned[0]).toBe(focus);
    expect([...ack.pruned, ...cut].sort()).toEqual([...row.expect.pruned].sort());
    expect(engine.columnAspect?.edges).toEqual(before.columnAspect?.edges);
    expect(engine.heldFindingFocus).toBeNull();
    const after = engine.toJSON();
    expect(after.removedSet.slice().sort()).toEqual([...before.removedSet, ...row.expect.pruned].sort());
    expect(after.visited).toEqual(before.visited);
    expect(after.removedSet.filter(id => id !== focus && before.visited.includes(id))).toEqual([]);
    expect(after.agenda.some(entry => row.expect.pruned.includes(entry.nodeId))).toBe(false);
    const inspected: string[] = [];
    for (let step = 0; step < nodes.length; step++) {
      const hop = engine.getHopContext();
      if (hop.done) break;
      const id = String(hop.focus_node!.id);
      inspected.push(id);
      const nextFinding = finding(id);
      if (hop.analysis_mode === 'bb') delete nextFinding.column_flow;
      const neighbors = hop.neighbors as readonly HopNeighborDisclosure[] | undefined;
      expect(engine.submitFindings({ ...nextFinding, questions: neighbors?.filter(neighbor => neighbor.can_question && neighbor.in_approved_scope).map(neighbor => ({ nodeId: neighbor.id, question: 'Inspect the remaining retained branch.' })) })).toHaveProperty('ok', true);
    }
    const result = engine.getResult();
    expect(result.node_states.filter(state => state.action === 'prune').map(state => state.nodeId).sort()).toEqual(row.expect.pruned);
    expect(result.fullNodes.map(node => node.id)).not.toContain(current);
    expect(result.fullNodes.map(node => node.id)).toContain(origin);
    expect(result.edges.some(([from, to]) => row.expect.pruned.includes(from) || row.expect.pruned.includes(to))).toBe(false);
    expect(inspected.slice().sort()).toEqual(row.expect.inspected!.map(qualify).sort());
    if (row.expect.kept) expect(result.fullNodes.map(node => node.id).sort()).toEqual(row.expect.kept.map(qualify).sort());
    if (row.expect.edges) expect(result.edges.map(([from, to]) => `${from}->${to}`).sort())
      .toEqual(row.expect.edges.map(([from, to]) => `${qualify(from)}->${qualify(to)}`).sort());
  });
});

describe('downstream carried inputs and authored outputs', () => {
  const origin = '[d].[Input]', focus = '[d].[Transform]', next = '[d].[Consumer]';
  const finding = (id: string) => ({ focus_node_id: id, summary: 'Trace the supplied columns.', sections: [{ angle: 'technical' as const, text: 'Inspect the declared flow.' }] });
  function world(levels: 1 | 'all' = 'all') {
    const nodes = [origin, focus, next].map(id => makeNode({ id, schema: 'd', name: id, type: 'view',
      columns: (id === origin ? ['Value', 'Other'] : ['Mapped']).map(column), bodyScript: 'SELECT 1;' }));
    const pairs: Array<[string, string]> = [[origin, focus], [focus, next]];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['d']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin, question: 'Trace Value and Other downstream', analysisMode: 'ct', targetColumns: ['Value', 'Other'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...finding(origin), column_flow: ['Value', 'Other'].map(out_col => ({ out_col, upstream_columns: [] })),
      questions: [{ nodeId: focus, question: 'Establish which inputs Transform uses.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: focus }, analysis_mode: 'ct' });
    return engine;
  }
  it.each(['continued', 'terminated'] as const)('never forwards an unmapped SQL input: %s', disposition => {
    const engine = world();
    if (disposition === 'continued') {
      const rejected = engine.submitFindings({ ...finding(focus), column_flow: [{ out_col: 'Mapped', upstream_columns: [{ node: origin, col: 'Value' }] }],
        questions: [{ nodeId: next, question: 'Establish how Consumer uses Mapped.' }] });
      expect(rejected).toMatchObject({ code: 'incomplete_task', issuePaths: ['terminated_inputs.0'],
        detail: [{ reason: expect.stringContaining(`${origin}.Other`) }] });
      expect(rejected).not.toHaveProperty('detail.0.allowed_values');
      expect(rejected).not.toHaveProperty('detail.0.when');
    }
    expect(engine.submitFindings({ ...finding(focus), column_flow: [{ out_col: 'Mapped', upstream_columns: [{ node: origin, col: 'Value' }] }],
      terminated_inputs: [{ node: origin, col: 'Other' }], questions: [{ nodeId: next, question: 'Establish how Consumer uses Mapped.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: next }, analysis_mode: 'ct' });
    expect(engine.columnAspect?.active_columns.sort()).toEqual(['Mapped']);
    expect(engine.pendingLineageQuestions.join('\n')).toContain('Mapped');
    expect(engine.getCurrentTasks()[0].question).toBe('Establish how Consumer uses Mapped.');
  });
  it('allows an explicit whole-input stop when no local output is traced, then stays BB', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding(focus), column_flow: [], questions: [{ nodeId: next, question: 'Explain the consumer role.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: next }, analysis_mode: 'bb' });
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('does not invent an out-of-scope follow-up after analyze', () => {
    const engine = world(1);
    expect(engine.submitFindings({ ...finding(focus), column_flow: [] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.pendingLeads).toEqual([]);
  });
});


describe('TaskLedger qualified references', () => {
  it.each([false, true])('retains distinct SQL literal questions through fan-in under CS=%s', caseSensitive => {
    const ledger = new TaskLedger(caseSensitive);
    const agenda = new AgendaManager(caseSensitive);
    const questions = ["Explain Code = 'US'", "Explain Code = 'us'", "Explain Code = 'A B'", "Explain Code = 'A  B'"];
    const ids = questions.map(question => {
      const task = ledger.ensureTask({ kind: 'analytical', source: 'model', nodeId: 'focus', question, createdHop: 1 });
      agenda.push({ nodeId: 'focus', taskIds: [task.id], priority: 0, depth: 1, lineageQuestions: [question] });
      return task.id;
    });
    expect(new Set(ids).size).toBe(questions.length);
    expect(agenda.get('focus')).toMatchObject({ taskIds: ids, lineageQuestions: questions });
    expect(ledger.investigationTasks.map(task => task.question)).toEqual(questions);
    expect(ledger.ensureTask({ kind: 'analytical', source: 'model', nodeId: 'focus', question: questions[0], createdHop: 2 }).id).toBe(ids[0]);
  });

  const task = (field: 'sourceRefs' | 'returnTargets', col: string) => ({
    source: 'engine' as const, question: 'Trace Value', nodeId: 'dbo.Fn',
    kind: 'column_lineage' as const, activeColumns: ['Value'] as [string],
    [field]: [{ node: 'dbo.Caller', col }], createdHop: 1,
  });

  it.each(['sourceRefs', 'returnTargets'] as const)('normalizes delimiters and insensitive case in %s identity', field => {
    const ledger = new TaskLedger();
    expect(ledger.ensureTask(task(field, '[Value]')).id).toBe(ledger.ensureTask(task(field, 'value')).id);
  });

  it.each(['sourceRefs', 'returnTargets'] as const)('preserves case-sensitive %s identity', field => {
    const ledger = new TaskLedger(true);
    expect(ledger.ensureTask(task(field, 'Value')).id).not.toBe(ledger.ensureTask(task(field, 'value')).id);
    expect(ledger.ensureTask(task(field, '[Value]')).id).toBe(ledger.ensureTask(task(field, 'Value')).id);
  });

  it.each(['bb', 'ct'] as const)('keeps inherited and assigned %s tasks distinct even with identical purpose and parent', mode => {
    const common = { source: 'engine' as const, question: 'Resolve the same purpose.', nodeId: '[dbo].[Reader]', parentTaskId: 'same-parent', createdHop: 1 };
    const assigned = mode === 'ct' ? { ...common, kind: 'column_lineage' as const,
      activeColumns: ['X'] as [string], sourceRefs: [{ node: '[dbo].[Stored]', col: 'X' }], traversalSide: 'downstream' as const }
      : { ...common, kind: 'analytical' as const };
    for (const caseSensitive of [false, true]) {
      const ledger = new TaskLedger(caseSensitive);
      const inherited = { ...assigned, passthroughFromNodeId: '[dbo].[Carrier]' };
      const assignedId = ledger.ensureTask(assigned).id, inheritedId = ledger.ensureTask(inherited).id;
      expect(inheritedId).not.toBe(assignedId);
      expect(ledger.ensureTask(assigned).id).toBe(assignedId);
      const differentlyCased = ledger.ensureTask({ ...inherited, passthroughFromNodeId: '[DBO].[CARRIER]' }).id;
      expect(differentlyCased === inheritedId).toBe(!caseSensitive);
      // Engine routes canonical object IDs; ledger object identity retains their delimiter spelling.
      expect(ledger.ensureTask({ ...inherited, passthroughFromNodeId: 'dbo.Carrier' }).id).not.toBe(inheritedId);
    }
  });

  it.each(['input', 'snapshot'] as const)('owns source references independently of the %s', owner => {
    const input = { ...task('sourceRefs', 'Value'), sourceRefs: [{ node: 'dbo.Caller', col: 'Value' }] };
    const ledger = new TaskLedger();
    ledger.ensureTask(input);
    const snapshot = ledger.investigationTasks[0];
    if (snapshot.kind !== 'column_lineage') throw new Error('Expected column task');
    const refs = owner === 'input' ? input.sourceRefs : snapshot.sourceRefs!;
    refs[0].col = 'ChangedOutsideLedger';
    refs.push({ node: 'dbo.Other', col: 'Injected' });
    expect(ledger.investigationTasks[0]).toMatchObject({ sourceRefs: [{ node: 'dbo.Caller', col: 'Value' }] });
  });
});

describe('current task completeness before advancement', () => {
  it.each(['depth', 'direction', 'excluded', 'admitted'] as const)('keeps %s column sources consistent with scope while retaining neighbor evidence', border => {
    const root = 'root', writer = 'writer', source = 'source';
    const nodes = [makeNode({ id: root, name: root, schema: 'dbo', type: 'view', columns: [column('Value')], bodyScript: 'SELECT Value FROM writer;' }),
      makeNode({ id: writer, name: writer, schema: 'dbo', type: 'procedure', bodyScript: 'SELECT Value FROM source;' }),
      makeNode({ id: source, name: source, schema: 'dbo', type: 'table', columns: [column('Value')] })];
    const engine = navigationFor(nodes, [[writer, root], border === 'direction' ? [writer, source] : [source, writer]]);
    expect(engine.init({ origin: root, question: 'Trace Value', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
      depthIntent: { upstream: { levels: border === 'depth' ? 1 : 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
      ...(border === 'excluded' ? { excludeNodeIds: [source] } : {}),
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: root } });
    expect(engine.submitFindings({ focus_node_id: root, summary: 'Value comes from the writer.', sections: [{ angle: 'technical', text: 'The writer supplies Value.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col: 'Value' }] }],
      questions: [{ nodeId: writer, question: 'Explain Value.' }], prune_neighbors: [],
    })).toHaveProperty('ok', true);
    const context = engine.getHopContext();
    expect(context).toMatchObject({ focus_node: { id: writer }, neighbors: expect.arrayContaining([
      expect.objectContaining({ id: root, already_visited: true }), expect.objectContaining({ id: source, can_question: true }),
    ]) });
    expect(engine.hopSubmitColumns.columnSourceNodeIds?.includes(source)).toBe(border === 'admitted');
    expect(engine.hopSubmitColumns.columnSourceNodeIds).toContain(root);
  });

  it.each(['bb', 'ct'] as const)('rejects a non-neighbor prune before committing %s findings', analysisMode => {
    const root = '[d].[Root]', middle = '[d].[Middle]', leaf = '[d].[Leaf]';
    const nodes = [root, middle, leaf].map(id => makeNode({ id, schema: 'd', name: id, type: 'view',
      columns: [column('Value')], bodyScript: 'SELECT 1 AS Value;' }));
    const engine = navigationFor(nodes, [[leaf, middle], [middle, root]]);
    expect(engine.init({ origin: root, question: 'Explain Value', analysisMode, targetColumns: analysisMode === 'ct' ? ['Value'] : undefined,
      direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    const context = engine.getHopContext();
    expect(context).toMatchObject({ focus_node: { id: root } });
    expect(engine.hopSubmitColumns.neighbors).toEqual((context.neighbors as HopNeighborDisclosure[]).map(({ id, can_question, can_prune }) => ({ id, can_question, can_prune })));
    const before = engine.toJSON();
    const result = engine.submitFindings({ focus_node_id: root, summary: 'A constant value.',
      sections: [{ angle: 'technical', text: 'The output is a constant.' }],
      ...(analysisMode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [] }] } : {}),
      questions: [{ nodeId: middle, question: 'Explain the source.' }],
      prune_neighbors: [{ id: leaf, reason: 'This distant object is irrelevant.' }],
    });
    expect(result).toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining('prune_neighbors.0.id') });
    expect(result).toMatchObject({ detail: expect.arrayContaining([{ id: leaf, path: 'prune_neighbors.0.id',
      reason: expect.any(String), allowed_values: [] }]) });
    const after = engine.toJSON();
    expect(after.removedSet).toEqual(before.removedSet);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    const schema = submitFindingsSchemaForMode(analysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, prune_neighbors: [] })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: middle } });
    expect(engine.toJSON().removedSet).toEqual([]);
  });

  const root = '[d].[Root]', neighbor = '[d].[Source]', other = '[d].[OtherSource]';
  function world(twoNeighbors = false, rootSql = 'SELECT 1 AS Value, 2 AS Other;') {
    const nodes = [root, neighbor, ...(twoNeighbors ? [other] : [])].map(id => makeNode({ id, schema: 'd', name: id, type: 'view',
      columns: [column('Value'), column('Other')], bodyScript: id === root ? rootSql : 'SELECT 1 AS Value, 2 AS Other;' }));
    const pairs: Array<[string, string]> = [[neighbor, root], ...(twoNeighbors ? [[other, root] as [string, string]] : [])];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['d']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: root, question: 'Trace Value and Other', analysisMode: 'ct', targetColumns: ['Value', 'Other'], direction: 'upstream',
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: root } });
    return engine;
  }
  const finding = { focus_node_id: root, summary: 'Constant outputs.', sections: [{ angle: 'technical' as const, text: 'Both outputs are constants.' }] };
  const terminal = (out_col: string) => ({ out_col, upstream_columns: [] });
  it.each([root, '[d].[Absent]'])('rejects a refused prune of %s atomically and accepts an explicit repair', id => {
    const engine = world();
    const before = engine.toJSON();
    const result = engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
      prune_neighbors: [{ id, reason: 'Not relevant to this investigation.' }],
    });
    expect(result).toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining('prune_neighbors.0'),
      hint: expect.stringContaining('Remove it from prune_neighbors') });
    const after = engine.toJSON();
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(engine.currentFocus).toBe(root);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, prune_neighbors: [] })))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([neighbor]);
  });
  it.each(['target', 'neighbor'] as const)('rejects an omitted %s decision without completing the current task', missing => {
    const engine = world();
    const before = engine.toJSON();
    const result = engine.submitFindings({ ...finding,
      column_flow: missing === 'target' ? [terminal('Value')] : [terminal('Value'), terminal('Other')],
      ...(missing === 'target' ? { questions: [{ nodeId: neighbor, question: 'Explain the source object role.' }] } : {}),
    });
    expect(result).toHaveProperty('code');
    const after = engine.toJSON();
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(engine.currentFocus).toBe(root);
    if (missing === 'target') {
      expect(result).toMatchObject({ hint: expect.stringContaining('Resend: column_flow.') });
      expect(engine.submitFindings({ ...finding, column_flow: [terminal('Other')] }),
        'a sent column_flow replaces the held flow; the Value entry is not merged back by out_col').toMatchObject({ code: 'incomplete_task' });
    }
    expect(engine.submitFindings({ ...finding, ...(missing === 'target'
      ? { column_flow: [terminal('Value'), terminal('Other')] }
      : { questions: [{ nodeId: neighbor, question: 'Explain the source object role.' }] }),
    })).toHaveProperty('ok', true);
  });
  it('accepts explicit terminal targets and an explicit business question without inventing a column continuation', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain the source object role.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('rejects undecided SQL neighbors without synthesizing a purpose or column mapping', () => {
    const engine = world();
    const rejected = engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')] });
    expect(rejected).toHaveProperty('code', 'incomplete_task');
    expect(rejected).not.toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({
      path: 'questions.0', allowed_values: expect.anything(),
    })]) });
    expect(engine.currentFocus).toBe(root);
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('owes the whole questions list when one neighbor is missing, and merges no question back', () => {
    const engine = world(true);
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    })).toMatchObject({ code: 'incomplete_task', hint: expect.stringContaining('Held: sections.technical, summary, column_flow. Resend: questions.') });
    const schema = submitFindingsSchemaForMode(engine.currentHopAnalysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const patch = (questions: Array<{ nodeId: string; question: string }>) => toHopFinding(schema.parse({ focus_node_id: root, questions }));
    const otherQuestion = { nodeId: other, question: 'Explain OtherSource rows.' };
    expect(engine.submitFindings(patch([otherQuestion]))).toMatchObject({ code: 'incomplete_task', reason: expect.stringContaining(neighbor) });
    expect(engine.submitFindings(patch([{ nodeId: neighbor, question: 'Explain Source rows.' }, otherQuestion]))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId).sort()).toEqual([neighbor, other].sort());
  });
  it('replaces a held questions list whole and never drops a held question for a neighbor named in prune_neighbors', () => {
    const engine = world(true);
    const overlong = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', note: 'x'.repeat(201) }] };
    const questions = [{ nodeId: neighbor, question: 'Explain Source Value.' }, { nodeId: other, question: 'Explain OtherSource rows.' }];
    expect(engine.submitFindings({ ...finding, column_flow: [overlong, terminal('Other')], questions }))
      .toMatchObject({ code: 'field_length_exceeded', hint: expect.stringContaining('Held: sections.technical, summary, questions. Resend: column_flow.') });
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }] }, terminal('Other')];
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const retry = (extra: Record<string, unknown>) => toHopFinding(schema.parse({ focus_node_id: root, column_flow, ...extra }));
    expect(engine.submitFindings(retry({ prune_neighbors: [{ id: other, reason: 'OtherSource supplies no tracked value.' }] })),
      'the held question for the pruned neighbor is kept, so the two lists conflict').toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining(other) });
    expect(engine.submitFindings(retry({ questions: [questions[1]] })),
      'a sent questions list replaces the held list; the neighbor entry is not merged back').toMatchObject({ code: 'incomplete_task', reason: expect.stringContaining(neighbor) });
    expect(engine.submitFindings(retry({ questions: [questions[0]], prune_neighbors: [{ id: other, reason: 'OtherSource supplies no tracked value.' }] }))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([neighbor]);
  });
  it('keeps the authored investigation purpose separate from generated column instructions', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }] }, terminal('Other'),
    ] })).toHaveProperty('code');
    const schema = submitFindingsSchemaForMode(engine.currentHopAnalysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const question = 'Establish how Source.Value determines the business price.';
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, questions: [{ nodeId: neighbor, question }] })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks().map(task => task.question)).toContain(question);
    expect(engine.pendingLineageQuestions.join('\n')).toContain('Value');
  });
  it.each([false, true])('combines mapping, question and prune atomically, with same-neighbor conflict=%s', conflict => {
    const engine = world(true, 'SELECT Value, 2 AS Other FROM d.Source;');
    const prune = { id: other, reason: 'This source does not supply the requested value.' };
    const input = { ...finding, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }] }, terminal('Other'),
    ], questions: [{ nodeId: neighbor, question: 'Resolve the source Value.' }],
    prune_neighbors: [prune, ...(conflict ? [{ id: neighbor, reason: 'Conflicts with its investigation.' }] : [])] };
    const before = engine.toJSON();
    const submitted = engine.submitFindings(input);
    if (conflict) {
      expect(submitted).toMatchObject({ code: 'route_validation_failed',
        issuePaths: ['questions.0.nodeId', 'prune_neighbors.1.id'] });
      const after = engine.toJSON();
      expect(after.agenda).toEqual(before.agenda);
      expect(after.removedSet).toEqual(before.removedSet);
      expect(after.visited).toEqual(before.visited);
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      expect(engine.currentFocus).toBe(root);
      expect(engine.heldColumnFlow).toBe(true);
      const repair = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
      expect(engine.submitFindings(toHopFinding(repair.parse({ focus_node_id: root, questions: input.questions, prune_neighbors: [prune] })))).toHaveProperty('ok', true);
    } else expect(submitted).toHaveProperty('ok', true);
    expect(engine.toJSON().removedSet).toEqual([other]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({
      activeColumns: ['Value'], sourceRefs: [{ node: neighbor, col: 'Value' }], question: 'Resolve the source Value.',
    }));
    expect(engine.submitFindings({ ...finding, focus_node_id: neighbor, column_flow: [terminal('Value')] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    const result = engine.getResult();
    expect(result.fullNodes.map(node => node.id).sort()).toEqual([root, neighbor].sort());
    expect(result.edges.map(([from, to]) => [from, to])).toEqual([[neighbor, root]]);
    expect(result.columnAspect!.edges.map(edge => [edge.from_node, edge.from_col, edge.to_node, edge.to_col]))
      .toEqual([[neighbor, 'Value', root, 'Value']]);
  });
  it('requests only a missing summary when valid sections and flow are held', () => {
    const engine = world();
    engine.holdRejectedSubmission({ ...finding, sections: { technical: finding.sections[0].text }, summary: '', column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    }, ['summary']);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const patch = (summary?: string) => toHopFinding(schema.parse({ focus_node_id: root, ...(summary ? { summary } : {}) }));
    expect(engine.submitFindings(patch())).toMatchObject({ code: 'missing_field', issuePaths: ['summary'],
      hint: expect.stringContaining('Held: sections.technical, questions, column_flow. Resend: summary.') });
    expect(engine.submitFindings(patch('Both requested outputs are constants.'))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
  });
  it('owes the whole column_flow after a sole length rejection and merges no flow entry back by out_col', () => {
    const engine = world();
    const overlong = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', note: 'x'.repeat(201) }] };
    const rejected = engine.submitFindings({ ...finding, column_flow: [overlong, terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    });
    expect(rejected).toMatchObject({ code: 'field_length_exceeded', issuePaths: ['column_flow.0.upstream_columns.0.note'] });
    expect(rejected).toMatchObject({ hint: expect.stringContaining('Held: sections.technical, summary, questions. Resend: column_flow.') });
    expect(engine.heldColumnFlow).toBe(false);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const malformed = { focus_node_id: root, prune_neighbors: [{ id: '[d].[Absent]', reason: 42 }] };
    const parsed = schema.safeParse(malformed);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected the malformed prune to be rejected');
    const schemaRejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input: malformed, schema });
    const beforeMalformed = engine.toJSON();
    const held = engine.holdRejectedSubmission(malformed, schemaRejection.issuePaths ?? []);
    expect(held?.resend).toEqual(['column_flow', 'prune_neighbors']);
    expect(findingRepairOrder(held)).toContain('Resend: column_flow, prune_neighbors.');
    expect(engine.toJSON(), 'a malformed repair changes guidance without replacing the valid held draft').toEqual(beforeMalformed);
    const shortened = { ...overlong, upstream_columns: [{ node: neighbor, col: 'Value', note: 'The source value.' }] };
    const retry = (column_flow: unknown[]) => toHopFinding(schema.parse({ focus_node_id: root, column_flow, prune_neighbors: [] }));
    expect(engine.submitFindings(retry([shortened])), 'the Other entry of the rejected call is not restored').toMatchObject({ code: 'incomplete_task' });
    expect(engine.submitFindings(retry([shortened, terminal('Other')]))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
  });
  it('holds the valid angle of a failed section and names the failed and missing locked angle as owed', () => {
    const engine = world();
    engine.classification = 'both';
    expect(engine.holdRejectedSubmission({ ...finding, sections: { technical: finding.sections[0].text, business: 42 },
      column_flow: [terminal('Value'), terminal('Other')], questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    }, ['sections.business'])).toEqual({ sections: ['technical'], summary: true, fields: ['questions', 'column_flow'], resend: ['sections.business'] });
    const schema = submitFindingsSchemaForMode('ct', 'both', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const retry = (sections: Record<string, string>) => toHopFinding(schema.parse({ focus_node_id: root, sections }));
    expect(engine.submitFindings(retry({}))).toMatchObject({ code: 'invalid_input',
      hint: expect.stringContaining('Held: sections.technical, summary, questions, column_flow. Resend: sections.business.') });
    expect(engine.submitFindings(retry({ business: 'Both outputs are fixed values.' }))).toHaveProperty('ok', true);
  });
  it('rejects an unknown neighbor id rather than silently dropping its question', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source.' }, { nodeId: '[d].[Unknown]', question: 'Explain the missing object.' }],
    })).toMatchObject({ code: 'route_validation_failed', issuePaths: expect.arrayContaining(['questions.1.nodeId']) });
    expect(engine.currentFocus).toBe(root);
    expect(engine.toJSON().agenda).toEqual([]);
  });
});

describe('shared object dispatch', () => {
  it.each(['depth', 'direction', 'excluded'] as const)('rejects an unsupported %s prune at its SQL sender before automatic storage routing', border => {
    const origin = '[d].[origin]', stored = '[d].[stored]', outside = border === 'excluded' ? '[x].[outside]' : '[d].[outside]';
    const nodes = [
      makeNode({ id: origin, schema: 'd', name: 'origin', type: 'view', columns: [column('Value')] }),
      makeNode({ id: stored, schema: 'd', name: 'stored', type: 'table', columns: [column('Value')] }),
      makeNode({ id: outside, schema: border === 'excluded' ? 'x' : 'd', name: 'outside', type: 'procedure' }),
    ];
    const pairs: Array<[string, string]> = [[stored, origin], border === 'direction' ? [stored, outside] : [outside, stored]];
    const engine = engineFor(nodes, pairs);
    expect(engine.init({ origin, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
      ...(border === 'excluded' ? { excludeSchemas: ['x'] } : {}),
      depthIntent: { upstream: { levels: border === 'depth' ? 1 : 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Value', upstream_columns: [{ node: stored, col: 'Value' }] }],
      questions: [{ nodeId: stored, question: 'Resolve the stored Value from its writers.' }],
      prune_neighbors: [{ id: outside, reason: 'Outside the approved exploration.' }],
    })).toMatchObject({ code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'] });
    const after = engine.toJSON();
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(engine.getDetailSlots()).toEqual([]);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: origin, prune_neighbors: [] })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().columnAspect!.edges).toEqual([expect.objectContaining({ from_node: stored, from_col: 'Value', to_node: origin, to_col: 'Value' })]);
    expect(engine.pendingLeads).toHaveLength(border === 'depth' ? 1 : 0);
  });

  it('retains an explicitly empty SQL flow through a malformed repair of an out-of-depth prune', () => {
    const origin = '[d].[origin]', focus = '[d].[focus]', outside = '[d].[outside]';
    const nodes = [origin, focus, outside].map(id => makeNode({ id, schema: 'd', name: id, type: 'view', columns: [column('Value')] }));
    const engine = engineFor(nodes, [[origin, focus], [focus, outside]]);
    expect(engine.init({ origin, question: 'Trace Value one level downstream.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [{ nodeId: focus, question: 'Establish whether Value continues here.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: focus }, analysis_mode: 'ct' });
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...guardRecord(focus), column_flow: [], prune_neighbors: [{ id: outside, reason: 'Not part of this trace.' }] }))
      .toMatchObject({ code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'] });
    expect(engine.heldColumnFlow).toBe(true);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const malformed = { focus_node_id: focus, prune_neighbors: [{ id: outside, reason: 42 }] };
    const parsed = schema.safeParse(malformed);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected a numeric prune reason to be rejected');
    const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input: malformed, schema });
    expect(rejection.issuePaths).toEqual(['prune_neighbors.0.id', 'prune_neighbors.0.reason']);
    engine.holdRejectedSubmission(malformed, rejection.issuePaths ?? []);
    expect(engine.heldColumnFlow).toBe(true);
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: focus, prune_neighbors: [] })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
  });

  it('keeps stored computed-column metadata and caller SQL on its scalar function task', () => {
    const stored = '[d].[stored]', fn = '[d].[scale]';
    const dependencies = [{ reference: fn, sourceElementType: 'SqlScalarFunction' }];
    const columns = [column('Base'), { ...column('Value'), extra: 'COMPUTED', expressionDependencies: dependencies }];
    const ddl = 'CREATE TABLE d.stored (Base int DEFAULT 7, Value AS d.scale(Base));';
    const nodes = [makeNode({ id: stored, schema: 'd', name: 'stored', type: 'table', hasColumns: true, hasDdl: true }),
      makeNode({ id: fn, schema: 'd', name: 'scale', type: 'function', bodyScript: 'CREATE FUNCTION d.scale(@Base int) RETURNS int AS BEGIN RETURN @Base * 2 END;' })];
    const pairs: Array<[string, string]> = [[fn, stored]];
    const store = new ColumnStore();
    store.setColumns(stored, columns);
    store.setDdl(stored, ddl);
    const engine = new NavigationEngine(makeIndexedModel(nodes, pairs), makeGraph(nodes, pairs), () => {}, {}, store);
    expect(engine.init({ origin: stored, question: 'Trace the computed Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'ct',
      caller_output_targets: [{ node: stored, col: 'Value' }], caller_objects: [{ node: stored, ddl }],
      storage_context: [expect.objectContaining({ id: stored, ddl, columns })] });
    expect(engine.columnAspect!.edges).toEqual([]);
    expect(engine.submitFindings({ ...guardRecord(fn), column_flow: [{ out_col: 'Value', returns_to: { node: stored, col: 'Value' },
      upstream_columns: [{ node: stored, col: 'Base', transforms: ['compute'] }] }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().columnAspect!.edges).toEqual([expect.objectContaining({ from_node: stored, from_col: 'Base', to_node: stored, to_col: 'Value' })]);
    expect(engine.getResult().node_states.find(state => state.nodeId === stored)).toMatchObject({ source: 'engine', reason: 'storage_passthrough' });
  });

  it('keeps a SQL module with an unreadable definition as a model hop', () => {
    const stored = '[d].[stored]', writer = '[d].[writer]';
    const nodes = [makeNode({ id: stored, schema: 'd', name: 'stored', type: 'table', columns: [column('Value')] }),
      makeNode({ id: writer, schema: 'd', name: 'writer', type: 'procedure', definitionUnreadable: true })];
    const engine = engineFor(nodes, [[writer, stored]]);
    expect(engine.init({ origin: stored, question: 'Establish how Value is written.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer }, analysis_mode: 'ct' });
    expect(engine.columnAspect!.edges).toEqual([]);
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ sourceRefs: [{ node: stored, col: 'Value' }] }));
  });

  it.each(['bb', 'ct'] as const)('preserves queued work while requiring a question for a new %s column continuation', analysisMode => {
    const root = '[d].[root]', branch = '[d].[branch]', stored = '[d].[stored]';
    const nodes = [
      makeNode({ id: root, schema: 'd', name: 'root', type: 'view', columns: ['Value', 'Other'].map(column),
        bodyScript: 'CREATE VIEW d.root AS SELECT s.Value, b.Other FROM d.stored s CROSS JOIN d.branch b;' }),
      makeNode({ id: branch, schema: 'd', name: 'branch', type: 'view', columns: [column('Other')],
        bodyScript: 'CREATE VIEW d.branch AS SELECT Other FROM d.stored;' }),
      makeNode({ id: stored, schema: 'd', name: 'stored', type: 'table', columns: ['Value', 'Other'].map(column) }),
    ];
    const engine = engineFor(nodes, [[stored, root], [stored, branch], [branch, root]]);
    expect(engine.init({ origin: root, question: 'Trace Value and Other', analysisMode, ...(analysisMode === 'ct' ? { targetColumns: ['Value', 'Other'] } : {}),
      direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(root), ...(analysisMode === 'ct' ? { column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: stored, col: 'Value' }] },
      { out_col: 'Other', upstream_columns: [{ node: branch, col: 'Other' }] },
    ] } : {}), questions: [{ nodeId: stored, question: 'Trace stored Value.' }, { nodeId: branch, question: 'Trace derived Other.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: branch } });
    const before = engine.toJSON();
    const acknowledgement = engine.submitFindings({ ...guardRecord(branch), ...(analysisMode === 'ct'
      ? { column_flow: [{ out_col: 'Other', upstream_columns: [{ node: stored, col: 'Other' }] }] } : {}) });
    {
      expect(acknowledgement).toMatchObject({ code: 'incomplete_task', issuePaths: ['questions.0'], reason: expect.stringContaining(stored) });
      const after = engine.toJSON();
      expect(after.agenda).toEqual(before.agenda);
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      const schema = submitFindingsSchemaForMode(analysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
      expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: branch,
        questions: [{ nodeId: stored, question: 'Trace stored Other.' }],
      })))).toMatchObject({ ok: true, route_outcomes: [{ nodeId: stored, accepted: true }] });
    }
    expect(engine.investigationTasks.filter(task => task.nodeId === stored).map(task => task.question)).toEqual(['Trace stored Value.', 'Trace stored Other.']);
    if (analysisMode === 'ct') expect(engine.toJSON().agenda).toMatchObject([{ nodeId: stored, activeColumns: ['Value', 'Other'] }]);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().node_states.find(state => state.nodeId === stored)).toMatchObject({ action: 'passthrough', source: 'engine' });
  });
  it.each(['bb', 'ct'] as const)('dispatches a bodyless %s neighbor before forwarding its question', analysisMode => {
    const root = '[d].[root]', relay = '[d].[relay]', writer = '[d].[writer]';
    const nodes = [
      makeNode({ id: root, schema: 'd', name: 'root', type: 'view', columns: [column('Value')] }),
      makeNode({ id: relay, schema: 'd', name: 'relay', type: 'table', columns: [column('Value')] }),
      makeNode({ id: writer, schema: 'd', name: 'writer', type: 'procedure', columns: [column('Value')] }),
    ];
    const pairs: Array<[string, string]> = [[writer, relay], [relay, root]];
    const model = makeIndexedModel(nodes, pairs);
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: root, question: 'Explain the input chain', analysisMode, ...(analysisMode === 'ct' ? { targetColumns: ['Value'] } : {}), direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    expect(engine.measureAdmissionScope().rounds).toBe(2);
    const record = (id: string) => ({ focus_node_id: id, summary: 'Object role.', sections: [{ angle: 'technical' as const, text: 'Investigate the input.' }] });
    const flow = (node: string) => analysisMode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node, col: 'Value' }] }] } : {};
    engine.getHopContext();
    const question = 'Explain how relay supplies the approved result.';
    expect(engine.submitFindings({ ...record(root), ...flow(relay), questions: [{ nodeId: relay, question }] })).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([relay]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer }, analysis_mode: analysisMode });
    expect(engine.toJSON().nodeStates).toContainEqual(expect.objectContaining({ nodeId: relay, action: 'passthrough', source: 'engine' }));
    expect(engine.getCurrentTasks()[0].question).toBe(question);
  });
});

describe('result dispositions', () => {
  const record = (focus_node_id: string) => ({ focus_node_id,
    summary: 'Record the supplied definition.', sections: [{ angle: 'technical' as const, text: 'The supplied SQL establishes this hop.' }] });

  it('retains an in-scope procedure expression while omitting its outside SQL destination', () => {
    const input = '[d].[Input]', procedure = '[d].[Procedure]', stored = '[d].[Stored]';
    const nodes = [
      makeNode({ id: input, schema: 'd', name: 'Input', type: 'view', columns: [column('X')], bodyScript: 'SELECT 10 AS X' }),
      makeNode({ id: procedure, schema: 'd', name: 'Procedure', type: 'procedure', columns: [], bodyScript: 'INSERT d.Stored(X) SELECT X FROM d.Input;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('X')] }),
    ];
    const engine = navigationFor(nodes, [[input, procedure], [procedure, stored]]);
    expect(engine.init({ origin: input, question: 'Trace X downstream one level.', analysisMode: 'ct', targetColumns: ['X'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(input), column_flow: [{ out_col: 'X', upstream_columns: [] }],
      questions: [{ nodeId: procedure, question: 'Determine how X contributes to the SQL output.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: procedure }, analysis_mode: 'ct' });
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const payload = { focus_node_id: procedure, summary: 'The procedure inserts X into Stored beyond the requested limit.',
      sections: { technical: 'INSERT d.Stored(X) SELECT X FROM d.Input; Stored is beyond downstream one.' },
      column_flow: [{ out_col: 'X', upstream_columns: [{ node: input, col: 'X' }] }] };
    expect(engine.submitFindings(toHopFinding(schema.parse(payload)))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toMatchObject([{ from_node: input, from_col: 'X', to_node: procedure, to_col: 'X' }]);
    expect(engine.columnAspect!.edges.some(edge => edge.from_node === stored || edge.to_node === stored)).toBe(false);
  });

  it.each([false, true])('rejects a write edge into an out-of-scope destination and keeps its follow-up (equivalent=%s)', equivalent => {
    const producer = '[d].[Producer]', stored = '[d].[Stored]';
    const nodes = [
      makeNode({ id: producer, schema: 'd', name: 'Producer', type: 'procedure', columns: [], bodyScript: 'INSERT d.Stored(X) SELECT 10;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('X')] }),
    ];
    const engine = navigationFor(nodes, [[producer, stored]]);
    expect(engine.init({ origin: producer, question: 'Where does X go?', analysisMode: 'ct', targetColumns: ['X'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } }, excludeNodeIds: [stored],
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const before = engine.toJSON();
    const rejected = engine.submitFindings({ ...record(producer),
      column_flow: [{ out_col: 'X', upstream_columns: [], writes_to: { node: equivalent ? ' "D" . "stored" ' : stored, col: 'X' } }] });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['column_flow.0.writes_to.node'],
      reason: expect.stringContaining(`\`${stored}\` is out of scope (excluded)`), hint: expect.stringContaining('as a follow-up') });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.submitFindings({ ...record(producer), column_flow: [{ out_col: 'X', upstream_columns: [] }],
      questions: [{ nodeId: equivalent ? 'D.Stored' : stored, question: 'Where is the stored X read?' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.deferredQuestions.map(question => question.nodeId)).toEqual([stored]);
    const result = engine.getResult();
    expect(result.fullNodes.map(node => node.id)).toEqual([producer]);
    expect(result.columnAspect!.edges.some(edge => edge.to_node === stored)).toBe(false);
  });

  it('renders exactly the dispositioned nodes and reports a pruned neighbor through its state', () => {
    const target = '[d].[Target]', writer = '[d].[Writer]', used = '[d].[Used]', unused = '[d].[Unused]';
    const nodes = [
      makeNode({ id: target, schema: 'd', name: 'Target', type: 'table', columns: [column('X')] }),
      makeNode({ id: writer, schema: 'd', name: 'Writer', type: 'procedure', columns: [],
        bodyScript: 'INSERT d.Target(X) SELECT u.X FROM d.Used u WHERE EXISTS (SELECT 1 FROM d.Unused);' }),
      makeNode({ id: used, schema: 'd', name: 'Used', type: 'table', columns: [column('X')] }),
      makeNode({ id: unused, schema: 'd', name: 'Unused', type: 'table', columns: [column('X')] }),
    ];
    const engine = navigationFor(nodes, [[writer, target], [used, writer], [unused, writer]]);
    expect(engine.init({ origin: target, question: 'What loads Target?', analysisMode: 'bb', direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    const decisions: Record<string, object> = {
      [target]: { questions: [{ nodeId: writer, question: 'How is Target loaded?' }] },
      [writer]: { questions: [{ nodeId: used, question: 'What does Used hold?' }],
        prune_neighbors: [{ id: unused, reason: 'Unused only gates the load and is outside the question.' }] },
      [used]: {},
    };
    for (let step = 0; step < nodes.length; step++) {
      const hop = engine.getHopContext();
      if (hop.done) break;
      const id = hop.focus_node!.id as string;
      expect(engine.submitFindings({ ...record(id), ...decisions[id] })).toHaveProperty('ok', true);
    }
    const result = engine.getResult();
    const kept = result.node_states.filter(state => state.action !== 'prune').map(state => state.nodeId);
    expect(kept.sort()).toEqual([target, used, writer]);
    expect(result.fullNodes.map(node => node.id).sort()).toEqual(kept);
    expect(result.node_states.find(state => state.nodeId === unused)).toMatchObject({ action: 'prune' });
    expect(result.edges.map(([from, to]) => `${from}->${to}`).sort()).toEqual([`${used}->${writer}`, `${writer}->${target}`]);
    expect(result.detail_slots.map(slot => slot.nodeId).sort()).toEqual(kept);
  });
});

// CT carry guard: authored column decisions are ACKed or REJECTed and an accepted carry dispatches exactly as accepted.
const guardRecord = (focus_node_id: string) => ({ focus_node_id,
  summary: 'Trace the requested value.', sections: [{ angle: 'technical' as const, text: 'The supplied SQL establishes this mapping.' }] });
const upstreamAll = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 0, exactness: 'exact' as const } };

function engineFor(nodes: LineageNode[], pairs: Array<[string, string]>, mutate?: (model: ReturnType<typeof makeIndexedModel>) => void) {
  const model = makeIndexedModel(nodes, pairs);
  mutate?.(model);
  return new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
}

describe('CT dispatch keeps the accepted carry', () => {
  const origin = '[d].[Report]', first = '[d].[First]', second = '[d].[Second]', writer = '[d].[Writer]';
  const nodes = [
    makeNode({ id: origin, schema: 'd', name: 'Report', type: 'view', columns: [column('A'), column('B')], bodyScript: 'CREATE VIEW d.Report AS SELECT 1;' }),
    makeNode({ id: first, schema: 'd', name: 'First', type: 'table', columns: [column('X')] }),
    makeNode({ id: second, schema: 'd', name: 'Second', type: 'table', columns: [column('Y')] }),
    makeNode({ id: writer, schema: 'd', name: 'Writer', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.Writer AS SELECT 1;' }),
  ];
  const pairs: Array<[string, string]> = [[writer, first], [writer, second], [first, origin], [second, origin]];

  /** Walks to the shared writer: one table passes its stored column to Writer, the other maps Writer.Out. */
  function reachWriter() {
    const engine = engineFor(nodes, pairs);
    expect(engine.init({ origin, question: 'Trace A and B.', analysisMode: 'ct', targetColumns: ['A', 'B'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [
      { out_col: 'A', upstream_columns: [{ node: first, col: 'X' }] },
      { out_col: 'B', upstream_columns: [{ node: second, col: 'Y' }] },
    ], questions: [{ nodeId: first, question: 'Resolve X.' }, { nodeId: second, question: 'Resolve Y.' }] })).toHaveProperty('ok', true);
    return { engine, passed: { node: first, col: 'X' } };
  }

  it('dispatches every accepted column, not only the ones historical edges already bind', () => {
    const { engine } = reachWriter();
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer }, analysis_mode: 'ct' });
    expect([...engine.columnAspect!.active_columns].sort()).toEqual(['X', 'Y']);
    expect(engine.getCurrentTasks().filter(task => task.kind === 'column_lineage').flatMap(task => task.sourceRefs ?? [])).toEqual(expect.arrayContaining([{ node: first, col: 'X' }, { node: second, col: 'Y' }]));
  });

  it('stops the run when an accepted endpoint no longer resolves at dispatch', () => {
    const { engine, passed } = reachWriter();
    const stored = nodes.find(node => node.id === passed.node)!;
    const declared = stored.columns;
    stored.columns = [column('Renamed')];
    try {
      expect(engine.getHopContext()).toMatchObject({ done: false, sm_status: 'error' });
      expect(engine.errorReason).toContain('no qualified source column');
    } finally {
      stored.columns = declared;
    }
  });

  it('applies the same endpoint invariant when the queued node is a user pass node', () => {
    const engine = engineFor(nodes, pairs);
    expect(engine.init({ origin, question: 'Trace A.', analysisMode: 'ct', targetColumns: ['A'], direction: 'upstream', depthIntent: upstreamAll, passNodeIds: [first] })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'A', upstream_columns: [{ node: first, col: 'X' }] }],
      questions: [{ nodeId: first, question: 'Resolve X.' }], prune_neighbors: [{ id: second, reason: 'B ends at the report.' }] })).toHaveProperty('ok', true);
    const stored = nodes.find(node => node.id === first)!;
    const declared = stored.columns;
    stored.columns = [column('Renamed')];
    try {
      expect(engine.getHopContext()).toMatchObject({ done: false, sm_status: 'error' });
      expect(engine.errorReason).toContain('no qualified source column');
    } finally {
      stored.columns = declared;
    }
  });
});

describe('passthrough candidates at the next object', () => {
  it('maps the used candidate and ends an unmapped one at this node without a rejection', () => {
    const a = '[d].[A]', b = '[d].[B]', c = '[d].[C]', t = '[d].[T]';
    const nodes = [
      makeNode({ id: a, schema: 'd', name: 'A', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.A AS INSERT d.B(X, Y) SELECT 1, 2;' }),
      makeNode({ id: b, schema: 'd', name: 'B', type: 'table', columns: [column('X'), column('Y')] }),
      makeNode({ id: c, schema: 'd', name: 'C', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.C AS INSERT d.T(Z) SELECT X FROM d.B;' }),
      makeNode({ id: t, schema: 'd', name: 'T', type: 'table', columns: [column('Z')] }),
    ];
    const logs: string[] = [];
    const pairs: Array<[string, string]> = [[a, b], [b, c], [c, t]];
    const engine = new NavigationEngine(makeIndexedModel(nodes, pairs), makeGraph(nodes, pairs), (_level, message) => logs.push(message), {});
    expect(engine.init({ origin: a, question: 'Where do X and Y go?', analysisMode: 'ct', targetColumns: ['X', 'Y'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(a), column_flow: ['X', 'Y'].map(col => ({ out_col: col, upstream_columns: [], writes_to: { node: b, col } })),
      questions: [{ nodeId: b, question: 'Where are X and Y read?' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: c }, analysis_mode: 'ct' });
    expect(engine.submitFindings({ ...guardRecord(c), column_flow: [{ out_col: 'X', upstream_columns: [{ node: b, col: 'X' }], writes_to: { node: t, col: 'Z' } }],
      questions: [{ nodeId: t, question: 'Describe T.' }] })).toHaveProperty('ok', true);
    expect(logs.some(message => message.includes('unmapped candidates end') && message.includes(`${b}.Y`))).toBe(true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().node_states.find(state => state.nodeId === t)).toMatchObject({ action: 'passthrough', source: 'engine', columns: ['Z'] });
    expect(engine.columnAspect!.edges.some(edge => edge.from_node === b && edge.from_col === 'Y')).toBe(false);
  });
});

describe('a procedure that writes and reads back the same table', () => {
  const origin = '[d].[O]', staged = '[d].[S2]', proc = '[d].[P]', work = '[d].[T]', source = '[d].[W]', other = '[d].[U]';
  const nodes = [
    makeNode({ id: origin, schema: 'd', name: 'O', type: 'view', columns: [column('X')], bodyScript: 'CREATE VIEW d.O AS SELECT X FROM d.S2;' }),
    makeNode({ id: staged, schema: 'd', name: 'S2', type: 'table', columns: [column('X')] }),
    makeNode({ id: proc, schema: 'd', name: 'P', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.P AS MERGE d.T USING d.W ON 1 = 1 WHEN NOT MATCHED THEN INSERT (Y) VALUES (W.Z); INSERT d.U(V) SELECT Z FROM d.W; INSERT d.S2(X) SELECT Y FROM d.T;' }),
    makeNode({ id: work, schema: 'd', name: 'T', type: 'table', columns: [column('Y')] }),
    makeNode({ id: source, schema: 'd', name: 'W', type: 'table', columns: [column('Z')] }),
    makeNode({ id: other, schema: 'd', name: 'U', type: 'table', columns: [column('V')] }),
  ];
  const pairs: Array<[string, string]> = [[staged, origin], [proc, staged], [work, proc], [proc, work], [source, proc], [proc, other]];
  const readBack = { out_col: 'X', upstream_columns: [{ node: work, col: 'Y' }], writes_to: { node: staged, col: 'X' } };
  const atProc = () => {
    const engine = engineFor(nodes, pairs);
    expect(engine.init({ origin, question: 'Trace X.', analysisMode: 'ct', targetColumns: ['X'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'X', upstream_columns: [{ node: staged, col: 'X' }] }],
      questions: [{ nodeId: staged, question: 'Resolve X.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: proc }, analysis_mode: 'ct' });
    return engine;
  };
  const questions = [{ nodeId: work, question: 'Resolve Y.' }, { nodeId: source, question: 'Resolve Z.' }, { nodeId: other, question: 'Describe U.' }];

  it('maps its own write into the read-back table on the first visit and traces the write source', () => {
    const engine = atProc();
    const served = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns).parse({ focus_node_id: proc,
      summary: 'Trace X.', sections: { technical: 'P merges W into T and loads S2 from T.' }, questions,
      column_flow: [readBack, { out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: work, col: 'Y' } }] });
    expect(engine.submitFindings(toHopFinding(served)), 'internal write is declared').toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'Z', to_node: work, to_col: 'Y', hop_node: proc }));
    const visits: string[] = [];
    for (let context = engine.getHopContext(); context?.focus_node; context = engine.getHopContext()) {
      const id = String(context.focus_node.id);
      visits.push(`${id}:${context.analysis_mode}:${engine.getCurrentTasks().flatMap(task => task.kind === 'column_lineage' ? task.sourceRefs ?? [] : []).map(ref => `${ref.node}.${ref.col}`).join(',')}`);
      const ct = context.analysis_mode === 'ct';
      expect(engine.submitFindings({ ...guardRecord(id), ...(ct ? { column_flow: [] } : {}) })).toHaveProperty('ok', true);
    }
    expect(visits).toEqual([]);
    const result = engine.getResult();
    expect(result.node_states.filter(state => state.nodeId === work || state.nodeId === source).map(state => state.nodeId).sort()).toEqual([work, source].sort());
    expect(result.columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'Z', to_node: work, to_col: 'Y' }));
  });

  it('rejects a write to an out-of-direction neighbor and keeps the in-scope mapping', () => {
    const engine = atProc();
    expect(engine.submitFindings({ ...guardRecord(proc), questions, column_flow: [readBack,
      { out_col: 'V', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: other, col: 'V' } }] }))
      .toMatchObject({ code: 'route_validation_failed', issuePaths: ['column_flow.1.writes_to.node'] });
  });

  it('accepts an extra in-direction mapping that is not on the requested column chain', () => {
    const engine = atProc();
    expect(engine.submitFindings({ ...guardRecord(proc), questions, column_flow: [
      { ...readBack, upstream_columns: [{ node: source, col: 'Z' }] },
      { out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: work, col: 'Y' } },
    ] })).toHaveProperty('ok', true);
  });
});

describe('bodyless passthrough forwards to every writer', () => {
  it('adds the stored endpoint to a writer already queued from an earlier hop', () => {
    const origin = '[d].[Report]', stored = '[d].[Stored]', loader = '[d].[Loader]';
    const nodes = [
      makeNode({ id: origin, schema: 'd', name: 'Report', type: 'view', columns: [column('A')], bodyScript: 'CREATE VIEW d.Report AS SELECT 1;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('C')] }),
      makeNode({ id: loader, schema: 'd', name: 'Loader', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.Loader AS INSERT d.Stored(C) SELECT 1;' }),
    ];
    const engine = engineFor(nodes, [[stored, origin], [loader, origin], [loader, stored]]);
    expect(engine.init({ origin, question: 'Trace A.', analysisMode: 'ct', targetColumns: ['A'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'A', upstream_columns: [{ node: stored, col: 'C' }] }],
      questions: [{ nodeId: stored, question: 'Resolve C.' }, { nodeId: loader, question: 'Describe the load.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: loader }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ sourceRefs: [{ node: stored, col: 'C' }] }));
    // A candidate asks whether the writer touches the endpoint at all; it is not an assignment.
    expect(engine.toJSON().lineageQuestionsLastHop).toEqual([`Determine whether ${loader} writes ${stored}.C; map confirmed value contributions and end unused inputs on this branch.`]);
  });
});

describe('passthrough treats a writer outside the border alike in BB and CT', () => {
  it.each(['bb', 'ct'] as const)('%s forwards neither the question nor a candidate to an excluded writer', analysisMode => {
    const origin = '[d].[Report]', stored = '[d].[Stored]', loader = '[x].[Loader]';
    const nodes = [
      makeNode({ id: origin, schema: 'd', name: 'Report', type: 'view', columns: [column('A')], bodyScript: 'CREATE VIEW d.Report AS SELECT A FROM d.Stored;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('A')] }),
      makeNode({ id: loader, schema: 'x', name: 'Loader', type: 'procedure', bodyScript: 'CREATE PROCEDURE x.Loader AS INSERT d.Stored(A) SELECT 1;' }),
    ];
    const engine = engineFor(nodes, [[stored, origin], [loader, stored]]);
    expect(engine.init({ origin, question: 'Trace A.', analysisMode, ...(analysisMode === 'ct' ? { targetColumns: ['A'] } : {}), direction: 'upstream',
      depthIntent: upstreamAll, excludeSchemas: ['x'] })).toHaveProperty('ok', true);
    const flow = (value: object) => analysisMode === 'ct' ? value : {};
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(origin), ...flow({ column_flow: [{ out_col: 'A', upstream_columns: [{ node: stored, col: 'A' }] }] }),
      questions: [{ nodeId: stored, question: 'Resolve A.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.pendingLeads).toEqual([]);
  });
});

describe('CT boundary rejects instead of dropping a column reference', () => {
  const origin = '[d].[Report]', source = '[d].[Source]', stranger = '[d].[Stranger]';
  const nodes = [
    makeNode({ id: origin, schema: 'd', name: 'Report', type: 'view', columns: [column('Total')], bodyScript: 'CREATE VIEW d.Report AS SELECT 1;' }),
    makeNode({ id: source, schema: 'd', name: 'Source', type: 'table', columns: [column('Amount')] }),
    makeNode({ id: stranger, schema: 'd', name: 'Stranger', type: 'table', columns: [column('Amount')] }),
  ];
  const start = (all = nodes, pairs: Array<[string, string]> = [[source, origin]], mutate?: (model: ReturnType<typeof makeIndexedModel>) => void) => {
    const engine = engineFor(all, pairs, mutate);
    expect(engine.init({ origin, question: 'Trace Total.', analysisMode: 'ct', targetColumns: ['Total'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    return engine;
  };

  it.each([
    ['an object outside the loaded model', '[d].[Missing]', 'is absent from the loaded model'],
    ['a loaded object that is not a neighbor', stranger, 'has no dependency edge'],
  ])('rejects a contributor naming %s with its path and commits nothing', (_label, node, reason) => {
    const engine = start();
    const before = engine.toJSON();
    const rejected = engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Total', upstream_columns: [{ node: source, col: 'Amount' }, { node, col: 'Amount' }] }],
      questions: [{ nodeId: source, question: 'Resolve Amount.' }] });
    expect(rejected).toMatchObject({ issuePaths: ['column_flow.0.upstream_columns.1.node'], reason: expect.stringContaining(reason) });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
  });

  it.each(['fresh', 'held'] as const)('rejects pruning a %s column contributor before committing either decision', draft => {
    const engine = start(nodes, [[source, origin], [stranger, origin]]);
    const flow = [{ out_col: 'Total', upstream_columns: [{ node: source, col: 'Amount' }] }];
    const prunes = [source, stranger].map(id => ({ id, reason: 'Outside the investigation path.' }));
    let submission: Parameters<NavigationEngine['submitFindings']>[0] = { ...guardRecord(origin), column_flow: flow, prune_neighbors: prunes };
    if (draft === 'held') {
      const raw = { focus_node_id: origin, summary: 'Total comes from Source.Amount.',
        sections: { technical: 'The supplied mapping connects Source.Amount to Total.' }, column_flow: flow,
        prune_neighbors: [{ id: source, reason: 42 }] };
      const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns);
      const parsed = schema.safeParse(raw);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Expected the malformed prune reason to fail');
      const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input: raw, schema });
      engine.holdRejectedSubmission(raw, rejection.issuePaths ?? []);
      expect(engine.heldColumnFlow).toBe(true);
      submission = toHopFinding(submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, true)
        .parse({ focus_node_id: origin, prune_neighbors: prunes }));
    }
    const before = engine.toJSON();
    const rejection = engine.submitFindings(submission);
    expect(rejection).toMatchObject({ code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'],
      detail: [expect.objectContaining({ path: 'prune_neighbors.0.id', allowed_values: [stranger] })] });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.getDetailSlots()).toEqual([]);
    const repair = toHopFinding(submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow)
      .parse({ focus_node_id: origin, prune_neighbors: [prunes[1]], questions: [{ nodeId: source, question: 'Resolve Amount.' }] }));
    expect(engine.submitFindings(repair)).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.toJSON().removedSet).toEqual([stranger]);
    expect(engine.getResult().columnAspect!.edges).toEqual([expect.objectContaining({ from_node: source, from_col: 'Amount', to_node: origin, to_col: 'Total' })]);
    expect(engine.getResult().fullNodes.map(node => node.id).sort()).toEqual([origin, source].sort());
  });

  it('accepts an unrelated prune when this hop keeps a source with an older pending prune ballot', () => {
    const root = '[d].[Root]', first = '[d].[First]', writer = '[d].[Writer]', kept = '[d].[Kept]', unused = '[d].[Unused]';
    const all = [
      makeNode({ id: root, schema: 'd', name: 'Root', type: 'view', columns: [column('Value')], bodyScript: 'SELECT 1 AS Value;' }),
      makeNode({ id: first, schema: 'd', name: 'First', type: 'procedure', bodyScript: 'DELETE FROM d.Kept;' }),
      makeNode({ id: writer, schema: 'd', name: 'Writer', type: 'procedure', bodyScript: 'INSERT d.Kept(Value) SELECT Value FROM d.Root; DELETE FROM d.Unused;' }),
      makeNode({ id: kept, schema: 'd', name: 'Kept', type: 'table', columns: [column('Value')] }),
      makeNode({ id: unused, schema: 'd', name: 'Unused', type: 'table', columns: [column('Value')] }),
    ];
    const engine = engineFor(all, [[root, first], [root, writer], [first, kept], [writer, kept], [writer, unused]]);
    expect(engine.init({ origin: root, question: 'Trace Value downstream.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(root), column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [first, writer].map(nodeId => ({ nodeId, question: 'Establish whether Value continues here.' })) })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: first } });
    expect(engine.submitFindings({ ...guardRecord(first), column_flow: [], prune_neighbors: [{ id: kept, reason: 'No Value is written on this branch.' }] })).toHaveProperty('ok', true);
    expect(engine.toJSON().engineInternals.pruneBallots).toEqual([{ nodeId: kept, votes: [{ senderId: first, vote: 'prune' }] }]);
    expect(engine.toJSON().removedSet).not.toContain(kept);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer } });
    expect(engine.submitFindings({ ...guardRecord(writer),
      column_flow: [{ out_col: 'Value', writes_to: { node: kept, col: 'Value' }, upstream_columns: [{ node: root, col: 'Value' }] }],
      questions: [{ nodeId: kept, question: 'Establish how the stored Value continues.' }],
      prune_neighbors: [{ id: unused, reason: 'The delete target carries no Value.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.toJSON().removedSet).toEqual([unused]);
    expect(engine.getResult().fullNodes.map(node => node.id)).toContain(kept);
    expect(engine.getResult().columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: root, to_node: kept, to_col: 'Value' }));
  });

  it.each(['a delete-only write', 'a metadata-declared scalar return'])('stores a mapping through %s as declared, without classifying the SQL', via => {
    const contributor = via === 'a delete-only write' ? '[d].[Purge]' : '[d].[Rate]';
    const all = via === 'a delete-only write'
      ? [...nodes, makeNode({ id: contributor, schema: 'd', name: 'Purge', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.Purge AS DELETE FROM d.Report;' })]
      : [makeNode({ ...nodes[0], columns: [{ ...column('Total'), expressionDependencies: [{ reference: contributor, sourceElementType: 'SqlScalarFunction' }] }] }), nodes[1],
        makeNode({ id: contributor, schema: 'd', name: 'Rate', type: 'function', columns: [column('Value')], bodyScript: 'CREATE FUNCTION d.Rate() RETURNS int AS BEGIN RETURN 1 END;' })];
    const col = via === 'a delete-only write' ? 'Total' : 'Value';
    const engine = start(all, [[source, origin], [contributor, origin]], model => {
      if (via === 'a delete-only write') model.edges.find(edge => edge.source === contributor)!.deleteOnly = true;
    });
    const accepted = engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Total', upstream_columns: [{ node: contributor, col }] }],
      questions: [{ nodeId: source, question: 'Resolve Amount.' }, { nodeId: contributor, question: 'Describe its role.' }] });
    expect(accepted, JSON.stringify(accepted)).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([expect.objectContaining({ from_node: contributor, from_col: col, to_node: origin, to_col: 'Total' })]);
  });
});

describe('current task endpoints come from the engine', () => {
  it('renders the engine-qualified root endpoint and never treats bare active column names as endpoints', () => {
    const origin = '[d].[Report]';
    const nodes = [makeNode({ id: origin, schema: 'd', name: 'Report', type: 'view', columns: [column('Total')], bodyScript: 'CREATE VIEW d.Report AS SELECT 1 AS Total;' })];
    const engine = engineFor(nodes, []);
    expect(engine.init({ origin, question: 'Trace total.', analysisMode: 'ct', targetColumns: ['Total'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    const [task] = engine.getCurrentTasks();
    expect(engine.taskEndpoints(task)).toEqual({ assigned: [{ node: origin, col: 'Total' }], external: [] });
    expect(buildCurrentTaskBlock([{ ...task, endpoints: engine.taskEndpoints(task) }], ['total'])).toContain(`<assigned_endpoints>${origin}.Total:`);
    expect(buildCurrentTaskBlock([task], ['total'])).not.toContain('<assigned_endpoints>');
  });
});
