/** Saved checkpoint text stays historical while current-object checks respect encoding ownership. */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { aiRunStorageKey, hashDdl, readStoredRun, type StoredAiRun } from '../../../src/ai/session/runStore';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { buildModel } from '../../../src/engine/modelBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import { loadParseRules } from '../helpers/testUtils';

const escaped = '[dbo].[a]]b]', twice = '[dbo].[a]]]]b]';
const ddl = 'SELECT 1 AS ID;';
function record(id: string, current: boolean): StoredAiRun {
  const node = makeNode({ id, schema: 'dbo', name: id, type: 'view', bodyScript: ddl });
  const model = makeModel([node], [], ['dbo']);
  const engine = new NavigationEngine(model, makeGraph([node], []), () => {}, {});
  expect(engine.init({ origin: id, question: 'Inspect output', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: 'Historical output.', sections: [{ angle: 'technical', text: 'Historical SQL.' }] })).toMatchObject({ ok: true });
  return { schemaVersion: 1, runId: 'saved', savedAt: '2026-01-01', origin: id, ddlHashes: { [id]: hashDdl(ddl) }, snapshot: engine.toJSON(), ...(current ? { nodeIdEncodingVersion: 2 } : {}) };
}
async function recall(raw: string, ids: string[], current = false, model?: DatabaseModel) {
  const stored = record(raw, current);
  const persisted = JSON.parse(JSON.stringify(stored));
  const read = readStoredRun({ get: <T,>(key: string) => key === aiRunStorageKey('saved-view') ? persisted as T : undefined }, 'saved-view')!;
  const session = new AiSession();
  session.model = model ?? makeModel(ids.map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' })), [], ['dbo']);
  for (const id of ids) session.columnStore.setDdl(id, ddl);
  session.uiState = { screenState: { bookmark: { id: 'saved-view', source: 'ai' } } };
  const noop = () => {};
  const logger = { info: noop, debug: noop, warn: noop, error: noop } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, logger, () => undefined, undefined, { getStoredRun: () => read });
  const result = JSON.parse(String(await registry.invoke('lineage_get_screen_state', { ids: [raw] })));
  expect(read.snapshot).toEqual(stored.snapshot);
  return { result, read, stored };
}

describe('checkpoint identity ownership', () => {
  it('recovers a unique legacy ID for presence/hash checks without rewriting historical IDs or text', async () => {
    const { result } = await recall('[dbo].[a]b]', [escaped, '[dbo].[ab]']);
    expect(result.objects).toEqual([expect.objectContaining({ id: '[dbo].[a]b]', decision: 'analyze', summary: 'Historical output.', in_current_model: true, stale: false })]);
  });
  it('does not claim an ambiguous legacy ID is a current fresh twin', async () => {
    const { result } = await recall(escaped, [escaped, twice]);
    expect(result.objects).toEqual([expect.objectContaining({ id: escaped, decision: 'analyze', in_current_model: false, stale: true })]);
  });
  it('preserves the current encoding marker on a new persisted record', async () => {
    const { result, read } = await recall(escaped, [escaped, twice], true);
    expect(read).toMatchObject({ nodeIdEncodingVersion: 2 });
    expect(result.objects).toEqual([expect.objectContaining({ id: escaped, in_current_model: true, stale: false })]);
  });
  it('continues to recall ordinary legacy IDs unchanged', async () => {
    const { result } = await recall('[dbo].[ordinary]', ['[dbo].[ordinary]']);
    expect(result.objects).toEqual([expect.objectContaining({ id: '[dbo].[ordinary]', in_current_model: true, stale: false })]);
  });
  it.each([false, true])('does not claim a collapsed old remote ID belongs to its new virtual twin (CS=%s)', async cs => {
    loadParseRules();
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT * FROM "Remote"."dbo"."a]]b"; SELECT * FROM "Remote"."dbo"."a]b";' }], [], undefined, 'Local', true, undefined, cs);
    const raw = cs ? '[Remote].[dbo].[a]]b]' : '[remote].[dbo].[a]b]';
    const { result } = await recall(raw, model.nodes.map(node => node.id), false, model);
    expect(result.objects).toEqual([expect.objectContaining({ id: raw, decision: 'analyze', in_current_model: false, stale: true })]);
  });
  it.each([false, true])('retains exact current remote IDs for checkpoint presence/hash checks (CS=%s)', async cs => {
    loadParseRules();
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT * FROM "Remote"."dbo"."a]]b"; SELECT * FROM "Remote"."dbo"."a]b";' }], [], undefined, 'Local', true, undefined, cs);
    const raw = cs ? '[Remote].[dbo].[a]]b]' : '[remote].[dbo].[a]]b]';
    const { result } = await recall(raw, model.nodes.map(node => node.id), true, model);
    expect(result.objects).toEqual([expect.objectContaining({ id: raw, in_current_model: true, stale: false })]);
  });
  it.each([false, true])('does not claim repeated-quote legacy remote bytes belong to a fresh current twin (CS=%s)', async cs => {
    loadParseRules();
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT ID FROM [Remote].[dbo].[a""""b]; SELECT ID FROM [Remote].[dbo].[a"b];' }], [], undefined, 'Local', true, undefined, cs);
    const raw = cs ? '[Remote].[dbo].[a"b]' : '[remote].[dbo].[a"b]';
    const { result } = await recall(raw, model.nodes.map(node => node.id), false, model);
    expect(result.objects).toEqual([expect.objectContaining({ id: raw, decision: 'analyze', in_current_model: false, stale: true })]);
  });
});
