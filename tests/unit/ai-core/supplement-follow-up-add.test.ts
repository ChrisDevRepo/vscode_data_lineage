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

  await executeStartExploration({ supplement: { nodeIds }, ...mode } as Parameters<typeof executeStartExploration>[0], services);
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
