/**
 * A follow-up supplement is read only from the request: an object request is an object visit, a
 * column continuation needs the request's own qualified task, and a pruned connector the request
 * does not name refuses the target instead of being restored.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';

const ORIGIN = '[s].[origin]', BRANCH = '[s].[branch]', OTHER = '[s].[other]';
const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
const sections = [{ angle: 'technical' as const, text: 'The supplied SQL establishes this.' }];

function engineFor(nodes: ReturnType<typeof makeNode>[], pairs: Array<[string, string]>, init: Parameters<NavigationEngine['init']>[0]) {
  const model = makeModel(nodes, pairs, ['s']);
  const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
  expect(engine.init(init)).toHaveProperty('ok', true);
  engine.getHopContext();
  return engine;
}

/** A completed CT run in which BRANCH.Value is a committed endpoint of ORIGIN.Value. */
function completedColumnTrace() {
  const nodes = [
    makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'view', columns: [col('Value')], bodyScript: `SELECT Value FROM ${BRANCH};` }),
    makeNode({ id: BRANCH, schema: 's', name: 'branch', type: 'view', columns: [col('Value')], bodyScript: 'SELECT 1 AS Value;' }),
  ];
  const engine = engineFor(nodes, [[BRANCH, ORIGIN]], { origin: ORIGIN, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
  expect(engine.submitFindings({ focus_node_id: ORIGIN, summary: 'Value comes from branch.', sections,
    column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
    questions: [{ nodeId: BRANCH, question: 'Resolve the source endpoint.' }] })).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: BRANCH }, analysis_mode: 'ct' });
  expect(engine.submitFindings({ focus_node_id: BRANCH, summary: 'Value is a literal.', sections,
    column_flow: [{ out_col: 'Value', upstream_columns: [] }] })).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toHaveProperty('done', true);
  expect(engine.status).toBe('complete');
  return engine;
}

/** Adds a host-selectable lead on BRANCH whose column task carries the given qualified endpoints. */
function leadOnBranch(engine: NavigationEngine, sourceRefs?: Array<{ node: string; col: string }>) {
  const ledger = engine['taskLedger'] as TaskLedger;
  const task = ledger.ensureTask({ source: 'model', question: 'Continue Value at branch.', nodeId: BRANCH, status: 'deferred', createdHop: 1,
    kind: 'column_lineage', activeColumns: ['Value'], ...(sourceRefs ? { sourceRefs } : {}) });
  return ledger.ensureLead({ taskId: task.id, nodeId: BRANCH, fromNodeId: ORIGIN, reason: 'depth_boundary', valueToUser: 'Continue at branch.', createdHop: 1 }).id;
}

/** A completed scalar-function run whose function task carries the caller's explicit context. */
function completedCallerContextTrace() {
  const fn = BRANCH;
  const nodes = [
    makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'view', columns: [col('Value')], bodyScript: `SELECT ${fn}(1) AS Value;` }),
    makeNode({ id: fn, schema: 's', name: 'branch', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END` }),
  ];
  const engine = engineFor(nodes, [[fn, ORIGIN]], { origin: ORIGIN, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
  expect(engine.submitFindings({ focus_node_id: ORIGIN, summary: 'The function computes Value.', sections, column_flow: [],
    questions: [{ nodeId: fn, question: 'Establish Value from the caller argument.', caller_context: { node: ORIGIN, col: 'Value' } }] })).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn } });
  const result = engine.submitFindings({ focus_node_id: fn, summary: 'Value doubles the argument.', sections,
    column_flow: [{ out_col: 'Value', returns_to: { node: ORIGIN, col: 'Value' }, upstream_columns: [] }] });
  expect(result).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toHaveProperty('done', true);
  return engine;
}

/** A completed downstream BB run whose automatically reached reader BRANCH was pruned with its only reader OTHER. */
function completedPrunedPath() {
  const nodes = [
    makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'table', columns: [col('Value')] }),
    makeNode({ id: BRANCH, schema: 's', name: 'branch', type: 'view', bodyScript: `SELECT Other FROM ${ORIGIN};` }),
    makeNode({ id: OTHER, schema: 's', name: 'other', type: 'view', bodyScript: `SELECT Other FROM ${BRANCH};` }),
  ];
  const engine = engineFor(nodes, [[ORIGIN, BRANCH], [BRANCH, OTHER]], { origin: ORIGIN, question: 'Follow the Value investigation.', analysisMode: 'bb', direction: 'downstream',
    depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } });
  expect(engine.peekHopContext()).toMatchObject({ focus_node: { id: BRANCH } });
  expect(engine.toJSON().visited).toContain(ORIGIN);
  expect(engine.pruneCurrent(BRANCH, 'The supplied SQL does not use Value.')).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toHaveProperty('done', true);
  expect(engine.status).toBe('complete');
  expect(engine.toJSON().removedSet).toEqual(expect.arrayContaining([BRANCH, OTHER]));
  return engine;
}

describe('supplement request contract', () => {
  it('does not count a writer behind an excluded storage request even when a read-back cycle connects it', () => {
    const nodes = [
      makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'view', bodyScript: `CREATE VIEW ${ORIGIN} AS SELECT Value FROM ${BRANCH};` }),
      makeNode({ id: BRANCH, schema: 's', name: 'branch', type: 'table', columns: [col('Value')] }),
      makeNode({ id: OTHER, schema: 's', name: 'other', type: 'procedure', bodyScript: `INSERT ${BRANCH}(Value) SELECT Value FROM ${ORIGIN};` }),
    ];
    const engine = engineFor(nodes, [[BRANCH, ORIGIN], [OTHER, BRANCH], [ORIGIN, OTHER]], {
      origin: ORIGIN, question: 'Explain origin.', analysisMode: 'bb', direction: 'upstream', excludeNodeIds: [BRANCH],
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    });
    expect(engine.submitFindings({ focus_node_id: ORIGIN, summary: 'The source is excluded.', sections })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    const before = engine.toJSON();
    expect(engine.measureSupplementScope([BRANCH])).toEqual({ ...engine.measureAdmissionScope(), columns: 0 });
    expect(engine.toJSON()).toEqual(before);
    expect(engine.supplementAgenda([BRANCH])).toMatchObject({ ok: true, agendaed: 0, skipped: 1,
      skippedDetails: [{ nodeId: BRANCH, reason: 'excluded' }] });
    expect(engine.toJSON()).toEqual(before);
  });

  it('visits an object named without a task as BB, without carry from its committed endpoints', () => {
    const engine = completedColumnTrace();
    expect(engine.supplementAgenda([BRANCH])).toMatchObject({ ok: true, agendaed: 1, skipped: 0 });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: BRANCH }, analysis_mode: 'bb' });
    expect(engine.getCurrentTasks().map(task => task.kind)).not.toContain('column_lineage');
  });

  it('continues a selected lead as CT only from its own qualified task', () => {
    const engine = completedColumnTrace();
    expect(engine.supplementAgenda([], [leadOnBranch(engine, [{ node: BRANCH, col: 'Value' }])])).toMatchObject({ ok: true, agendaed: 1 });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: BRANCH }, analysis_mode: 'ct' });
  });

  it('rejects a selected column task without qualified endpoints and changes nothing', () => {
    const engine = completedColumnTrace();
    const lead = leadOnBranch(engine);
    const before = engine.toJSON();
    const result = engine.supplementAgenda([], [lead]);
    expect(result).toMatchObject({ code: 'route_validation_failed', reason: expect.stringContaining(`${BRANCH} (no qualified task)`) });
    expect(engine.toJSON()).toEqual(before);
    expect(engine.status).toBe('complete');
  });

  it('uses only the request for a function named by object, not an earlier caller-context task', () => {
    const engine = completedCallerContextTrace();
    const earlier = engine.toJSON().engineInternals.investigationTasks.filter(task => task.nodeId === BRANCH && task.callerContext);
    expect(earlier).toHaveLength(1);
    expect(engine.supplementAgenda([BRANCH])).toMatchObject({ ok: true, agendaed: 1 });
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ focus_node: { id: BRANCH }, analysis_mode: 'bb' });
    expect(hop).not.toHaveProperty('caller_requested_outputs');
    const current = engine.getCurrentTasks();
    expect(current.map(task => task.id)).not.toContain(earlier[0].id);
    expect(current.some(task => task.callerContext || task.question.includes(earlier[0].question))).toBe(false);
  });

  it('refuses a target joined only through a pruned connector and names the connector', () => {
    const engine = completedPrunedPath();
    const before = engine.toJSON();
    const result = engine.supplementAgenda([OTHER]);
    expect(result).toMatchObject({ ok: true, agendaed: 0, skipped: 1,
      skippedDetails: [{ nodeId: OTHER, reason: 'not_connected_to_trace', hint: expect.stringContaining(BRANCH) }] });
    expect(engine.toJSON()).toEqual(before);
    expect(engine.status).toBe('complete');
  });

  it.each(['bb', 'ct'] as const)('brings a stored %s lead\'s next object along, so its question reaches analysed SQL', analysisMode => {
    const VIEW = '[s].[view]', LOADER = '[s].[loader]';
    const nodes = [
      makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'view', columns: [col('Value')], bodyScript: `SELECT Value FROM ${VIEW};` }),
      makeNode({ id: VIEW, schema: 's', name: 'view', type: 'view', columns: [col('Value')], bodyScript: `SELECT Value FROM ${BRANCH};` }),
      makeNode({ id: BRANCH, schema: 's', name: 'branch', type: 'table', columns: [col('Value')] }),
      makeNode({ id: LOADER, schema: 's', name: 'loader', type: 'procedure', bodyScript: `INSERT ${BRANCH}(Value) SELECT 1;` }),
    ];
    const engine = engineFor(nodes, [[VIEW, ORIGIN], [BRANCH, VIEW], [LOADER, BRANCH]], { origin: ORIGIN, question: 'Explain the load.', analysisMode, direction: 'upstream',
      ...(analysisMode === 'ct' ? { targetColumns: ['Value'] } : {}),
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    const flow = (node?: string) => analysisMode === 'ct' ? { column_flow: node ? [{ out_col: 'Value', upstream_columns: [{ node, col: 'Value' }] }] : [] } : {};
    const question = 'How is branch loaded?';
    expect(engine.submitFindings({ focus_node_id: ORIGIN, summary: 'Reads view.', sections, ...flow(VIEW),
      questions: [{ nodeId: VIEW, question: 'Resolve Value.' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: VIEW } });
    expect(engine.submitFindings({ focus_node_id: VIEW, summary: 'Reads branch.', sections, ...flow(),
      questions: [{ nodeId: BRANCH, question }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    const lead = engine.pendingLeads.find(item => item.nodeId === BRANCH)!;
    expect(engine.measureSupplementScope([BRANCH]).nodes - engine.measureAdmissionScope().nodes).toBe(2);
    expect(engine.supplementAgenda([], [lead.id])).toMatchObject({ ok: true, agendaed: 1, skipped: 0 });
    // A lead without a qualified column task reaches SQL as BB after automatic table forwarding.
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: LOADER }, analysis_mode: 'bb' });
    expect(engine.toJSON().visited).toContain(BRANCH);
    expect(engine.toJSON().nodeStates).toContainEqual(expect.objectContaining({ nodeId: BRANCH, action: 'passthrough', source: 'engine' }));
    expect(engine.getCurrentTasks().map(task => task.question)).toContain(question);
    expect(engine.submitFindings({ focus_node_id: LOADER, summary: 'Inserts a literal.', sections })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.pendingLeads.filter(item => item.status === 'pending')).toEqual([]);
  });

  it('keeps a pruned next object pruned when a follow-up names only its table', () => {
    const LOADER = '[s].[loader]';
    const nodes = [
      makeNode({ id: ORIGIN, schema: 's', name: 'origin', type: 'view', columns: [col('Value')], bodyScript: `SELECT Value FROM ${BRANCH};` }),
      makeNode({ id: BRANCH, schema: 's', name: 'branch', type: 'table', columns: [col('Value')] }),
      makeNode({ id: LOADER, schema: 's', name: 'loader', type: 'procedure', bodyScript: `INSERT ${BRANCH}(Value) SELECT 1;` }),
    ];
    const engine = engineFor(nodes, [[BRANCH, ORIGIN], [LOADER, BRANCH]], { origin: ORIGIN, question: 'Explain the load.', analysisMode: 'bb', direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    expect(engine.submitFindings({ focus_node_id: ORIGIN, summary: 'Reads branch.', sections,
      questions: [{ nodeId: BRANCH, question: 'How is branch kept?' }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: LOADER } });
    expect(engine.pruneCurrent(LOADER, 'The load is outside this question.')).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toHaveProperty('done', true);
    expect(engine.supplementAgenda([BRANCH])).toMatchObject({ ok: true, agendaed: 1, skipped: 0 });
    expect(engine.toJSON().removedSet).toContain(LOADER);
    expect(engine.toJSON().agenda.map(entry => entry.nodeId)).toEqual([BRANCH]);
  });

  it('admits the target when the request names the pruned connector explicitly', () => {
    const engine = completedPrunedPath();
    expect(engine.supplementAgenda([OTHER, BRANCH])).toMatchObject({ ok: true, agendaed: 2, skipped: 0 });
    expect(engine.toJSON().removedSet).not.toEqual(expect.arrayContaining([BRANCH]));
    expect(engine.toJSON().removedSet).not.toEqual(expect.arrayContaining([OTHER]));
  });
});
