import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
// Owner: src/ai/sm/smBase.ts, columnTracer.ts and agendaManager.ts; supplied-message functional contracts.
/** Runs column-flow rows from `tests/cases/lineage-cases.yaml`. A row locks ids, columns, edges, and rejection kinds. Prompt sentences stay out of the catalog. */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { AgendaManager } from '../../../src/ai/sm/agendaManager';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { ColumnEdge, ColumnFlowEntry } from '../../../src/ai/sm/smTypes';
import { NavigationEngine, type HopNeighborDisclosure } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode, toHopFinding } from '../../../src/ai/tools/toolSchemas';
import { rejectionFromZodError, renderProblem, type ToolRejection } from '../../../src/ai/support/toolErrorEnvelope';
/** The model-visible messages of an engine rejection at feedback 3. */
/** Everything the model reads of a rejection at its last feedback stage. */
const shownMessages = (rejection: unknown): string => renderProblem(rejection as ToolRejection, 3);

import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { buildColumnTraceView } from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { ColumnStore } from '../../../src/engine/columnStore';

function expectUnchangedRouting(after: ReturnType<NavigationEngine['toJSON']>, before: ReturnType<NavigationEngine['toJSON']>) {
  for (const key of ['agenda', 'columnAspect', 'removedSet'] as const) expect(after[key], key).toEqual(before[key]);
}

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

const guardRecord = (focus_node_id: string) => ({ focus_node_id,
  summary: 'Trace the requested value.', sections: [{ angle: 'technical' as const, text: 'The supplied SQL establishes this mapping.' }] });
const upstreamAll = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 0, exactness: 'exact' as const } };

function engineFor(nodes: LineageNode[], pairs: ReadonlyArray<readonly [string, string]>, mutate?: (model: ReturnType<typeof makeIndexedModel>) => void) {
  const model = makeIndexedModel(nodes, pairs);
  mutate?.(model);
  return new NavigationEngine(model, makeGraph(nodes, pairs.map(([from, to]) => [from, to])), () => {}, {});
}
const navigationFor = engineFor;

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

/** Seed held state through real admission; fixtures cannot prescribe arbitrary failure paths. */
function rejectAndReadHeld(engine: NavigationEngine, input: unknown) {
  expect(engine.submitModelFindings(input)).toHaveProperty('code');
  return engine.heldPartsOfCurrentFocus();
}

describe('declared contributor identities', () => {
  it('continues only qualified arriving columns while retaining extra valid mappings', () => {
    const root = '[d].[Root]', source = '[d].[Source]';
    const nodes = [makeNode({ id: root, name: 'Root', schema: 'd', type: 'view', columns: ['Tracked', 'Other'].map(column), bodyScript: 'SELECT A AS Tracked, B AS Other FROM d.Source;' }),
      makeNode({ id: source, name: 'Source', schema: 'd', type: 'view', columns: ['A', 'B'].map(column), bodyScript: 'SELECT 1 AS A, 2 AS B;' })];
    const pairs: Array<[string, string]> = [[source, root]];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['d']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: root, question: 'Trace Tracked upstream.', analysisMode: 'ct', targetColumns: ['Tracked'], direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: root, summary: 'Tracked uses A; Other uses B.',
      sections: [{ angle: 'technical', text: 'Both source relations are retained.' }],
      column_flow: [{ out_col: 'Tracked', upstream_columns: [{ node: source, col: 'A' }] },
        { out_col: 'Other', upstream_columns: [{ node: source, col: 'B' }] }],
      questions: [{ nodeId: source, question: 'Establish how A contributes to Tracked.' }],
    })).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges.map(edge => [edge.from_col, edge.to_col])).toEqual([['A', 'Tracked'], ['B', 'Other']]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: source }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toEqual([expect.objectContaining({ sourceRefs: [{ node: source, col: 'A' }] })]);
    expect(engine.pendingLineageQuestions.join('\n')).toContain('`A`');
    expect(engine.pendingLineageQuestions.join('\n')).not.toContain('`B`');
    expect(engine.submitFindings({ focus_node_id: source, summary: 'A is a constant.',
      sections: [{ angle: 'technical', text: 'A has no upstream supplier.' }], column_flow: [{ out_col: 'A', upstream_columns: [] }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().columnAspect!.edges.map(edge => [edge.from_col, edge.to_col])).toEqual([['A', 'Tracked'], ['B', 'Other']]);
  });
  it('stages a valid neighbor-column pair that does not sit on the requested chain', () => {
    const result = run({ id: 'detached-source-array', active: ['Tracked'], focus: 'writer', out: 'Other', direction: 'downstream',
      roots: [{ node: 'writer', col: 'Tracked' }],
      nodes: [{ id: 'writer', type: 'view', columns: ['Tracked', 'Other'] }, { id: 'source', type: 'table', columns: ['Other'] }], expect: {},
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
      expect(result).toMatchObject({ detail: { node: 'root' }, errors: [{ path: 'targetColumns.0', code: 'unknown_target_column', values: ['Value'] }] });
      expect(result).not.toHaveProperty('hint');
      expect(result).toHaveProperty('reason', expect.not.stringContaining(target));
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
      { column_flow: [{ out_col: output, upstream_columns: [{ node: 'proc', col: output }] }] },
      new Map(nodes.map(node => [node.id, node])), makeIndexedModel(nodes, [['source', 'proc'], ['proc', 'root']]), null, undefined, undefined, 'upstream', undefined, [], [], [], [{ node: 'root', col: output }]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges.map(edge => edge.from_col)).toEqual([output]);
  });
  it('stores a supplied pair whose endpoints share one object column as one direct pair (D-130)', () => {
    const columns = ['OrderAmount', 'RegionCode', 'Discount'];
    const nodes = [
      makeNode({ id: 'writer', name: 'writer', schema: 'dbo', type: 'procedure', bodyScript: 'INSERT INTO staging SELECT * FROM staging;' }),
      makeNode({ id: 'staging', name: 'staging', schema: 'dbo', type: 'table', columns: columns.map(column) }),
    ];
    const result = new ColumnTracer(['OrderAmount']).validateColumnFlow('writer',
      { column_flow: [{
        out_node: 'staging',
        out_col: 'OrderAmount',
        upstream_columns: [{ node: 'staging', col: 'OrderAmount' }],
      }] },
      new Map(nodes.map(node => [node.id, node])),
      makeIndexedModel(nodes, [['writer', 'staging'], ['staging', 'writer']]),
      null, undefined, undefined, 'upstream', undefined, [], [], [], [{ node: 'staging', col: 'OrderAmount' }],
    );
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toMatchObject([{ from_node: 'staging', from_col: 'OrderAmount', to_node: 'staging', to_col: 'OrderAmount' }]);
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
      upstream_columns: [{ node: upstream ? carrier : origin, col: 'Value' }], ...(!upstream ? { out_node: carrier } : {}),
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
      { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Value' }] }] },
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
    expect(engine.submitFindings({ ...record(producer), column_flow: ['X', 'Y'].map(out_col => ({ out_node: stored, out_col,
      upstream_columns: [{ node: producer, col: out_col }] })), questions: [{ nodeId: stored, question }],
    })).toHaveProperty('ok', true);
    const producerEdges = structuredClone(engine.columnAspect!.edges);
    return { engine, nodes, pairs, producerEdges };
  }

  it('assigns each write destination its own renamed endpoints and carries nothing the AI did not pair (D-130)', () => {
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
        { out_node: left, out_col: 'SavedLeft', upstream_columns: [{ node: producer, col: 'LeftPort' }] },
        { out_node: right, out_col: 'SavedRight', upstream_columns: [{ node: producer, col: 'RightPort' }] },
      ], questions: [left, right, reader].map(nodeId => ({ nodeId, question: 'Inspect this destination or reader.' })),
    })).toHaveProperty('ok', true);
    const arrivals = engine.toJSON().engineInternals.investigationTasks.filter(task => task.kind === 'column_lineage' && task.status === 'pending');
    expect(arrivals.find(task => task.nodeId === left)).toMatchObject({ activeColumns: ['SavedLeft'], sourceRefs: [{ node: left, col: 'SavedLeft' }] });
    expect(arrivals.find(task => task.nodeId === right)).toMatchObject({ activeColumns: ['SavedRight'], sourceRefs: [{ node: right, col: 'SavedRight' }] });
    expect(arrivals.find(task => task.nodeId === reader)).not.toHaveProperty('sourceRefs');
    expect(engine.columnAspect!.edges.map(edge => `${edge.from_node}.${edge.from_col}->${edge.to_node}.${edge.to_col}`)).toEqual([
      `${producer}.LeftPort->${left}.SavedLeft`, `${producer}.RightPort->${right}.SavedRight`,
    ]);
  });

  it.each((['filter', 'combine'] as const).flatMap(role => [false, true].map(declareBirth => ({ role, declareBirth }))))(
    'retains $role influence and stores a procedure origin only when the AI pairs it: $declareBirth', ({ role, declareBirth }) => {
    const source = '[d].[Source]', writer = '[d].[Producer]', stored = '[d].[Stored]';
    const nodes = [
      makeNode({ id: source, schema: 'd', name: 'Source', type: 'table', columns: [column('Flag')] }),
      makeNode({ id: writer, schema: 'd', name: 'Producer', type: 'procedure', columns: [],
        bodyScript: 'INSERT d.Stored(Discount) SELECT 1 FROM d.Source WHERE Flag = 1;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('Discount')] }),
    ];
    const engine = navigationFor(nodes, [[source, writer], [writer, stored]]);
    expect(engine.init({ origin: writer, question: 'Trace Discount.', analysisMode: 'ct', targetColumns: ['Discount'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: writer, summary: 'Discount is written after a row test.',
      sections: [{ angle: 'technical', text: 'Source.Flag only selects the row.' }],
      column_flow: [{ out_node: stored, out_col: 'Discount',
        upstream_columns: [{ node: source, col: 'Flag', transforms: [role] }] },
      ...(declareBirth ? [{ out_node: stored, out_col: 'Discount', upstream_columns: [{ node: writer, col: 'Discount' }] }] : [])],
    })).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges.map(edge => ({
      from: `${edge.from_node}.${edge.from_col}`, to: `${edge.to_node}.${edge.to_col}`, transforms: edge.transforms ?? null,
    }))).toEqual([
      { from: `${source}.Flag`, to: `${stored}.Discount`, transforms: [role] },
      ...(declareBirth ? [{ from: `${writer}.Discount`, to: `${stored}.Discount`, transforms: null }] : []),
    ]);
    },
  );

  it('keeps a value-carrying ref on its own edge and does not add a writer edge', () => {
    const source = '[d].[Source]', writer = '[d].[Producer]', stored = '[d].[Stored]';
    const nodes = [
      makeNode({ id: source, schema: 'd', name: 'Source', type: 'table', columns: [column('Amount')] }),
      makeNode({ id: writer, schema: 'd', name: 'Producer', type: 'procedure', columns: [],
        bodyScript: 'INSERT d.Stored(Discount) SELECT Amount FROM d.Source;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column('Discount')] }),
    ];
    const engine = navigationFor(nodes, [[source, writer], [writer, stored]]);
    expect(engine.init({ origin: writer, question: 'Trace Discount.', analysisMode: 'ct', targetColumns: ['Discount'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: writer, summary: 'Discount carries Amount.',
      sections: [{ angle: 'technical', text: 'Source.Amount is the written value.' }],
      column_flow: [{ out_node: stored, out_col: 'Discount',
        upstream_columns: [{ node: source, col: 'Amount', transforms: ['compute'] }] }],
    })).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([
      expect.objectContaining({ from_node: source, from_col: 'Amount', to_node: stored, to_col: 'Discount', transforms: ['compute'] }),
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
            ...(reader.type === 'procedure' ? { out_node: reader.sink } : {}) })),
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
        prune_neighbors: [{ id: '[d].[Absent]', reason: 'Unknown object.' }],
      })).toMatchObject({ code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'] });
      expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
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
  it('ends an unmapped SQL input at this hop and names it in the acknowledgement, never forwarding it', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding(focus), column_flow: [{ out_col: 'Mapped', upstream_columns: [{ node: origin, col: 'Value' }] }],
      questions: [{ nodeId: next, question: 'Establish how Consumer uses Mapped.' }],
    })).toMatchObject({ ok: true, ended_columns: [`${origin}.Other`] });
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
    // can_map and the served enums are one projection: a neighbour is mappable exactly when the enum names it.
    const served = new Set(engine.hopSubmitColumns.columnSourceNodeIds ?? []);
    for (const neighbor of context.neighbors as HopNeighborDisclosure[]) expect(neighbor.can_map).toBe(served.has(neighbor.id));
    expect((context.neighbors as HopNeighborDisclosure[]).find(neighbor => neighbor.id === source)?.can_map).toBe(border === 'admitted');
    const result = engine.submitFindings({ focus_node_id: writer, summary: 'No output is recorded.',
      sections: [{ angle: 'technical', text: 'The upstream evidence is retained.' }], column_flow: [], questions: [] });
    expect(result).toMatchObject(border === 'admitted'
      ? { code: 'route_validation_failed', detail: [expect.objectContaining({ kind: 'neighbor_outcome_missing', id: source })] }
      : { ok: true });
  });

  it('admits a direct upstream read supplier of a downstream focus as a mappable column source while keeping it out of downstream routing', () => {
    const root = 'root', writer = 'writer', source = 'source';
    const nodes = [
      makeNode({ id: root, name: root, schema: 'dbo', type: 'view', columns: [column('Value')], bodyScript: 'SELECT 1 AS Value;' }),
      makeNode({ id: writer, name: writer, schema: 'dbo', type: 'procedure', bodyScript: 'SELECT Value * Rate FROM root JOIN source;' }),
      makeNode({ id: source, name: source, schema: 'dbo', type: 'view', columns: [column('Rate')], bodyScript: 'SELECT 1 AS Rate;' }),
    ];
    const engine = navigationFor(nodes, [[root, writer], [source, writer]]);
    expect(engine.init({ origin: root, question: 'Trace Value downstream', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: root, summary: 'Produces Value.', sections: [{ angle: 'technical', text: 'Produces Value.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [] }], questions: [{ nodeId: writer, question: 'Follow Value.' }],
    })).toHaveProperty('ok', true);
    const context = engine.getHopContext();
    expect(context).toMatchObject({ focus_node: { id: writer } });
    expect(engine.hopSubmitColumns.columnSourceNodeIds).toEqual([root, source, writer]);
    expect((context.neighbors as HopNeighborDisclosure[]).find(neighbor => neighbor.id === source)?.can_map).toBe(true);
    expect(engine.submitFindings({ focus_node_id: writer, summary: 'Combines Value and Rate.', sections: [{ angle: 'technical', text: 'Combines Value and Rate.' }],
      column_flow: [], questions: [],
    })).toHaveProperty('ok', true);
  });

  it.each(['depth', 'direction', 'excluded', 'admitted'] as const)('filters out_node and source choices against the %s scope boundary', border => {
    const root = 'root', writer = 'writer', target = 'target';
    const nodes = [makeNode({ id: root, name: root, schema: 'dbo', type: 'view', columns: [column('Value')], bodyScript: 'SELECT 1 AS Value;' }),
      makeNode({ id: writer, name: writer, schema: 'dbo', type: 'procedure', bodyScript: 'INSERT target SELECT 1 AS Value;' }),
      makeNode({ id: target, name: target, schema: 'dbo', type: 'table', columns: [column('Value')] })];
    const pairs: Array<[string, string]> = [[writer, root], [writer, target], ...(border === 'direction' ? [] : [[target, writer] as [string, string]])];
    const engine = navigationFor(nodes, pairs);
    expect(engine.init({ origin: root, question: 'Explain Value', analysisMode: 'ct', targetColumns: ['Value'],
      direction: border === 'direction' ? 'upstream' : 'bidirectional',
      depthIntent: { upstream: { levels: border === 'depth' ? 1 : 'all', exactness: 'exact' },
        downstream: { levels: border === 'depth' ? 1 : 'all', exactness: 'exact' } },
      ...(border === 'excluded' ? { excludeNodeIds: [target] } : {}),
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: root, summary: 'The writer supplies Value.',
      sections: [{ angle: 'technical', text: 'Inspect the writer.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col: 'Value' }] }],
      questions: [{ nodeId: writer, question: 'Explain Value.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer } });
    expect(engine.hopSubmitColumns.columnSourceNodeIds).toEqual(border === 'admitted' ? [root, target, writer] : [root, writer]);
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
    expect(result).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({ id: leaf, path: 'prune_neighbors.0.id',
      reason: expect.any(String), allowed_values: [] })]) });
    const after = engine.toJSON();
    expectUnchangedRouting(after, before);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    const schema = submitFindingsSchemaForMode(analysisMode, undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
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

  it.each(['fresh', 'held'] as const)('collects independent faults at the internal shape boundary with %s content', draft => {
    const engine = world();
    if (draft === 'held') rejectAndReadHeld(engine, { focus_node_id: root, summary: finding.summary,
      sections: { technical: finding.sections[0].text }, column_flow: '[]', questions: [], prune_neighbors: [],
    });
    const before = engine.toJSON();
    const rejected = engine.submitFindings({ ...finding,
      ...(draft === 'held' ? { summary: 'A valid replacement summary.' } : {}),
      column_flow: '[]' as unknown as ColumnFlowEntry[], questions: [{ nodeId: '[d].[Absent]', question: 'Explain Absent.' }], prune_neighbors: [],
    });
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['column_flow', 'questions.0.nodeId']),
      errors: expect.arrayContaining([
        expect.objectContaining({ path: 'column_flow', code: 'json_text' }),
        expect.objectContaining({ path: 'questions.0.nodeId', code: 'not_neighbor' }),
      ]) });
    if (!('code' in rejected)) throw new Error('Expected both independent boundary faults');
    expect(rejected.issuePaths).toHaveLength(2);
    expect(engine.toJSON().engineInternals.heldFinding?.finding.sections).toEqual(finding.sections);
    expect(rejected.issuePaths).not.toContain('column_flow.0');
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds', 'nodeStates'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.memory.detailSlots).toEqual(before.memory.detailSlots);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const repaired = engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root,
      column_flow: [terminal('Value'), terminal('Other')], questions: [{ nodeId: neighbor, question: 'Explain the source role.' }],
    })));
    expect(repaired, JSON.stringify(repaired)).toHaveProperty('ok', true);
    expect(engine.toJSON().memory.detailSlots[root], 'the replacement validated, so it replaced the held summary').toMatchObject({
      summary: draft === 'held' ? 'A valid replacement summary.' : finding.summary, sections: finding.sections });
  });
  it.each([false, true])('keeps protected-prune repair guidance consistent per neighbor (independent conflict: %s)', independentConflict => {
    const engine = world(independentConflict);
    const before = engine.toJSON();
    const ids = [neighbor, ...(independentConflict ? [other] : [])];
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', transforms: ['compute' as const, 'filter' as const] }] }, terminal('Other')];
    const questions = ids.map(nodeId => ({ nodeId, question: 'Explain the source contribution.' }));
    const rejected = engine.submitFindings({ ...finding, column_flow, questions,
      prune_neighbors: ids.map(id => ({ id, reason: 'Outside the investigation.' })),
    });
    // A refused prune leaves one legal repair for its neighbor: the refusal and the conflict are both stated at their paths.
    expect(rejected).toMatchObject({ code: 'route_validation_failed',
      errors: expect.arrayContaining([expect.objectContaining({ path: 'prune_neighbors.0.id', code: 'prune_target' }),
        expect.objectContaining({ code: 'conflict' })]),
      issuePaths: expect.arrayContaining(['questions.0.nodeId', 'prune_neighbors.0.id']),
      detail: expect.arrayContaining([
        expect.objectContaining({ id: neighbor, path: 'prune_neighbors.0.id' }),
        expect.objectContaining({ id: neighbor, path: 'questions.0.nodeId' }),
      ]),
    });
    if (independentConflict) {
      expect(rejected).toMatchObject({
        reason: expect.stringContaining('questions.1.nodeId'),
        issuePaths: expect.arrayContaining(['questions.1.nodeId', 'prune_neighbors.1.id']),
        detail: expect.arrayContaining([expect.objectContaining({ id: other, path: 'questions.1.nodeId' })]),
      });
    }
    const after = engine.toJSON();
    expectUnchangedRouting(after, before);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(engine.submitFindings({ ...finding, column_flow, questions, prune_neighbors: [] })).toHaveProperty('ok', true);
    expect(engine.toJSON().removedSet).toEqual([]);
  });
  it('keeps both repairs legal for a question/prune conflict without a prune refusal', () => {
    const engine = world();
    const column_flow = [terminal('Value'), terminal('Other')];
    const rejected = engine.submitFindings({ ...finding, column_flow,
      questions: [{ nodeId: neighbor, question: 'Explain this source.' }],
      prune_neighbors: [{ id: neighbor, reason: 'No contribution to the traced constants.' }],
    });
    expect(rejected).toMatchObject({ code: 'route_validation_failed',
      errors: [{ path: 'questions.0.nodeId', code: 'conflict', values: [neighbor] }],
    });
    expect(engine.submitFindings({ ...finding, column_flow, questions: [],
      prune_neighbors: [{ id: neighbor, reason: 'No contribution to the traced constants.' }],
    })).toHaveProperty('ok', true);
    expect(engine.toJSON().removedSet).toContain(neighbor);
  });
  it.each([false, true])('requests only actual defects and reports refused pruning with its mapping conflict (held questions: %s)', hasQuestions => {
    const engine = world(true);
    const before = engine.toJSON();
    const held = rejectAndReadHeld(engine, { ...finding, sections: { technical: finding.sections[0].text }, column_flow: 'malformed',
      prune_neighbors: [{ id: neighbor, reason: 'Outside the value path.' }],
      questions: hasQuestions ? [{ nodeId: other, question: 'Explain OtherSource.' }] : [],
    });
    expect(held?.resend).toEqual(['column_flow']);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', transforms: ['compute' as const, 'filter' as const] }] }, terminal('Other')];
    const rejected = engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, column_flow })));
    expect(rejected).toMatchObject({ code: 'route_validation_failed', detail: expect.arrayContaining([expect.objectContaining({ kind: 'prune_unsupported', id: neighbor })]),
      issuePaths: expect.arrayContaining(['prune_neighbors.0.id', 'column_flow.0.upstream_columns.0']) });
    expectUnchangedRouting(engine.toJSON(), before);
    const repair = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
    expect(engine.submitFindings(toHopFinding(repair.parse({ focus_node_id: root, prune_neighbors: [],
      questions: [neighbor, other].map(nodeId => ({ nodeId, question: 'Establish this source contribution.' })),
    })))).toHaveProperty('ok', true);
    expect(engine.toJSON().removedSet).toEqual([]);
  });
  it.each([root, '[d].[Absent]'])('rejects a refused prune of %s atomically and accepts an explicit repair', id => {
    const engine = world();
    const before = engine.toJSON();
    const result = engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
      prune_neighbors: [{ id, reason: 'Not relevant to this investigation.' }],
    });
    expect(result).toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining('prune_neighbors.0'),
      errors: expect.arrayContaining([expect.objectContaining({ path: 'prune_neighbors.0.id', code: expect.stringMatching(/^prune_/) })]) });
    const after = engine.toJSON();
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(engine.currentFocus).toBe(root);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, prune_neighbors: [] })))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([neighbor]);
  });

  it.each(['duplicate', 'mixed', 'changing'] as const)('rejects repeated %s invalid mappings without committing findings or routes', scenario => {
    const engine = world();
    const before = engine.toJSON();
    for (let attempt = 0; attempt < 3; attempt++) {
      const badSource = { node: neighbor, col: scenario === 'changing' ? `Missing${attempt}` : 'Missing' };
      const result = engine.submitFindings({ ...finding,
        column_flow: [
          { out_col: 'Value', upstream_columns: scenario === 'mixed'
            ? [{ node: neighbor, col: 'Value' }, badSource]
            : [badSource, badSource, badSource] },
          terminal('Other'),
        ],
        questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
      });
      expect(result).toMatchObject({ code: 'contributor_col_not_on_source' });
      expect(result).not.toHaveProperty('missingParts');
      const after = engine.toJSON();
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.agenda).toEqual(before.agenda);
      expect(after.memory.detailSlots).toEqual(before.memory.detailSlots);
      expect(after.memory.verdictCounts).toEqual(before.memory.verdictCounts);
      expect(after.removedSet).toEqual(before.removedSet);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      expect(engine.currentFocus).toBe(root);
    }
    expect(engine.submitFindings({ ...finding,
      column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    })).toHaveProperty('ok', true);
  });

  it('ends an unmapped requested output at the origin and names it in the acknowledgement', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value')],
      questions: [{ nodeId: neighbor, question: 'Explain the source object role.' }] })).toMatchObject({ ok: true, ended_columns: [`${root}.Other`] });
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('accepts explicit terminal targets and an explicit business question without inventing a column continuation', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain the source object role.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('rejects an unnamed, unmapped CT neighbor without synthesizing a purpose or column mapping', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')] })).toMatchObject({
      code: 'route_validation_failed', detail: [expect.objectContaining({ kind: 'neighbor_outcome_missing', id: neighbor })] });
    expect(engine.toJSON().agenda).toEqual([]);
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('replaces a held questions list whole and never drops a held question for a neighbor named in prune_neighbors', () => {
    const engine = world(true);
    const invalid = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Absent', note: 'x'.repeat(2000) }] };
    const questions = [{ nodeId: neighbor, question: 'Explain Source Value.' }, { nodeId: other, question: 'Explain OtherSource rows.' }];
    expect(engine.submitFindings({ ...finding, column_flow: [invalid, terminal('Other')], questions }))
      .toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: expect.arrayContaining([expect.stringMatching(/^column_flow(?:\.|$)/)]) });
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }] }, terminal('Other')];
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(schema.safeParse({ focus_node_id: root, column_flow, prune_neighbors: [] }).success).toBe(true);
    const retry = (extra: Record<string, unknown>) => toHopFinding(schema.parse({ focus_node_id: root, column_flow, ...extra }));
    expect(engine.submitFindings(retry({ prune_neighbors: [{ id: other, reason: 'OtherSource supplies no tracked value.' }] })),
      'the held question for the pruned neighbor is kept, so the two lists conflict').toMatchObject({ code: 'route_validation_failed', detail: expect.arrayContaining([expect.objectContaining({ kind: 'prune_question_conflict', id: other })]) });
    expect(engine.submitFindings(retry({ questions: [questions[0]], prune_neighbors: [{ id: other, reason: 'OtherSource supplies no tracked value.' }] }))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([neighbor]);
  });
  it.each([false, true])('continues a mapped neighbor with generated column instructions, keeping an authored question separate (question: %s)', asked => {
    const engine = world();
    const question = 'Establish how Source.Value determines the business price.';
    expect(engine.submitFindings({ ...finding, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }] }, terminal('Other'),
    ], ...(asked ? { questions: [{ nodeId: neighbor, question }] } : {}) })).toMatchObject({ ok: true, route_outcomes: [{ nodeId: neighbor, accepted: true }] });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks().some(task => task.question === question)).toBe(asked);
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
        issuePaths: ['questions.0.nodeId', 'prune_neighbors.1.id', 'column_flow.0.upstream_columns.0'] });
      const after = engine.toJSON();
      expect(after.agenda).toEqual(before.agenda);
      expect(after.removedSet).toEqual(before.removedSet);
      expect(after.visited).toEqual(before.visited);
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      expect(engine.currentFocus).toBe(root);
      expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
      const repair = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
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
    rejectAndReadHeld(engine, { ...finding, sections: { technical: finding.sections[0].text }, summary: '', column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    });
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const patch = (summary?: string) => toHopFinding(schema.parse({ focus_node_id: root, ...(summary ? { summary } : {}) }));
    expect(engine.submitFindings(patch())).toMatchObject({ code: 'missing_field', issuePaths: ['summary'], missingParts: ['summary'] });
    expect(engine.submitFindings(patch('Both requested outputs are constants.'))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
  });
  it('never merges a resent flow back by out_col and keeps held content through a malformed retry', () => {
    const engine = world();
    const invalid = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Absent', note: 'x'.repeat(2000) }] };
    const rejected = engine.submitFindings({ ...finding, column_flow: [invalid, terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    });
    expect(rejected).toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: ['column_flow.0.upstream_columns.0.col'], resend: ['column_flow'] });
    expect(engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false).toBe(false);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const malformed = { focus_node_id: root, prune_neighbors: [{ id: '[d].[Absent]', reason: 42 }] };
    const parsed = schema.safeParse(malformed);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected the malformed prune to be rejected');
    const beforeMalformed = engine.toJSON();
    const held = rejectAndReadHeld(engine, malformed);
    expect([...held!.resend].sort(), 'the malformed prune and the flow the draft still lacks are owed').toEqual(['column_flow', 'prune_neighbors']);
    const afterMalformed = engine.toJSON();
    expect(afterMalformed.engineInternals.heldFinding?.finding).toEqual(beforeMalformed.engineInternals.heldFinding?.finding);
    expectUnchangedRouting(afterMalformed, beforeMalformed);
    const corrected = { ...invalid, upstream_columns: [{ node: neighbor, col: 'Value', note: 'x'.repeat(2000) }] };
    const retry = (column_flow: unknown[]) => toHopFinding(schema.parse({ focus_node_id: root, column_flow, prune_neighbors: [] }));
    expect(engine.submitFindings(retry([corrected])), 'the Other entry of the rejected call is not restored')
      .toMatchObject({ ok: true, ended_columns: [`${root}.Other`] });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
  });
  it.each(['note', 'transforms'] as const)('resends the whole list after a malformed flow entry with misplaced %s', field => {
    const engine = world();
    const corrected = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', note: 'Retain source evidence.' }] };
    const sibling = terminal('Other');
    const invalid = { ...corrected, [field]: field === 'note' ? 'Misplaced explanation.' : ['pass_through'] };
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...finding, column_flow: [invalid, sibling],
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    })).toMatchObject({ code: 'invalid_input', resend: ['column_flow'] });
    expectUnchangedRouting(engine.toJSON(), before);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(schema.safeParse({ focus_node_id: root, column_flow: [corrected, sibling] }).success).toBe(true);
    expect(schema.safeParse({ focus_node_id: root, column_flow_repairs: [{ entry_index: 0, replacement: corrected }] }).success,
      'a partial entry repair is not part of the contract').toBe(false);
    expect(engine.submitFindings(toHopFinding({ focus_node_id: root, column_flow: [corrected, sibling] }))).toHaveProperty('ok', true);
    expect(engine.toJSON().memory.detailSlots[root]).toMatchObject({ summary: finding.summary, sections: finding.sections });
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: neighbor, from_col: 'Value', to_node: root, to_col: 'Value' }));
  });
  it('revalidates a resent list against metadata before committing held content', () => {
    const engine = world();
    const flow = [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value' }], note: 'Wrong level.' }, terminal('Other')];
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...finding, column_flow: flow,
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    })).toHaveProperty('code', 'invalid_input');
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root,
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Absent' }] }, terminal('Other')] }))))
      .toHaveProperty('code', 'contributor_col_not_on_source');
    expectUnchangedRouting(engine.toJSON(), before);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, resend: ['column_flow'] });
  });
  it('preserves long column evidence while rejecting only an overlong rendered node badge', () => {
    const engine = world();
    const note = 'The source value and its SQL explanation. '.repeat(100);
    const input = { ...finding, sections: { technical: finding.sections[0].text }, badge_label: 'x'.repeat(51),
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', note }] }, terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    };
    const fresh = submitFindingsSchemaForMode('ct', undefined, true, engine.hopSubmitColumns);
    const parsed = fresh.safeParse(input);
    if (parsed.success) throw new Error('The node badge exceeds its rendered-label bound');
    const rejected = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema: fresh });
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: ['badge_label'] });
    expect(rejectAndReadHeld(engine, input)?.resend).toEqual(['badge_label']);
    expect(engine.columnAspect?.edges).toEqual([]);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, badge_label: 'Source contribution' })))).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges.find(edge => edge.from_node === neighbor)?.note).toBe(note);
  });
  it('merges the valid fields of a rejected retry into the held draft and owes only the still-failing field', () => {
    const engine = world();
    const entry = (out_col: string, misplaced: boolean) => ({ out_col, upstream_columns: [{ node: neighbor, col: 'Value', note: `Supplies ${out_col}.` }],
      ...(misplaced ? { note: 'Misplaced explanation.' } : {}) });
    const outs = ['Value', 'Other', 'Value', 'Other'];
    const first = { ...finding, sections: { technical: finding.sections[0].text }, column_flow: outs.map(out => entry(out, true)) };
    expect(rejectAndReadHeld(engine, first)).toMatchObject({ sections: ['technical'], summary: true, resend: ['column_flow'] });
    const retryFlow = outs.map((out, index) => entry(out, index === 3));
    const held = rejectAndReadHeld(engine, { focus_node_id: root, summary: 'Amended summary.', badge_label: 'Source role', column_flow: retryFlow });
    expect(held).toMatchObject({ sections: ['technical'], summary: true, fields: ['badge_label'], resend: ['column_flow'] });
    const saved = engine.toJSON().engineInternals.heldFinding;
    expect(saved?.finding, 'the valid fields replaced their held copies').toMatchObject({ summary: 'Amended summary.', sections: finding.sections, badge_label: 'Source role' });
    expect(saved?.finding.column_flow, 'no unvalidated flow is committed to the typed draft').toBeUndefined();
  });
  it('holds the valid angle of a failed section and names the failed and missing locked angle as owed', () => {
    const engine = world();
    engine.classification = 'both';
    expect(rejectAndReadHeld(engine, { ...finding, sections: { technical: finding.sections[0].text, business: 42 },
      column_flow: [terminal('Value'), terminal('Other')], questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    })).toEqual({ sections: ['technical'], summary: true, fields: ['questions', 'column_flow'], failed: ['sections.business'], resend: ['sections.business'] });
    const schema = submitFindingsSchemaForMode('ct', 'both', false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const retry = (sections: Record<string, string>) => toHopFinding(schema.parse({ focus_node_id: root, sections }));
    expect(engine.submitFindings(retry({}))).toMatchObject({ code: 'invalid_input',
      issuePaths: expect.arrayContaining([expect.stringMatching(/^sections(?:\.|$)/)]) });
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
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
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
    expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const malformed = { focus_node_id: focus, prune_neighbors: [{ id: outside, reason: 42 }] };
    const parsed = validateToolCandidate(schema, malformed);
    if (parsed.success) throw new Error('Expected a numeric prune reason to be rejected');
    expect(parsed.rejection.issuePaths).toEqual(['prune_neighbors', 'prune_neighbors.0.reason']);
    rejectAndReadHeld(engine, malformed);
    expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
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

  it.each(['bb', 'ct'] as const)('preserves queued work with a new %s authored mapping or relevance question', analysisMode => {
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
    const branchContext = engine.getHopContext();
    expect(branchContext).toMatchObject({ focus_node: { id: branch } });
    const before = engine.toJSON();
    expect(before.agenda.some(entry => entry.nodeId === stored)).toBe(true);
    expect(engine.submitFindings({ ...guardRecord(branch), ...(analysisMode === 'ct'
      ? { column_flow: [{ out_col: 'Other', upstream_columns: [{ node: stored, col: 'Other' }] }] }
      : { questions: [{ nodeId: stored, question: 'Trace stored Other.' }] }) }))
      .toMatchObject({ ok: true, route_outcomes: [{ nodeId: stored, accepted: true }] });
    expect(engine.investigationTasks.filter(task => task.nodeId === stored).map(task => task.question)).toContain('Trace stored Value.');
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

  it('omits the entry of a write to an outside SQL destination and stores no pair (D-096)', () => {
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
      column_flow: [] };
    expect(engine.hopSubmitColumns.columnSourceNodeIds).not.toContain(stored);
    expect(engine.submitFindings(toHopFinding(schema.parse(payload)))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([]);
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
      column_flow: [{ out_node: equivalent ? ' "D" . "stored" ' : stored, out_col: 'X', upstream_columns: [{ node: producer, col: 'X' }] }] });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['column_flow.0.out_node'],
      errors: [{ path: 'column_flow.0.out_node', code: 'not_neighbor' }] });
    expect(shownMessages(rejected), 'D-102: no echoed id').not.toContain(stored);
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
    expect(result.detail_slots.map(slot => slot.nodeId)).toEqual([writer]);
  });
  it('accepts a losing prune of an unvisited neighbor mapped by an earlier branch', () => {
    const origin = '[d].[Proc]', focus = '[d].[Src]', sink = '[d].[Sink]';
    const nodes = [
      makeNode({ id: origin, schema: 'd', name: 'Proc', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.Proc AS INSERT INTO d.Sink(X) SELECT X FROM d.Src;' }),
      makeNode({ id: focus, schema: 'd', name: 'Src', type: 'view', columns: [column('X')], bodyScript: 'SELECT X FROM d.Sink;' }),
      makeNode({ id: sink, schema: 'd', name: 'Sink', type: 'table', columns: [column('X')] }),
    ];
    const engine = navigationFor(nodes, [[focus, origin], [origin, sink], [sink, focus]]);
    expect(engine.init({ origin, question: 'Trace X.', analysisMode: 'ct', targetColumns: ['X'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({
      ...guardRecord(origin),
      column_flow: [{ out_node: sink, out_col: 'X', upstream_columns: [{ node: focus, col: 'X' }] }],
      questions: [{ nodeId: focus, question: 'Follow Src.' }],
    })).toHaveProperty('ok', true);
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ focus_node: { id: focus } });
    expect(hop && 'neighbors' in hop ? hop.neighbors?.find(n => n.id === sink) : undefined).toMatchObject({ id: sink, can_question: true, can_prune: true });
    expect(engine.hopSubmitColumns.neighbors).toContainEqual({ id: sink, can_question: true, can_prune: true });
    const edges = engine.columnAspect!.edges.slice();
    const accepted = engine.submitFindings({ ...guardRecord(focus),
      prune_neighbors: [{ id: sink, reason: 'No relevant value from this branch.' }],
    });
    expect(accepted, JSON.stringify(accepted)).toHaveProperty('ok', true);
    expect(engine.toJSON().removedSet).toEqual([]);
    expect(engine.columnAspect!.edges).toEqual(edges);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.columnAspect!.edges.map(edge => `${edge.from_node}.${edge.from_col}->${edge.to_node}.${edge.to_col}`).sort())
      .toEqual([`${focus}.X->${sink}.X`]);
    const dispositions = engine.toJSON().nodeStates;
    const result = engine.getResult();
    expect(result.node_states).toEqual(dispositions);
    expect(result.fullNodes.map(node => node.id).sort()).toEqual([origin, focus, sink].sort());
    const rendered = new Set(result.fullNodes.map(node => node.id));
    for (const edge of result.columnAspect!.edges) {
      expect(rendered.has(edge.from_node), `source ${edge.from_node}`).toBe(true);
      expect(rendered.has(edge.to_node), `destination ${edge.to_node}`).toBe(true);
    }
  });
});

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
    expect(engine.submitFindings({ ...guardRecord(a), column_flow: ['X', 'Y'].map(col => ({ out_node: b, out_col: col, upstream_columns: [{ node: a, col }] })),
      questions: [{ nodeId: b, question: 'Where are X and Y read?' }] })).toHaveProperty('ok', true);
    // D-093: generated work names metadata only; mapping instructions belong to the prompt/schema.
    expect(engine.toJSON().agenda).toContainEqual(expect.objectContaining({ nodeId: b,
      lineageQuestions: [`Analyze column ${b}.X, ${b}.Y in ${b} (downstream).`] }));
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: c }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ question: 'Where are X and Y read?',
      sourceRefs: [{ node: b, col: 'X' }, { node: b, col: 'Y' }] }));
    expect(engine.submitFindings({ ...guardRecord(c), column_flow: [{ out_node: t, out_col: 'Z', upstream_columns: [{ node: b, col: 'X' }] }],
      questions: [{ nodeId: t, question: 'Describe T.' }] })).toHaveProperty('ok', true);
    expect(logs.some(message => message.includes('columns end') && message.includes(`${b}.Y`))).toBe(true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.getResult().node_states.find(state => state.nodeId === t)).toMatchObject({ action: 'passthrough', source: 'engine', columns: ['Z'] });
    expect(engine.columnAspect!.edges).toEqual([
      ...['X', 'Y'].map(col => expect.objectContaining({ hop_node: a, from_node: a, from_col: col, to_node: b, to_col: col })),
      expect.objectContaining({ hop_node: c, from_node: b, from_col: 'X', to_node: t, to_col: 'Z' }),
    ]);
    expect(engine.columnAspect!.edges.some(edge => edge.from_node === b && edge.from_col === 'Y')).toBe(false);
    expect(engine.columnAspect!.edges.map(edge => `${edge.from_node}.${edge.from_col}->${edge.to_node}.${edge.to_col}`)).toEqual([
      `${a}.X->${b}.X`, `${a}.Y->${b}.Y`, `${b}.X->${t}.Z`,
    ]);
  });
});

describe('out_col enum is the arriving columns', () => {
  it('serves only the arriving declared columns and rejects another declared column with allowed values', () => {
    const v = '[d].[V]', s = '[d].[S]';
    const nodes = [
      makeNode({ id: v, schema: 'd', name: 'V', type: 'view', columns: [column('X'), column('Y')], bodyScript: 'CREATE VIEW d.V AS SELECT X, Y FROM d.S;' }),
      makeNode({ id: s, schema: 'd', name: 'S', type: 'view', columns: [column('X'), column('Y')], bodyScript: 'CREATE VIEW d.S AS SELECT 1 AS X, 2 AS Y;' }),
    ];
    const engine = engineFor(nodes, [[s, v]]);
    expect(engine.init({ origin: v, question: 'Trace X.', analysisMode: 'ct', targetColumns: ['X'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.hopSubmitColumns.outCols).toEqual(['X']);
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const flow = (out_col: string) => ({ focus_node_id: v, column_flow: [{ out_col, upstream_columns: [{ node: s, col: 'X' }, { node: s, col: 'Y' }] }] });
    expect(validateToolCandidate(schema, flow('X')).success).toBe(true);
    const bad = validateToolCandidate(schema, flow('Y'));
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.success ? [] : bad.rejection.errors)).toContain('"X"');
  });
});

describe('out_node is required at a procedure focus', () => {
  const v = '[d].[V]', p = '[d].[P]', t = '[d].[T]', src = '[d].[S]';
  const nodes = [
    makeNode({ id: v, schema: 'd', name: 'V', type: 'view', columns: [column('X')], bodyScript: 'CREATE VIEW d.V AS SELECT X FROM d.T;' }),
    makeNode({ id: t, schema: 'd', name: 'T', type: 'table', columns: [column('X')] }),
    makeNode({ id: p, schema: 'd', name: 'P', type: 'procedure', bodyScript: 'CREATE PROCEDURE d.P AS INSERT d.T(X) SELECT Z FROM d.S;' }),
    makeNode({ id: src, schema: 'd', name: 'S', type: 'table', columns: [column('Z')] }),
  ];
  const served = (focus: string) => {
    const engine = engineFor(nodes, [[t, v], [p, t], [src, p]]);
    expect(engine.init({ origin: v, question: 'Trace X.', analysisMode: 'ct', targetColumns: ['X'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    if (focus === p) {
      expect(engine.submitFindings({ ...guardRecord(v), column_flow: [{ out_col: 'X', upstream_columns: [{ node: t, col: 'X' }] }], questions: [{ nodeId: t, question: 'Resolve X.' }] })).toHaveProperty('ok', true);
      expect(engine.getHopContext()).toMatchObject({ focus_node: { id: p } });
    }
    return submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns);
  };
  const body = (entry: Record<string, unknown>, focus: string) => ({ focus_node_id: focus, summary: 's', sections: { technical: 't' }, column_flow: [{ out_col: 'X', upstream_columns: [{ node: src, col: 'Z' }], ...entry }] });

  it('rejects an entry without out_node or with null, accepts a neighbor destination and the procedure as a source', () => {
    const schema = served(p);
    expect(schema.safeParse(body({}, p)).success).toBe(false);
    expect(schema.safeParse(body({ out_node: null }, p)).success).toBe(false);
    expect(schema.safeParse(body({ out_node: t }, p)).success).toBe(true);
    expect(schema.safeParse(body({ out_node: t, upstream_columns: [{ node: p, col: 'X' }] }, p)).success).toBe(true);
  });

  it('does not admit out_node at a view focus', () => {
    const schema = served(v);
    expect(schema.safeParse({ focus_node_id: v, summary: 's', sections: { technical: 't' }, column_flow: [{ out_col: 'X', upstream_columns: [{ node: t, col: 'X' }] }] }).success).toBe(true);
    expect(schema.safeParse({ focus_node_id: v, summary: 's', sections: { technical: 't' }, column_flow: [{ out_col: 'X', upstream_columns: [{ node: t, col: 'X' }], out_node: t }] }).success).toBe(false);
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
  const readBack = { out_node: staged, out_col: 'X', upstream_columns: [{ node: work, col: 'Y' }] };
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
      column_flow: [readBack, { out_node: work, out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }] }] });
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
      { out_node: other, out_col: 'V', upstream_columns: [{ node: source, col: 'Z' }] }] }))
      .toMatchObject({ code: 'route_validation_failed', issuePaths: ['column_flow.1.out_node'] });
  });

  it('accepts an extra in-direction mapping that is not on the requested column chain', () => {
    const engine = atProc();
    expect(engine.submitFindings({ ...guardRecord(proc), questions, column_flow: [
      { ...readBack, upstream_columns: [{ node: source, col: 'Z' }] },
      { out_node: work, out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }] },
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
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ question: 'Resolve C.', sourceRefs: [{ node: stored, col: 'C' }] }));
    // D-093 fixes metadata-only WHAT serialization, not model response quality or repair hints.
    expect(engine.toJSON().lineageQuestionsLastHop).toEqual([`Analyze column ${stored}.C in ${loader} (upstream).`]);
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
    ['an object outside the loaded model', '[d].[Missing]'],
    ['a loaded object that is not a neighbor', stranger],
  ])('rejects a contributor naming %s with its path and commits nothing', (_label, node) => {
    const engine = start();
    const before = engine.toJSON();
    const rejected = engine.submitFindings({ ...guardRecord(origin), column_flow: [{ out_col: 'Total', upstream_columns: [{ node: source, col: 'Amount' }, { node, col: 'Amount' }] }],
      questions: [{ nodeId: source, question: 'Resolve Amount.' }] });
    expect(rejected).toMatchObject({ issuePaths: ['column_flow.0.upstream_columns.1.node'],
      errors: [{ path: 'column_flow.0.upstream_columns.1.node', code: 'not_neighbor' }] });
    expect(shownMessages(rejected), 'D-102: no echoed id').not.toContain(node);
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
      rejectAndReadHeld(engine, raw);
      expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
      // The schema permits atomic replacement; omitting that replacement still retains the conflicting mapping.
      const served = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, true).safeParse({ focus_node_id: origin, prune_neighbors: prunes });
      expect(served.success).toBe(true);
      // The effective submission still conflicts with its held mapping and is refused atomically.

      submission = { ...toHopFinding(submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, true).parse({ focus_node_id: origin })), prune_neighbors: prunes };
    }
    const before = engine.toJSON();
    const rejection = engine.submitFindings(submission);
    expect(rejection).toMatchObject({ code: 'route_validation_failed',
      issuePaths: ['prune_neighbors.0.id', 'column_flow.0.upstream_columns.0'],
      detail: [expect.objectContaining({ path: 'prune_neighbors.0.id', allowed_values: [stranger] })] });
    const after = engine.toJSON();
    expectUnchangedRouting(after, before);
    expect(after.visited).toEqual(before.visited);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.engineInternals.pruneBallots).toEqual(before.engineInternals.pruneBallots);
    expect(engine.getDetailSlots()).toEqual([]);
    const repair = toHopFinding(submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false)
      .parse({ focus_node_id: origin, column_flow: flow, prune_neighbors: [prunes[1]], questions: [{ nodeId: source, question: 'Resolve Amount.' }] }));
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
      column_flow: [{ out_node: kept, out_col: 'Value', upstream_columns: [{ node: root, col: 'Value' }] }],
      questions: [{ nodeId: kept, question: 'Establish how the stored Value continues.' }],
      prune_neighbors: [{ id: unused, reason: 'The delete target carries no Value.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.toJSON().removedSet).toEqual([unused]);
    expect(engine.getResult().fullNodes.map(node => node.id)).toContain(kept);
    expect(engine.getResult().columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: root, to_node: kept, to_col: 'Value' }));
  });

  it('accepts an unrelated prune when this hop maps a source with an older pending prune ballot', () => {
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
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer } });
    const flow = [{ out_node: kept, out_col: 'Value', upstream_columns: [{ node: root, col: 'Value' }] }];
    // The mapping is this hop's keep vote, so the stale ballot leaves pruning the unrelated leaf open.
    expect(engine.submitFindings({ ...guardRecord(writer), column_flow: flow })).toMatchObject({ code: 'route_validation_failed',
      errors: [{ path: '', code: 'neighbor_undecided', values: [unused] }], resend: ['questions', 'prune_neighbors', 'column_flow'] });
    const accepted = engine.submitFindings({ ...guardRecord(writer), column_flow: flow, prune_neighbors: [{ id: unused, reason: 'The delete target carries no Value.' }] });
    expect(accepted, JSON.stringify(accepted)).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    // The losing vote removes nothing; the mapped source stays in the result.
    expect(engine.toJSON().removedSet).toEqual([unused]);
    expect(engine.getResult().fullNodes.map(node => node.id)).toContain(kept);
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

describe('authored outcomes for every open neighbor', () => {
  it.each((['bb', 'ct'] as const).flatMap(mode => (['upstream', 'downstream', 'bidirectional'] as const).map(direction => ({ mode, direction }))))('requires an authored decision in $mode / $direction', ({ mode, direction }) => {
    const root = '[d].[Root]', up = '[d].[Supplier]', down = '[d].[Consumer]';
    const nodes = [root, up, down].map(id => makeNode({ id, schema: 'd', name: id, type: 'view',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }], bodyScript: 'SELECT 1 AS Value;' }));
    const edges: [string, string][] = [[up, root], [root, down]];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: root, question: 'Explain Value.', analysisMode: mode, direction,
      ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}),
      depthIntent: { upstream: { levels: direction === 'downstream' ? 0 : 1, exactness: 'exact' },
        downstream: { levels: direction === 'upstream' ? 0 : 1, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    const before = engine.toJSON();
    // A local CT output generates downstream carry, but states no decision about the consumer.
    const result = engine.submitFindings({ focus_node_id: root, summary: 'Local constant.',
      sections: [{ angle: 'technical', text: 'Value is a constant.' }], ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [] }] } : {}) });
    const required = direction === 'upstream' ? [up] : direction === 'downstream' ? [down] : [up, down];
    expect(result, `${mode}/${direction}`).toMatchObject({ code: 'route_validation_failed',
      detail: required.map(id => expect.objectContaining({ kind: 'neighbor_outcome_missing', id })) });
    for (const id of required) expect(JSON.stringify(result)).toContain(id);
    // column_flow is offered only for a neighbor that can supply the focus's value; a downstream reader is never mapped as a source, and in CT its keep / question option comes first.
    const mapsSupplier = mode === 'bb' || direction !== 'downstream';
    expect((result as ToolRejection).resend?.includes('column_flow')).toBe(mode === 'ct' && mapsSupplier);
    // The undecided neighbors are backend facts, listed as missing from the first feedback.
    expect(result).toMatchObject({ errors: required.map(id => ({ path: '', code: 'neighbor_undecided', values: [id] })) });
    const after = engine.toJSON();
    expectUnchangedRouting(after, before);
    expect(after.visited).toEqual(before.visited);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.engineInternals.pruneBallots).toEqual(before.engineInternals.pruneBallots);
    expect(engine.getDetailSlots()).toEqual([]);
    expect(engine.currentFocus).toBe(root);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: ['questions', 'prune_neighbors', ...(mode === 'ct' && direction !== 'downstream' ? ['column_flow'] : [])] });
    expect(engine.submitFindings({ focus_node_id: root, summary: '', sections: [] })).toHaveProperty('code', 'route_validation_failed');
    expect(engine.submitFindings({ focus_node_id: root, summary: '', sections: [], questions: [], prune_neighbors: [],
      ...(mode === 'ct' ? { column_flow: [] } : {}) })).toHaveProperty('code', 'route_validation_failed');
    expect(engine.submitFindings({ focus_node_id: root, summary: '', sections: [],
      questions: required.map(nodeId => ({ nodeId, question: 'Explain your role in Value.' })) })).toHaveProperty('ok', true);
    expect(engine.toJSON().engineInternals.investigationTasks).toEqual(expect.arrayContaining(required.map(nodeId =>
      expect.objectContaining({ nodeId, question: 'Explain your role in Value.' }))));
  });
});

describe('authored column endpoints and downstream decisions', () => {
  it('counts a written table as mapped while requiring a separate outcome for an untouched consumer', () => {
    const root = '[d].[Root]', writer = '[d].[Writer]', stored = '[d].[Stored]', consumer = '[d].[Consumer]';
    const column = { name: 'Value', type: 'int', nullable: 'NULL', extra: '' };
    const nodes = [
      makeNode({ id: root, schema: 'd', name: 'Root', type: 'view', columns: [column], bodyScript: 'SELECT 1 AS Value;' }),
      makeNode({ id: writer, schema: 'd', name: 'Writer', type: 'procedure', bodyScript: 'INSERT d.Stored(Value) SELECT Value FROM d.Root;' }),
      makeNode({ id: stored, schema: 'd', name: 'Stored', type: 'table', columns: [column] }),
      makeNode({ id: consumer, schema: 'd', name: 'Consumer', type: 'view', columns: [column], bodyScript: 'EXEC d.Writer;' }),
    ];
    const edges: [string, string][] = [[root, writer], [writer, stored], [writer, consumer]];
    const engine = new NavigationEngine(makeIndexedModel(nodes, edges), makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: root, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: root, summary: 'Local value.', sections: [{ angle: 'technical', text: 'Value is constant.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [] }], questions: [{ nodeId: writer, question: 'Where does Value land?' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer } });
    const before = engine.toJSON();
    const flow = [{ out_node: stored, out_col: 'Value', upstream_columns: [{ node: root, col: 'Value' }] }];
    const result = engine.submitFindings({ focus_node_id: writer, summary: 'Persists Value.', sections: [{ angle: 'technical', text: 'Declared insert.' }], column_flow: flow });
    expect(result).toMatchObject({ code: 'route_validation_failed', detail: [expect.objectContaining({ kind: 'neighbor_outcome_missing', id: consumer })] });
    expectUnchangedRouting(engine.toJSON(), before);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    const repair = { focus_node_id: writer, questions: [{ nodeId: consumer, question: 'How does it use the procedure result?' }] };
    expect(engine.submitFindings(toHopFinding(schema.parse(repair)))).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: root, from_col: 'Value', to_node: stored, to_col: 'Value' })]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: consumer }, analysis_mode: 'bb' });
  });
});
