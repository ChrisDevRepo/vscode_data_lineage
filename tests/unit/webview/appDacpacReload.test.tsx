// @vitest-environment jsdom
/**
 * Pins the reload contract: a second `dacpac-model` frame into an already-open panel renders that
 * second model, never the one it replaces — with identical settings and with changed settings in the
 * same frame. `GraphCanvas` is mocked to its `flowNodes` prop.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

let lastFlowNodeCount = -1;

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: { flowNodes: { id: string }[] }) => {
    lastFlowNodeCount = props.flowNodes.length;
    return null;
  },
}));

// React reads this to decide whether `act` may drive updates; without it every act() warns.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  lastFlowNodeCount = -1;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Config forcing Object View (never Schema View) regardless of node count, so the mocked canvas's `flowNodes` prop is the object graph — the same surface the Electron reload evidence measured. */
const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };

function postDacpacModel(objectCount: number, seed: number, sourceName: string, config: object = objectViewConfig): void {
  const { model } = generateDwhModel({ objectCount, seed, profile: { externalRefCount: 0 } });
  const frame = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    type: 'dacpac-model',
    model,
    config: { ...config },
    sourceName,
    autoVisualize: true,
  };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: frame }));
  });
}

async function loadTwice(secondConfig: object): Promise<{ firstCount: number; secondCount: number }> {
  const { App } = await import('../../../src/components/App');
  act(() => {
    root.render(
      <VsCodeProvider api={{ postMessage: vi.fn() } as never}>
        <App />
      </VsCodeProvider>
    );
  });
  postDacpacModel(40, 1, 'first.dacpac');
  await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
  const firstCount = lastFlowNodeCount;
  postDacpacModel(90, 2, 'second.dacpac', secondConfig);
  await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
  return { firstCount, secondCount: lastFlowNodeCount };
}

describe('reload into an already-open panel', () => {
  it('renders the second model when the frame carries changed settings', async () => {
    const changed = { ...objectViewConfig, layout: { ...objectViewConfig.layout, rankSeparation: objectViewConfig.layout.rankSeparation + 40 } };
    const { firstCount, secondCount } = await loadTwice(changed);
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBeGreaterThan(firstCount);
  }, 15000);

  it('renders the second model with unchanged settings', async () => {
    const { firstCount, secondCount } = await loadTwice(objectViewConfig);
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBeGreaterThan(firstCount);
  }, 15000);
});
