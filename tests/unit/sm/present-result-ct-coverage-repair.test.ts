/** The CT chain-coverage rejection authorizes repair only in the fields its own check counts. */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import type { ColumnEdge } from '../../../src/ai/sm/smTypes';

function ctWorld() {
  const id = (name: string) => normalizeName(`dbo.${name}`, false);
  const origin = id('Report'), source = id('Source');
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT Amount AS Value FROM dbo.Source', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] },
    { fullName: '[dbo].[Source]', type: 'table' },
  ], [], undefined, undefined, true, undefined, false);
  const session = new AiSession();
  const epoch = session.beginTurn();
  const edge = { hop_node: origin, hop: 1, from_node: source, from_col: 'Amount', to_node: origin, to_col: 'Value' } as ColumnEdge;
  session.resultGraph = {
    nodeIds: [origin, source], edges: [[source, origin, 'read']], source: 'column_trace', originNodeId: origin,
    columnAspect: { edges: [edge] },
  };
  session.enterCompleted(epoch);
  const services = {
    getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    budget: DEFAULT_TURN_TOKEN_BUDGET, deliverPreview: vi.fn().mockResolvedValue('delivered'),
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  return { services, origin, source };
}

function firstCall(origin: string) {
  return {
    name: 'Report column lineage', summary: 'Report.Value from Source.Amount.', is_update: true,
    sections: [{ label: 'Report', node_ids: [origin], text: 'Value is Source.Amount.' }],
    highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
  };
}

describe('CT chain-coverage rejection', () => {
  it('names sections and notes as the repair fields, never highlight_groups', async () => {
    const { services, origin, source } = ctWorld();
    const result = JSON.parse(await executePresentResult({
      name: 'Report column lineage', summary: 'Report.Value from Source.Amount.', is_update: true,
      sections: [{ label: 'Report', node_ids: [origin], text: 'Value is Source.Amount.' }],
      highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }],
    }, services));
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
