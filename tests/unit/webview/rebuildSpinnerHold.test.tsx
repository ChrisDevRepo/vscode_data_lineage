// @vitest-environment jsdom
/**
 * Pins the Refresh spinner contract: the minimum-spinner hold armed by one `rebuild-config` reply
 * never ends a later rebuild that is still waiting for its own reply. `GraphCanvas` is mocked to
 * its props.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

let lastIsRebuilding: boolean | undefined;
let lastOnRebuild: (() => void) | undefined;

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: { isRebuilding?: boolean; onRebuild?: () => void }) => {
    lastIsRebuilding = props.isRebuilding;
    lastOnRebuild = props.onRebuild;
    return null;
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  lastIsRebuilding = undefined;
  lastOnRebuild = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };

function post(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

describe('Refresh spinner hold', () => {
  it('keeps a second rebuild spinning past the first reply\'s minimum-spinner hold', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: vi.fn() } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const { model } = generateDwhModel({ objectCount: 20, seed: 3, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: { ...objectViewConfig }, sourceName: 'hold.dacpac', autoVisualize: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(lastOnRebuild).toBeTypeOf('function');

    act(() => lastOnRebuild!());
    expect(lastIsRebuilding).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    post({ type: 'rebuild-config', config: { ...objectViewConfig } });
    expect(lastIsRebuilding).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => lastOnRebuild!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(lastIsRebuilding).toBe(true);

    post({ type: 'rebuild-config', config: { ...objectViewConfig } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(lastIsRebuilding).toBe(false);
  }, 15000);
});
