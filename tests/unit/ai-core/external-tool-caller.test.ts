/**
 * Callers without a chat turn (`vscode.lm`, MCP) dispatch the core tools through the `external`
 * stage: scope walks and renders are kept by handle (`scope_id`, `view_id`) and never touch the
 * chat's discovery scope, report, phase, per-turn flags, held repair draft or hop log.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commands: { executeCommand: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/bridge/host', () => ({
  postToWebview: (panel: VSCode.WebviewPanel, msg: unknown) => panel.webview.postMessage(msg),
}));

import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { AiSession } from '../../../src/ai/session/session';
import { buildAiToolRegistry, createEffectSerializer, createExternalToolSource } from '../../../src/ai/tools/toolProvider';
import { EXTERNAL_TOOL_NAMES, getAllowedLmToolNames } from '../../../src/ai/tools/toolPolicy';
import { EXTERNAL_TOOL_DEFS, TOOL_DEFS, type ToolContract } from '../../../src/ai/tools/toolDefs';
import { createTurnTokenBudget, turnTokenBudgetFromSettings } from '../../../src/ai/support/tokenBudget';
import { applyModelToSession } from '../../../src/bridge/messageHandlers';
import { LineageRuntime, type LineageRuntimeRunInput } from '../../../src/ai/runtime/lineageRuntime';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

const id = (name: string) => normalizeName(`dbo.${name}`, false);
const REPORT = id('Report');
const SOURCE = id('Source');
const LOOKUP = id('Lookup');
const AUDIT = id('Audit');
const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as VSCode.LogOutputChannel;

function demoModel() {
  return buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT s.Value, l.Label FROM dbo.Source s JOIN dbo.Lookup l ON l.Id = s.Id' },
    { fullName: '[dbo].[Audit]', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source' },
    { fullName: '[dbo].[Source]', type: 'table' },
    { fullName: '[dbo].[Lookup]', type: 'table' },
  ], [], undefined, undefined, true, undefined, false);
}

function world(options: { panel?: boolean; readBudget?: () => ReturnType<typeof createTurnTokenBudget> } = {}) {
  const model = demoModel();
  const session = new AiSession();
  session.model = model;
  session.graph = buildGraphologyGraph(model);
  const posted: unknown[] = [];
  const panel = { reveal: vi.fn(), webview: { postMessage: vi.fn(async (msg: unknown) => { posted.push(msg); return true; }) } } as unknown as VSCode.WebviewPanel;
  const source = createExternalToolSource(() => session, channel, () => (options.panel === false ? undefined : panel), { readBudget: options.readBudget });
  const call = async (name: string, input: unknown) => JSON.parse(await source.invoke(name, input, new AbortController().signal)) as Record<string, any>;
  return { session, posted, call };
}

const render = (extra: Record<string, unknown>) => ({
  name: 'Report lineage',
  summary: 'Report reads Source and Lookup.',
  sections: [{ label: 'Inputs', node_ids: [REPORT, SOURCE, LOOKUP], text: 'Report joins Source to Lookup.' }],
  highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [REPORT] }],
  ...extra,
});
const walkReport = { origin: REPORT, upstream_depth: 1, downstream_depth: 0 };

describe('external tool policy and catalog', () => {
  it('offers discovery reads and present_result, never the hop-by-hop tools', () => {
    const idle = getAllowedLmToolNames({ kind: 'external', chatTurnActive: false });
    expect([...idle]).toEqual([...EXTERNAL_TOOL_NAMES]);
    for (const name of ['lineage_start_exploration', 'lineage_submit_findings', 'lineage_get_neighbor_columns']) {
      expect(idle.has(name)).toBe(false);
    }
    const busy = getAllowedLmToolNames({ kind: 'external', chatTurnActive: true });
    expect(busy.has('lineage_present_result')).toBe(false);
    expect(busy.has('lineage_get_scope_bundle')).toBe(true);
  });

  it('serves the external catalog in catalog order, with present_result on its external contract', () => {
    const source = createExternalToolSource(() => new AiSession(), channel, () => undefined);
    expect(source.tools).toBe(EXTERNAL_TOOL_DEFS);
    expect(source.tools.map(tool => tool.name)).toEqual(TOOL_DEFS.map(tool => tool.name).filter(name => EXTERNAL_TOOL_NAMES.has(name)));
    const present = source.tools.find(tool => tool.name === 'lineage_present_result')!;
    const catalog = (TOOL_DEFS as readonly ToolContract[]).find(tool => tool.name === 'lineage_present_result')!;
    expect(present.inputSchema).toBe(catalog.externalInputSchema);
  });

  it('refuses a tool outside the external stage', async () => {
    const source = createExternalToolSource(() => new AiSession(), channel, () => undefined);
    await expect(source.invoke('lineage_submit_findings', {}, new AbortController().signal)).rejects.toThrow(/No external lineage tool/);
  });
});

describe('external scope walks', () => {
  it('returns a scope_id and leaves the chat discovery scope and hop log alone', async () => {
    const { session, call } = world();
    const bundle = await call('lineage_get_scope_bundle', walkReport);
    expect(bundle.scope_id).toMatch(/^scope-[0-9a-f]{8}$/);
    expect(session.externalScope(bundle.scope_id)?.nodeIds).toEqual(expect.arrayContaining([REPORT, SOURCE, LOOKUP]));
    expect(session.discoveryScopeArtifact).toBeNull();
    expect(session.hopLog).toHaveLength(0);
  });

  it('asks an oversized walk to narrow, never to start an exploration', async () => {
    const { call } = world({ readBudget: () => createTurnTokenBudget({ discoveryNodeCap: 2 }) });
    const rejection = await call('lineage_get_scope_bundle', { origin: SOURCE, upstream_depth: 0, downstream_depth: 1 });
    expect(rejection.code).toBe('over_discovery_budget');
    expect(rejection.hint).toMatch(/smaller upstream_depth or downstream_depth/);
    expect(rejection.hint).not.toMatch(/exploration/);
    expect(rejection.scope_id).toBeUndefined();
  });
});

describe('external renders by handle', () => {
  it('renders a walk by scope_id without touching chat state', async () => {
    const { session, posted, call } = world();
    const epoch = session.beginTurn();
    session.presentResultRepairDraft.hold(render({}) as never, { fields: ['sections'] });
    session.hopLog.push({ tool: 'lineage_search_objects', input: {}, output: {}, timestamp: 'now' });
    session.endTurn(epoch);

    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const result = await call('lineage_present_result', render({ scope_id }));
    expect(result).toMatchObject({ success: true, node_count: 3, graph_source: 'external_scope', delivery: 'delivered' });
    expect(result.view_id).toMatch(/^view-[0-9a-f]{8}$/);
    expect(posted[0]).toMatchObject({ type: 'ai-view-preview', name: 'Report lineage', aiMetadata: { modelName: 'External AI client' } });
    expect((posted[0] as { aiMetadata: Record<string, unknown> }).aiMetadata.runId).toBeUndefined();
    expect(session.externalView(result.view_id)?.nodeIds).toHaveLength(3);
    expect(session.presentationArtifact).toBeNull();
    expect(session.resultGraph).toBeNull();
    expect(session.phase.kind).toBe('idle');
    expect(session.presentResultCalledThisTurn).toBe(false);
    expect(session.presentResultAttemptCountThisTurn).toBe(0);
    expect(session.presentResultRepairDraft.get()).not.toBeNull();
    expect(session.hopLog).toHaveLength(1);
  });

  it('draws the walk it names, even when another caller walked since', async () => {
    const { call } = world();
    const first = await call('lineage_get_scope_bundle', walkReport);
    await call('lineage_get_scope_bundle', { origin: AUDIT, upstream_depth: 1, downstream_depth: 0 });
    const result = await call('lineage_present_result', render({ scope_id: first.scope_id }));
    expect(result).toMatchObject({ success: true, node_count: 3 });
  });

  it('edits a rendered view by view_id with prune_node_ids and add_node_ids', async () => {
    const { session, call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const { view_id } = await call('lineage_present_result', render({ scope_id }));
    const pruned = await call('lineage_present_result', render({
      view_id,
      prune_node_ids: [LOOKUP],
      sections: [{ label: 'Inputs', node_ids: [REPORT, SOURCE], text: 'Report reads Source.' }],
    }));
    expect(pruned).toMatchObject({ success: true, view_id, node_count: 2 });
    expect(session.externalView(view_id)?.nodeIds.sort()).toEqual([REPORT, SOURCE].sort());
    const added = await call('lineage_present_result', render({ view_id, add_node_ids: [LOOKUP] }));
    expect(added).toMatchObject({ success: true, view_id, node_count: 3 });
  });

  it('rejects removing the origin and keeps the view', async () => {
    const { session, call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const { view_id } = await call('lineage_present_result', render({ scope_id }));
    const result = await call('lineage_present_result', render({ view_id, prune_node_ids: [REPORT] }));
    expect(result).toMatchObject({ code: 'validation', issuePaths: ['prune_node_ids'] });
    expect(session.externalView(view_id)?.nodeIds).toHaveLength(3);
  });

  it('requires exactly one known handle', async () => {
    const { call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    expect(await call('lineage_present_result', render({}))).toMatchObject({ code: 'invalid_input', issuePaths: ['scope_id', 'view_id'] });
    expect(await call('lineage_present_result', render({ scope_id, view_id: 'view-00000000' }))).toMatchObject({ code: 'invalid_input' });
    expect(await call('lineage_present_result', render({ scope_id: 'scope-00000000' }))).toMatchObject({ code: 'missing_result_graph', issuePaths: ['scope_id'] });
    expect(await call('lineage_present_result', render({ view_id: 'view-00000000' }))).toMatchObject({ code: 'missing_result_graph', issuePaths: ['view_id'] });
  });

  it('rejects an invalid payload whole, holding nothing', async () => {
    const { session, call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const result = await call('lineage_present_result', render({ scope_id, highlight_groups: [] }));
    expect(result).toMatchObject({ code: 'invalid_input', issuePaths: ['highlight_groups'] });
    expect(String(result.hint)).not.toMatch(/held draft/);
    expect(session.presentResultRepairDraft.get()).toBeNull();
  });

  it('rejects an unclosed SQL fence, as the chat does', async () => {
    const { call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const result = await call('lineage_present_result', render({
      scope_id,
      sections: [{ label: 'Inputs', node_ids: [REPORT, SOURCE, LOOKUP], text: 'Join:\n```sql\nSELECT 1\n\nMore prose.' }],
    }));
    expect(result.code).toBe('validation');
    expect(result.reason).toMatch(/Unclosed SQL fence/);
  });

  it('renders with no panel open and says so', async () => {
    const { call } = world({ panel: false });
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    expect(await call('lineage_present_result', render({ scope_id }))).toMatchObject({ success: true, delivery: 'no_panel' });
  });

  it('withholds rendering while a chat turn runs, naming the full tool names', async () => {
    const { session, call } = world();
    const epoch = session.beginTurn();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const blocked = await call('lineage_present_result', render({ scope_id }));
    expect(blocked).toMatchObject({ code: 'off_policy', reason: expect.stringContaining('@lineage chat turn') });
    expect(blocked.hint).toContain('lineage_get_scope_bundle');
    session.endTurn(epoch);
    expect(await call('lineage_present_result', render({ scope_id }))).toMatchObject({ success: true });
  });

  it('records no chat failure when the external call fails', async () => {
    const session = new AiSession();
    const source = createExternalToolSource(() => session, channel, () => undefined);
    const result = JSON.parse(await source.invoke('lineage_present_result', render({ scope_id: 'scope-00000000' }), new AbortController().signal));
    expect(result.code).toBe('no_project_loaded');
    expect(session.presentResultFailureCountThisTurn).toBe(0);
  });

  it('leaves a completed chat report untouched', async () => {
    const { session, call } = world();
    const epoch = session.beginTurn();
    const chatGraph = { nodeIds: [REPORT, SOURCE], edges: [[SOURCE, REPORT, 'read']] as [string, string, string][], source: 'blackboard', originNodeId: REPORT };
    session.resultGraph = chatGraph;
    session.enterCompleted(epoch);
    session.endTurn(epoch);
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    expect(await call('lineage_present_result', render({ scope_id }))).toMatchObject({ success: true, node_count: 3 });
    expect(session.resultGraph).toBe(chatGraph);
    expect(chatGraph.nodeIds).toEqual([REPORT, SOURCE]);
    expect(session.phase.kind).toBe('completed');
    expect(session.presentationArtifact).toBeNull();
  });

  it('forgets every walk and view when another model loads', async () => {
    const { session, call } = world();
    const { scope_id } = await call('lineage_get_scope_bundle', walkReport);
    const { view_id } = await call('lineage_present_result', render({ scope_id }));
    applyModelToSession(session, demoModel(), false);
    expect(session.externalScope(scope_id)).toBeUndefined();
    expect(session.externalView(view_id)).toBeUndefined();
  });
});

describe('shared effect queue', () => {
  it('runs state-changing calls one at a time, in arrival order', async () => {
    const serialize = createEffectSerializer();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = serialize(async () => { order.push('first:start'); await new Promise<void>(resolve => { releaseFirst = resolve; }); order.push('first:end'); });
    const second = serialize(async () => { order.push('second'); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('serves chat and external registries built on one serializer from one queue', async () => {
    const serialize = createEffectSerializer();
    const session = new AiSession();
    const order: string[] = [];
    const chat = buildAiToolRegistry(() => session, channel, () => undefined, undefined, { serialize });
    const external = buildAiToolRegistry(() => session, channel, () => undefined, undefined, { serialize, caller: 'external' });
    let releaseGate!: () => void;
    const gate = serialize(async () => { order.push('gate'); await new Promise<void>(resolve => { releaseGate = resolve; }); });
    const chatCall = Promise.resolve(chat.invoke('lineage_present_result', render({}))).then(() => order.push('chat'));
    const externalCall = Promise.resolve(external.invoke('lineage_present_result', render({ scope_id: 'scope-00000000' }))).then(() => order.push('external'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['gate']);
    releaseGate();
    await Promise.all([gate, chatCall, externalCall]);
    expect(order).toEqual(['gate', 'chat', 'external']);
  });
});

describe('turn budget from settings', () => {
  const config = (values: Record<string, number>) => ({ get: <T>(key: string) => values[key] as T | undefined });

  it('caps the discovery token budget at a share of the model window', () => {
    const budget = turnTokenBudgetFromSettings(config({ 'ai.discoveryTokenBudget': 32000 }), 80_000);
    expect(budget.discovery.tokenBudget).toBe(10_000);
    expect(budget.modelWindowTokens).toBe(80_000);
  });

  it('applies the user caps as they are without a model window', () => {
    const budget = turnTokenBudgetFromSettings(config({ 'ai.discoveryNodeCap': 25, 'ai.discoveryTokenBudget': 20000 }));
    expect(budget.discovery.nodeCap).toBe(25);
    expect(budget.discovery.tokenBudget).toBe(20_000);
    expect(budget.modelWindowTokens).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('chat turn tracking', () => {
  it('closes the turn when its setup fails, so external rendering is not blocked', async () => {
    const session = new AiSession();
    const runtime = new LineageRuntime({
      getSession: () => session,
      createRegistry: () => { throw new Error('registry setup failed'); },
    });
    const input = { request: { id: 'r1', prompt: 'hello' }, model: { identity: { id: 'fixture', name: 'fixture' } }, sink: { addObserver: () => ({ dispose: () => {} }) } } as unknown as LineageRuntimeRunInput;
    await expect(runtime.run(input)).rejects.toThrow('registry setup failed');
    expect(session.chatTurnActive).toBe(false);
  });

  it('ignores a superseded turn closing', () => {
    const session = new AiSession();
    const first = session.beginTurn();
    const second = session.beginTurn();
    session.endTurn(first);
    expect(session.chatTurnActive).toBe(true);
    session.endTurn(second);
    expect(session.chatTurnActive).toBe(false);
  });
});
