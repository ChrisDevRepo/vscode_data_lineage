/**
 * A follow-up that trips the semantic breaker still delivers the answer it already wrote.
 *
 * @remarks
 * UAT sess_1789702959746_3m3q1: the model researched the user's follow-up correctly and wrote the
 * answer, then spent three strikes trying to render it. `proseGate: 'buffer-until-tool'` holds
 * follow-up prose until a tool call succeeds, so the breaker discarded 1,672 chars of correct
 * analysis and the turn ended on a red error.
 *
 * `synthesisNode` already salvages its held draft; `followUpNode` did not. The answer is delivered
 * with a plain statement that the graph did not change, so prose that promised a change cannot
 * mislead.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { MAX_TOOL_SEMANTIC_FAILURES } from '../../../src/ai/agent/toolAttempt';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from '../sm/helpers/fixtures';
import { ScriptedModelPort, collectingSink, scriptedRegistry, validCall } from './helpers/scriptedModelPort';

const ORIGIN = '[ai].[spimport]';
const STAGE = '[ai].[stage]';
const ANSWER = 'Two other procedures write to ai.ErrorLog: spCleanOrders and spBuildSalesReport.';

const NODES: LineageNode[] = [
  makeNode({ id: ORIGIN, schema: 'ai', name: 'spImport', type: 'procedure', bodyScript: 'CREATE PROCEDURE [ai].[spImport] AS INSERT [ai].[stage] SELECT 1' }),
  makeNode({ id: STAGE, schema: 'ai', name: 'stage', type: 'table' }),
];
const EDGES: Array<[string, string]> = [[ORIGIN, STAGE]];

/** A session holding a completed exploration and its presented result graph. */
function seedCompletedSession(): { session: AiSession; epoch: number } {
  const model = makeModel(NODES, EDGES, ['ai']);
  const graph = makeGraph(NODES.map(node => ({ id: node.id, schema: node.schema, name: node.name, type: node.type })), EDGES);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;

  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: ORIGIN, question: 'Trace spImport downstream.', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
  driveEngine(engine, { tag: 'initial', limit: 20 });

  const epoch = session.beginTurn();
  session.stateMachine = engine;
  session.resultGraph = {
    nodeIds: NODES.map(node => node.id),
    edges: EDGES.map(([source, target]) => [source, target, 'write'] as [string, string, string]),
    source: 'blackboard',
    originNodeId: ORIGIN,
  };
  session.setClassification('business');
  session.enterCompleted(epoch);
  return { session, epoch };
}

describe('follow-up breaker salvage', () => {
  it('delivers the buffered answer instead of the turn error, and says the graph is unchanged', async () => {
    const { session, epoch } = seedCompletedSession();

    // Strike 1 carries no prose; the answer arrives with strike 2 and is buffered behind the
    // pending tool call, which is exactly what the breaker used to discard. Each payload differs:
    // a byte-identical resend is absorbed as unproductive and charges no strike, so identical ones
    // would never reach the breaker.
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('sup-1', 'lineage_start_exploration', { supplement: { nodeIds: [] }, question: 'attempt one' })] },
      { text: ANSWER, toolCalls: [validCall('sup-2', 'lineage_start_exploration', { supplement: { nodeIds: [] }, question: 'attempt two' })] },
      { toolCalls: [validCall('sup-3', 'lineage_start_exploration', { supplement: { nodeIds: [] }, question: 'attempt three' })] },
    ]);
    const { registry, invocations } = scriptedRegistry([{
      name: 'lineage_start_exploration',
      result: JSON.stringify({ error: REJECTION_CODES.supplementEmpty, hint: 'supplement requires at least one node id in supplement.nodeIds.' }),
    }]);

    const turn = collectingSink();
    const runtime = new AgentRuntime({
      threadId: 'follow-up-salvage',
      getSession: () => session,
      model: port as unknown as ModelPort,
      registry,
      sink: turn.sink,
      turnEpoch: epoch,
      maxRounds: 6,
    });

    const outcome = await runtime.run('who else writes to ai.ErrorLog?');

    expect(invocations).toHaveLength(MAX_TOOL_SEMANTIC_FAILURES);
    expect(outcome, 'the turn ends ok rather than on the breaker error').toBe('ok');
    const streamed = turn.events.filter(event => event.type === 'text').map(event => (event as { delta: string }).delta).join('');
    expect(streamed).toContain(ANSWER);
    expect(streamed).toContain('The graph was not changed');
  });
});
