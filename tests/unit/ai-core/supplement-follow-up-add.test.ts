/**
 * A follow-up that asks for an object adds it to the graph that is already presented.
 *
 * @remarks
 * UAT sess_1789702959746_3m3q1: the user approved a run, received the graph, then asked which other
 * procedures write to one of its tables. The model found them (`search_ddl`) and every route to add
 * them was refused — one had been pruned, neither was offered by a pending lead — so the turn died
 * on the semantic breaker and delivered nothing.
 *
 * The approve gate authorizes one hop-by-hop run and is spent when its result is presented. A
 * follow-up is the user's own request on top of that graph, so it is the consent: the named objects
 * are analysed in the same engine, against the same origin, with no second approval. What the user
 * removed (`excludeNodeIds`) stays removed, and only the ids named are added.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import type { Logger } from '../../../src/utils/log';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from '../sm/helpers/fixtures';

const ORIGIN = '[ai].[spimport]';
const ERRORLOG = '[ai].[errorlog]';
/** Writes to the shared table but sits upstream of it, so a downstream run never routes to it. */
const CLEANER = '[ai].[spclean]';
const REPORTER = '[ai].[spreport]';

const NODES: LineageNode[] = [
  makeNode({ id: ORIGIN, schema: 'ai', name: 'spImport', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spImport] AS INSERT [ai].[ErrorLog] SELECT 1' }),
  makeNode({ id: ERRORLOG, schema: 'ai', name: 'ErrorLog', type: 'table' }),
  makeNode({ id: CLEANER, schema: 'ai', name: 'spClean', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spClean] AS INSERT [ai].[ErrorLog] SELECT 2' }),
  makeNode({ id: REPORTER, schema: 'ai', name: 'spReport', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spReport] AS INSERT [ai].[ErrorLog] SELECT 3' }),
];
const EDGES: Array<[string, string]> = [
  [ORIGIN, ERRORLOG],
  [CLEANER, ERRORLOG],
  [REPORTER, ERRORLOG],
];

/** A session holding a completed downstream exploration and its presented result graph. */
function seedCompletedSession(options: { excludeNodeIds?: string[] } = {}): { session: AiSession; engine: NavigationEngine } {
  const model = makeModel(NODES, EDGES, ['ai']);
  const graph = makeGraph(NODES.map(node => ({ id: node.id, schema: node.schema, name: node.name, type: node.type })), EDGES);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;

  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({
    origin: ORIGIN,
    question: 'Trace spImport downstream.',
    direction: 'downstream',
    depthIntent: { kind: 'explicit', levels: 1 },
    ...(options.excludeNodeIds ? { excludeNodeIds: options.excludeNodeIds } : {}),
  });
  driveEngine(engine, { tag: 'initial', limit: 20 });
  expect(engine.status === 'complete', 'the seeded exploration completes').toBe(true);

  const epoch = session.beginTurn();
  session.stateMachine = engine;
  session.setClassification('business');
  session.enterCompleted(epoch);
  return { session, engine };
}

/** Drives `lineage_start_exploration` the way the model does — one payload through the handler. */
async function supplement(
  session: AiSession,
  nodeIds: string[],
  mode: Record<string, unknown> = { analysisMode: 'bb' },
  chain?: { direction: 'upstream' | 'downstream'; depth: number | 'all' },
): Promise<Record<string, unknown>> {
  let returned: Record<string, unknown> = {};
  const services = {
    getSession: () => session,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    maxRounds: 50,
    turnEpoch: () => session.turnEpoch,
    requireModel: () => session.model,
    requireGraph: () => session.graph,
    buildActiveFilter: () => ({}),
    logAndReturn: (_tool: string, data: Record<string, unknown>) => {
      returned = data;
      return JSON.stringify(data);
    },
    toolError: (_tool: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;

  await executeStartExploration({ supplement: { nodeIds, ...(chain ? { chain } : {}) }, ...mode } as Parameters<typeof executeStartExploration>[0], services);
  return returned;
}

describe('a follow-up adds the object the user asked for', () => {
  it('analyses objects no lead offered, in the same engine, with no second approval', async () => {
    const { session, engine } = seedCompletedSession();
    expect(engine.pendingLeads.some(lead => [CLEANER, REPORTER].includes(lead.nodeId.toLowerCase())), 'neither writer was offered as a lead by the completed run').toBe(false);

    const res = await supplement(session, [CLEANER, REPORTER]);

    expect(res.error, `the follow-up add is accepted (got ${JSON.stringify(res)})`).toBeUndefined();
    expect(res.admittedIds).toEqual([CLEANER, REPORTER]);
    expect((res.supplement as { agendaed: number }).agendaed).toBe(2);
    // Same engine, same origin: the objects join the committed graph rather than starting a new run.
    expect(session.stateMachine === engine, 'the completed engine is retained, not replaced').toBe(true);
    const scope = engine.toJSON().scopeNodeIds;
    expect(scope.includes(ORIGIN) && scope.includes(CLEANER) && scope.includes(REPORTER), 'both objects joined the existing scope').toBe(true);
    expect(session.phase.kind).toBe('exploring');
  });

  it('refuses an object the user removed, and adds the rest of the same request', async () => {
    const { session, engine } = seedCompletedSession({ excludeNodeIds: [CLEANER] });

    const res = await supplement(session, [CLEANER, REPORTER]);

    expect(res.error, 'a partly excluded request is still accepted for the rest').toBeUndefined();
    expect(res.admittedIds).toEqual([REPORTER]);
    const skipped = (res.supplement as { skippedDetails: Array<{ nodeId: string; reason: string }> }).skippedDetails;
    expect(skipped).toEqual([{ nodeId: CLEANER, reason: 'excluded' }]);
    expect(engine.toJSON().scopeNodeIds.includes(CLEANER), 'the excluded object stays out of the graph').toBe(false);
  });

  it('a supplement stating analysisMode "ct" without columns keeps the running mode — the schema gate on origin is not a hole', async () => {
    const { session, engine } = seedCompletedSession();
    expect(engine.columnAspect, 'the seeded run is BB').toBeFalsy();

    const res = await supplement(session, [CLEANER], { analysisMode: 'ct' });

    expect(res.error, `the add itself is accepted (got ${JSON.stringify(res)})`).toBeUndefined();
    expect(session.stateMachine === engine, 'the same engine runs the add').toBe(true);
    expect(engine.columnAspect, 'no column trace is started without columns').toBeFalsy();
  });
});

describe('a follow-up asking what to investigate next', () => {
  it('reads the open leads of the run on screen when no bookmark is applied', async () => {
    const { session, engine } = seedCompletedSession();
    const checkpoint = engine.toJSON();
    checkpoint.engineInternals.pendingLeads = [
      { id: 'lead_1', nodeId: CLEANER, fromNodeId: ERRORLOG, reason: 'schema_boundary', valueToUser: 'Also writes ErrorLog.' },
    ] as typeof checkpoint.engineInternals.pendingLeads;
    session.presentationArtifact = {
      name: 'spImport lineage',
      nodeIds: [ORIGIN, ERRORLOG],
      aiMetadata: { summary: 's', description: 'd' } as NonNullable<typeof session.presentationArtifact>['aiMetadata'],
      runId: 'run-live',
      checkpoint,
    };
    const silent = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Parameters<typeof Logger.create>[0];
    const registry = buildAiToolRegistry(() => session, silent, () => undefined);

    const raw = await registry.invoke('lineage_get_screen_state', { filter: 'open_leads' });
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;

    expect(parsed.error, `the live run answers (got ${raw as string})`).toBeUndefined();
    expect(parsed.run_id).toBe('run-live');
    expect(parsed.open_leads).toEqual([{ id: CLEANER, on_graph: false, from: ERRORLOG, reason: 'schema_boundary', value: 'Also writes ErrorLog.' }]);
  });
});

/**
 * PM 2026-09-21: the approval covers the first run up to its presented result; a later request is
 * the user's own. "Trace X all the way down" therefore adds the whole chain beyond X to the graph
 * on screen, with no second approval — only what the user removed stays out.
 */
describe('a follow-up that follows an object to the end of its chain', () => {
  const FEED = '[ai].[spfeed]';
  const STAGE = '[ai].[stage]';
  const LOADER = '[ai].[spload]';
  const FACT = '[ai].[fact]';
  const REPORT = '[ai].[vwreport]';
  const CHAIN_NODES: LineageNode[] = [
    makeNode({ id: ORIGIN, schema: 'ai', name: 'spImport', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spImport] AS INSERT [ai].[ErrorLog] SELECT 1' }),
    makeNode({ id: ERRORLOG, schema: 'ai', name: 'ErrorLog', type: 'table' }),
    makeNode({ id: FEED, schema: 'ai', name: 'spFeed', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spFeed] AS INSERT [ai].[Stage] SELECT * FROM [ai].[ErrorLog]' }),
    makeNode({ id: STAGE, schema: 'ai', name: 'Stage', type: 'table' }),
    makeNode({ id: LOADER, schema: 'ai', name: 'spLoad', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spLoad] AS INSERT [ai].[Fact] SELECT * FROM [ai].[Stage]' }),
    makeNode({ id: FACT, schema: 'ai', name: 'Fact', type: 'table' }),
    makeNode({ id: REPORT, schema: 'ai', name: 'vwReport', type: 'view', bodyScript: 'CREATE VIEW [ai].[vwReport] AS SELECT * FROM [ai].[Fact]' }),
  ];
  const CHAIN_EDGES: Array<[string, string]> = [
    [ORIGIN, ERRORLOG], [ERRORLOG, FEED], [FEED, STAGE], [STAGE, LOADER], [LOADER, FACT], [FACT, REPORT],
  ];

  function completedDownstreamOne(excludeNodeIds?: string[]): { session: AiSession; engine: NavigationEngine } {
    const model = makeModel(CHAIN_NODES, CHAIN_EDGES, ['ai']);
    const graph = makeGraph(CHAIN_NODES.map(node => ({ id: node.id, schema: node.schema, name: node.name, type: node.type })), CHAIN_EDGES);
    const session = new AiSession();
    session.model = model;
    session.graph = graph;
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: ORIGIN,
      question: 'Trace spImport one level downstream.',
      direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 1 },
      ...(excludeNodeIds ? { excludeNodeIds } : {}),
    });
    driveEngine(engine, { tag: 'initial', limit: 20 });
    expect(engine.status === 'complete', 'the seeded exploration completes').toBe(true);
    const epoch = session.beginTurn();
    session.stateMachine = engine;
    session.setClassification('business');
    session.enterCompleted(epoch);
    return { session, engine };
  }

  it('analyses every object beyond the named one and merges it into the same graph', async () => {
    const { session, engine } = completedDownstreamOne();
    expect(engine.toJSON().scopeNodeIds.includes(REPORT), 'the first run stopped one level down').toBe(false);

    const res = await supplement(session, [FEED], { analysisMode: 'bb' }, { direction: 'downstream', depth: 'all' });

    expect(res.error, `the chain add is accepted (got ${JSON.stringify(res)})`).toBeUndefined();
    expect(session.stateMachine === engine, 'the same engine runs the chain').toBe(true);
    const firstFocus = (res.focus_node as { id: string } | undefined)?.id;
    const visited = [firstFocus, ...driveEngine(engine, { tag: 'chain', limit: 20 })];
    for (const id of [FEED, LOADER, REPORT]) expect(visited, `${id} is analysed`).toContain(id);
    const scope = engine.toJSON().scopeNodeIds;
    for (const id of [ORIGIN, FEED, STAGE, LOADER, FACT, REPORT]) expect(scope, `${id} is on the one graph`).toContain(id);
  });

  it('stops the chain at an object the user removed', async () => {
    const { session, engine } = completedDownstreamOne([LOADER]);

    const res = await supplement(session, [FEED], { analysisMode: 'bb' }, { direction: 'downstream', depth: 'all' });

    expect(res.error).toBeUndefined();
    driveEngine(engine, { tag: 'chain', limit: 20 });
    const scope = engine.toJSON().scopeNodeIds;
    expect(scope).toContain(STAGE);
    expect(scope.includes(LOADER) || scope.includes(REPORT), 'the removed object and the branch behind it stay out').toBe(false);
  });

  it('closes an open lead once the follow-up add has analysed its object', async () => {
    const { session, engine } = completedDownstreamOne();
    const openOnFeed = (): number => engine.toJSON().engineInternals.pendingLeads
      .filter(lead => lead.nodeId.toLowerCase() === FEED && lead.status === 'pending').length;
    expect(openOnFeed(), 'the first run left spFeed as an open lead').toBeGreaterThan(0);

    const res = await supplement(session, [FEED]);
    // The reply already carries the first focus; the model answers it before the loop continues.
    expect((res.focus_node as { id: string }).id).toBe(FEED);
    engine.submitFindings({ focus_node_id: FEED, sections: [{ angle: 'business', text: 'analysis for spFeed' }], summary: 'spFeed', verdict: 'analyze' });
    driveEngine(engine, { tag: 'add', limit: 10 });

    expect(openOnFeed(), 'analysing spFeed answers its lead').toBe(0);
    const feedLeads = engine.toJSON().engineInternals.pendingLeads.filter(lead => lead.nodeId.toLowerCase() === FEED);
    expect(feedLeads.every(lead => lead.status === 'resolved')).toBe(true);
  });
});
