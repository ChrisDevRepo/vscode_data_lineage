// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

const canvas = vi.hoisted(() => ({ ids: null as string[] | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({ GraphCanvas: (props: { flowNodes: { id: string }[] }) => { canvas.ids = props.flowNodes.map(n => n.id); return null; } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let posted: { type: string }[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
  canvas.ids = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const config = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
const { model } = generateDwhModel({ objectCount: 30, seed: 3, profile: { externalRefCount: 0 } });
const preview = { schemas: model.schemas, totalObjects: model.nodes.length };
const connectedIds = [...new Set(model.edges.flatMap(e => [e.source, e.target]))].sort();
function post(data: object): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } })));
}
function click(text: string): void {
  const button = [...host.querySelectorAll('button')].find(el => el.textContent?.includes(text));
  expect(button, `button containing ${text}`).toBeDefined();
  expect(button!.disabled).toBe(false);
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });
async function renderApp(): Promise<void> {
  const { App } = await import('../../../src/components/App');
  act(() => root.render(<VsCodeProvider api={{ postMessage: (m: unknown) => posted.push(m as { type: string }) } as never}><App /></VsCodeProvider>));
  expect(posted.some(m => m.type === 'check-mssql')).toBe(true);
  post({ type: 'mssql-status', available: true, provider: 'builtIn' });
  post({ type: 'projects-list', lastOpenedId: 'saved-project', projects: [{
    id: 'saved-project', name: 'Saved project', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    connection: { type: 'dacpac', path: '/synthetic.dacpac', displayName: 'Saved', schemas: model.schemas.map(s => s.name) },
  }] });
}
function start(mode: string, acknowledge = true): void {
  click(mode === 'demo' ? 'Try with demo data' : 'Saved project');
  expect(posted.some(m => m.type === (mode === 'demo' ? 'load-demo' : 'load-project'))).toBe(true);
  if (acknowledge) post({ type: 'load-started' });
}
function loaded(mode: string): void {
  post({ type: 'dacpac-model', model, config, sourceName: mode, autoVisualize: true, isDemo: mode === 'demo' });
}
function cancel(acknowledge = true): void {
  click('Cancel');
  expect(host.textContent).toContain('Try with demo data');
  expect(canvas.ids).toBeNull();
  if (acknowledge) post({ type: 'load-cancelled' });
}
function expectModel(): void {
  expect(canvas.ids?.slice().sort()).toEqual(connectedIds);
}
async function manual(source: string): Promise<void> {
  await renderApp();
  start('demo');
  cancel();
  click('Create New Project');
  click(source === 'dacpac' ? 'Open .dacpac file' : 'Connect to database');
  post({ type: 'load-started' });
  post({ type: `${source}-schema-preview`, preview, config, sourceName: 'Manual source', filePath: source === 'dacpac' ? '/manual.dacpac' : undefined });
  click('Visualize');
  expect(posted.some(m => m.type === `${source}-visualize`)).toBe(true);
  post({ type: 'load-started' });
}

describe('load cancellation through the application', () => {
  it.each(['demo', 'project'])('keeps a cancelled %s closed when its delayed automatic model arrives', async mode => {
    await renderApp();
    start(mode);
    cancel();
    loaded(mode);
    await settle();
    expect(host.textContent).toContain('Try with demo data');
    expect(canvas.ids).toBeNull();
    expect(posted.filter(m => m.type === 'cancel-load')).toHaveLength(1);
  }, 15000);

  it.each(['dacpac', 'db'])('rejects a cancelled late %s preview after returning to the creation wizard', async source => {
    await renderApp();
    start('demo');
    cancel();
    click('Create New Project');
    post({ type: `${source}-schema-preview`, preview, config, sourceName: 'Cancelled source', filePath: '/cancelled.dacpac' });
    expect(host.textContent).toContain('Open .dacpac file');
    expect(host.textContent).not.toContain('Cancelled source');
  }, 15000);

  it('preserves a host-initiated startup restore without a preceding UI load request', async () => {
    await renderApp();
    post({ type: 'load-started' });
    loaded('project');
    await settle();
    expectModel();
    expect(posted.some(m => m.type === 'cancel-load')).toBe(false);
  }, 15000);

  it('allows the host demo command to start a fresh load after cancellation', async () => {
    await renderApp();
    start('demo');
    cancel();
    post({ type: 'load-started' });
    loaded('demo');
    await settle();
    expectModel();
  }, 15000);

  it('ignores a queued old result after requesting a new load until the host announces its ownership', async () => {
    await renderApp();
    start('demo');
    cancel();
    start('project', false);
    loaded('demo');
    await settle();
    expect(canvas.ids).toBeNull();
    post({ type: 'load-started' });
    loaded('project');
    await settle();
    expectModel();
  }, 15000);

  it.each([false, true])('ignores an old start acknowledgement before the UI cancellation acknowledgement, reopenWizard=%s', async reopenWizard => {
    await renderApp();
    start('demo', false);
    cancel(false);
    if (reopenWizard) click('Create New Project');
    post({ type: 'load-started' });
    loaded('demo');
    post({ type: 'load-cancelled' });
    await settle();
    expect(host.textContent).toContain(reopenWizard ? 'Open .dacpac file' : 'Try with demo data');
    expect(canvas.ids).toBeNull();
  }, 15000);

  it.each([false, true])('keeps both UI cancellations pending through the first acknowledgement, nativeNotice=%s', async nativeNotice => {
    await renderApp();
    start('demo', false);
    cancel(false);
    start('demo', false);
    cancel(false);
    post({ type: 'load-started' });
    if (nativeNotice) post({ type: 'db-cancelled' });
    post({ type: 'load-cancelled' });
    post({ type: 'load-started' });
    loaded('demo');
    await settle();
    expect(host.textContent).toContain('Try with demo data');
    expect(canvas.ids).toBeNull();
    post({ type: 'load-cancelled' });
    start('project');
    loaded('project');
    await settle();
    expectModel();
  }, 15000);

  it('allows a new demo load after cancelling the previous one', async () => {
    await renderApp();
    start('demo');
    cancel();
    start('demo');
    loaded('demo');
    await settle();
    expectModel();
  }, 15000);

  it.each(['dacpac', 'db'])('preserves manual %s preview and visualization after cancellation', async source => {
    await manual(source);
    post({ type: `${source}-model`, model, config, sourceName: 'Manual source' });
    await settle();
    expectModel();
  }, 15000);

  it.each([false, true])('returns to start on native progress cancellation, queuedModel=%s', async queuedModel => {
    await manual('db');
    act(() => {
      if (queuedModel) post({ type: 'db-model', model, config, sourceName: 'Cancelled source' });
      post({ type: 'db-cancelled' });
    });
    await settle();
    expect(host.textContent).toContain('Try with demo data');
    expect(canvas.ids).toBeNull();
    expect(posted.filter(m => m.type === 'cancel-load')).toHaveLength(1);
  }, 15000);

  it('keeps an ordinary database error visible for recovery', async () => {
    await manual('db');
    post({ type: 'db-error', message: 'Synthetic database failure', phase: 'extract' });
    await settle();
    expect(host.textContent).toContain('Synthetic database failure');
    expect(host.textContent).not.toContain('Try with demo data');
    expect(canvas.ids).toBeNull();
  }, 15000);

  it('does not clear a valid graph for a cancellation frame received after load completion', async () => {
    await manual('db');
    post({ type: 'db-model', model, config, sourceName: 'Manual source' });
    await settle();
    post({ type: 'db-cancelled' });
    expectModel();
  }, 15000);
});
