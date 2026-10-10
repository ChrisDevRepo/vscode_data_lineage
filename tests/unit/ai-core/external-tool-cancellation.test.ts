/** External cancellation must stop queued effects and leave kept scopes and views unchanged. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { AiSession } from '../../../src/ai/session/session';
import { createEffectSerializer, createExternalToolSource, type EffectSerializer } from '../../../src/ai/tools/toolProvider';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

const REPORT = normalizeName('dbo.Report', false);
const SOURCE = normalizeName('dbo.Source', false);
const LOOKUP = normalizeName('dbo.Lookup', false);
const walkInput = { origin: REPORT, upstream_depth: 1, downstream_depth: 0 };
const renderInput = (handle: { scope_id: string } | { view_id: string }) => ({
  name: 'Report lineage',
  summary: 'Report reads Source and Lookup.',
  sections: [{ label: 'Inputs', node_ids: [REPORT, SOURCE, LOOKUP], text: 'Report joins Source to Lookup.' }],
  highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [REPORT] }],
  ...handle,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function world() {
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT s.Value, l.Label FROM dbo.Source s JOIN dbo.Lookup l ON l.Id = s.Id' },
    { fullName: '[dbo].[Source]', type: 'table' },
    { fullName: '[dbo].[Lookup]', type: 'table' },
  ], [], undefined, undefined, true, undefined, false);
  const session = new AiSession();
  session.model = model;
  session.graph = buildGraphologyGraph(model);
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as VSCode.LogOutputChannel;
  const postMessage = vi.fn(async (_message: unknown): Promise<boolean> => true);
  const reveal = vi.fn();
  const panel = { reveal, webview: { postMessage } } as unknown as VSCode.WebviewPanel;
  const queue = createEffectSerializer();
  const queueAdmission = vi.fn();
  const serialize: EffectSerializer = run => { queueAdmission(); return queue(run); };
  const source = createExternalToolSource(() => session, channel, () => panel, { serialize });
  const scopeStore = vi.spyOn(session, 'storeExternalScope');
  const viewStore = vi.spyOn(session, 'commitExternalView');
  const invoke = (name: string, input: unknown, signal = new AbortController().signal) => source.invoke(name, input, signal);
  const walk = async () => {
    const { scope_id } = JSON.parse(await invoke('lineage_get_scope_bundle', walkInput)) as { scope_id: string };
    return { scope_id };
  };
  const render = async (handle: { scope_id: string } | { view_id: string }) => JSON.parse(await invoke('lineage_present_result', renderInput(handle))) as { success: boolean; view_id: string };
  return { session, channel, serialize, queueAdmission, invoke, walk, render, reveal, postMessage, scopeStore, viewStore };
}

describe('external effect cancellation', () => {
  it.each(['scope', 'render'] as const)('does not admit an already aborted %s call', async kind => {
    const w = world();
    const handle = kind === 'render' ? await w.walk() : undefined;
    w.scopeStore.mockClear();
    w.queueAdmission.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(w.invoke(
      kind === 'scope' ? 'lineage_get_scope_bundle' : 'lineage_present_result',
      handle ? renderInput(handle) : walkInput,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.queueAdmission).not.toHaveBeenCalled();
    expect(w.scopeStore).not.toHaveBeenCalled();
    expect(w.viewStore).not.toHaveBeenCalled();
    expect(w.reveal).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(w.channel.error).not.toHaveBeenCalled();
  });

  it.each(['scope', 'render'] as const)('does not execute a %s call aborted while queued', async kind => {
    const w = world();
    const handle = kind === 'render' ? await w.walk() : undefined;
    w.scopeStore.mockClear();
    const entered = deferred<void>();
    const release = deferred<void>();
    const gate = w.serialize(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const call = w.invoke(
      kind === 'scope' ? 'lineage_get_scope_bundle' : 'lineage_present_result',
      handle ? renderInput(handle) : walkInput,
      controller.signal,
    );
    const rejection = expect(call).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(w.scopeStore).not.toHaveBeenCalled();
    expect(w.viewStore).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([gate, rejection]);
    expect(w.scopeStore).not.toHaveBeenCalled();
    expect(w.viewStore).not.toHaveBeenCalled();
    expect(w.reveal).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(w.channel.error).not.toHaveBeenCalled();
    // A cancelled queue entry releases the same queue for the next healthy effect.
    const next = await w.walk();
    expect(w.session.externalScope(next.scope_id)?.nodeIds).toHaveLength(3);
  });

  it.each(['new', 'amendment'] as const)('does not retain a %s view when aborted during delivery', async kind => {
    const w = world();
    const scope = await w.walk();
    const handle = kind === 'amendment' ? { view_id: (await w.render(scope)).view_id } : scope;
    const prior = 'view_id' in handle ? w.session.externalView(handle.view_id) : undefined;
    const priorSnapshot = prior ? structuredClone(prior) : undefined;
    w.viewStore.mockClear();
    w.postMessage.mockClear();
    const posted = deferred<void>();
    const delivery = deferred<boolean>();
    w.postMessage.mockImplementationOnce(() => { posted.resolve(); return delivery.promise; });
    const controller = new AbortController();
    const call = w.invoke('lineage_present_result', {
      ...renderInput(handle),
      prune_node_ids: [LOOKUP],
      sections: [{ label: 'Inputs', node_ids: [REPORT, SOURCE], text: 'Report reads Source.' }],
    }, controller.signal);
    const rejection = expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await posted.promise;
    controller.abort();
    delivery.resolve(true);
    await rejection;
    expect(w.viewStore).not.toHaveBeenCalled();
    if ('view_id' in handle) {
      expect(w.session.externalView(handle.view_id)).toBe(prior);
      expect(prior).toEqual(priorSnapshot);
    }
    expect(w.session.externalScope(scope.scope_id)?.nodeIds).toHaveLength(3);
    expect(w.channel.error).not.toHaveBeenCalled();
  });

  it('propagates cancellation during a rejected delivery without retaining a view', async () => {
    const w = world();
    const scope = await w.walk();
    const posted = deferred<void>();
    const delivery = deferred<boolean>();
    w.postMessage.mockImplementationOnce(() => { posted.resolve(); return delivery.promise; });
    const controller = new AbortController();
    const call = w.invoke('lineage_present_result', renderInput(scope), controller.signal);
    const rejection = expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await posted.promise;
    controller.abort();
    delivery.reject(controller.signal.reason);
    await rejection;
    expect(w.viewStore).not.toHaveBeenCalled();
    expect(w.channel.warn).not.toHaveBeenCalled();
    expect(w.channel.error).not.toHaveBeenCalled();
  });

  it('keeps normal scopes and rendered views through the real delivery boundary', async () => {
    const w = world();
    const scope = await w.walk();
    const result = await w.render(scope);
    expect(result.success).toBe(true);
    expect(w.session.externalScope(scope.scope_id)?.nodeIds).toHaveLength(3);
    expect(w.session.externalView(result.view_id)?.nodeIds).toHaveLength(3);
    expect(w.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai-view-preview', protocolVersion: expect.any(Number) }));
    expect(w.scopeStore).toHaveBeenCalledTimes(1);
    expect(w.viewStore).toHaveBeenCalledTimes(1);
    expect(w.session.hopLog).toHaveLength(0);
  });

  it('serves parallel reads while the effect queue is occupied', async () => {
    const w = world();
    const entered = deferred<void>();
    const release = deferred<void>();
    const gate = w.serialize(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try {
      const outputs = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        w.invoke(index % 2 ? 'lineage_get_context' : 'lineage_get_object_detail', index % 2 ? {} : { id: REPORT }),
      ));
      expect(outputs).toHaveLength(12);
      expect(outputs.map(text => JSON.parse(text))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: REPORT }),
      ]));
      expect(w.queueAdmission).toHaveBeenCalledTimes(1);
      expect(w.scopeStore).not.toHaveBeenCalled();
      expect(w.viewStore).not.toHaveBeenCalled();
      expect(w.postMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await gate;
    }
  });
});
