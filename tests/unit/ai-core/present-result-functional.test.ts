/** Owns handlers/presentResult.ts functional CT coverage, origin closure and committed graph amendments. */
import { describe, expect, it, vi } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import type { ResultGraph } from '../../../src/ai/session/types';

function completedWorld(model: DatabaseModel, resultGraph: ResultGraph) {
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = resultGraph;
  session.enterCompleted(epoch);
  const deliverPreview = vi.fn().mockResolvedValue('delivered');
  const services = {
    getSession: () => session,
    turnEpoch: () => epoch,
    requireModel: () => model,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    budget: DEFAULT_TURN_TOKEN_BUDGET,
    deliverPreview,
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => {
      throw error;
    },
  } as unknown as ToolServices;
  return { session, services, deliverPreview };
}

/** A report call with the origin highlighted and one Sources section; `extra` overrides or adds fields. */
const sourcesReport = (
  origin: string,
  nodeIds: string[],
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  name: 'Report lineage',
  summary: 'Report sources.',
  sections: [{ label: 'Sources', node_ids: nodeIds, text }],
  highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
  ...extra,
});

function world(cs: boolean) {
  const id = (name: string) => normalizeName(`dbo.${name}`, cs);
  const origin = id('Report'),
    source = id('Source'),
    sibling = id('Sibling');
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Report]',
        type: 'view',
        bodyScript: 'SELECT Value FROM dbo.Source',
        columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
      },
      { fullName: '[dbo].[Source]', type: 'table' },
      { fullName: '[dbo].[Sibling]', type: 'table' },
    ],
    [],
    undefined,
    undefined,
    true,
    undefined,
    cs,
  );
  return {
    ...completedWorld(model, {
      nodeIds: [origin, source, sibling],
      edges: [
        [source, origin, 'read'],
        [sibling, origin, 'read'],
      ],
      source: 'blackboard',
      originNodeId: origin,
    }),
    model,
    origin,
    source,
    sibling,
  };
}

describe.each([false, true])('result origin closure (CS=%s)', (cs) => {
  it('rejects removing a connector while retaining the origin without delivering islands', async () => {
    const { session, services, deliverPreview, origin, source, sibling } =
      world(cs);
    session.resultGraph!.edges = [
      [source, origin, 'read'],
      [sibling, source, 'read'],
    ];
    const before = structuredClone(session.resultGraph);
    const result = JSON.parse(
      await executePresentResult(
        sourcesReport(origin, [origin, sibling], 'Recorded report sources.', {
          is_update: true,
          prune_node_ids: [source],
        }),
        services,
      ),
    );
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(result.errors).toContainEqual({
      path: '',
      code: 'disconnects_view',
    });
    expect(result.reason, 'no echoed id').not.toContain(sibling);
    expect(session.resultGraph).toEqual(before);
    expect(deliverPreview).not.toHaveBeenCalled();
  });
});

it('retains frozen asked columns from the completed engine through result storage and the preview artifact', async () => {
  const origin = normalizeName('dbo.Target', false);
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Target]',
        type: 'table',
        columns: ['Value', 'Unmapped'].map((name) => ({
          name,
          type: 'int',
          nullable: 'NULL',
          extra: '',
        })),
      },
    ],
    [],
  );
  const engine = new NavigationEngine(
    model,
    buildGraphologyGraph(model),
    () => {},
    {},
  );
  expect(
    engine.init({
      origin,
      question: 'Trace Value and Unmapped.',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['Value', 'Unmapped'],
      depthIntent: {
        upstream: { levels: 'all', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toEqual({ ok: true });
  engine.getHopContext();
  const fullResult = engine.getResult();
  const { session, services } = completedWorld(model, {
    nodeIds: [],
    edges: [],
    source: 'column_trace',
  });
  session.stateMachine = engine;
  session.storeSmResult(fullResult, session.turnEpoch);
  const expected = { node: origin, columns: ['Value', 'Unmapped'] };
  expect(session.resultGraph?.columnAspect).toEqual({
    edges: [],
    requested: expected,
  });
  const answer = JSON.parse(
    await executePresentResult(
      {
        name: 'Asked columns',
        summary: 'No accepted value mappings.',
        sections: [
          {
            label: 'Target',
            node_ids: [origin],
            text: 'No value source was mapped.',
          },
        ],
        highlight_groups: [
          { label: 'Target', color: 'target', node_ids: [origin] },
        ],
      },
      services,
    ),
  );
  expect(answer).toMatchObject({ success: true });
  expect(session.presentationArtifact?.aiMetadata.columnAspect).toEqual({
    edges: [],
    requested: expected,
  });
  expect(session.presentationArtifact?.aiMetadata).not.toHaveProperty(
    'nodeVerdicts',
  );
  expect(answer).not.toHaveProperty('nodeVerdicts');
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '## Column Chain',
  );
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '`' + origin + '.Value`',
  );
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '`' + origin + '.Unmapped`',
  );
  expect(fullResult.columnAspect?.target_columns).toEqual([
    'Value',
    'Unmapped',
  ]);
  expect(session.resultGraph?.columnAspect?.requested?.columns).not.toBe(
    fullResult.columnAspect?.target_columns,
  );
  expect(
    session.presentationArtifact?.aiMetadata.columnAspect?.requested?.columns,
  ).not.toBe(session.resultGraph?.columnAspect?.requested?.columns);
});
