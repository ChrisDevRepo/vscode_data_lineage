// @vitest-environment jsdom
/**
 * Pins that a `maxNodes` refusal inside the panel reaches the user once, as the actionable limit
 * warning, never through the `error` channel the extension reports as an unexpected webview failure.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

vi.mock('../../../src/components/GraphCanvas', () => ({ GraphCanvas: () => null }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; text?: string; error?: string };

let host: HTMLDivElement;
let root: Root;
let posted: Posted[];
const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
  w.vscode = { postMessage: (m: unknown) => { posted.push(m as Posted); } };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
});

const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

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

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 1300)); });

describe('maxNodes refusal channel', () => {
  it('a model over the limit is refused with the limit warning, not an unexpected error', async () => {
    await renderApp();
    const { model } = generateDwhModel({ objectCount: 40, seed: 1, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: { ...objectViewConfig, maxNodes: 10 }, sourceName: 'big.dacpac', autoVisualize: true });
    await settle();

    expect(posted.filter((m) => m.type === 'error')).toEqual([]);
    expect(posted.some((m) => m.type === 'show-warning' && /limit 10/.test(m.text ?? ''))).toBe(true);
  }, 15000);

  it('a settings rebuild that lowers the limit below the open model warns, not errors', async () => {
    await renderApp();
    const { model } = generateDwhModel({ objectCount: 40, seed: 1, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: { ...objectViewConfig }, sourceName: 'big.dacpac', autoVisualize: true });
    await settle();
    posted.length = 0;

    post({ type: 'rebuild-config', config: { ...objectViewConfig, maxNodes: 10 } });
    await settle();

    expect(posted.filter((m) => m.type === 'error')).toEqual([]);
    expect(posted.filter((m) => m.type === 'show-warning' && /limit 10/.test(m.text ?? ''))).toHaveLength(1);
  }, 15000);
});
