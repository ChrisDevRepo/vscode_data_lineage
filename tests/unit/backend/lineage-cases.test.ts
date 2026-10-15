// Owner: src/ai/sm/smBase.ts, columnTracer.ts and agendaManager.ts; supplied-message functional contracts.
/**
 * Runs column-flow rows from `tests/cases/lineage-cases.yaml`.
 * A row locks ids, columns, edges, and rejection kinds. Prompt sentences stay out of the catalog.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { ColumnEdge, ColumnFlowEntry, ScalarReturnTarget } from '../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode, toHopFinding } from '../../../src/ai/tools/toolSchemas';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';

import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { buildColumnTraceView } from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';

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
  sender_verdict?: 'analyze' | 'passthrough';
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
    { verdict: 'analyze', summary: 's', sections: [], column_flow: [{ out_col: row.out, upstream_columns: upstream }] } as never,
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

describe('lineage case catalog', () => {
  it('gives Playwright, Electron, and headless their own rows and expected output', () => {
    const rows = loadCases();
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(scriptedCases.length).toBeGreaterThan(0);
    expect(storedArrivalCases.length).toBeGreaterThan(0);
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
  it.each([
    ...(['passthrough', 'analyze', 'terminal', 'terminated', 'delete-only', 'read-only', 'missing-index', 'pruned', 'out-of-scope', 'prune-depth', 'prune-direction', 'prune-excluded'] as const)
      .map(mode => ({ direction: 'upstream' as const, mode })),
    { direction: 'downstream' as const, mode: 'passthrough' as const },
  ])('preserves only explicit unresolved carrier tasks: $direction/$mode', ({ direction, mode }) => {
    const origin = '[d].[Origin]', carrier = '[d].[Stored]', nextId = mode === 'prune-excluded' ? '[x].[Next]' : '[d].[Next]';
    const upstream = direction === 'upstream';
    const invalidPrune = mode.startsWith('prune-');
    const nodes = [origin, carrier, nextId].map(id => makeNode({ id, schema: id === nextId && mode === 'prune-excluded' ? 'x' : 'd', name: id,
      type: id === carrier ? 'table' : (id === origin ? !upstream : upstream && mode !== 'read-only') ? 'procedure' : 'view',
      columns: (id === nextId && upstream ? [] : ['Value']).map(column),
    }));
    const pairs: Array<[string, string]> = upstream ? [mode === 'prune-direction' ? [carrier, nextId] : [nextId, carrier], [carrier, origin]] : [[origin, carrier], [carrier, nextId]];
    const model = makeIndexedModel(nodes, pairs);
    if (mode === 'missing-index') model.neighborIndex = {};
    if (mode === 'delete-only') model.edges[0].deleteOnly = true;
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'passthrough' as const,
      summary: 'Inspect the requested stored value.', sections: [{ angle: 'technical' as const, text: 'Resolve the stored output at the next SQL hop.' }] });
    expect(engine.init({ origin, question: 'Trace the stored Value.', analysisMode: 'ct', targetColumns: ['Value'], direction,
      ...(mode === 'prune-excluded' ? { excludeSchemas: ['x'] } : {}),
      depthIntent: { upstream: { levels: upstream ? mode === 'out-of-scope' || mode === 'prune-depth' ? 1 : 'all' : 0, exactness: 'exact' },
        downstream: { levels: upstream ? 0 : 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(origin), column_flow: [{ out_col: 'Value', upstream_columns: upstream ? [{ node: carrier, col: 'Value' }] : [],
      ...(!upstream ? { writes_to: { node: carrier, col: 'Value' } } : {}),
    }] })).toHaveProperty('ok', true);
    const carrierHop = engine.getHopContext();
    expect(carrierHop).toMatchObject({ focus_node: { id: carrier }, analysis_mode: 'ct' });
    if (invalidPrune) expect(carrierHop.neighbors?.find(n => n.id === nextId)).toMatchObject({ can_prune: false });
    const edges = structuredClone(engine.columnAspect?.edges);
    const incoming = engine.getCurrentTasks()[0];
    if (!('sourceRefs' in incoming)) throw new Error('Expected a qualified column task');
    const sourceRefs = structuredClone(incoming.sourceRefs), question = incoming.question;
    const before = engine.toJSON(), slots = structuredClone(engine.getDetailSlots());
    const result = engine.submitFindings({ ...record(carrier), verdict: mode === 'analyze' ? 'analyze' : 'passthrough',
      column_flow: mode === 'terminal' ? [{ out_col: 'Value', upstream_columns: [] }] : [],
      ...(mode === 'terminated' ? { terminated_inputs: [{ node: carrier, col: 'Value' }] } : {}),
      ...(mode === 'analyze' ? { questions: [{ nodeId: nextId, question: 'Describe the writer.' }] } : {}),
      ...(mode === 'pruned' || invalidPrune ? { prune_neighbors: [{ id: nextId, reason: 'The branch is explicitly outside this investigation.' }] } : {}),
    });
    if (invalidPrune) {
      expect(result).toMatchObject({ code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'] });
      const after = engine.toJSON();
      expect(after.agenda).toEqual(before.agenda);
      expect(after.columnAspect).toEqual(before.columnAspect);
      expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
      expect(engine.getDetailSlots()).toEqual(slots);
      expect(engine.heldFindingFocus).toBe(carrier);
      const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
      if (mode === 'prune-depth') {
        const malformed = { focus_node_id: carrier, verdict: 'passthrough', prune_neighbors: [{ id: nextId, reason: 42 }] };
        const parsed = schema.safeParse(malformed);
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error('Expected the repair schema to reject a numeric prune reason');
        const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input: malformed, schema });
        expect(rejection.issuePaths).toEqual(['prune_neighbors.0.reason']);
        engine.holdRejectedSubmission(malformed, rejection.issuePaths ?? []);
        expect(engine.heldColumnFlow, 'an unrelated malformed repair retains the explicitly held empty flow').toBe(true);
      }
      const repaired = engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: carrier, verdict: 'passthrough', prune_neighbors: [] })));
      expect(repaired, JSON.stringify(repaired)).toHaveProperty('ok', true);
      expect(engine.getDetailSlots().find(slot => slot.nodeId === carrier)?.sections).toEqual(record(carrier).sections);
      expect(engine.columnAspect?.edges).toEqual(edges);
      return;
    }
    expect(result).toHaveProperty('ok', true);
    const next = engine.getHopContext();
    if (mode === 'pruned' || mode === 'out-of-scope') expect(next).toMatchObject({ done: true });
    else {
      // A delete-only write is still a writer: passthrough forwards to it without classifying the SQL.
      const forwards = mode === 'passthrough' || mode === 'delete-only';
      expect(next).toMatchObject({ focus_node: { id: nextId }, analysis_mode: forwards ? 'ct' : 'bb' });
      if (forwards) expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({
        activeColumns: ['Value'], sourceRefs, traversalSide: direction, question,
      }));
    }
    expect(engine.columnAspect?.edges).toEqual(edges);
  });
  it.each(['upstream', 'downstream'] as const)('accepts writer inputs and rejects reversed reader inputs while exploring %s', direction => {
    const writer = '[d].[Writer]', carrier = '[d].[Stored]', reader = '[d].[Reader]';
    const nodes = [writer, carrier, reader].map(id => makeNode({ id, schema: 'd', name: id,
      type: id === carrier ? 'table' : 'view', columns: ['Value'].map(column) }));
    const model = makeModel(nodes, [[writer, carrier], [carrier, reader]], ['d']);
    model.neighborIndex = { '[d].[stored]': { in: [writer], out: [reader] } };
    const validate = (source: string) => new ColumnTracer(['Value']).validateColumnFlow(carrier,
      { focus_node_id: carrier, verdict: 'analyze', summary: 'Trace Value.', sections: [], column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Value' }] }] },
      new Map(nodes.map(node => [node.id, node])), model, null, undefined, undefined, direction,
      [{ node: carrier, col: 'Value' }], [], [], [], [{ node: carrier, col: 'Value' }]);
    const valid = validate(writer);
    expect(valid.invalidRoutes).toEqual([]);
    expect(valid.stagedEdges).toMatchObject([{ from_node: writer, to_node: carrier }]);
    const reversed = validate(reader);
    expect(reversed.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'non_writer_continuation' }));
    expect(reversed.stagedEdges).toEqual([]);
  });
});

describe('stored-column arrival admission and delivery', () => {
  const producer = '[d].[Producer]', stored = '[d].[Stored]';
  const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'analyze' as const,
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
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: stored }, analysis_mode: 'ct' });
    expect(engine.submitFindings({ ...record(stored), verdict: 'passthrough', column_flow: [] })).toHaveProperty('ok', true);
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
    expect(engine.submitFindings({ focus_node_id: producer, verdict: 'analyze', summary: 'Writes two separate destinations.',
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
    const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'analyze' as const, summary: 'Resolve the assigned endpoint.',
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
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: sink }, analysis_mode: row.expect.sink_mode });
    expect(engine.getCurrentTasks()[0]).toMatchObject(row.expect.sink_mode === 'ct'
      ? { kind: 'column_lineage', activeColumns: row.expect.sink_columns }
      : { kind: 'analytical' });
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
    const authored = row.route === 'authored';
    const upstream = row.direction === 'upstream' || mapped || row.route === 'function';
    const pairs = row.graph.edges.map(([from, to]) => [qualify(from), qualify(to)] as [string, string]);
    const ids = [...new Set(pairs.flat())];
    const nodes = ids.map(id => makeNode({ id, schema: 'd', name: id,
      type: id === origin && !mapped && row.route !== 'function' ? 'table'
        : id === current && row.route === 'function' ? 'function'
          : id === current && row.direction === 'upstream' ? 'procedure' : 'view',
      columns: id === current && (row.route === 'function' || row.direction === 'upstream') ? []
        : (id === origin && row.direction === 'upstream' ? ['X', 'Other'] : ['X']).map(column),
      ...(id === current && row.direction === 'upstream' ? { bodyScript: 'UPDATE d.Origin SET Other = 42;' } : {}),
      ...(row.route === 'function' ? { bodyScript: id === origin
        ? `CREATE VIEW ${origin} AS SELECT ${current}(42) AS X;`
        : `CREATE FUNCTION ${current}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END;` } : {}),
    }));
    const engine = navigationFor(nodes, pairs);
    const finding = (focus_node_id: string) => ({ focus_node_id, verdict: 'passthrough' as const,
      summary: 'Investigate the inherited purpose at the next SQL object.',
      sections: [{ angle: 'technical' as const, text: 'Topology supplies investigation candidates, not confirmed consumption.' }],
      ...(row.mode === 'ct' ? { column_flow: [] } : {}),
    });
    expect(engine.init({ origin, question: 'Investigate the production and use of X, including row conditions that govern its value.', analysisMode: row.mode,
      ...(row.mode === 'ct' ? { targetColumns: ['X'] } : {}), direction: upstream ? 'upstream' : 'downstream',
      depthIntent: { upstream: { levels: upstream ? 'all' : 0, exactness: 'exact' },
        downstream: { levels: upstream ? 0 : 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: origin } });
    if (row.route !== 'root') {
      expect(engine.submitFindings({ ...finding(origin),
        verdict: row.sender_verdict ?? (authored || mapped || row.route === 'function' ? 'analyze' : 'passthrough'),
        ...(authored ? {
          questions: [{ nodeId: current, question: 'Explain the current object\'s established row role.' }] } : {}),
        ...(mapped ? {
          column_flow: [{ out_col: 'X', upstream_columns: [{ node: current, col: 'X' }] }],
          questions: [{ nodeId: current, question: 'Resolve the definition of Current.X.' }] } : {}),
        ...(row.route === 'function' ? {
          questions: [{ nodeId: current, question: 'Resolve the scalar output from its actual caller.', caller_context: { node: origin, col: 'X' } }] } : {}),
      })).toHaveProperty('ok', true);
      if (row.route === 'mixed') {
        expect(engine.getHopContext()).toMatchObject({ focus_node: { id: left } });
        expect(engine.submitFindings(finding(left))).toHaveProperty('ok', true);
        expect(engine.getHopContext()).toMatchObject({ focus_node: { id: right } });
        expect(engine.submitFindings({ ...finding(right), verdict: 'analyze',
          questions: [{ nodeId: current, question: 'Explain the independently established business rule.' }] })).toHaveProperty('ok', true);
      }
      expect(engine.getHopContext()).toMatchObject({ focus_node: { id: current } });
    }
    if (row.route === 'held-mapping') {
      expect(engine.canPruneCurrent).toBe(true);
      expect(engine.submitFindings({ ...finding(current), verdict: 'analyze',
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
        expect(engine.submitFindings({ ...finding(current), verdict: 'analyze',
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
      expect(engine.submitFindings(finding(id))).toHaveProperty('ok', true);
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
  const finding = (id: string) => ({ focus_node_id: id, verdict: 'analyze' as const, summary: 'Trace the supplied columns.', sections: [{ angle: 'technical' as const, text: 'Inspect the declared flow.' }] });
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
  it.each(['analyze', 'passthrough'] as const)('only explicit passthrough forwards unmapped inputs: %s', verdict => {
    const engine = world();
    expect(engine.submitFindings({ ...finding(focus), verdict, column_flow: [{ out_col: 'Mapped', upstream_columns: [{ node: origin, col: 'Value' }] }],
      ...(verdict === 'analyze' ? { terminated_inputs: [{ node: origin, col: 'Other' }], questions: [{ nodeId: next, question: 'Establish how Consumer uses Mapped.' }] } : {}),
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: next }, analysis_mode: 'ct' });
    expect(engine.columnAspect?.active_columns.sort()).toEqual(verdict === 'passthrough' ? ['Mapped', 'Other'] : ['Mapped']);
    expect(engine.pendingLineageQuestions.join('\n')).toContain('Mapped');
    expect(engine.getCurrentTasks()[0].question).toBe(verdict === 'passthrough' ? 'Establish which inputs Transform uses.' : 'Establish how Consumer uses Mapped.');
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
  const finding = { focus_node_id: root, verdict: 'analyze' as const, summary: 'Constant outputs.', sections: [{ angle: 'technical' as const, text: 'Both outputs are constants.' }] };
  const terminal = (out_col: string) => ({ out_col, upstream_columns: [] });
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
  it('forwards undecided neighbors only after an explicit passthrough, without synthesizing column mappings', () => {
    const engine = world();
    expect(engine.submitFindings({ ...finding, verdict: 'passthrough', column_flow: [terminal('Value'), terminal('Other')] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
    expect(engine.columnAspect?.edges).toEqual([]);
  });
  it('owes the whole questions list when one neighbor is missing, and merges no question back', () => {
    const engine = world(true);
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    })).toMatchObject({ code: 'incomplete_task', hint: expect.stringContaining('Held: sections.technical, summary, column_flow. Resend: questions.') });
    const schema = submitFindingsSchemaForMode(engine.currentHopAnalysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const patch = (questions: Array<{ nodeId: string; question: string }>) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', questions }));
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
    const retry = (extra: Record<string, unknown>) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', column_flow, ...extra }));
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
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', questions: [{ nodeId: neighbor, question }] })))).toHaveProperty('ok', true);
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
      expect(engine.submitFindings(toHopFinding(repair.parse({ focus_node_id: root, verdict: 'analyze', questions: input.questions, prune_neighbors: [prune] })))).toHaveProperty('ok', true);
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
    const patch = (summary?: string) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', ...(summary ? { summary } : {}) }));
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
    const shortened = { ...overlong, upstream_columns: [{ node: neighbor, col: 'Value', note: 'The source value.' }] };
    const retry = (column_flow: unknown[]) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', column_flow }));
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
    const retry = (sections: Record<string, string>) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', sections }));
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
    expect(engine.measureAdmissionScope().rounds).toBe(3);
    const record = (id: string) => ({ focus_node_id: id, verdict: 'analyze' as const, summary: 'Object role.', sections: [{ angle: 'technical' as const, text: 'Investigate the input.' }] });
    const flow = (node: string) => analysisMode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node, col: 'Value' }] }] } : {};
    engine.getHopContext();
    const question = 'Explain how relay supplies the approved result.';
    expect(engine.submitFindings({ ...record(root), ...flow(relay), questions: [{ nodeId: relay, question }] })).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([relay]);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: relay }, analysis_mode: analysisMode });
    expect(engine.submitFindings({ ...record(relay), ...flow(writer) })).toHaveProperty('code', 'incomplete_task');
    expect(engine.submitFindings({ ...record(relay), verdict: 'passthrough', ...flow(writer) })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer }, analysis_mode: analysisMode });
    expect(engine.getCurrentTasks()[0].question).toBe(question);
  });
});

describe('result dispositions', () => {
  const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'analyze' as const,
    summary: 'Record the supplied definition.', sections: [{ angle: 'technical' as const, text: 'The supplied SQL establishes this hop.' }] });

  it('rejects a write edge into an out-of-scope destination and keeps that object as a follow-up question', () => {
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
      column_flow: [{ out_col: 'X', upstream_columns: [], writes_to: { node: stored, col: 'X' } }] });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['column_flow.0.writes_to.node'],
      reason: expect.stringContaining(`\`${stored}\` is out of scope (excluded)`), hint: expect.stringContaining('kept as a follow-up question') });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.submitFindings({ ...record(producer), column_flow: [{ out_col: 'X', upstream_columns: [] }],
      questions: [{ nodeId: stored, question: 'Where is the stored X read?' }] })).toHaveProperty('ok', true);
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
      [used]: { verdict: 'passthrough' },
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
const guardRecord = (focus_node_id: string, verdict: 'analyze' | 'passthrough' = 'analyze') => ({ focus_node_id, verdict,
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
    const passed = String(engine.getHopContext().focus_node!.id);
    expect(engine.submitFindings({ ...guardRecord(passed, 'passthrough'), column_flow: [] })).toHaveProperty('ok', true);
    const mapped = String(engine.getHopContext().focus_node!.id);
    expect(engine.submitFindings({ ...guardRecord(mapped), column_flow: [{ out_col: mapped === first ? 'X' : 'Y', upstream_columns: [{ node: writer, col: 'Out' }] }],
      questions: [{ nodeId: writer, question: 'Resolve Out.' }] })).toHaveProperty('ok', true);
    return { engine, passed: passed === first ? { node: first, col: 'X' } : { node: second, col: 'Y' } };
  }

  it('dispatches every accepted column, not only the ones historical edges already bind', () => {
    const { engine, passed } = reachWriter();
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer }, analysis_mode: 'ct' });
    expect([...engine.columnAspect!.active_columns].sort()).toEqual(['Out', passed.col].sort());
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
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(b, 'passthrough'), column_flow: [] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: c }, analysis_mode: 'ct' });
    expect(engine.submitFindings({ ...guardRecord(c), column_flow: [{ out_col: 'X', upstream_columns: [{ node: b, col: 'X' }], writes_to: { node: t, col: 'Z' } }],
      questions: [{ nodeId: t, question: 'Describe T.' }] })).toHaveProperty('ok', true);
    expect(logs.some(message => message.includes('unmapped candidates end') && message.includes(`${b}.Y`))).toBe(true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: t }, analysis_mode: 'ct' });
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
    engine.getHopContext();
    expect(engine.submitFindings({ ...guardRecord(staged, 'passthrough'), column_flow: [] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: proc }, analysis_mode: 'ct' });
    return engine;
  };
  const questions = [{ nodeId: work, question: 'Resolve Y.' }, { nodeId: source, question: 'Resolve Z.' }, { nodeId: other, question: 'Describe U.' }];

  it('maps its own write into the read-back table on the first visit and traces the write source', () => {
    const engine = atProc();
    const served = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns).parse({ focus_node_id: proc, verdict: 'analyze',
      summary: 'Trace X.', sections: { technical: 'P merges W into T and loads S2 from T.' }, questions,
      column_flow: [readBack, { out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: work, col: 'Y' } }] });
    expect(engine.submitFindings(toHopFinding(served)), 'internal write is declared').toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'Z', to_node: work, to_col: 'Y', hop_node: proc }));
    const visits: string[] = [];
    for (let context = engine.getHopContext(); context?.focus_node; context = engine.getHopContext()) {
      const id = String(context.focus_node.id);
      visits.push(`${id}:${context.analysis_mode}:${engine.getCurrentTasks().flatMap(task => task.kind === 'column_lineage' ? task.sourceRefs ?? [] : []).map(ref => `${ref.node}.${ref.col}`).join(',')}`);
      const ct = context.analysis_mode === 'ct';
      expect(engine.submitFindings({ ...guardRecord(id, ct ? 'passthrough' : 'analyze'), ...(ct ? { column_flow: [] } : {}) })).toHaveProperty('ok', true);
    }
    expect(visits.sort()).toEqual([`${work}:ct:${work}.Y`, `${source}:ct:${source}.Z`].sort());
  });

  it.each([
    ['a write into a table the procedure does not read', { out_col: 'V', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: other, col: 'V' } }, 'column_flow.1.out_col'],
    ['a read-back write that feeds no tracked column', { out_col: 'Y', upstream_columns: [{ node: source, col: 'Z' }], writes_to: { node: work, col: 'Y' } }, 'column_flow.1.upstream_columns'],
  ])('rejects %s', (label, entry, path) => {
    const engine = atProc();
    const flow = label.startsWith('a read-back') ? [{ ...readBack, upstream_columns: [{ node: source, col: 'Z' }] }, entry] : [readBack, entry];
    expect(engine.submitFindings({ ...guardRecord(proc), questions, column_flow: flow })).toMatchObject({ issuePaths: expect.arrayContaining([path]) });
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
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: stored } });
    expect(engine.submitFindings({ ...guardRecord(stored, 'passthrough'), column_flow: [] })).toHaveProperty('ok', true);
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
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: stored }, analysis_mode: analysisMode });
    expect(engine.submitFindings({ ...guardRecord(stored, 'passthrough'), ...flow({ column_flow: [] }) })).toHaveProperty('ok', true);
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
    expect(engine.init({ origin, question: 'Trace total.', analysisMode: 'ct', targetColumns: ['total'], direction: 'upstream', depthIntent: upstreamAll })).toHaveProperty('ok', true);
    engine.getHopContext();
    const [task] = engine.getCurrentTasks();
    expect(engine.taskEndpoints(task)).toEqual({ assigned: [{ node: origin, col: 'Total' }], external: [] });
    expect(buildCurrentTaskBlock([{ ...task, endpoints: engine.taskEndpoints(task) }], ['total'])).toContain(`<assigned_endpoints>${origin}.Total:`);
    expect(buildCurrentTaskBlock([task], ['total'])).not.toContain('<assigned_endpoints>');
  });
});
