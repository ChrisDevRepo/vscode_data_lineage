/** Result amendments retain the declared origin and reject disconnected views without committing. */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';

function world(cs: boolean) {
  const id = (name: string) => normalizeName(`dbo.${name}`, cs);
  const origin = id('Report'), source = id('Source'), sibling = id('Sibling');
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] },
    { fullName: '[dbo].[Source]', type: 'table' }, { fullName: '[dbo].[Sibling]', type: 'table' },
  ], [], undefined, undefined, true, undefined, cs);
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = { nodeIds: [origin, source, sibling], edges: [[source, origin, 'read'], [sibling, origin, 'read']], source: 'blackboard', originNodeId: origin };
  session.enterCompleted(epoch);
  const deliverPreview = vi.fn().mockResolvedValue(true);
  const services = {
    getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    budget: DEFAULT_TURN_TOKEN_BUDGET, deliverPreview,
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  return { session, services, deliverPreview, origin, source, sibling };
}

describe.each([false, true])('result origin closure (CS=%s)', cs => {
  it('rejects removing a connector while retaining the origin without delivering islands', async () => {
    const { session, services, deliverPreview, origin, source, sibling } = world(cs);
    session.resultGraph!.edges = [[source, origin, 'read'], [sibling, source, 'read']];
    const before = structuredClone(session.resultGraph);
    const result = JSON.parse(await executePresentResult({ name: 'Report lineage', summary: 'Report sources.', is_update: true,
      prune_node_ids: [source], sections: [{ label: 'Sources', node_ids: [origin, sibling], text: 'Recorded report sources.' }], highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
      }, services));
    expect(result).toMatchObject({ code: 'validation' });
    expect(result.reason).toContain('disconnected');
    expect(result.reason).toContain(sibling);
    expect(session.resultGraph).toEqual(before);
    expect(deliverPreview).not.toHaveBeenCalled();
  });

  it.each(['origin', 'all'] as const)('rejects pruning %s atomically and permits a connected retry', async selection => {
    const { session, services, deliverPreview, origin, source, sibling } = world(cs);
    const before = structuredClone(session.resultGraph);
    const result = JSON.parse(await executePresentResult({ name: 'Report lineage', summary: 'Report sources.', is_update: true,
      prune_node_ids: selection === 'all' ? [origin, source, sibling] : [cs ? 'dbo.Report' : 'DBO.REPORT'],
      sections: [{ label: 'Sources', node_ids: selection === 'all' ? [] : [source, sibling], text: 'Recorded report sources.' }], highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
    }, services));
    expect(result).toMatchObject({ code: 'validation' });
    expect(result.reason).toContain(origin);
    expect(session.resultGraph).toEqual(before);
    expect(session.presentationArtifact).toBeNull();
    expect(deliverPreview).not.toHaveBeenCalled();
    const corrected = JSON.parse(await executePresentResult({ name: 'Report lineage', summary: 'Report sources.', is_update: true,
      prune_node_ids: [sibling], sections: [{ label: 'Sources', node_ids: [origin, source], text: 'Source supplies the report.' }], highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
    }, services));
    expect(corrected.success).toBe(true);
    expect(session.resultGraph?.nodeIds).toEqual([origin, source]);
    expect(deliverPreview).toHaveBeenCalledTimes(1);
  });
});
