// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG, type FilterState } from '../../../src/engine/types';
import { serializeFilter, type FilterProfile } from '../../../src/engine/projectStore';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

type CanvasProps = {
  flowNodes: { id: string }[];
  filter: FilterState;
  aiPreview: { nodeIds: Set<string> } | null;
  activeViewId: string | null;
  activeAdvancedProfile: FilterProfile | null;
  pendingPositions?: FilterProfile['positions'];
  expandedSchemas?: Set<string>;
  showExpandedSchemaClusters: boolean;
  onSelectNoneSchemas: (schemas: string[]) => void;
  onToggleSchema: (schema: string) => void;
  onApplyView: (profile: FilterProfile) => void;
  onRefresh: () => void;
  onRemoveFromView: (id: string) => void;
  onSaveAiBookmark: (name: string) => void;
  onSaveView: (name: string) => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let posted: {type: string; text?: string; profile?: FilterProfile}[];
const w = window as unknown as {vscode?: {postMessage: (m: unknown) => void}};
beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
  canvas.props = null;
  w.vscode = {postMessage: m => posted.push(m as {type: string})};
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
  vi.useRealTimers();
});
const config = {...DEFAULT_CONFIG, overview: {...DEFAULT_CONFIG.overview, enabled: false}};
const {model} = generateDwhModel({objectCount: 40, seed: 1, profile: {externalRefCount: 0, schemaCount: 3}});
function post(data: object): void {
  act(() => window.dispatchEvent(new MessageEvent('message', {data: {protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data}})));
}
const settle = () => act(async () => {await vi.advanceTimersByTimeAsync(1300);});
async function openSource(): Promise<void> {
  const {App} = await import('../../../src/components/App');
  act(() => root.render(<VsCodeProvider api={{postMessage: (m: unknown) => posted.push(m as {type: string})} as never}><App /></VsCodeProvider>));
  post({ type: 'projects-list', lastOpenedId: 'review-project', projects: [{
    id: 'review-project', name: 'Review', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    connection: { type: 'dacpac', path: '/synthetic.dacpac', displayName: 'Review', schemas: model.schemas.map(s => s.name) },
  }] });
  post({type: 'dacpac-model', model, config, sourceName: 'Review', autoVisualize: true});
  await settle();
}
async function openNarrowedSource(): Promise<void> {
  await openSource();
  const first = model.schemas[0].name;
  act(() => canvas.props!.onSelectNoneSchemas(model.schemas.map(s => s.name)));
  act(() => canvas.props!.onToggleSchema(first));
  post({type: 'rebuild-config', config: {...config, maxNodes: model.nodes.filter(n => n.schema === first).length}});
  await settle();
  posted.length = 0;
}
function profile(): FilterProfile {
  return {
    id: 'large-view', name: 'Large view', createdAt: '2026-10-10T00:00:00Z', graphMode: 'full',
    positions: {[model.nodes[0].id]: {x: 987, y: 654}},
    expandedSchemaView: {focusNodeId: model.nodes[0].id, expandedSchemas: model.schemas.map(s => s.name)},
    showExpandedSchemaClusters: false,
    filter: serializeFilter({...canvas.props!.filter, schemas: new Set(model.schemas.map(s => s.name))}),
  };
}
function snapshot() {
  const p = canvas.props!;
  return {filter: p.filter, activeViewId: p.activeViewId, pendingPositions: p.pendingPositions,
    expandedSchemas: p.expandedSchemas, showExpandedSchemaClusters: p.showExpandedSchemaClusters};
}

describe('bookmark selection admission', () => {
  it('refuses an over-limit ordinary bookmark without committing any saved-view state', async () => {
    await openNarrowedSource();
    const before = snapshot();
    act(() => canvas.props!.onApplyView(profile()));
    expect(posted.some(m => m.type === 'show-warning')).toBe(true);
    expect(snapshot()).toEqual(before);
  }, 15000);

  it('retains advanced bookmark scope admission independently of its saved schema selection', async () => {
    await openNarrowedSource();
    const advanced = {...profile(), id: 'advanced-view', source: 'ai' as const};
    advanced.filter.allowlistNodeIds = [model.nodes[0].id];
    act(() => canvas.props!.onApplyView(advanced));
    expect(canvas.props!.activeViewId).toBe(advanced.id);
    expect(canvas.props!.activeAdvancedProfile?.id).toBe(advanced.id);
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual(advanced.filter.allowlistNodeIds);
  }, 15000);
});

describe('scoped view preservation', () => {
  function preview(ids: string[]) {
    post({ type: 'ai-view-preview', name: 'Scoped preview', nodeIds: ids, aiMetadata: {
      createdAt: '2026-01-01', modelName: 'test', highlightGroups: [], badges: [],
    } });
  }

  it.each(['preview', 'bookmark'])('keeps a bounded %s scope when Refresh resets user filters', async mode => {
    await openSource();
    const ids = model.nodes.slice(0, 2).map(n => n.id);
    if (mode === 'preview') preview(ids);
    else act(() => canvas.props!.onApplyView({ ...profile(), positions: undefined, filter: { ...profile().filter, allowlistNodeIds: ids } }));
    await settle();
    expect(canvas.props!.flowNodes).toHaveLength(2);
    act(() => canvas.props!.onRefresh());
    post({ type: 'rebuild-config', config });
    await settle();
    expect([...canvas.props!.filter.allowlistNodeIds!]).toEqual(ids);
    expect(canvas.props!.flowNodes).toHaveLength(2);
  }, 15000);

  it.each(['preview', 'bookmark'])('keeps an empty %s scope through last-object removal, save and reopen', async mode => {
    await openSource();
    const id = model.nodes[0].id;
    if (mode === 'preview') preview([id]);
    else act(() => canvas.props!.onApplyView({ ...profile(), positions: undefined, filter: { ...profile().filter, allowlistNodeIds: [id] } }));
    await settle();
    act(() => canvas.props!.onRemoveFromView(id));
    await settle();
    expect(canvas.props!.flowNodes).toHaveLength(0);
    act(() => mode === 'preview' ? canvas.props!.onSaveAiBookmark('Empty scope') : canvas.props!.onSaveView('Empty scope'));
    const saved = posted.filter(m => m.type === 'save-view').at(-1)!.profile!;
    expect(saved.filter.allowlistNodeIds).toEqual([]);
    expect(canvas.props!.activeAdvancedProfile?.id).toBe(saved.id);
    act(() => root.render(null));
    await openSource();
    act(() => canvas.props!.onApplyView(JSON.parse(JSON.stringify(saved))));
    await settle();
    expect(canvas.props!.activeAdvancedProfile?.id).toBe(saved.id);
    expect(canvas.props!.flowNodes).toHaveLength(0);
    expect(canvas.props!.filter.allowlistNodeIds!.size).toBe(0);
    act(() => canvas.props!.onRefresh());
    post({ type: 'rebuild-config', config });
    await settle();
    expect(canvas.props!.flowNodes).toHaveLength(0);
  }, 15000);

  it('retains ordinary unscoped refresh and bookmark behavior', async () => {
    await openSource();
    const before = canvas.props!.flowNodes.map(n => n.id);
    act(() => canvas.props!.onRefresh());
    post({ type: 'rebuild-config', config });
    await settle();
    expect(canvas.props!.filter.allowlistNodeIds).toBeUndefined();
    expect(canvas.props!.flowNodes.map(n => n.id)).toEqual(before);
    act(() => canvas.props!.onSaveView('Ordinary view'));
    const saved = posted.filter(m => m.type === 'save-view').at(-1)!.profile!;
    expect(saved.filter.allowlistNodeIds).toBeUndefined();
    expect(canvas.props!.activeAdvancedProfile).toBeNull();
    act(() => canvas.props!.onApplyView(JSON.parse(JSON.stringify(saved))));
    await settle();
    expect(canvas.props!.activeAdvancedProfile).toBeNull();
    expect(canvas.props!.flowNodes.map(n => n.id)).toEqual(before);
  }, 15000);

  it('saves the edited AI scope rather than restoring removed preview objects', async () => {
    await openSource();
    const ids = model.nodes.slice(0, 2).map(n => n.id);
    preview(ids);
    await settle();
    act(() => canvas.props!.onRemoveFromView(ids[0]));
    await settle();
    expect(canvas.props!.flowNodes.map(n => n.id)).toEqual([ids[1]]);
    act(() => canvas.props!.onSaveAiBookmark('Edited scope'));
    const saved = posted.filter(m => m.type === 'save-view').at(-1)!.profile!;
    expect(saved.filter.allowlistNodeIds).toEqual([ids[1]]);
  }, 15000);
});
