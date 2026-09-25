// @vitest-environment jsdom
/**
 * Pins that when the render limit falls back to Schema View, the canvas is told it shows Schema
 * View, so the Schema View toggle, schema-node clicks, search and legend match what is drawn; with
 * Schema View disabled in settings, the limit notice replaces the graph instead.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

let canvasProps: { graphMode?: string; flowNodes: { type?: string }[] } | null = null;

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: { graphMode?: string; flowNodes: { type?: string }[] }) => {
    canvasProps = props;
    return null;
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  canvasProps = null;
  w.vscode = { postMessage: () => {} };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
});

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 1300)); });

describe('render-limit fallback to Schema View', () => {
  it('passes Schema View to the canvas while it draws the schema fallback', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const { model } = generateDwhModel({ objectCount: 60, seed: 1, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'm.dacpac', autoVisualize: true });
    await settle();
    expect(canvasProps?.graphMode).toBe('full');

    post({ type: 'rebuild-config', config: { ...DEFAULT_CONFIG, renderLimit: 10 } });
    await settle();

    expect(canvasProps?.flowNodes.every((n) => n.type === 'schemaNode')).toBe(true);
    expect(canvasProps?.graphMode).toBe('overview');
  }, 15000);

  it('shows the render-limit notice, not Schema View, when Schema View is disabled in settings', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const noOverview = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
    const { model } = generateDwhModel({ objectCount: 60, seed: 1, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: noOverview, sourceName: 'm.dacpac', autoVisualize: true });
    await settle();
    expect(canvasProps?.flowNodes.length).toBeGreaterThan(0);

    post({ type: 'rebuild-config', config: { ...noOverview, renderLimit: 10 } });
    await settle();

    expect(canvasProps?.flowNodes).toEqual([]);
    expect(canvasProps?.graphMode).toBe('full');
  }, 15000);
});
