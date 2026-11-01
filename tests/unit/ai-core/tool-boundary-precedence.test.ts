import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { executePruneCurrent } from '../../../src/ai/tools/handlers/pruneCurrent';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import {
  makeGraph,
  makeIndexedModel,
  makeModel,
  makeNode,
} from '../helpers/modelFixtures';
import { stubToolServices } from './helpers/toolServices';

vi.mock('../../../src/ai/tools/normalizeModelInput', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/ai/tools/normalizeModelInput')
    >();
  return { ...actual, normalizeModelInput: vi.fn(actual.normalizeModelInput) };
});

const ORIGIN = '[hop].[origin]';
/** One exact upstream level, none downstream: the depth most start fixtures send. */
const oneUp = () => ({
  upstream: { levels: 1 as const, exactness: 'exact' as const },
  downstream: { levels: 0 as const, exactness: 'exact' as const },
});
const BRANCH = '[hop].[branch]';
const OTHER = '[hop].[other]';

it('keeps tool payloads in results and hop evidence while host logs contain metadata only', async () => {
  const marker = 'ToolPayloadLeakSentinel';
  const node = makeNode({
    id: '[hop].[logging]',
    schema: 'hop',
    name: 'logging',
    type: 'view',
    bodyScript: `SELECT '${marker}' AS Value;`,
  });
  const session = new AiSession();
  session.model = makeModel([node], [], ['hop']);
  session.graph = makeGraph([node], []);
  session.columnStore.setDdl(node.id, node.bodyScript!);
  session.beginTurn();
  const channel = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registry = buildAiToolRegistry(
    () => session,
    channel as never,
    () => undefined,
  );
  await registry.invoke('lineage_search_objects', { query: marker });
  const accepted = await registry.invoke('lineage_get_object_detail', {
    id: node.id,
  });
  const rejected = await registry.invoke('lineage_get_object_detail', {
    id: `[missing].[${marker}]`,
  });
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const gate = await registry.invoke('lineage_start_exploration', {
    origin: node.id,
    question: marker,
    mission_brief: marker,
    analysisMode: 'bb',
    classification: 'technical',
    depth: oneUp(),
  });
  expect(String(accepted)).toContain(marker);
  expect(String(rejected)).toContain(marker);
  expect(String(gate)).toContain(marker);
  expect(JSON.parse(String(gate)).code).toBe('action_required');
  expect(JSON.stringify(session.hopLog)).toContain(marker);
  const logs = [channel.debug, channel.info, channel.warn, channel.error]
    .flatMap((logger) => logger.mock.calls.flat())
    .join(' ');
  expect(logs).not.toContain(marker);
  expect(logs).toContain('resultChars=');
  expect(logs).toContain('code=invalid_input');
});

/**
 * A rejected commit leaves the navigation state untouched: no queued work, visit, removal, column
 * edge or scope change.
 */
const expectUncommitted = (
  before: ReturnType<NavigationEngine['toJSON']>,
  after: ReturnType<NavigationEngine['toJSON']>,
) => {
  for (const key of [
    'agenda',
    'visited',
    'removedSet',
    'columnAspect',
    'scopeNodeIds',
  ] as const)
    expect(after[key]).toEqual(before[key]);
};

function ctWorld(
  options: {
    deferred?: boolean;
    scalar?: boolean;
    caseSensitive?: boolean;
    mode?: 'bb' | 'ct';
    selfLoop?: boolean;
    sibling?: boolean;
    other?: boolean;
    outsideWrite?: boolean;
    extraSource?: boolean;
  } = {},
) {
  const column = [
    { name: 'Value', type: 'int', nullable: 'NULL', extra: '' },
    ...(options.other
      ? [{ name: 'Other', type: 'int', nullable: 'NULL', extra: '' }]
      : []),
  ];
  const nodes = [
    makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: options.selfLoop ? 'procedure' : 'view',
      columns: column,
      bodyScript: options.scalar
        ? `SELECT ${BRANCH}(1) AS Value;`
        : `SELECT Value FROM ${BRANCH};`,
    }),
    makeNode({
      id: BRANCH,
      schema: 'hop',
      name: 'branch',
      type: options.scalar ? 'function' : options.selfLoop ? 'table' : 'view',
      columns: options.scalar ? [] : column,
      bodyScript: options.scalar
        ? `CREATE FUNCTION ${BRANCH}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END`
        : 'SELECT 1 AS Value;',
    }),
    makeNode({
      id: OTHER,
      schema: 'hop',
      name: 'other',
      type: 'table',
      columns: column,
    }),
    ...(options.extraSource
      ? [
          makeNode({
            id: '[hop].[extra]',
            schema: 'hop',
            name: 'extra',
            type: 'view',
            columns: column,
            bodyScript: 'SELECT 1 AS Value;',
          }),
        ]
      : []),
  ];
  const pairs: Array<[string, string]> = [
    [BRANCH, ORIGIN],
    ...(options.selfLoop ? [[ORIGIN, BRANCH] as [string, string]] : []),
    ...(options.deferred ? [[OTHER, BRANCH] as [string, string]] : []),
    ...(options.sibling ? [[OTHER, ORIGIN] as [string, string]] : []),
    ...(options.outsideWrite ? [[ORIGIN, OTHER] as [string, string]] : []),
    ...(options.extraSource
      ? [['[hop].[extra]', ORIGIN] as [string, string]]
      : []),
  ];
  const model = makeIndexedModel(nodes, pairs);
  model.identifierCaseSensitive = options.caseSensitive ?? false;
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;
  session.classification = 'technical';
  session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(
    engine.init({
      origin: ORIGIN,
      question: 'Trace Value.',
      analysisMode: options.mode ?? 'ct',
      ...(options.mode === 'bb'
        ? {}
        : { targetColumns: options.other ? ['Value', 'Other'] : ['Value'] }),
      direction: 'upstream',
      depthIntent: {
        upstream: { levels: options.deferred ? 1 : 'all', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const noop = () => {};
  const registry = buildAiToolRegistry(
    () => session,
    { info: noop, debug: noop, warn: noop, error: noop } as never,
    () => undefined,
  );
  return { session, model, graph, registry, engine };
}

it.each(
  (['bb', 'ct'] as const).flatMap((mode) =>
    ['object', 'markdown', 'invalid-json'].map((sectionShape) => ({
      mode,
      sectionShape,
    })),
  ),
)(
  'reports missing $mode neighbor decisions alongside shape faults (sections: $sectionShape)',
  ({ mode, sectionShape }) => {
    const malformedSections = sectionShape !== 'object';
    const { engine, session, model, graph } = ctWorld({ mode, sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const questions = [
      { nodeId: BRANCH, question: 'Explain the source Value.' },
    ];
    const before = engine.toJSON();
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          summary: 'Value provenance.',
          sections:
            sectionShape === 'markdown'
              ? '# Findings\nPlain authored Markdown.'
              : sectionShape === 'invalid-json'
                ? '{"technical":"Authored "quoted" evidence."}'
                : { technical: 'Preserve this authored evidence.' },
          questions,
          badge_label: 42,
          ...(mode === 'ct'
            ? {
                column_flow: [
                  {
                    out_col: 'Value',
                    upstream_columns: [{ node: BRANCH, col: 'Value' }],
                  },
                ],
              }
            : {}),
        },
        services,
      ),
    );
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'badge_label' }),
        { path: '', code: 'neighbor_undecided', values: [OTHER] },
      ]),
    );
    if (malformedSections)
      expect(rejected.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'sections' })]),
      );
    expect(rejected.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'neighbor_outcome_missing',
          id: OTHER,
        }),
      ]),
    );
    expectUncommitted(before, engine.toJSON());
    expect(engine.getDetailSlots()).toEqual([]);
    const heldRetry = JSON.parse(
      executeSubmitFindings({ focus_node_id: ORIGIN }, services),
    );
    expect(heldRetry).toHaveProperty('code');
    expect(
      heldRetry.errors.filter(
        (error: { code: string }) => error.code === 'neighbor_undecided',
      ),
    ).toEqual([{ path: '', code: 'neighbor_undecided', values: [OTHER] }]);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            ...(malformedSections
              ? { sections: { technical: 'Corrected authored evidence.' } }
              : {}),
            questions: [
              ...questions,
              { nodeId: OTHER, question: 'Explain the other source.' },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: 'Value provenance.',
      sections: [
        {
          angle: 'technical',
          text: malformedSections
            ? 'Corrected authored evidence.'
            : 'Preserve this authored evidence.',
        },
      ],
    });
    expect(engine.getCurrentTasks()).toContainEqual(
      expect.objectContaining({ question: questions[0].question }),
    );
    if (mode === 'ct')
      expect(engine.columnAspect?.edges).toEqual([
        expect.objectContaining({ from_node: BRANCH, to_node: ORIGIN }),
      ]);
  },
);

/** An inherited investigation reaches a reader that does not use the table's Value. */
function tableArrivalWorld(mode: 'bb' | 'ct') {
  const nodes = [
    makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: 'table',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
    }),
    makeNode({
      id: BRANCH,
      schema: 'hop',
      name: 'branch',
      type: 'view',
      bodyScript: `SELECT Other FROM ${ORIGIN};`,
    }),
    makeNode({
      id: OTHER,
      schema: 'hop',
      name: 'other',
      type: 'view',
      bodyScript: `SELECT Other FROM ${BRANCH};`,
    }),
  ];
  const pairs: Array<[string, string]> = [
    [ORIGIN, BRANCH],
    [BRANCH, OTHER],
  ];
  const model = makeIndexedModel(nodes, pairs);
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;
  session.classification = 'technical';
  session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(
    engine.init({
      origin: ORIGIN,
      question: 'Follow the Value investigation.',
      analysisMode: mode,
      ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}),
      direction: 'downstream',
      depthIntent: {
        upstream: { levels: 0, exactness: 'exact' },
        downstream: { levels: 'all', exactness: 'exact' },
      },
    }),
  ).toHaveProperty('ok', true);
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
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Value comes from Branch.',
          sections: { technical: 'Branch supplies Value.' },
          badge_label: 42,
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Missing' }],
            },
          ],
          questions: [
            { nodeId: '[hop].[absent]', question: 'Explain Absent.' },
          ],
          prune_neighbors: [
            { id: '[hop].[absent]', reason: 'Unknown object.' },
          ],
        },
        services,
      ),
    );
    expect(rejected.issuePaths, JSON.stringify(rejected)).toEqual(
      expect.arrayContaining([
        'badge_label',
        'column_flow.0.upstream_columns.0.col',
        'questions.0.nodeId',
        'prune_neighbors.0.id',
      ]),
    );
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
  });
});

describe('lineage_prune_current boundary', () => {
  it.each(['bb', 'ct'] as const)(
    'accepts the exact current %s focus and completes through the shared acknowledgement',
    (mode) => {
      const { engine, session, services } = tableArrivalWorld(mode);
      const input = {
        focus_node_id: BRANCH,
        reason:
          'The supplied SQL uses only Other and does not answer the inherited purpose.',
      };
      const before = structuredClone(input);
      expect(engine.canPruneCurrent).toBe(true);
      const result = JSON.parse(executePruneCurrent(input, services));
      expect(result).toMatchObject({
        ok: true,
        done: true,
        pruned: [BRANCH],
        cut_ids: [OTHER],
      });
      expect(engine.status).toBe('complete');
      expect(engine.getResult().fullNodes.map((node) => node.id)).toEqual([
        ORIGIN,
      ]);
      expect(session.resultGraph?.nodeIds).toEqual([ORIGIN]);
      expect(input).toEqual(before);
    },
  );
});

describe('lineage_start_exploration boundary', () => {
  it('opens the approval gate for a fresh proposal whatever phase the session holds, never a hop', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    expect(session.phase.kind).toBe('exploring');
    const { services } = stubToolServices({
      session,
      model,
      graph,
      turnEpoch: () => session.turnEpoch,
    });
    const result = JSON.parse(
      await executeStartExploration(
        {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'technical',
          question: 'What feeds it?',
          depth: oneUp(),
        },
        services,
      ),
    );
    expect(result).toMatchObject({
      code: 'action_required',
      detail: { gate: 'confirm_sm_start', proposalRevision: 1 },
    });
    expect(result).not.toHaveProperty('focus_node');
    expect(result.errors).toEqual([{ path: '', code: 'awaiting_approval' }]);
    expect(session.stateMachine).toBeNull();
  });

  it('rejects a fresh start with both depth sides 0 with the explicit depth_zero issue', async () => {
    const node = makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: 'view',
    });
    const session = new AiSession();
    session.model = makeModel([node], [], ['hop']);
    session.graph = makeGraph([node], []);
    session.beginTurn();
    session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    const registry = buildAiToolRegistry(
      () => session,
      { debug() {}, info() {}, warn() {}, error() {} } as never,
      () => undefined,
    );
    const result = JSON.parse(
      String(
        await registry.invoke('lineage_start_exploration', {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'business',
          depth: {
            upstream: { levels: 0, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        }),
      ),
    );
    expect(result.errors, JSON.stringify(result)).toEqual([
      { path: 'depth', code: 'depth_zero' },
    ]);
    expect(session.stateMachine).toBeNull();
  });
});
