/** Owns handlers/presentResult.ts functional CT coverage, origin closure and committed graph amendments. */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { ColumnEdge } from '../../../src/ai/sm/smTypes';

function completedWorld(model: DatabaseModel, resultGraph: ResultGraph) {
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = resultGraph;
  session.enterCompleted(epoch);
  const deliverPreview = vi.fn().mockResolvedValue('delivered');
  const services = {
    getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    budget: DEFAULT_TURN_TOKEN_BUDGET, deliverPreview,
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  return { session, services, deliverPreview };
}

function world(cs: boolean) {
  const id = (name: string) => normalizeName(`dbo.${name}`, cs);
  const origin = id('Report'), source = id('Source'), sibling = id('Sibling');
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] },
    { fullName: '[dbo].[Source]', type: 'table' }, { fullName: '[dbo].[Sibling]', type: 'table' },
  ], [], undefined, undefined, true, undefined, cs);
  return { ...completedWorld(model, { nodeIds: [origin, source, sibling], edges: [[source, origin, 'read'], [sibling, origin, 'read']], source: 'blackboard', originNodeId: origin }), model, origin, source, sibling };
}

function ctWorld() {
  const id = (name: string) => normalizeName(`dbo.${name}`, false);
  const origin = id('Report'), source = id('Source');
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT Amount AS Value FROM dbo.Source', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] },
    { fullName: '[dbo].[Source]', type: 'table' },
  ], [], undefined, undefined, true, undefined, false);
  const edge = { hop_node: origin, hop: 1, from_node: source, from_col: 'Amount', to_node: origin, to_col: 'Value' } as ColumnEdge;
  const { services } = completedWorld(model, {
    nodeIds: [origin, source], edges: [[source, origin, 'read']], source: 'column_trace', originNodeId: origin,
    columnAspect: { edges: [edge] },
  });
  return { services, origin, source };
}

function firstCall(origin: string) {
  return {
    name: 'Report column lineage', summary: 'Report.Value from Source.Amount.', is_update: true,
    sections: [{ label: 'Report', node_ids: [origin], text: 'Value is Source.Amount.' }],
    highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
  };
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

  it.each([undefined, false] as const)('commits a completed-phase prune with is_update=%s so the next render keeps it pruned', async isUpdate => {
    const { session, services, deliverPreview, origin, source, sibling } = world(cs);
    const render = (extra: Record<string, unknown>) => executePresentResult({ name: 'Report lineage', summary: 'Report sources.',
      sections: [{ label: 'Sources', node_ids: [origin, source], text: 'Source supplies the report.' }],
      highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }], ...extra,
    }, services).then(out => JSON.parse(out));
    const first = await render({ prune_node_ids: [sibling], ...(isUpdate === undefined ? {} : { is_update: isUpdate }) });
    expect(first.success).toBe(true);
    expect(first.node_count).toBe(2);
    expect(session.resultGraph?.nodeIds).toEqual([origin, source]);
    expect(session.resultGraph?.edges).toEqual([[source, origin, 'read']]);
    const second = await render({});
    expect(second.success).toBe(true);
    expect(second.node_count).toBe(2);
    expect(deliverPreview).toHaveBeenLastCalledWith(expect.objectContaining({ nodeIds: [origin, source] }));
  });

  it('commits a completed-phase add without is_update so the next render keeps the added node', async () => {
    const { session, services, deliverPreview, model, origin, source, sibling } = world(cs);
    model.edges.push({ source, target: origin, type: 'body' }, { source: sibling, target: origin, type: 'body' });
    session.resultGraph!.nodeIds = [origin, source];
    session.resultGraph!.edges = [[source, origin, 'read']];
    const render = (extra: Record<string, unknown>) => executePresentResult({ name: 'Report lineage', summary: 'Report sources.',
      sections: [{ label: 'Sources', node_ids: [origin, source, sibling], text: 'Source and sibling supply the report.' }],
      highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }], ...extra,
    }, services).then(out => JSON.parse(out));
    const first = await render({ add_node_ids: [sibling] });
    expect(first).toMatchObject({ success: true });
    expect(session.resultGraph?.nodeIds).toEqual([origin, source, sibling]);
    const second = await render({});
    expect(second.success).toBe(true);
    expect(deliverPreview).toHaveBeenLastCalledWith(expect.objectContaining({ nodeIds: expect.arrayContaining([origin, source, sibling]) }));
  });
});

describe('CT chain-coverage rejection', () => {
  it('names sections and notes as the repair fields, never highlight_groups', async () => {
    const { services, origin, source } = ctWorld();
    const result = JSON.parse(await executePresentResult(firstCall(origin), services));
    expect(result).toMatchObject({ code: 'validation' });
    expect(result.reason).toContain(source);
    expect(result.hint).toContain('only these corrected fields: sections, notes.');
    expect(result.hint).not.toContain('highlight_groups');
    expect(result.reason).not.toContain('highlight_groups');
  });

  it('a new section without text keeps the held draft and repeats the first repair mode, not a full resend', async () => {
    const { services, origin, source } = ctWorld();
    const first = JSON.parse(await executePresentResult(firstCall(origin), services));
    const session = services.getSession();
    expect(session.presentResultRepairDraft.get()?.sections).toHaveLength(1);

    const textless = { sections: [{ label: 'Upstream: Staging', node_ids: [source] }], notes: [{ node_id: origin, caption: 'Report view.' }] };
    const second = JSON.parse(await executePresentResult(textless, services));
    const third = JSON.parse(await executePresentResult(textless, services));

    for (const rejected of [second, third]) {
      expect(rejected).toMatchObject({ code: 'validation', issuePaths: ['sections'] });
      expect(rejected.reason).toContain('`Upstream: Staging`');
      expect(rejected.hint).toContain('only these corrected fields: sections, notes.');
      expect(rejected.hint).toContain('resend only the entries you add or change');
      expect(rejected.hint).toContain('a label not on file appends a new entry and needs its text');
      expect(rejected.hint).not.toContain('resend every field');
    }
    expect(second.hint).toBe(third.hint);
    expect(second.hint).toContain(first.hint);
    expect(session.presentResultRepairDraft.get()?.sections).toHaveLength(1);
  });

  it('the repair both hints permit is accepted: the missing id under one notes entry', async () => {
    const { services, origin, source } = ctWorld();
    await executePresentResult(firstCall(origin), services);
    const repaired = JSON.parse(await executePresentResult({
      notes: [{ node_id: source, caption: 'Holds the traced Amount column.' }],
    }, services));
    expect(repaired).toMatchObject({ success: true });
  });
});
