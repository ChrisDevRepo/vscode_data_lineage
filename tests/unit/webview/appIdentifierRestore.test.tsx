// @vitest-environment jsdom
/** Real save/persist/reopen path distinguishes legacy aliases from current SQL identities. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG, type DatabaseModel, type FilterState } from '../../../src/engine/types';
import { migrateProjectStore, serializeFilter, type FilterProfile } from '../../../src/engine/projectStore';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { makeModel, makeNode } from '../sm/helpers/fixtures';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(loadParseRules);

type CanvasProps = {
  flowNodes: { id: string }[];
  filter: FilterState;
  activeAdvancedProfile: FilterProfile | null;
  pendingPositions?: FilterProfile['positions'];
  onApplyView: (profile: FilterProfile) => void;
  onSaveView: (name: string) => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({ GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let posted: { type: string; text?: string; profile?: FilterProfile }[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  posted = []; canvas.props = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const config = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
const escaped = '[dbo].[a]]b]', twice = '[dbo].[a]]]]b]', ordinary = '[dbo].[ab]';
const modelFor = (...ids: string[]): DatabaseModel => {
  const anchor = '[dbo].[reader]';
  const model = makeModel([...ids.map(id => makeNode({ id, schema: 'dbo', name: id, type: 'table' })), makeNode({ id: anchor, schema: 'dbo', name: 'reader', type: 'view' })], ids.map(id => [id, anchor]), ['dbo']);
  model.schemas[0].nodeCount = ids.length + 1;
  model.schemas[0].types.table = ids.length;
  model.schemas[0].types.view = 1;
  for (const node of model.nodes) model.catalog[node.id] = { schema: node.schema, name: node.name, type: node.type };
  return model;
};
function post(data: object): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } })));
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });
async function open(model: DatabaseModel): Promise<void> {
  const { App } = await import('../../../src/components/App');
  act(() => root.render(<VsCodeProvider api={{ postMessage: (message: unknown) => posted.push(message as { type: string }) } as never}><App /></VsCodeProvider>));
  post({ type: 'projects-list', lastOpenedId: 'synthetic', projects: [{ id: 'synthetic', name: 'Synthetic', createdAt: '2026-01-01', updatedAt: '2026-01-01', connection: { type: 'dacpac', path: '/synthetic.dacpac', displayName: 'Synthetic', schemas: ['dbo'] } }] });
  post({ type: 'dacpac-model', model, config, sourceName: 'Synthetic', autoVisualize: true });
  await settle();
}
function saved(raw: string, current = false): FilterProfile {
  return {
    id: 'saved-view', name: 'Saved', createdAt: '2026-01-01', source: 'ai', graphMode: 'full',
    ...(current ? { nodeIdEncodingVersion: 2 } : {}),
    filter: { ...serializeFilter(canvas.props!.filter), allowlistNodeIds: [raw] },
    positions: { [raw]: { x: 51, y: 72 } },
    expandedSchemaView: { focusNodeId: raw, expandedSchemas: ['dbo'] },
    aiMetadata: { createdAt: '2026-01-01', modelName: 'synthetic', highlightGroups: [{ label: 'Input', color: 'source', nodeIds: [raw] }], badges: [{ nodeId: raw, text: 'Input' }], notes: [{ nodeId: raw, text: 'Captured' }], nodeVerdicts: [{ nodeId: raw, verdict: 'analyze' }], columnAspect: { edges: [{ hopNode: raw, fromNode: raw, toNode: raw, fromCol: 'ID', toCol: 'ID' }] } },
  };
}
function persist(profile: FilterProfile): FilterProfile {
  const store = migrateProjectStore(JSON.parse(JSON.stringify({ schemaVersion: 1, projects: [{ id: 'synthetic', name: 'Synthetic', createdAt: '2026-01-01', updatedAt: '2026-01-01', connection: { type: 'dacpac', path: '/synthetic.dacpac', displayName: 'Synthetic', schemas: ['dbo'] }, filterProfiles: [profile] }], lastOpenedId: 'synthetic' })));
  return store.projects[0].filterProfiles![0];
}

describe('saved identifier restore', () => {
  it('recovers a unique legacy escaped identity through filter, positions and AI annotations', async () => {
    await open(modelFor(escaped, ordinary));
    const profile = persist(saved('[dbo].[a]b]'));
    const before = structuredClone(profile);
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([escaped]);
    expect(canvas.props!.flowNodes.map(node => node.id)).toEqual([escaped]);
    expect(canvas.props!.pendingPositions).toEqual({ [escaped]: { x: 51, y: 72 } });
    expect(canvas.props!.activeAdvancedProfile?.aiMetadata).toMatchObject({ badges: [{ nodeId: escaped }], notes: [{ nodeId: escaped }], highlightGroups: [{ nodeIds: [escaped] }], nodeVerdicts: [{ nodeId: escaped }], columnAspect: { edges: [{ hopNode: escaped, fromNode: escaped, toNode: escaped }] } });
    expect(canvas.props!.activeAdvancedProfile?.expandedSchemaView?.focusNodeId).toBe(escaped);
    expect(profile).toEqual(before);
  }, 15000);
  it('leaves ambiguous legacy bytes unresolved instead of restoring the valid current twin', async () => {
    await open(modelFor(escaped, twice));
    const profile = persist(saved(escaped));
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(canvas.props!.pendingPositions ?? {}).toEqual({});
    expect(canvas.props!.activeAdvancedProfile?.aiMetadata?.badges).toEqual([]);
    expect(canvas.props!.activeAdvancedProfile?.aiMetadata?.columnAspect?.edges).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
    expect(profile.filter.allowlistNodeIds).toEqual([escaped]);
  }, 15000);
  it('persists current encoding on new saves and reopens its exact canonical twin', async () => {
    await open(modelFor(escaped, twice));
    act(() => canvas.props!.onApplyView(saved(escaped, true))); await settle();
    act(() => canvas.props!.onSaveView('Current encoding'));
    const profile = persist([...posted].reverse().find(message => message.type === 'save-view')!.profile!);
    expect(profile).toMatchObject({ nodeIdEncodingVersion: 2 });
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([escaped]);
    expect(canvas.props!.flowNodes.map(node => node.id)).toEqual([escaped]);
  }, 15000);
  it('continues to restore ordinary legacy IDs unchanged', async () => {
    await open(modelFor(ordinary));
    act(() => canvas.props!.onApplyView(persist(saved(ordinary)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([ordinary]);
    expect(canvas.props!.pendingPositions).toEqual({ [ordinary]: { x: 51, y: 72 } });
    expect(posted.some(message => message.type === 'show-warning')).toBe(false);
  }, 15000);
  it.each(['__schema__dbo', '__expandedschemaviewcluster__dbo'])('preserves the existing saved layout position %s', async layoutId => {
    await open(modelFor(ordinary));
    const profile = persist({ ...saved(ordinary), graphMode: 'overview', positions: { [layoutId]: { x: 51, y: 72 } } });
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect(canvas.props!.pendingPositions).toEqual(profile.positions);
    expect(posted.some(message => message.type === 'show-warning')).toBe(false);
  }, 15000);
  it.each([false, true])('does not restore opposite-delimiter legacy twins (CS=%s)', async cs => {
    const quoted = '[dbo].[a""b]', twin = '[dbo].[a"b]';
    const model = modelFor(quoted, twin);
    model.identifierCaseSensitive = cs;
    Object.assign(model.nodes[0], { name: 'a""b', fullName: quoted });
    Object.assign(model.nodes[1], { name: 'a"b', fullName: twin });
    await open(model);
    act(() => canvas.props!.onApplyView(persist(saved(twin)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
  }, 15000);
  it.each([false, true])('does not restore an old double-quoted delimiter alias to its bracket twin (CS=%s)', async cs => {
    const model = modelFor(twice, escaped);
    model.identifierCaseSensitive = cs;
    Object.assign(model.nodes[0], { name: 'a]]b', fullName: '"dbo"."a]]b"' });
    Object.assign(model.nodes[1], { name: 'a]b', fullName: escaped });
    await open(model);
    act(() => canvas.props!.onApplyView(persist(saved(cs ? escaped : '[dbo].[a]b]')))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
  }, 15000);
  it('recovers a unique old schema spelling without expanding its saved selection', async () => {
    const model = modelFor('[a""b].[t]');
    Object.assign(model.nodes[0], { name: 't', schema: 'a""b' });
    model.schemas.push({ ...model.schemas[0], name: 'a""b' });
    await open(model);
    const profile = persist({ ...saved(ordinary), source: 'user', filter: { ...serializeFilter(canvas.props!.filter), schemas: ['a"b'], focusSchemas: ['a"b'] }, positions: undefined, aiMetadata: undefined, expandedSchemaView: { focusNodeId: '[a"b].[t]', expandedSchemas: ['a"b'] } });
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.schemas]).toEqual(['a""b']);
    expect([...canvas.props!.filter.focusSchemas]).toEqual(['a""b']);
  }, 15000);
  it('does not select a current schema twin from an ambiguous legacy schema spelling', async () => {
    const model = modelFor('[a"b].[t]', '[a""b].[t]');
    Object.assign(model.nodes[0], { schema: 'a"b' });
    Object.assign(model.nodes[1], { schema: 'a""b' });
    model.schemas.push({ ...model.schemas[0], name: 'a"b' }, { ...model.schemas[0], name: 'a""b' });
    await open(model);
    const profile = persist({ ...saved(ordinary), source: 'user', filter: { ...serializeFilter(canvas.props!.filter), schemas: ['a"b'] }, positions: undefined, aiMetadata: undefined, expandedSchemaView: undefined });
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect(canvas.props!.filter.schemas).toEqual(new Set());
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
  }, 15000);
  it('reopens a newly saved current schema spelling without treating it as a legacy alias', async () => {
    const model = modelFor('[a"b].[t]', '[a""b].[t]');
    Object.assign(model.nodes[0], { schema: 'a"b' }); Object.assign(model.nodes[1], { schema: 'a""b' });
    model.schemas.push({ ...model.schemas[0], name: 'a"b' }, { ...model.schemas[0], name: 'a""b' });
    await open(model);
    const profile = persist({ ...saved(ordinary, true), source: 'user', filter: { ...serializeFilter(canvas.props!.filter), schemas: ['a"b'] }, positions: undefined, aiMetadata: undefined, expandedSchemaView: undefined });
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.schemas]).toEqual(['a"b']);
    expect(posted.some(message => message.type === 'show-warning')).toBe(false);
  }, 15000);
  it('does not restore a legacy URL hash to a catalog object occupying the same ID', async () => {
    const short = '[__ext__].[6b68923e]';
    const model = modelFor(short);
    const file = makeNode({ id: '[__ext__].[collision_file]', schema: '', name: 'Aa.csv', type: 'external', externalType: 'file', externalUrl: 'https://example.test/Aa.csv' });
    model.nodes.push(file); model.edges.push({ source: file.id, target: '[dbo].[reader]', type: 'body' });
    model.catalog[file.id] = { schema: '', name: file.name, type: 'external', externalType: 'file' };
    await open(model);
    act(() => canvas.props!.onApplyView(persist(saved(short)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
  }, 15000);
  it('continues to reopen an unambiguous saved URL short ID', async () => {
    const short = '[__ext__].[6b68923e]';
    const model = modelFor(short);
    Object.assign(model.nodes[0], { schema: '', type: 'external', externalType: 'file', externalUrl: 'https://example.test/Aa.csv' });
    await open(model);
    act(() => canvas.props!.onApplyView(persist(saved(short)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([short]);
    expect(canvas.props!.flowNodes.map(node => node.id)).toEqual([short]);
  }, 15000);
  it('reopens a current file view after another URL with the old hash is loaded', async () => {
    const urls = ['https://example.test/Aa.csv', 'https://example.test/BB.csv'];
    const procedures = urls.map((url, i) => ({ fullName: `[dbo].[reader${i}]`, type: 'procedure' as const, bodyScript: `SELECT * FROM OPENROWSET(BULK '${url}', FORMAT='CSV') AS src;` }));
    const original = buildModel([procedures[0]], []);
    const id = original.nodes.find(node => node.externalUrl === urls[0])!.id;
    await open(original);
    const profile = persist(saved(id, true));
    post({ type: 'dacpac-model', model: buildModel(procedures, []), config, sourceName: 'Synthetic', autoVisualize: true });
    await settle();
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([id]);
    expect(canvas.props!.flowNodes.map(node => node.id)).toEqual([id]);
    expect(canvas.props!.pendingPositions).toEqual({ [id]: { x: 51, y: 72 } });
    expect(canvas.props!.activeAdvancedProfile?.aiMetadata).toMatchObject({ badges: [{ nodeId: id }], columnAspect: { edges: [{ hopNode: id, fromNode: id, toNode: id }] } });
    expect(posted.some(message => message.type === 'show-warning')).toBe(false);
  }, 15000);
  it.each([false, true])('restores a previously saved short file ID into the new model (current=%s)', current => {
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: "SELECT * FROM OPENROWSET(BULK 'https://example.test/Aa.csv', FORMAT='CSV') AS src;" }], []);
    return (async () => {
      await open(model);
      act(() => canvas.props!.onApplyView(persist(saved('[__ext__].[6b68923e]', current)))); await settle();
      const id = model.nodes.find(node => node.externalType === 'file')!.id;
      expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([id]);
      expect(canvas.props!.pendingPositions).toEqual({ [id]: { x: 51, y: 72 } });
      expect(posted.some(message => message.type === 'show-warning')).toBe(false);
    })();
  }, 15000);
  it.each([false, true])('does not restore a collapsed old virtual reference to its new remote twin (CS=%s)', async cs => {
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT * FROM "Remote"."dbo"."a]]b"; SELECT * FROM "Remote"."dbo"."a]b";' }], [], undefined, 'Local', true, undefined, cs);
    expect(model.nodes.filter(node => node.externalType === 'db')).toHaveLength(2);
    await open(model);
    const raw = cs ? '[Remote].[dbo].[a]]b]' : '[remote].[dbo].[a]b]';
    act(() => canvas.props!.onApplyView(persist(saved(raw)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
  }, 15000);
  it.each([false, true])('restores the exact remote canonical twin with a current marker (CS=%s)', async cs => {
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT * FROM "Remote"."dbo"."a]]b"; SELECT * FROM "Remote"."dbo"."a]b";' }], [], undefined, 'Local', true, undefined, cs);
    await open(model);
    const id = cs ? '[Remote].[dbo].[a]]b]' : '[remote].[dbo].[a]]b]';
    act(() => canvas.props!.onApplyView(persist(saved(id, true)))); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([id]);
    expect(canvas.props!.flowNodes.map(node => node.id)).toEqual([id]);
  }, 15000);
  it.each([false, true])('does not restore repeated-quote legacy remote bytes to their current twin (CS=%s)', async cs => {
    const model = buildModel([{ fullName: '[dbo].[reader]', type: 'procedure', bodyScript: 'SELECT ID FROM [Remote].[dbo].[a""""b]; SELECT ID FROM [Remote].[dbo].[a"b];' }], [], undefined, 'Local', true, undefined, cs);
    expect(model.nodes.filter(node => node.externalType === 'db')).toHaveLength(2);
    await open(model);
    const raw = cs ? '[Remote].[dbo].[a"b]' : '[remote].[dbo].[a"b]';
    const profile = persist(saved(raw));
    const before = structuredClone(profile);
    act(() => canvas.props!.onApplyView(profile)); await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual([]);
    expect(canvas.props!.flowNodes).toEqual([]);
    expect(posted.some(message => message.type === 'show-warning' && message.text?.includes('unresolved'))).toBe(true);
    expect(profile).toEqual(before);
  }, 15000);
});
