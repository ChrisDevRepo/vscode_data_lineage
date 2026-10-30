import { expect } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph, makeIndexedModel, makeNode } from './modelFixtures';

/** A session holding a two-node result graph (plus an optional in-scope third object), and `send` to drive the production `executePresentResult` handler against it. */
export function draftWorld(
  options: { inScope?: boolean; synthesis?: boolean } = {},
) {
  const ids = ['[dbo].[Result]', '[dbo].[Source]', '[dbo].[Outside]'];
  const pairs: Array<[string, string]> = [
    [ids[1], ids[0]],
    ...(options.inScope ? [[ids[2], ids[0]] as [string, string]] : []),
  ];
  const model = makeIndexedModel(
    ids.map((id) => makeNode({ id, schema: 'dbo', name: id, type: 'table' })),
    pairs,
  );
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = {
    nodeIds: ids.slice(0, 2),
    edges: [[ids[1], ids[0], 'read']],
    source: 'blackboard',
    originNodeId: ids[0],
  };
  if (options.inScope) {
    const engine = new NavigationEngine(
      model,
      makeGraph(model.nodes, pairs),
      () => {},
      {},
    );
    session.stateMachine = engine;
    expect(
      engine.init({
        origin: ids[0],
        question: 'Explain Result.',
        analysisMode: 'bb',
        direction: 'upstream',
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
  }
  if (options.synthesis) session.enterExploring(epoch);
  else session.enterCompleted(epoch);
  const logs: string[] = [];
  const services = {
    getSession: () => session,
    turnEpoch: () => epoch,
    requireModel: () => model,
    logger: {
      debug: (message: string) => logs.push(message),
      info() {},
      warn() {},
      error() {},
    },
    deliverPreview: async () => 'delivered',
    logAndReturn: (_tool: string, value: unknown) => JSON.stringify(value),
    toolError: (_tool: string, error: unknown) => {
      throw error;
    },
  } as unknown as ToolServices;
  const report = {
    name: 'Result',
    summary: 'Source feeds Result.',
    title: 'Held title sentinel',
    sections: [
      {
        label: 'Flow',
        node_ids: ids.slice(0, 2),
        text: 'Source feeds the Result.',
      },
    ],
    highlight_groups: [
      { label: 'Flow', color: 'source' as const, node_ids: ids.slice(0, 2) },
    ],
  };
  return {
    session,
    ids,
    report,
    logs,
    send: async (input: unknown) =>
      JSON.parse(await executePresentResult(input, services)),
  };
}
