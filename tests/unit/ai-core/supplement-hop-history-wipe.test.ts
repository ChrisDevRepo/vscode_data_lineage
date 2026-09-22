import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import { modelAssistantMessage, modelUserMessage, type ModelPort } from '../../../src/ai/model/modelPort';
import { buildActiveContinuationAnchor } from '../../../src/ai/prompting/hostPrompts';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from '../sm/helpers/fixtures';
import { ScriptedModelPort, collectingSink, scriptedRegistry, validCall } from './helpers/scriptedModelPort';

/**
 * A completed-session supplement re-enters the hop loop from the follow-up phase instead of from
 * the approval gate. That entry is blinkered like the other two: the hop reads its focus,
 * neighbours and short-term memory from the engine, so the completed-phase conversation stays out
 * of the hop request.
 */

const HISTORY_SENTINEL = 'EARLIER_TURN_ANSWER_SENTINEL';

const NODES = [
  makeNode({
    id: '[ai].[spimport]',
    schema: 'ai',
    name: 'spImport',
    type: 'procedure',
    bodyScript: 'CREATE PROCEDURE [ai].[spImport] AS INSERT [ai].[stage] SELECT 1',
  }),
  makeNode({ id: '[ai].[stage]', schema: 'ai', name: 'stage', type: 'table' }),
  makeNode({ id: '[ai].[auditlog]', schema: 'ai', name: 'auditlog', type: 'table' }),
];
const EDGES: Array<[string, string]> = [
  ['[ai].[spimport]', '[ai].[stage]'],
  ['[ai].[spimport]', '[ai].[auditlog]'],
];

/** Seeds a session holding a completed exploration plus its committed result graph. */
function seedCompletedSession(): { session: AiSession; epoch: number; engine: NavigationEngine } {
  const session = new AiSession();
  const model = makeModel(NODES, EDGES, ['ai']);
  const graph = makeGraph(
    NODES.map(node => ({ id: node.id, schema: node.schema, name: node.name, type: node.type })),
    EDGES,
  );
  session.model = model;
  session.graph = graph;

  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({
    origin: '[ai].[spimport]',
    question: 'Trace spImport downstream.',
    direction: 'downstream',
    depthIntent: { kind: 'explicit', levels: 1 },
  });
  driveEngine(engine, { tag: 'initial', limit: 20 });

  const epoch = session.beginTurn();
  session.stateMachine = engine;
  session.resultGraph = {
    nodeIds: NODES.map(node => node.id),
    edges: EDGES.map(([source, target]) => [source, target, 'write'] as [string, string, string]),
    source: 'blackboard',
    originNodeId: '[ai].[spimport]',
  };
  session.setClassification('business');
  session.enterCompleted(epoch);
  return { session, epoch, engine };
}

describe('supplement hop history wipe', () => {
  it('enters the supplemented hop from the continuation anchor with no completed-phase history', async () => {
    const { session, epoch, engine } = seedCompletedSession();

    const port = new ScriptedModelPort([
      {
        toolCalls: [validCall('sup-1', 'lineage_start_exploration', {
          supplement: { nodeIds: ['[ai].[auditlog]'] },
        })],
      },
      { text: 'hop prose' },
    ]);

    const { registry } = scriptedRegistry([
      {
        name: 'lineage_start_exploration',
        // The real handler's two committed effects: node agendaed, session flipped to exploring.
        result: (): string => {
          engine.supplementAgenda(['[ai].[auditlog]']);
          session.enterExploring(epoch);
          return JSON.stringify({ ok: true, supplement: { ok: true, agendaed: 1 } });
        },
      },
      { name: 'lineage_submit_findings', result: JSON.stringify({ ok: true }) },
    ]);

    const runtime = new AgentRuntime({
      threadId: 'supplement-turn',
      getSession: () => session,
      model: port as unknown as ModelPort,
      registry,
      sink: collectingSink().sink,
      turnEpoch: epoch,
      maxRounds: 3,
      priorMessages: [
        modelUserMessage('trace spImport downstream'),
        modelAssistantMessage(HISTORY_SENTINEL),
      ],
    });

    await runtime.run('check auditlog');

    // Request 0 is the completed-phase follow-up; it legitimately carries the conversation.
    expect(port.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(port.requests[0].messages)).toContain(HISTORY_SENTINEL);

    const hop = port.requests[1];
    expect(hop.phase).toBe('active');
    expect(JSON.stringify(hop.messages)).not.toContain(HISTORY_SENTINEL);
    expect(JSON.stringify(hop.messages)).not.toContain('check auditlog');
    expect(hop.messages[0]).toEqual(modelUserMessage(buildActiveContinuationAnchor()));
    expect(hop.messages).toHaveLength(2);
  });
});
