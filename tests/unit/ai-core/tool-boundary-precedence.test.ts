// Owner: src/ai/tools/toolProvider.ts and tools/handlers; raw tool admission and handler functional contracts.
/** The strict boundary that runs first owns these rejections, so the handler and engine never see the shapes below: a start with no origin/supplement/revision, a non-string scope list, an empty highlight-group list in any served present_result stage, and a neighbour id the engine has not validated as an in-scope direct neighbour. */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { executePruneCurrent } from '../../../src/ai/tools/handlers/pruneCurrent';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import { StartExplorationInputSchema, StartExplorationCompletedProviderInputSchema, StartExplorationProviderInputSchema, PruneCurrentInputSchema, presentResultSchemaForPhase, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import Ajv from 'ajv';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { stubToolServices } from './helpers/toolServices';

const ORIGIN = '[hop].[origin]';
const BRANCH = '[hop].[branch]';
const OTHER = '[hop].[other]';

it('keeps tool payloads in results and hop evidence while host logs contain metadata only', async () => {
  const marker = 'ToolPayloadLeakSentinel';
  const node = makeNode({ id: '[hop].[logging]', schema: 'hop', name: 'logging', type: 'view', bodyScript: `SELECT '${marker}' AS Value;` });
  const session = new AiSession();
  session.model = makeModel([node], [], ['hop']);
  session.graph = makeGraph([node], []);
  session.columnStore.setDdl(node.id, node.bodyScript!);
  session.beginTurn();
  const channel = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registry = buildAiToolRegistry(() => session, channel as never, () => undefined);
  await registry.invoke('lineage_search_objects', { query: marker });
  const accepted = await registry.invoke('lineage_get_object_detail', { id: node.id });
  const rejected = await registry.invoke('lineage_get_object_detail', { id: `[missing].[${marker}]` });
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const gate = await registry.invoke('lineage_start_exploration', { origin: node.id, question: marker, mission_brief: marker,
    analysisMode: 'bb', classification: 'technical',
    depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
  expect(String(accepted)).toContain(marker);
  expect(String(rejected)).toContain(marker);
  expect(String(gate)).toContain(marker);
  expect(JSON.parse(String(gate)).code).toBe('action_required');
  expect(JSON.stringify(session.hopLog)).toContain(marker);
  const logs = [channel.debug, channel.info, channel.warn, channel.error].flatMap(logger => logger.mock.calls.flat()).join(' ');
  expect(logs).not.toContain(marker);
  expect(logs).toContain('resultChars=');
  expect(logs).toContain('code=not_found');
});

function ctWorld(options: { deferred?: boolean; scalar?: boolean; caseSensitive?: boolean; mode?: 'bb' | 'ct'; selfLoop?: boolean; sibling?: boolean; other?: boolean } = {}) {
  const column = [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }, ...(options.other ? [{ name: 'Other', type: 'int', nullable: 'NULL', extra: '' }] : [])];
  const nodes = [
    makeNode({ id: ORIGIN, schema: 'hop', name: 'origin', type: options.selfLoop ? 'procedure' : 'view', columns: column, bodyScript: options.scalar ? `SELECT ${BRANCH}(1) AS Value;` : `SELECT Value FROM ${BRANCH};` }),
    makeNode({ id: BRANCH, schema: 'hop', name: 'branch', type: options.scalar ? 'function' : options.selfLoop ? 'table' : 'view', columns: options.scalar ? [] : column, bodyScript: options.scalar ? `CREATE FUNCTION ${BRANCH}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END` : 'SELECT 1 AS Value;' }),
    makeNode({ id: OTHER, schema: 'hop', name: 'other', type: 'table', columns: column }),
  ];
  const pairs: Array<[string, string]> = [[BRANCH, ORIGIN], ...(options.selfLoop ? [[ORIGIN, BRANCH] as [string, string]] : []), ...(options.deferred ? [[OTHER, BRANCH] as [string, string]] : []), ...(options.sibling ? [[OTHER, ORIGIN] as [string, string]] : [])];
  const model = makeIndexedModel(nodes, pairs);
  model.identifierCaseSensitive = options.caseSensitive ?? false;
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(engine.init({ origin: ORIGIN, question: 'Trace Value.', analysisMode: options.mode ?? 'ct',
    ...(options.mode === 'bb' ? {} : { targetColumns: options.other ? ['Value', 'Other'] : ['Value'] }), direction: 'upstream',
    depthIntent: { upstream: { levels: options.deferred ? 1 : 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const noop = () => {};
  const registry = buildAiToolRegistry(() => session, { info: noop, debug: noop, warn: noop, error: noop } as never, () => undefined);
  return { session, model, graph, registry, engine };
}

it('states whole action-list replacement and preserves explicit withdrawal without merging decisions', () => {
  const { engine, session, model, graph } = ctWorld({ mode: 'bb', sibling: true });
  const { services } = stubToolServices({ session, model, graph });
  const first = { nodeId: BRANCH, question: 'Explain the source.' };
  const second = { nodeId: OTHER, question: 'Explain the other source.' };
  const submit = (input: object) => JSON.parse(executeSubmitFindings(input, services));
  const initial = submit({ summary: 'Authored summary.', sections: { technical: 'Authored evidence.' }, questions: [first] });
  expect(initial.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: OTHER,
    issue: expect.stringContaining('Send the complete list') })]));
  expect(initial.resend).toEqual(['questions', 'prune_neighbors']);
  expect(initial.errors).toEqual(expect.arrayContaining([expect.objectContaining({ alternatives: ['questions', 'prune_neighbors'] })]));
  const schema = toModelJsonSchema(submitFindingsSchemaForMode('bb', 'technical', false, engine.hopSubmitColumns));
  expect(schema.description).toContain('questions or prune_neighbors list replaces its held list whole');
  expect(submit({ questions: [second] }).errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: BRANCH })]));
  expect(engine.toJSON().engineInternals.heldFinding?.finding.questions).toEqual([second]);
  expect(submit({ questions: [] }).errors).toHaveLength(2);
  expect(engine.toJSON().engineInternals.heldFinding?.finding.questions).toEqual([]);
  expect(submit({ questions: [first, second] })).toHaveProperty('ok', true);
  expect(engine.getDetailSlots().find(slot => slot.nodeId === ORIGIN)).toMatchObject({ summary: 'Authored summary.',
    sections: [{ angle: 'technical', text: 'Authored evidence.' }] });
});

it.each((['bb', 'ct'] as const).flatMap(mode => ['object', 'markdown', 'invalid-json'].map(sectionShape => ({ mode, sectionShape }))))(
  'reports missing $mode neighbor decisions alongside shape faults (sections: $sectionShape)', ({ mode, sectionShape }) => {
  const malformedSections = sectionShape !== 'object';
  const { engine, session, model, graph } = ctWorld({ mode, sibling: true });
  const { services } = stubToolServices({ session, model, graph });
  const questions = [{ nodeId: BRANCH, question: 'Explain the source Value.' }];
  const before = engine.toJSON();
  const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value provenance.',
    sections: sectionShape === 'markdown' ? '# Findings\nPlain authored Markdown.' : sectionShape === 'invalid-json'
      ? '{"technical":"Authored "quoted" evidence."}' : { technical: 'Preserve this authored evidence.' }, questions, badge_label: 42,
    ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }] } : {}) }, services));
  expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'badge_label' }), expect.objectContaining({ path: OTHER })]));
  if (malformedSections) expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'sections' })]));
  expect(rejected.detail).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'neighbor_outcome_missing', id: OTHER })]));
  const after = engine.toJSON();
  for (const key of ['agenda', 'columnAspect', 'removedSet', 'visited'] as const) expect(after[key]).toEqual(before[key]);
  expect(engine.getDetailSlots()).toEqual([]);
  expect(engine.toJSON().engineInternals.heldFinding?.finding.questions).toEqual(questions);
  expect(engine.toJSON().engineInternals.heldFinding?.finding).toMatchObject({ summary: 'Value provenance.',
    sections: malformedSections ? [] : [{ angle: 'technical', text: 'Preserve this authored evidence.' }] });
  expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN }, services))).toHaveProperty('code');
  expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN,
    ...(malformedSections ? { sections: { technical: 'Corrected authored evidence.' } } : {}), questions: [...questions,
    { nodeId: OTHER, question: 'Explain the other source.' }] }, services))).toHaveProperty('ok', true);
  expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Value provenance.' });
  if (mode === 'ct') expect(engine.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: BRANCH, to_node: ORIGIN })]);
});

describe('missing neighbor outcomes beside an invalid column_flow', () => {
  const missingIds = (result: { detail?: Array<{ kind?: string; id?: string }> }) =>
    (result.detail ?? []).filter(fault => fault.kind === 'neighbor_outcome_missing').map(fault => fault.id);
  const setup = () => {
    const world = ctWorld({ sibling: true });
    const { services } = stubToolServices({ session: world.session, model: world.model, graph: world.graph });
    const before = world.engine.toJSON();
    const submit = (column_flow: unknown) => JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value provenance.',
      sections: { technical: 'Authored evidence.' }, column_flow }, services));
    const unchanged = () => {
      const after = world.engine.toJSON();
      for (const key of ['agenda', 'columnAspect', 'removedSet', 'visited'] as const) expect(after[key]).toEqual(before[key]);
      expect(world.engine.getDetailSlots()).toEqual([]);
    };
    return { ...world, services, submit, unchanged };
  };

  it('reports a structurally unmentioned neighbor in the same first feedback as the flow fault', () => {
    const { submit, unchanged, services } = setup();
    const rejected = submit([{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing' }] }]);
    expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(/^column_flow\.0/) })]));
    // The neighbor named only inside the invalid entry has an authored (if faulty) outcome; only the absent one is owed.
    expect(missingIds(rejected)).toEqual([OTHER]);
    unchanged();
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: OTHER, question: 'Explain the other source.' }] }, services))).toHaveProperty('ok', true);
  });

  it('owes the same neighbors as the corrected flow when a faulty procedure entry lands nowhere', () => {
    const world = ctWorld({ sibling: true, selfLoop: true });
    const { services } = stubToolServices({ session: world.session, model: world.model, graph: world.graph });
    const submit = (col: string) => JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value provenance.',
      sections: { technical: 'Authored evidence.' }, column_flow: [{ out_col: 'Value', writes_to: null, upstream_columns: [{ node: BRANCH, col }] }] }, services));
    // A procedure value with no write or return target maps no supplier, so naming the branch there is no outcome.
    expect(missingIds(submit('Missing'))).toEqual([BRANCH, OTHER]);
    expect(missingIds(submit('Value'))).toEqual([BRANCH, OTHER]);
  });

  it('accepts a filter-only supplier as an indirect edge and maps its neighbor', () => {
    const { submit } = setup();
    const accepted = submit([{ out_col: 'Value', upstream_columns: [
      { node: BRANCH, col: 'Value', transforms: ['compute'] },
      { node: OTHER, col: 'Value', transforms: ['filter'] },
    ] }]);
    expect(accepted.code).not.toBe('invalid_input');
    expect(missingIds(accepted)).toEqual([]);
  });

  it.each([
    ['unparseable text', '[{"out_col": "Value", "upstream_columns": ['],
    ['shape-invalid entry', [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing', bogus: 1 }] }]],
    ['unresolvable reference', [{ out_col: 'Value', upstream_columns: [{ node: '[hop].[nowhere]', col: 'Value' }] }]],
  ])('claims no missing outcome when the flow cannot be read structurally: %s', (_label, flow) => {
    const { submit, unchanged } = setup();
    const rejected = submit(flow);
    expect(rejected).toHaveProperty('code');
    expect(missingIds(rejected)).toEqual([]);
    unchanged();
  });

  it('claims no missing outcome when a faulty flow reaching the engine names an unresolvable object', () => {
    const { engine, unchanged } = setup();
    const rejected = engine.submitFindings({ focus_node_id: ORIGIN, summary: 'Value provenance.', sections: [{ angle: 'technical', text: 'Authored evidence.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: '[hop].[nowhere]', col: 'Value' }] }] });
    expect(rejected).toHaveProperty('code');
    expect(missingIds(rejected as never)).toEqual([]);
    unchanged();
  });
});

/** An inherited investigation reaches a reader that does not use the table's Value. */
function tableArrivalWorld(mode: 'bb' | 'ct') {
  const nodes = [
    makeNode({ id: ORIGIN, schema: 'hop', name: 'origin', type: 'table', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: BRANCH, schema: 'hop', name: 'branch', type: 'view',
      bodyScript: `SELECT Other FROM ${ORIGIN};` }),
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
  it('reports every independent fault of one submission in a single rejection without committing', () => {
    const { engine, session, model, graph } = ctWorld({ sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ summary: 'Value comes from Branch.', sections: { technical: 'Branch supplies Value.' },
      badge_label: 42,
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing' }] }],
      questions: [{ nodeId: '[hop].[absent]', question: 'Explain Absent.' }],
      prune_neighbors: [{ id: '[hop].[absent]', reason: 'Unknown object.' }],
    }, services));
    expect(rejected.issuePaths, JSON.stringify(rejected)).toEqual(expect.arrayContaining(['badge_label', 'column_flow.0.upstream_columns.0.col', 'questions.0.nodeId', 'prune_neighbors.0.id']));
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
  });
  it.each([OTHER, null, 42])('exposes no held writing parts after an initial invalid explicit focus %s', focus => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: focus, summary: 'Value provenance.',
      sections: { technical: 'A complete finding for the wrong or unnamed focus.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
    }, services))).toHaveProperty('code');
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
    expect(engine.currentFocus).toBe(ORIGIN);
    expect(engine.columnAspect!.edges).toEqual([]);
  });
  it('holds shape-valid content under the dispatched hop and commits a correction that omits the faulty field and names it withdrawn', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const raw = { summary: 'Original Value provenance.', sections: { technical: 'Retain this authored SQL evidence.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value', note: 'Original mapping note.' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value.' }], badge_label: 42 };
    const original = structuredClone(raw);
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings(raw, services));
    expect(raw).toEqual(original);
    expect(raw).not.toHaveProperty('focus_node_id');
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: ['badge_label'] });
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], fields: expect.arrayContaining(['column_flow', 'questions']) });
    expect(engine.heldPartsOfCurrentFocus()!.fields).not.toContain('badge_label');
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().visited).toEqual(before.visited);
    const held = engine.toJSON();
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: BRANCH }, services))).toHaveProperty('code', 'focus_node_id_mismatch');
    expect(engine.toJSON()).toEqual(held);
    expect(JSON.parse(executeSubmitFindings({}, services))).toMatchObject({ ok: true, withdrawn: ['badge_label'] });
    expect(engine.columnAspect!.edges).toEqual([expect.objectContaining({ from_node: BRANCH, note: 'Original mapping note.' })]);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: raw.summary,
      sections: [{ angle: 'technical', text: raw.sections.technical }] });
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN }, services))).toHaveProperty('code');
  });
  it('does not provisionally retain a missing-focus payload before a hop is dispatched', () => {
    const { engine, session, model, graph } = ctWorld();
    expect(engine.init({ origin: ORIGIN, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    const { services } = stubToolServices({ session, model, graph });
    expect(JSON.parse(executeSubmitFindings({ summary: 'Unbound.', sections: { technical: 'No dispatched hop.' }, column_flow: [] }, services))).toHaveProperty('code');
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
  });
  it('commits an omitted focus as the dispatched hop and names it in the acknowledgement', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const accepted = JSON.parse(executeSubmitFindings({ summary: 'Original summary.', sections: { technical: 'Original findings.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }], questions: [],
    }, services));
    expect(accepted).toMatchObject({ ok: true, accepted_focus: ORIGIN, next_focus: BRANCH });
    expect(engine.toJSON().columnAspect).not.toEqual(before.columnAspect);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Original summary.',
      sections: [{ angle: 'technical', text: 'Original findings.' }] });
  });
  it.each(['malformed-note', 'unsupported-key'] as const)('reports a bad column independently of $0 on the same supplier', fault => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
      sections: { technical: 'Keep the valid prose.' }, questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing',
        ...(fault === 'malformed-note' ? { note: 42 } : { unsupported: true }) }] }],
    }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining([
      `column_flow.0.upstream_columns.0.${fault === 'malformed-note' ? 'note' : 'unsupported'}`,
      'column_flow.0.upstream_columns.0.col',
    ]), detail: expect.arrayContaining([expect.objectContaining({ kind: 'bad_contributor_col', path: 'column_flow.0.upstream_columns.0.col' })]) });
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const) expect(after[key]).toEqual(before[key]);
    expect(rejected.resend).toEqual(['column_flow']);
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, column_flow: [{ out_col: 'Value',
      upstream_columns: [{ node: BRANCH, col: 'Value', ...(fault === 'malformed-note' ? { note: 'Corrected supplier note.' } : {}) }] }],
    }, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(1);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Branch supplies Value.',
      sections: [{ angle: 'technical', text: 'Keep the valid prose.' }] });
  });
  it.each(['unsupported-key', 'bad-output'] as const)('reports a bad supplier independently of its $0 entry header', fault => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
      sections: { technical: 'Keep this analysis.' }, questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
      column_flow: [{ out_col: fault === 'bad-output' ? 'AbsentOutput' : 'Value',
        ...(fault === 'unsupported-key' ? { unsupported: true } : {}),
        upstream_columns: [{ node: BRANCH, col: 'Missing' }] }],
    }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining([
      `column_flow.0.${fault === 'unsupported-key' ? 'unsupported' : 'out_col'}`, 'column_flow.0.upstream_columns.0.col',
    ]), detail: expect.arrayContaining([expect.objectContaining({ kind: 'bad_contributor_col', path: 'column_flow.0.upstream_columns.0.col' })]) });
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const) expect(after[key]).toEqual(before[key]);
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN,
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
    }, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(1);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Branch supplies Value.',
      sections: [{ angle: 'technical', text: 'Keep this analysis.' }] });
  });
  it.each((['unsupported-key', 'wrong-type'] as const).flatMap(fault => [0, 1].map(entryIndex => ({ fault, entryIndex }))))(
    'reports an independent bad column beside $fault at original entry $entryIndex without committing either', ({ fault, entryIndex }) => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const malformed = fault === 'unsupported-key'
      ? { node: BRANCH, col: 'Value', unsupported: true } : { node: BRANCH, col: 42 };
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
      sections: { technical: 'Keep this valid analysis.' },
      column_flow: [...(entryIndex ? [{ out_col: 'Value', upstream_columns: [], unsupported: true }] : []),
        { out_col: 'Value', upstream_columns: [malformed, { node: BRANCH, col: 'Missing' },
        { node: BRANCH, col: 'Value', note: 'This valid sibling stays held.' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }],
    }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining([
      `column_flow.${entryIndex}.upstream_columns.0.${fault === 'unsupported-key' ? 'unsupported' : 'col'}`,
      `column_flow.${entryIndex}.upstream_columns.1.col`,
    ]), detail: expect.arrayContaining([expect.objectContaining({ kind: 'bad_contributor_col', path: `column_flow.${entryIndex}.upstream_columns.1.col` })]) });
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const) expect(after[key]).toEqual(before[key]);
    expect(rejected.resend).toEqual(['column_flow']);
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, column_flow: [{ out_col: 'Value', upstream_columns: [
      { node: BRANCH, col: 'Value' }, { node: BRANCH, col: 'Value' }, { node: BRANCH, col: 'Value', note: 'This valid sibling is resent with the list.' }] }],
    }, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(3);
    expect(engine.columnAspect!.edges[2].note).toBe('This valid sibling is resent with the list.');
  });
  it('advances the held draft with the valid fields of a retry whose sections are malformed', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const original = { focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
      sections: { technical: 'Preserve this original finding.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }] };
    expect(JSON.parse(executeSubmitFindings(original, services))).toHaveProperty('code');
    const correction = { focus_node_id: ORIGIN, summary: 'Amended summary.',
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }] };
    const before = engine.toJSON();
    const malformed = JSON.parse(executeSubmitFindings({ ...correction, sections: 42 }, services));
    expect(malformed).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['sections']), resend: ['sections'] });
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.engineInternals.heldFinding?.finding, 'the valid fields replace their held copies; the malformed sections never overwrite the held angle').toMatchObject({
      summary: 'Amended summary.', column_flow: correction.column_flow, sections: [{ angle: 'technical', text: original.sections.technical }],
      questions: original.questions });
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, sections: original.sections }, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(1);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Amended summary.',
      sections: [{ angle: 'technical', text: original.sections.technical }] });
  });
  it.each([false, true])('holds intrinsically valid mappings for an action-only prune correction (schema fault: %s)', schemaFault => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value comes from Branch.',
      sections: { technical: 'Retain the original SQL findings.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value', note: 'Keep this mapping.' }] }],
      prune_neighbors: [{ id: BRANCH, reason: 'No further investigation.' }],
      ...(schemaFault ? { badge_label: 42 } : {}),
    }, services));
    expect(rejected).toMatchObject({ issuePaths: expect.arrayContaining(['prune_neighbors.0.id', 'column_flow.0.upstream_columns.0']) });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
    expect(engine.heldColumnFlow).toBe(true);
    const correction = { focus_node_id: ORIGIN, prune_neighbors: [],
      questions: [{ nodeId: BRANCH, question: 'Establish the source of Value.' }] };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(schema.safeParse(correction).success).toBe(true);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(correction)).toBe(true);
    expect(JSON.parse(executeSubmitFindings(correction, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([expect.objectContaining({ from_node: BRANCH, from_col: 'Value', note: 'Keep this mapping.' })]);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Value comes from Branch.',
      sections: [{ angle: 'technical', text: 'Retain the original SQL findings.' }] });
    expect(engine.toJSON().removedSet).toEqual([]);
  });
  it.each([true, false])('uses only validated pairs for prune diagnostics beside a malformed entry (valid destination: %s)', validDestination => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Original findings.',
      sections: { technical: 'Keep the SQL evidence.' }, questions: [],
      column_flow: [
        { out_col: validDestination ? 'Value' : 'Missing', upstream_columns: [{ node: BRANCH, col: 'Value' }] },
        { out_col: 'Value', upstream_columns: [], note: 'Misplaced header field.' },
      ], prune_neighbors: [{ id: BRANCH, reason: 'Outside the investigation.' }],
    }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['column_flow.1.note']) });
    const pruneFaults = (rejected.detail ?? []).filter((fault: { kind: string }) => fault.kind === 'prune_unsupported');
    expect(pruneFaults).toHaveLength(validDestination ? 1 : 0);
    if (validDestination) expect(pruneFaults[0]).toMatchObject({ id: BRANCH, path: 'prune_neighbors.0.id' });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
    expect(engine.toJSON().visited).toEqual(before.visited);
    const correction = { focus_node_id: ORIGIN, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }, { out_col: 'Value', upstream_columns: [] },
    ], prune_neighbors: [], questions: [{ nodeId: BRANCH, question: 'Establish Value.' }] };
    expect(JSON.parse(executeSubmitFindings(correction, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(1);
  });
  it('rejects an unsupported prune key without committing when prune identities are valid', () => {
    const { engine, session, model, graph } = ctWorld({ sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value comes from Branch.',
      sections: { technical: 'Keep these valid SQL findings.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }], questions: [],
      prune_neighbors: [{ id: OTHER, reason: 'This neighbor is outside the requested calculation.', reasons: '' }],
    }, services));
    expect(rejected).toMatchObject({ issuePaths: ['prune_neighbors.0.reasons'] });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
  });
  it('reports a malformed entry and a separate supplier together and accepts the whole corrected list', () => {
    const { engine, session, model, graph } = ctWorld({ other: true });
    const { services } = stubToolServices({ session, model, graph });
    const sibling = { node: BRANCH, col: 'Value', note: 'Retain this valid sibling verbatim.' };
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Original summary.',
      sections: { technical: 'Original SQL findings.' },
      column_flow: [
        { out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Missing' }], note: 'Misplaced header field.' },
        { out_col: 'Other', upstream_columns: [sibling, { node: BRANCH, col: 'Missing', note: 'Retain this supplier note.' }] },
      ], questions: [{ nodeId: BRANCH, question: 'Establish both source columns.' }],
    }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining([
      'column_flow.0.note', 'column_flow.0.upstream_columns.0.col', 'column_flow.1.upstream_columns.1.col',
    ]), resend: ['column_flow'] });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    const correction = { focus_node_id: ORIGIN, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] },
      { out_col: 'Other', upstream_columns: [sibling, { node: BRANCH, col: 'Other', note: 'Retain this supplier note.' }] },
    ] };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(schema.safeParse(correction).success).toBe(true);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(correction)).toBe(true);
    expect(JSON.parse(executeSubmitFindings(correction, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(3);
    expect(engine.columnAspect!.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_col: 'Value', to_col: 'Other', note: sibling.note }),
      expect.objectContaining({ from_col: 'Other', to_col: 'Other', note: 'Retain this supplier note.' }),
    ]));
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Original summary.',
      sections: [{ angle: 'technical', text: 'Original SQL findings.' }] });
  });
  it.each(['column', 'schema', 'remove'] as const)('resends the whole list after a rejected tuple: %s', defect => {
    const { engine, session, model, graph } = ctWorld({ other: true });
    const { services } = stubToolServices({ session, model, graph });
    const valid = { node: BRANCH, col: 'Other', note: 'Original tuple note.', transforms: ['compute'] };
    const bad = defect === 'column' ? { ...valid, col: 'Missing' }
      : defect === 'schema' ? { ...valid, unsupported: true } : { ...valid, node: OTHER };
    const flow = ['Value', 'Other'].map(out_col => ({ out_col, upstream_columns: [{ node: BRANCH, col: 'Value', note: 'Keep this tuple verbatim.' }, valid] }));
    flow[1]!.upstream_columns[1] = bad;
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Both outputs use both inputs.',
      sections: { technical: 'Retain all valid relations and this original prose.' }, column_flow: flow,
      questions: [{ nodeId: BRANCH, question: 'Establish both source columns.' }],
    }, services));
    expect(rejected).toHaveProperty('code');
    expect(rejected.issuePaths).toEqual(expect.arrayContaining([expect.stringContaining('column_flow.1.upstream_columns.1')]));
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.currentFocus).toBe(ORIGIN);
    const patch = { focus_node_id: ORIGIN, column_flow: flow.map((entry, index) => index === 1
      ? { ...entry, upstream_columns: defect === 'remove' ? entry.upstream_columns.slice(0, 1) : [entry.upstream_columns[0]!, valid] } : entry) };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(schema.safeParse(patch).success).toBe(true);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(patch)).toBe(true);
    expect(JSON.parse(executeSubmitFindings(patch, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(defect === 'remove' ? 3 : 4);
    expect(engine.columnAspect!.edges.filter(edge => edge.from_col === 'Value')).toHaveLength(2);
    if (defect !== 'remove') expect(engine.columnAspect!.edges.find(edge => edge.from_col === 'Other' && edge.to_col === 'Other'))
      .toMatchObject({ note: 'Original tuple note.', transforms: ['compute'] });
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: 'Both outputs use both inputs.',
      sections: [{ angle: 'technical', text: 'Retain all valid relations and this original prose.' }] });
  });
  it('rejects the removed column_flow_repairs field as an unknown key and holds nothing for it', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, column_flow_repairs: [{ entry_index: 0, upstream_index: 0, replacement: { col: 'Value' } }] }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['column_flow_repairs']),
      errors: expect.arrayContaining([expect.objectContaining({ path: 'column_flow_repairs', issue: 'Unrecognized key' })]) });
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
  });
  it('names separate defective suppliers at their original indexes and accepts the corrected whole list', () => {
    const { engine, session, model, graph } = ctWorld();
    model.nodes.find(node => node.id === BRANCH)!.columns!.push({ name: 'Other', type: 'int', nullable: 'NULL', extra: '' });
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Both inputs contribute.',
      sections: { technical: 'Keep this complete finding.' }, column_flow: [{ out_col: 'Value', upstream_columns: [
        { node: BRANCH, col: 'Value', note: 'This valid sibling stays unchanged.' },
        { node: OTHER, col: 'Value' }, { node: BRANCH, col: 12, note: 'Preserve this note during a column correction.' },
      ] }], questions: [{ nodeId: BRANCH, question: 'Establish both inputs.' }],
    }, services));
    expect(rejected).toHaveProperty('code');
    expect(rejected.errors.map((error: { path: string }) => error.path)).toEqual(expect.arrayContaining([
      'column_flow.0.upstream_columns.1.node', 'column_flow.0.upstream_columns.2.col']));
    expect(engine.columnAspect!.edges).toEqual([]);
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, column_flow: [{ out_col: 'Value', upstream_columns: [
      { node: BRANCH, col: 'Value', note: 'This valid sibling stays unchanged.' },
      { node: BRANCH, col: 'Other', note: 'Preserve this note during a column correction.' }] }] }, services))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges.map(edge => [edge.from_col, edge.note])).toEqual([
      ['Value', 'This valid sibling stays unchanged.'], ['Other', 'Preserve this note during a column correction.'],
    ]);
  });
  it.each([
    { malformed: { questions: 42 }, path: 'questions' },
    { malformed: { sections: { technical: 42 } }, path: 'sections.technical' },
    { malformed: { column_flow: 42 }, path: 'column_flow' },
    { malformed: { summary: 42 }, path: 'summary' },
  ])('keeps the held copy of the malformed field $path and advances the valid ones', ({ malformed, path }) => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const sections = { technical: 'Branch supplies Value unchanged.' };
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }];
    const questions = [{ nodeId: BRANCH, question: 'Establish the origin of Value.' }];
    const submit = (input: object) => JSON.parse(executeSubmitFindings({ focus_node_id: ' HOP . ORIGIN ', ...input }, services));
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
    expect(submit({ sections, column_flow, questions })).toMatchObject({ code: 'invalid_input', issuePaths: ['summary'] });
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ sections: ['technical'], summary: false });
    const before = engine.toJSON();
    const rejected = submit({ summary: 'A valid replacement summary.', ...malformed });
    expect(rejected).toHaveProperty('code', 'invalid_input');
    expect(rejected.issuePaths).toContain(path);
    expect(rejected.resend).toEqual([path]);
    const after = engine.toJSON();
    const malformedSummary = path === 'summary';
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ sections: ['technical'], summary: !malformedSummary, resend: [path] });
    expect(after.engineInternals.heldFinding?.finding).toEqual({ ...before.engineInternals.heldFinding?.finding,
      ...(malformedSummary ? {} : { summary: 'A valid replacement summary.' }) });
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const) expect(after[key]).toEqual(before[key]);
    expect(submit({ summary: 'Branch supplies Value.' })).toMatchObject({ ok: true, next_focus: BRANCH });
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
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
      expect(rejected.resend).toEqual(['column_flow']);
      expect(rejected.hint ?? '').not.toContain('resend the full call');
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
    expect(JSON.parse(executePruneCurrent({ focus_node_id, reason: 'Off path.' }, services))).toHaveProperty('code', 'focus_node_id_mismatch');
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
  it('serves a fresh approval proposal after completion, with no direct supplement branch', () => {
    const proposal = { origin: OTHER, analysisMode: 'bb', classification: 'technical',
      depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } };
    const legacy = { supplement: { nodeIds: [OTHER] } };
    expect(StartExplorationCompletedProviderInputSchema.safeParse(proposal).success).toBe(true);
    expect(StartExplorationCompletedProviderInputSchema.safeParse(legacy).success).toBe(false);
    expect(StartExplorationProviderInputSchema.safeParse(legacy).success).toBe(false);
    const validate = new Ajv({ strict: false }).compile(toModelJsonSchema(StartExplorationCompletedProviderInputSchema));
    expect(validate(proposal)).toBe(true);
    expect(validate(legacy)).toBe(false);
  });
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

  it('directs an origin plus legacy supplement to a fresh approval proposal', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const text = await executeStartExploration({ origin: ORIGIN, analysisMode: 'bb', classification: 'technical', depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } }, supplement: { nodeIds: [OTHER] } } as never, services);
    expect(text).toMatch(/new exploration/);
    expect(text).toMatch(/origin and scope, without supplement/);
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

  it('requires fresh discovery and a new approval card after completion while keeping the completed run intact', async () => {
    const { engine, session, model, graph } = ctWorld({ deferred: true });
    const { services } = stubToolServices({ session, model, graph, turnEpoch: () => session.turnEpoch });
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, summary: 'Value comes from branch.',
      sections: { technical: 'Branch supplies Value.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value.' }] }, services))).toHaveProperty('ok', true);
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: BRANCH, summary: 'Source is beyond depth 1.',
      sections: { technical: 'Other is beyond the border.' }, column_flow: [],
      questions: [{ nodeId: OTHER, question: 'Establish how Other produces Value.' }] }, services))).toHaveProperty('done', true);
    const result = engine.getResult();
    session.resultGraph = { nodeIds: result.fullNodes.map(n => n.id), edges: result.edges, source: 'column_trace',
      originNodeId: ORIGIN, ...(result.columnAspect ? { columnAspect: { edges: result.columnAspect.edges } } : {}) };
    session.enterCompleted(session.turnEpoch);
    const beforeEngine = engine.toJSON();
    const beforeGraph = structuredClone(session.resultGraph);
    const legacy = JSON.parse(await executeStartExploration({ supplement: { nodeIds: [OTHER] } } as never, services));
    expect(legacy).not.toHaveProperty('focus_node');
    expect(session.phase.kind).toBe('completed');
    expect(engine.toJSON()).toEqual(beforeEngine);
    expect(session.resultGraph).toEqual(beforeGraph);
    const proposal = JSON.parse(await executeStartExploration({
      origin: OTHER, analysisMode: 'bb', classification: 'technical',
      depth: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } },
    }, services));
    expect(proposal).toMatchObject({ code: 'action_required', detail: { gate: 'confirm_sm_start', proposalRevision: 1 } });
    expect(proposal).not.toHaveProperty('focus_node');
    expect(session.pendingExploration?.init).toMatchObject({ origin: OTHER, analysisMode: 'bb', direction: 'downstream' });
    expect(session.stateMachine).toBe(engine);
    expect(engine.toJSON()).toEqual(beforeEngine);
    expect(session.resultGraph).toEqual(beforeGraph);
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
  const finding = (mode: 'bb' | 'ct' = 'ct') => ({
    focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
    sections: { technical: 'The selected Value comes from branch.' },
    ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }] } : {}),
    questions: [{ nodeId: BRANCH, question: 'Establish the SQL source of Value.' }], prune_neighbors: [],
  });
  it.each(['fresh-held', 'existing-held', 'none', 'existing-missing-focus', 'existing-wrong-focus'] as const)(
    'uses one coherent schema repair instruction with %s content', heldCase => {
      const { session, model, graph, engine } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const valid = { focus_node_id: ORIGIN, summary: 'Branch supplies Value.',
        sections: { technical: 'Preserve this SQL finding verbatim.' },
        column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }],
        questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }] };
      const existing = heldCase.startsWith('existing');
      const wrongFocus = heldCase === 'existing-wrong-focus';
      if (existing) {
        expect(JSON.parse(executeSubmitFindings({ ...valid, summary: undefined }, services))).toHaveProperty('code', 'invalid_input');
      }
      const before = engine.toJSON();
      const input = heldCase === 'none' || existing
        ? { focus_node_id: heldCase === 'existing-missing-focus' ? undefined : heldCase === 'existing-wrong-focus' ? OTHER : ORIGIN, column_flow: 42 }
        : { ...valid, column_flow: 42 };
      const result = JSON.parse(executeSubmitFindings(input, services));
      expect(result).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['column_flow']),
        errors: expect.arrayContaining([expect.objectContaining({ path: 'column_flow', expected: 'array', got: 42 })]) });
      expect(result).not.toHaveProperty('hint');
      expect(result.resend).toEqual(expect.arrayContaining(['column_flow']));
      if (heldCase === 'none' || wrongFocus) {
        if (!existing) expect(engine.heldFindingFocus).toBeNull();
        if (!existing) expect(engine.heldPartsOfCurrentFocus()).toBeNull();
        else expect(engine.toJSON(), 'an unbound repair cannot borrow or replace the current draft').toEqual(before);
      } else if (existing) {
        const after = engine.toJSON();
        expect(after.engineInternals.heldFinding?.finding, 'the malformed field keeps the existing draft').toEqual(before.engineInternals.heldFinding?.finding);
        expect(result.resend, 'the summary the draft still lacks stays owed').toEqual(['column_flow', 'summary']);
      } else expect(result.resend).toEqual(['column_flow']);
      const correction = heldCase === 'none' ? valid : existing
        ? { focus_node_id: ORIGIN, summary: valid.summary }
        : { focus_node_id: ORIGIN, column_flow: valid.column_flow };
      expect(JSON.parse(executeSubmitFindings(correction, services))).toHaveProperty('ok', true);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: valid.summary, sections: [{ angle: 'technical', text: valid.sections.technical }],
      });
    });

  it.each([
    { unavailable: 'questions', protectedEndpoint: true },
    { unavailable: 'column_flow', protectedEndpoint: false },
  ])('reports only established prune protection with unavailable $unavailable', ({ unavailable, protectedEndpoint }) => {
    const { session, model, graph, engine } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const input = { focus_node_id: ORIGIN, summary: 'Branch supplies Value.', sections: { technical: 'Value comes from branch.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] }], questions: [],
      prune_neighbors: [{ id: BRANCH, reason: 'Do not investigate this supplier.' }] };
    const before = engine.toJSON();
    const result = JSON.parse(executeSubmitFindings({ ...input, [unavailable]: 42 }, services));
    expect(result).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining([unavailable]) });
    const protection = result.detail?.filter((fault: { kind?: string; id?: string; path?: string }) =>
      fault.kind === 'prune_unsupported' && fault.id === BRANCH && fault.path === 'prune_neighbors.0.id') ?? [];
    expect(protection).toHaveLength(protectedEndpoint ? 1 : 0);
    const after = engine.toJSON();
    for (const key of ['agenda', 'visited', 'removedSet', 'columnAspect', 'scopeNodeIds'] as const)
      expect(after[key]).toEqual(before[key]);
    const corrected = JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN, prune_neighbors: [],
      column_flow: input.column_flow,
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }] }, services));
    expect(corrected, JSON.stringify(corrected)).toHaveProperty('ok', true);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({ summary: input.summary,
      sections: [{ angle: 'technical', text: input.sections.technical }] });
  });

  it.each([
    { name: 'bad supplier column', selfLoop: false, kind: 'bad_contributor_col', path: 'column_flow.0.upstream_columns.0.col' },
    { name: 'self-loop relation', selfLoop: true, kind: 'self_loop_column', path: 'column_flow.0.upstream_columns.0' },
  ])('collects a safe CT fault beside invalid narrative: $name', ({ selfLoop, kind, path }) => {
    const { session, model, graph, engine } = ctWorld({ selfLoop });
    const { services } = stubToolServices({ session, model, graph });
    const input = { summary: 'SQL findings retained.', sections: { technical: 42 },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: BRANCH, col: selfLoop ? 'Value' : 'Absent' }],
        ...(selfLoop ? { writes_to: { node: BRANCH, col: 'Value' } } : {}) }],
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }] };
    const before = engine.toJSON();
    const result = JSON.parse(executeSubmitFindings(input, services));
    const after = engine.toJSON();
    expect.soft(result).toMatchObject({ code: 'invalid_input', issuePaths: expect.arrayContaining(['sections.technical', path]) });
    expect.soft(result.detail).toEqual(expect.arrayContaining([expect.objectContaining({ kind, path })]));
    for (const key of ['agenda', 'visited', 'removedSet', 'currentFocusNodeId', 'columnAspect', 'scopeNodeIds'] as const)
      expect(after[key], `${key} remains atomic`).toEqual(before[key]);
    const control = JSON.parse(executeSubmitFindings({ column_flow: input.column_flow, sections: { technical: 'SQL findings retained.' } }, services));
    expect(control.detail, `the same typed CT fault is independently observable when narrative is valid: ${JSON.stringify(control)}`)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind, path })]));
    const repaired = JSON.parse(executeSubmitFindings({
      column_flow: [{ out_col: 'Value', upstream_columns: selfLoop ? [] : [{ node: BRANCH, col: 'Value' }],
        ...(selfLoop ? { writes_to: { node: BRANCH, col: 'Value' } } : {}) }] }, services));
    expect(repaired, JSON.stringify(repaired)).toHaveProperty('ok', true);
  });

  it.each([
    { name: 'unrelated sections', patch: { sections: { technical: 42 } }, schemaPath: 'sections.technical' },
    { name: 'unrelated flow', patch: { column_flow: 42 }, schemaPath: 'column_flow' },
    { name: 'unknown questions', patch: { questions: 42 }, schemaPath: 'questions' },
    { name: 'unknown prune decisions', patch: { sections: { technical: 42 }, prune_neighbors: 42 }, schemaPath: 'prune_neighbors' },
  ].flatMap(row => (['bb', 'ct'] as const).filter(mode => mode === 'ct' || row.schemaPath !== 'column_flow')
    .map(mode => ({ ...row, mode }))))('reports each fault without inventing unavailable decisions ($mode): $name', ({ patch, schemaPath, mode }) => {
    const { session, model, graph, engine } = ctWorld({ mode });
    const { services } = stubToolServices({ session, model, graph });
    const durable = () => {
      const state = engine.toJSON();
      return { agenda: state.agenda, visited: state.visited, removed: state.removedSet,
        focus: state.currentFocusNodeId, status: state.status, columnAspect: state.columnAspect,
        scope: state.scopeNodeIds, nodeStates: state.nodeStates };
    };
    const before = structuredClone(durable());
    const result = JSON.parse(executeSubmitFindings({ ...finding(mode), questions: [], ...patch }, services));
    expect(result.code).toBe('invalid_input');
    expect(result.issuePaths).toContain(schemaPath);
    expect(durable(), 'a rejected draft cannot commit graph, agenda or removal state').toEqual(before);
    expect(result.issuePaths, 'no decision is invented for an omitted or unavailable list').not.toContain('questions.0');
    const complete = finding(mode);
    const correction = schemaPath === 'focus_node_id' ? complete : {
      focus_node_id: ORIGIN,
      ...(schemaPath.startsWith('sections') || schemaPath === 'prune_neighbors' ? { sections: complete.sections } : {}),
      ...(schemaPath === 'column_flow' ? { column_flow: complete.column_flow } : {}),
      ...(schemaPath === 'prune_neighbors' ? { prune_neighbors: [] } : {}),
      ...(schemaPath === 'questions' || schemaPath === 'prune_neighbors' || (mode === 'bb' && schemaPath.startsWith('sections')) ? { questions: complete.questions } : {}),
    };
    const accepted = JSON.parse(executeSubmitFindings(correction, services));
    expect(accepted).toMatchObject({ ok: true, next_focus: BRANCH });
    expect(engine.toJSON().visited.filter(id => id === ORIGIN)).toHaveLength(1);
  });

  it.each([49, 50, 51])('keeps badge bound %i identical at the public schema and handler boundary', length => {
    const { session, model, graph, engine } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const input = { ...finding(), badge_label: 'x'.repeat(length) };
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns, engine.heldColumnFlow);
    const wireValid = new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(input);
    const result = JSON.parse(executeSubmitFindings(input, services));
    expect(schema.safeParse(input).success).toBe(length <= 50);
    expect(wireValid).toBe(length <= 50);
    expect(result.ok === true).toBe(length <= 50);
    if (length === 51) expect(result).toMatchObject({ code: 'invalid_input', issuePaths: ['badge_label'] });
  });

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
