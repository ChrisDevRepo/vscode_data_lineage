// @vitest-environment jsdom
/**
 * Pins that Reload on a reload-class settings notice reloads a demo the host opened, never reloads
 * the demo for a model that replaced it, and ends an AI preview built on the model it reloads.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

const canvas = vi.hoisted(() => ({ props: null as { aiPreview?: unknown } | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: { aiPreview?: unknown }) => { canvas.props = props; return null; },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; text?: string };

let host: HTMLDivElement;
let root: Root;
let posted: Posted[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

async function renderApp(): Promise<void> {
  const { App } = await import('../../../src/components/App');
  act(() => {
    root.render(
      <VsCodeProvider api={{ postMessage: (m: unknown) => { posted.push(m as Posted); } } as never}>
        <App />
      </VsCodeProvider>
    );
  });
}

const { model } = generateDwhModel({ objectCount: 30, seed: 1, profile: { externalRefCount: 0 } });

describe('reload-source after a demo', () => {
  it('reloads the demo when the host opened it', async () => {
    await renderApp();
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
    await settle();
    posted.length = 0;

    post({ type: 'reload-source' });

    expect(posted.map((m) => m.type)).toContain('load-demo');
    expect(posted.some((m) => m.type === 'show-warning')).toBe(false);
  }, 15000);

  it('does not reload the demo for a model the host loaded after it', async () => {
    await renderApp();
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
    await settle();
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'other', autoVisualize: true });
    await settle();
    posted.length = 0;

    post({ type: 'reload-source' });

    expect(posted.map((m) => m.type)).not.toContain('load-demo');
  }, 15000);

  it('ends an AI preview built on the model it reloads', async () => {
    await renderApp();
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
    await settle();
    post({
      type: 'ai-view-preview',
      name: 'Order flow',
      nodeIds: [model.nodes[0].id],
      aiMetadata: { createdAt: '2026-09-27T00:00:00Z', modelName: 'test', highlightGroups: [], badges: [] },
    });
    expect(canvas.props?.aiPreview).toBeTruthy();

    post({ type: 'reload-source' });
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
    await settle();

    expect(canvas.props?.aiPreview).toBeNull();
  }, 15000);
});
