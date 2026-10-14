/**
 * Runs column-flow rows from `tests/cases/lineage-cases.yaml`.
 * A row locks ids, columns, edges, and rejection kinds. Prompt sentences stay out of the catalog.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { ColumnFlowEntry } from '../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode, toHopFinding } from '../../../src/ai/tools/toolSchemas';
import { makeGraph } from '../helpers/testUtils';
import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeModel, makeNode } from './helpers/fixtures';

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
  readonly log_contains?: readonly string[];
  readonly log_matches?: string;
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
  readonly runners?: readonly string[];
  readonly prompt?: string;
  readonly command?: string;
  readonly dacpac?: string;
  readonly expect?: CaseExpect & { graph?: boolean; terminal?: string; phase?: string };
}

const scriptedCases = loadCases('scripted') as unknown as LineageCase[];

function column(name: string) {
  return { name, type: 'int', nullable: 'NULL' as const, extra: '' };
}

function run(row: LineageCase, upstream: readonly FlowColumn[]) {
  const nodes = row.nodes.map(node => makeNode({
    id: node.id, schema: 'dbo', name: node.id, type: node.type,
    columns: (node.columns ?? []).map(column),
  }));
  const lines: string[] = [];
  const result = new ColumnTracer([...row.active]).validateColumnFlow(
    row.focus,
    { verdict: 'analyze', summary: 's', sections: [], column_flow: [{ out_col: row.out, upstream_columns: upstream }] } as never,
    new Map<string, LineageNode>(nodes.map(node => [node.id, node])),
    makeModel(nodes, [], ['dbo']),
    null,
    ((_level: string, message: string) => { lines.push(message); }) as never,
    undefined,
    row.direction,
    undefined,
    [],
    [],
    [],
    row.roots ?? [],
  );
  return { result, lines };
}

function check(row: LineageCase, upstream: readonly FlowColumn[]) {
  const { result, lines } = run(row, upstream);
  const wanted = row.expect;
  if (wanted.edges) expect(result.stagedEdges.map(edge => edge.from_col)).toEqual(wanted.edges);
  if (wanted.invalid) expect(result.invalidRoutes).toEqual(wanted.invalid);
  if (wanted.invalid_kind) expect(result.invalidRoutes[0]?.kind).toBe(wanted.invalid_kind);
  if (wanted.reason_contains) expect(result.invalidRoutes[0]?.reason).toContain(wanted.reason_contains);
  for (const text of wanted.log_contains ?? []) expect(lines.join('\n')).toContain(text);
  if (wanted.log_matches) {
    const relevant = lines.filter(line => line.includes('row role only')).join('\n');
    expect(relevant).toMatch(new RegExp(wanted.log_matches));
  }
}

describe('lineage case catalog', () => {
  it('gives Playwright, Electron, and headless their own rows and expected output', () => {
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
  it.each(['direct', 'mixed transforms', 'mixed contributors'] as const)('rejects an indirect-only writer mapping while retaining %s and repairs only its qualified endpoint', roles => {
    const input = '[d].[Input]', writer = '[d].[Writer]', stored = '[d].[Stored]';
    const nodes = [input, writer, stored].map(id => makeNode({ id, schema: 'd', name: id,
      type: id === writer ? 'procedure' : 'table', columns: (id === stored ? ['Total'] : ['Amount', 'Region']).map(column) }));
    const pairs: Array<[string, string]> = [[input, writer], [writer, stored]];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['d']), makeGraph(nodes, pairs), () => {}, {});
    const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'analyze' as const, summary: 'Amount supplies Total; Region selects rows.',
      sections: [{ angle: 'technical' as const, text: 'Only Amount contributes to the stored value.' }] });
    expect(engine.init({ origin: input, question: 'Trace Amount and Region downstream', analysisMode: 'ct', targetColumns: ['Amount', 'Region'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(input), column_flow: ['Amount', 'Region'].map(out_col => ({ out_col, upstream_columns: [] })),
      questions: [{ nodeId: writer, question: 'Determine how each supplied input is used.' }] })).toHaveProperty('ok', true);
    engine.getHopContext();
    const before = engine.toJSON();
    const valueContributors: ColumnFlowEntry['upstream_columns'] = [
      { node: input, col: 'Amount', transforms: roles === 'mixed transforms' ? ['aggregate', 'filter'] : ['aggregate'] },
    ];
    if (roles === 'mixed contributors') valueContributors.push({ node: input, col: 'Region', transforms: ['filter'] });
    const rejected = engine.submitFindings({ ...record(writer), column_flow: [
      { out_col: 'Amount', upstream_columns: valueContributors, writes_to: { node: stored, col: 'Total' } },
      { out_col: 'Region', upstream_columns: [{ node: input, col: 'Region', transforms: ['filter'] }], writes_to: { node: stored, col: 'Total' } },
    ], questions: [{ nodeId: stored, question: 'Follow the stored Total value.' }] });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: expect.arrayContaining(['column_flow.1.upstream_columns']) });
    expect(JSON.stringify(rejected)).toContain('Row eligibility does not establish a written value');
    const after = engine.toJSON();
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: writer, verdict: 'analyze',
      terminated_inputs: [{ node: input, col: 'Region' }],
    })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: stored }, analysis_mode: 'ct' });
    expect(engine.columnAspect?.edges.map(edge => `${edge.from_node}.${edge.from_col}->${edge.to_node}.${edge.to_col}`)).toEqual([
      `${input}.Amount->${stored}.Total`, `${writer}.Amount->${stored}.Total`,
    ]);
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ activeColumns: ['Total'], question: 'Follow the stored Total value.' }));
  });
  it('forwards an explicit downstream passthrough without authoring another value edge', () => {
    const origin = '[d].[Writer]', carrier = '[d].[Stored]', reader = '[d].[Reader]';
    const nodes = [origin, carrier, reader].map(id => makeNode({ id, schema: 'd', name: id,
      type: id === carrier ? 'table' : id === origin ? 'procedure' : 'view', columns: ['Value'].map(column) }));
    const pairs: Array<[string, string]> = [[origin, carrier], [carrier, reader]];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['d']), makeGraph(nodes, pairs), () => {}, {});
    const record = (focus_node_id: string) => ({ focus_node_id, verdict: 'passthrough' as const, summary: 'Forward the approved task.', sections: [{ angle: 'technical' as const, text: 'The value is stored for consumers.' }] });
    expect(engine.init({ origin, question: 'Trace the stored value into consumers', analysisMode: 'ct', targetColumns: ['Value'], direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ ...record(origin), column_flow: [{ out_col: 'Value', upstream_columns: [], writes_to: { node: carrier, col: 'Value' } }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: carrier }, analysis_mode: 'ct' });
    const edges = structuredClone(engine.columnAspect?.edges);
    const incoming = engine.getCurrentTasks()[0];
    if (!('sourceRefs' in incoming)) throw new Error('Expected a qualified column task');
    const sourceRefs = structuredClone(incoming.sourceRefs);
    expect(engine.submitFindings({ ...record(carrier), column_flow: [] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: reader }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()[0]).toMatchObject({ question: 'Trace the stored value into consumers', sourceRefs });
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
  it('requires an explicit qualified endpoint for an arriving filter-only contributor without a write', () => {
    const engine = world();
    const before = engine.toJSON();
    const rejected = engine.submitFindings({ ...finding(focus), column_flow: [{ out_col: 'Mapped', writes_to: null, upstream_columns: [
      { node: origin, col: 'Value', transforms: ['compute'] }, { node: origin, col: 'Other', transforms: ['filter'] },
    ] }], questions: [{ nodeId: next, question: 'Follow the computed Mapped value.' }] });
    expect(rejected).toMatchObject({ code: 'incomplete_task', issuePaths: expect.arrayContaining(['terminated_inputs.0']),
      reason: expect.stringContaining(`${origin}.Other`) });
    const after = engine.toJSON();
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: focus, verdict: 'analyze',
      terminated_inputs: [{ node: origin, col: 'Other' }],
    })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: next }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ activeColumns: ['Mapped'], question: 'Follow the computed Mapped value.' }));
    expect(engine.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: origin, from_col: 'Value', to_node: focus, to_col: 'Mapped' })]);
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
  function world(twoNeighbors = false) {
    const nodes = [root, neighbor, ...(twoNeighbors ? [other] : [])].map(id => makeNode({ id, schema: 'd', name: id, type: 'view',
      columns: [column('Value'), column('Other')], bodyScript: 'SELECT 1 AS Value, 2 AS Other;' }));
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
    expect(engine.submitFindings({ ...finding, ...(missing === 'target'
      ? { column_flow: [terminal('Other')] }
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
  it('retains a valid neighbor question when a correction supplies only the missing neighbor', () => {
    const engine = world(true);
    expect(engine.submitFindings({ ...finding, column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    })).toHaveProperty('code');
    const schema = submitFindingsSchemaForMode(engine.currentHopAnalysisMode, undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const patch = schema.parse({ focus_node_id: root, verdict: 'analyze', questions: [{ nodeId: other, question: 'Explain OtherSource rows.' }] });
    expect(engine.submitFindings(toHopFinding(patch))).toHaveProperty('ok', true);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId).sort()).toEqual([neighbor, other].sort());
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
  it('requests only a missing summary when valid sections and flow are held', () => {
    const engine = world();
    engine.holdRejectedSubmission({ ...finding, sections: { technical: finding.sections[0].text }, summary: '', column_flow: [terminal('Value'), terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source rows.' }],
    }, ['summary']);
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const patch = (summary?: string) => toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', ...(summary ? { summary } : {}) }));
    expect(engine.submitFindings(patch())).toMatchObject({ code: 'missing_field', issuePaths: ['summary'], hint: expect.stringContaining('send only summary plus focus_node_id and verdict') });
    expect(engine.submitFindings(patch('Both requested outputs are constants.'))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'bb' });
  });
  it('names held flow groups in a sole length rejection and accepts only the shortened group', () => {
    const engine = world();
    const overlong = { out_col: 'Value', upstream_columns: [{ node: neighbor, col: 'Value', note: 'x'.repeat(201) }] };
    const rejected = engine.submitFindings({ ...finding, column_flow: [overlong, terminal('Other')],
      questions: [{ nodeId: neighbor, question: 'Explain Source Value.' }],
    });
    expect(rejected).toMatchObject({ code: 'field_length_exceeded', issuePaths: ['column_flow.0.upstream_columns.0.note'] });
    expect(JSON.stringify(rejected)).toContain('out_col: Other');
    expect(JSON.stringify(rejected)).toContain('column_flow: [] clears');
    const schema = submitFindingsSchemaForMode('ct', undefined, false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(engine.submitFindings(toHopFinding(schema.parse({ focus_node_id: root, verdict: 'analyze', column_flow: [
      { ...overlong, upstream_columns: [{ node: neighbor, col: 'Value', note: 'The source value.' }] },
    ] })))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: neighbor }, analysis_mode: 'ct' });
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
    const model = makeModel(nodes, pairs, ['d']);
    model.neighborIndex = Object.fromEntries(nodes.map(node => [node.id, { in: pairs.filter(([, to]) => to === node.id).map(([from]) => from), out: pairs.filter(([from]) => from === node.id).map(([, to]) => to) }]));
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
