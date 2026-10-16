// Owner: src/ai/tools/toolProvider.ts and tools/handlers; raw tool admission and handler functional contracts.
/**
 * The strict boundary that runs first owns these rejections, so the handler and engine never see the
 * shapes below: a start with no origin/supplement/revision, a non-string scope list, an empty
 * highlight-group list in any served present_result stage, and a neighbour id the engine has not
 * validated as an in-scope direct neighbour.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { executePruneCurrent } from '../../../src/ai/tools/handlers/pruneCurrent';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import { StartExplorationInputSchema, PruneCurrentInputSchema, presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import Ajv from 'ajv';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { stubToolServices } from './helpers/toolServices';

const ORIGIN = '[hop].[origin]';
const BRANCH = '[hop].[branch]';
const OTHER = '[hop].[other]';

function ctWorld(options: { deferred?: boolean; scalar?: boolean; caseSensitive?: boolean } = {}) {
  const column = [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }];
  const nodes = [
    makeNode({ id: ORIGIN, schema: 'hop', name: 'origin', type: 'view', columns: column, bodyScript: options.scalar ? `SELECT ${BRANCH}(1) AS Value;` : `SELECT Value FROM ${BRANCH};` }),
    makeNode({ id: BRANCH, schema: 'hop', name: 'branch', type: options.scalar ? 'function' : 'view', columns: options.scalar ? [] : column, bodyScript: options.scalar ? `CREATE FUNCTION ${BRANCH}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END` : 'SELECT 1 AS Value;' }),
    makeNode({ id: OTHER, schema: 'hop', name: 'other', type: 'table', columns: column }),
  ];
  const pairs: Array<[string, string]> = [[BRANCH, ORIGIN], ...(options.deferred ? [[OTHER, BRANCH] as [string, string]] : [])];
  const model = makeIndexedModel(nodes, pairs);
  model.identifierCaseSensitive = options.caseSensitive ?? false;
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(engine.init({ origin: ORIGIN, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
    depthIntent: { upstream: { levels: options.deferred ? 1 : 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const noop = () => {};
  const registry = buildAiToolRegistry(() => session, { info: noop, debug: noop, warn: noop, error: noop } as never, () => undefined);
  return { session, model, graph, registry, engine };
}

/** An inherited investigation reaches a reader that does not use the table's Value. */
function tableArrivalWorld(mode: 'bb' | 'ct') {
  const nodes = [
    makeNode({ id: ORIGIN, schema: 'hop', name: 'origin', type: 'table', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: BRANCH, schema: 'hop', name: 'branch', type: 'view', bodyScript: `SELECT Other FROM ${ORIGIN};` }),
    makeNode({ id: OTHER, schema: 'hop', name: 'other', type: 'view', bodyScript: `SELECT Other FROM ${BRANCH};` }),
  ];
  const pairs: Array<[string, string]> = [[ORIGIN, BRANCH], [BRANCH, OTHER]];
  const model = makeIndexedModel(nodes, pairs);
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(engine.init({ origin: ORIGIN, question: 'Follow the Value investigation.', analysisMode: mode,
    ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}), direction: 'downstream',
    depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
  const hop = engine.getHopContext();
  expect(hop).toMatchObject({ focus_node: { id: BRANCH } });
  expect(engine.toJSON().visited).toContain(ORIGIN);
  expect(engine.columnAspect?.edges ?? []).toEqual([]);
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const { services } = stubToolServices({ session, model, graph });
  return { engine, session, services };
}

describe('large findings repairs', () => {
  it.each([
    { malformed: { questions: 42 }, resend: 'summary, questions', path: 'questions' },
    { malformed: { sections: { technical: 42 } }, resend: 'sections.technical, summary', path: 'sections.technical' },
    { malformed: { column_flow: 42 }, resend: 'summary, column_flow', path: 'column_flow' },
    { malformed: { summary: 42 }, resend: 'summary', path: 'summary' },
  ])('preserves the held draft and names the malformed repair field $path', ({ malformed, resend, path }) => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const sections = { technical: 'Branch supplies Value unchanged.' };
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }];
    const questions = [{ nodeId: BRANCH, question: 'Establish the origin of Value.' }];
    const submit = (input: object) => JSON.parse(executeSubmitFindings({ focus_node_id: ' HOP . ORIGIN ', ...input }, services));
    expect(submit({ sections, column_flow, questions })).toMatchObject({ code: 'invalid_input', issuePaths: ['summary'] });
    const before = engine.toJSON();
    const rejected = submit({ summary: 'An unvalidated replacement.', ...malformed });
    expect(rejected).toHaveProperty('code', 'invalid_input');
    expect(rejected.issuePaths).toContain(path);
    expect(rejected.hint).toContain(`Held: sections.technical, questions, column_flow. Resend: ${resend}.`);
    expect(engine.toJSON()).toEqual(before);
    expect(submit({ summary: 'Branch supplies Value.' })).toMatchObject({ ok: true, next_focus: BRANCH });
    expect(engine.getDetailSlots().find(slot => slot.nodeId === ORIGIN)?.sections).toEqual([{ angle: 'technical', text: sections.technical }]);
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ question: questions[0].question }));
  });

  it('holds long valid prose through repeated column errors and accepts only the corrected list', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const text = 'The supplied SQL establishes this business and technical finding. '.repeat(3000);
    const valid = { focus_node_id: ORIGIN, summary: 'Branch supplies Value.', sections: { technical: text },
      questions: [{ nodeId: BRANCH, question: 'Establish the origin of Value.' }] };
    for (const [index, col] of ['Missing', 'StillMissing'].entries()) {
      const rejected = JSON.parse(executeSubmitFindings({ ...(index === 0 ? valid : { focus_node_id: ORIGIN }),
        column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col }] }] }, services));
      expect(rejected).toMatchObject({ code: 'contributor_col_not_on_source',
        issuePaths: ['column_flow.0.upstream_columns.0.col'] });
      expect(rejected.hint).toContain('Held: sections.technical, summary, questions.');
      expect(rejected.hint).toContain('Resend: column_flow.');
      expect(rejected.hint).not.toContain('resend the full call');
      expect(JSON.stringify(rejected)).not.toContain(text);
      expect(engine.getDetailSlots()).toEqual([]);
    }
    const accepted = JSON.parse(executeSubmitFindings({ focus_node_id: ' \"hop\" . \"origin\" ',
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 'HOP.BRANCH', col: 'Value' }] }] }, services));
    expect(accepted).toMatchObject({ ok: true, accepted_focus: ORIGIN, next_focus: BRANCH });
    expect(engine.getDetailSlots().find(slot => slot.nodeId === ORIGIN)?.sections).toEqual([{ angle: 'technical', text }]);
  });
});

describe('lineage_prune_current boundary', () => {
  it.each(['[hop].[bran\u200bch]', 'hop..branch', 'other.branch'])('rejects different or malformed focus identity %s before changing state', focus_node_id => {
    const { engine, services } = tableArrivalWorld('ct');
    const before = engine.toJSON();
    expect(JSON.parse(executePruneCurrent({ focus_node_id, reason: 'Off path.' }, services))).toHaveProperty('code', 'invalid_input');
    expect(engine.toJSON()).toEqual(before);
    expect(JSON.parse(executePruneCurrent({ focus_node_id: BRANCH, reason: 'Off path.' }, services))).toHaveProperty('ok', true);
  });

  it.each(['bb', 'ct'] as const)('accepts the exact current %s focus and completes through the shared acknowledgement', mode => {
    const { engine, session, services } = tableArrivalWorld(mode);
    const input = { focus_node_id: BRANCH, reason: 'The supplied SQL uses only Other and does not answer the inherited purpose.' };
    const before = structuredClone(input);
    expect(engine.canPruneCurrent).toBe(true);
    const result = JSON.parse(executePruneCurrent(input, services));
    expect(result).toMatchObject({ ok: true, done: true, pruned: [BRANCH], cut_ids: [OTHER] });
    expect(engine.status).toBe('complete');
    expect(engine.getResult().fullNodes.map(node => node.id)).toEqual([ORIGIN]);
    expect(session.resultGraph?.nodeIds).toEqual([ORIGIN]);
    expect(input).toEqual(before);
  });

  it.each([null, {}, { focus_node_id: BRANCH, reason: '' }, { focus_node_id: BRANCH, reason: 1 },
    { focus_node_id: BRANCH, reason: 'Off path.', column_flow: [] }, { focus_node_id: OTHER, reason: 'Wrong focus.' }])(
    'rejects malformed or stale commands without mutation: %j', input => {
      const { engine, services } = tableArrivalWorld('ct');
      const before = engine.toJSON();
      expect(JSON.parse(executePruneCurrent(input, services))).toHaveProperty('code');
      expect(engine.toJSON()).toEqual(before);
    });

  it('keeps provider and runtime schemas strict for the reason-only command', () => {
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(PruneCurrentInputSchema));
    for (const input of [{ focus_node_id: BRANCH, reason: 'Irrelevant to this investigation.' }, {},
      { focus_node_id: BRANCH }, { focus_node_id: BRANCH, reason: 'Off path.', verdict: 'end_branch' }]) {
      expect(wire(input)).toBe(PruneCurrentInputSchema.safeParse(input).success);
    }
  });

  it('refuses self-pruning on a direct analyzed arrival and leaves its evidence intact', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value comes from branch.',
      sections: { technical: 'The source endpoint is assigned.' }, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: BRANCH, question: 'Resolve the source endpoint.' }] }, services))).toHaveProperty('next_focus', BRANCH);
    expect(engine.canPruneCurrent).toBe(false);
    const before = engine.toJSON();
    expect(JSON.parse(executePruneCurrent({ focus_node_id: BRANCH, reason: 'No continuation.' }, services))).toHaveProperty('code');
    expect(engine.toJSON()).toEqual(before);
  });
});

describe('lineage_start_exploration boundary', () => {
  it('rejects string depth without decoding it into a number', () => {
    const payload = { origin: ORIGIN, analysisMode: 'bb', classification: 'technical',
      depth: { upstream: { levels: '2', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } };
    expect(StartExplorationInputSchema.safeParse(payload).success).toBe(false);
  });

  it.each([{}, { question: 'What feeds it?' }, { excludeTypes: ['table'] }])('rejects a start with no origin, supplement or revision at the schema: %j', input => {
    const parsed = StartExplorationInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some(issue => issue.code === 'custom' && (issue as { params?: { startIssue?: string } }).params?.startIssue === 'start_shape_required')).toBe(true);
  });

  it('answers that start with the schema rejection before the handler reads origin', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const result = JSON.parse(await executeStartExploration({ question: 'What feeds it?' }, services));
    expect(result).toMatchObject({ code: 'missing_field', detail: { issues: [expect.objectContaining({ path: '(root)', code: 'missing_field' })] } });
  });

  it('answers an origin plus supplement with the two valid call shapes and no keep-every-field tail', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const text = await executeStartExploration({ origin: ORIGIN, analysisMode: 'bb', classification: 'technical', depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } }, supplement: { nodeIds: [OTHER] } } as never, services);
    expect(text).toMatch(/supplement alone/);
    expect(text).toMatch(/origin without supplement/);
    expect(text).not.toContain('keep every other field unchanged');
  });

  it('opens the approval gate for a fresh proposal whatever phase the session holds, never a hop', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    expect(session.phase.kind).toBe('exploring');
    const { services } = stubToolServices({ session, model, graph, turnEpoch: () => session.turnEpoch });
    const result = JSON.parse(await executeStartExploration({
      origin: ORIGIN, analysisMode: 'bb', classification: 'technical', question: 'What feeds it?',
      depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    }, services));
    expect(result).toMatchObject({ code: 'action_required', detail: { gate: 'confirm_sm_start', proposalRevision: 1 } });
    expect(result).not.toHaveProperty('focus_node');
    expect(result.hint).toBe('Tool paused — awaiting user confirmation before the first hop.');
    expect(session.stateMachine).toBeNull();
  });

  it.each(['excludeTypes', 'excludeSchemas', 'excludeNodeIds', 'passNodeIds', 'scopeNotes'])('rejects a non-string-array %s at the schema', field => {
    expect(StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: [1] }).success).toBe(false);
    expect(StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: 'one' }).success).toBe(false);
  });
});

describe('lineage_present_result boundary', () => {
  const base = { name: 'View', summary: 'Summary.', sections: [{ label: 'One', node_ids: [ORIGIN], text: 'Body.' }] };
  it.each([
    ['completed', false], ['completed', true], ['synthesis', false], ['synthesis', true],
  ] as const)('rejects missing or empty highlight_groups in the %s schema (retainable=%s)', (stage, retainable) => {
    const schema = presentResultSchemaForPhase(stage, null, retainable);
    expect(schema.safeParse({ ...base, is_update: stage === 'completed' ? true : undefined }).success).toBe(false);
    expect(schema.safeParse({ ...base, highlight_groups: [] }).success).toBe(false);
  });

  it('rejects empty highlight_groups in the preview schema and in a repair patch', () => {
    const preview = presentResultSchemaForPhase('visual_preview', null, false, 1);
    expect(preview.safeParse({ name: 'View', sections: [{ label: 'One', node_ids: [ORIGIN], start: 'B1' }], highlight_groups: [] }).success).toBe(false);
    const repair = presentResultSchemaForPhase('completed', ['highlight_groups']);
    expect(repair.safeParse({ highlight_groups: [] }).success).toBe(false);
  });
});

describe('lineage_get_neighbor_columns boundary', () => {
  it.each(['[hop].[missing]', 'hop.missing', OTHER])('refuses %s at the engine before any column lookup', async id => {
    const { registry } = ctWorld();
    const result = JSON.parse(await registry.invoke('lineage_get_neighbor_columns', { ids: [id] }));
    expect(result).toMatchObject({ code: 'out_of_scope_or_not_neighbor' });
    expect(result).toMatchObject({ issuePaths: ['ids.0'], detail: [{ path: 'ids.0', allowed_values: [BRANCH] }] });
    expect(result).not.toHaveProperty('results');
  });

  it('binds a case-equivalent neighbor without changing the supplied request', async () => {
    const { registry } = ctWorld();
    const input = { ids: ['HOP.BRANCH'] };
    expect(JSON.parse(await registry.invoke('lineage_get_neighbor_columns', input))).toMatchObject({ total: 1, results: [{ id: BRANCH }] });
    expect(input).toEqual({ ids: ['HOP.BRANCH'] });
    const result = JSON.parse(await registry.invoke('lineage_get_neighbor_columns', { ids: [BRANCH] }));
    expect(result).toMatchObject({ total: 1, results: [{ id: BRANCH, columns: [expect.objectContaining({})] }] });
    expect(JSON.stringify(result)).not.toContain('not_found');
  });
});


describe('lineage_submit_findings boundary', () => {
  it.each([false, true])('preserves explicit route dispositions when done=%s', done => {
    const { session, model, graph } = ctWorld({ deferred: true });
    const { services } = stubToolServices({ session, model, graph });
    const first = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN,
      summary: 'Supplies Value.', sections: { technical: 'Value comes from branch.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish the source of Value.' }],
    }, services));
    const result = done ? JSON.parse(executeSubmitFindings({ focus_node_id: BRANCH,
      summary: 'Value is constant.', sections: { technical: 'The value is defined locally.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [{ nodeId: OTHER, question: 'Inspect this source if the depth is expanded.' }],
    }, services)) : first;
    expect(result).toMatchObject({ ok: true, done, route_outcomes: expect.arrayContaining([
      done ? { nodeId: OTHER, accepted: false, deferred: true, reason: 'depth' } : { nodeId: BRANCH, accepted: true },
    ]) });
  });

  it.each([
    { caseSensitive: false, node: 'HOP.BRANCH', extra: false, accepted: true },
    { caseSensitive: false, node: BRANCH, extra: false, accepted: true },
    { caseSensitive: true, node: BRANCH, extra: false, accepted: true },
    { caseSensitive: true, node: 'HOP.BRANCH', extra: false, accepted: false },
    { caseSensitive: false, node: ORIGIN, extra: false, accepted: false },
    { caseSensitive: false, node: 'HOP.BRANCH', extra: true, accepted: false },
  ])('resolves only permitted qualified terminal input identity: %j', options => {
    const { session, model, graph, engine } = ctWorld({ caseSensitive: options.caseSensitive });
    const { services } = stubToolServices({ session, model, graph });
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN,
      summary: 'Branch supplies Value.', sections: { technical: 'Inspect its source.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }],
    }, services))).toHaveProperty('ok', true);
    const edges = structuredClone(engine.columnAspect?.edges);
    const input = { focus_node_id: BRANCH, summary: 'No further input.',
      sections: { technical: 'The input ends here.' }, column_flow: [],
      terminated_inputs: [{ node: options.node, col: 'Value', ...(options.extra ? { transforms: [] } : {}) }],
    };
    const before = structuredClone(input);
    const result = JSON.parse(executeSubmitFindings(input, services));
    expect(result.ok === true).toBe(options.accepted);
    if (options.accepted) expect(result.done).toBe(true);
    else expect(result).toHaveProperty('code', 'invalid_input');
    expect(engine.columnAspect?.edges).toEqual(edges);
    expect(input).toEqual(before);
  });

  it.each([{ caseSensitive: false, node: '[HOP].[BRANCH]', extra: false, accepted: true }, { caseSensitive: true, node: '[HOP].[BRANCH]', extra: false, accepted: false }, { caseSensitive: false, node: BRANCH, extra: false, accepted: true }, { caseSensitive: true, node: BRANCH, extra: false, accepted: true }, { caseSensitive: false, node: BRANCH, extra: true, accepted: false }])(
    'binds only equivalent caller-neighbor identity before strict validation: %j', options => {
      const { session, model, graph } = ctWorld({ scalar: true, caseSensitive: options.caseSensitive });
      const { services } = stubToolServices({ session, model, graph });
      const input = { focus_node_id: ORIGIN, summary: 'The function computes Value.',
        sections: { technical: 'Inspect its supplied caller argument.' }, column_flow: [],
        questions: [{ nodeId: options.node, question: 'Establish Value from the caller argument.', caller_context: { node: ORIGIN, col: 'Value' } }],
        ...(options.extra ? { undeclared: true } : {}),
      };
      const before = structuredClone(input);
      const result = JSON.parse(executeSubmitFindings(input, services));
      expect(result.ok === true).toBe(options.accepted);
      if (options.accepted) expect(result.next_focus).toBe(BRANCH);
      else expect(result).toHaveProperty('code', 'invalid_input');
      expect(input).toEqual(before);
    });

  it('keeps a route to an already queued table accepted', () => {
    const V = '[bb].[v]'; const W = '[bb].[w]'; const T = '[bb].[t]';
    const nodes = [
      makeNode({ id: V, schema: 'bb', name: 'v', type: 'view', bodyScript: 'SELECT 1 AS One;' }),
      makeNode({ id: W, schema: 'bb', name: 'w', type: 'view', bodyScript: 'SELECT 1 AS One;' }),
      makeNode({ id: T, schema: 'bb', name: 't', type: 'table' }),
    ];
    const pairs: Array<[string, string]> = [[T, V], [W, V], [T, W]];
    const model = makeModel(nodes, pairs, ['bb']);
    const graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.classification = 'technical';
    expect(engine.init({ origin: V, question: 'What feeds v?', analysisMode: 'bb', direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const { services } = stubToolServices({ session, model, graph });
    const first = JSON.parse(executeSubmitFindings({ focus_node_id: V, summary: 'Reads t and w.',
      sections: { technical: 'Selects from both sources.' },
      questions: [{ nodeId: T, question: 'What does t hold?' }, { nodeId: W, question: 'What does w add?' }] }, services));
    expect(first).toMatchObject({ ok: true, next_focus: W });
    const second = JSON.parse(executeSubmitFindings({ focus_node_id: W, summary: 'Reads t.',
      sections: { technical: 'Selects from t.' }, questions: [{ nodeId: T, question: 'Which rows does w read?' }] }, services));
    expect(second).toMatchObject({ ok: true, done: true, route_outcomes: [{ nodeId: T, accepted: true }] });
    expect(engine.toJSON().visited).toContain(T);
    expect(session.resultGraph?.nodeIds).toEqual(expect.arrayContaining([V, W, T]));
  });
});
