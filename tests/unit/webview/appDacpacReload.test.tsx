// @vitest-environment jsdom
/**
 * Pins the reload contract: a second `dacpac-model` frame into an already-open panel renders that
 * second model, never the one it replaces — with identical settings, with changed settings in the
 * same frame, and with a `rebuild-config` frame landing mid-load; the canvas receives the trace hook's
 * full-model graph rather than building its own. `GraphCanvas` is mocked to its props.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

let lastFlowNodeCount = -1;
let lastModelGraphOrder = -1;
let lastFlowNodeIds: string[] = [];

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: { flowNodes: { id: string }[]; modelGraph?: { order: number } | null }) => {
    lastFlowNodeCount = props.flowNodes.length;
    lastFlowNodeIds = props.flowNodes.map(n => n.id);
    lastModelGraphOrder = props.modelGraph?.order ?? -1;
    return null;
  },
}));

// React reads this to decide whether `act` may drive updates; without it every act() warns.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  lastFlowNodeCount = -1;
  lastModelGraphOrder = -1;
  lastFlowNodeIds = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** Config forcing Object View (never Schema View) regardless of node count, so the mocked canvas's `flowNodes` prop is the object graph — the same surface the Electron reload evidence measured. */
const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };

/** Posts a `dacpac-model` frame for a generated model and returns that model's node ids. */
function postDacpacModel(objectCount: number, seed: number, sourceName: string, config: object = objectViewConfig): ReadonlySet<string> {
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
  return new Set(model.nodes.map(n => n.id));
}

/**
 * Waits, bounded in real time, until the canvas shows a non-empty graph drawn only from `nodeIds`.
 * Each poll advances the fake clock inside `act`, so the deferred build and the spinner hold run
 * however slowly the host schedules them.
 */
async function waitForCanvasOf(nodeIds: ReadonlySet<string>, label: string): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    if (lastFlowNodeIds.length === 0 || !lastFlowNodeIds.every(id => nodeIds.has(id))) {
      throw new Error(`the canvas does not show ${label} yet`);
    }
  }, { timeout: 10_000, interval: 25 });
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
  await waitForCanvasOf(postDacpacModel(40, 1, 'first.dacpac'), 'first.dacpac');
  const firstCount = lastFlowNodeCount;
  await waitForCanvasOf(postDacpacModel(90, 2, 'second.dacpac', secondConfig), 'second.dacpac');
  return { firstCount, secondCount: lastFlowNodeCount };
}

describe('reload into an already-open panel', () => {
  it('renders the second model when the frame carries changed settings', async () => {
    const changed = { ...objectViewConfig, layout: { ...objectViewConfig.layout, rankSeparation: objectViewConfig.layout.rankSeparation + 40 } };
    const { firstCount, secondCount } = await loadTwice(changed);
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBeGreaterThan(firstCount);
  }, 30000);

  it('renders the second model with unchanged settings', async () => {
    const { firstCount, secondCount } = await loadTwice(objectViewConfig);
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBeGreaterThan(firstCount);
  }, 30000);

  it('passes the full-model graph of the loaded model to the canvas', async () => {
    const { secondCount } = await loadTwice(objectViewConfig);
    expect(lastModelGraphOrder).toBeGreaterThanOrEqual(secondCount);
  }, 30000);

  it('renders the second model when rebuild-config lands between its build and the next render', async () => {
    const { App } = await import('../../../src/components/App');
    let armed = false;
    const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };
    w.vscode = {
      postMessage: (m: unknown) => {
        const text = (m as { text?: string }).text ?? '';
        if (!armed || !text.startsWith('[Filter] Graph built')) return;
        armed = false;
        window.dispatchEvent(new MessageEvent('message', {
          data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, type: 'rebuild-config', config: { ...objectViewConfig } },
        }));
      },
    };
    try {
      act(() => {
        root.render(
          <VsCodeProvider api={{ postMessage: vi.fn() } as never}>
            <App />
          </VsCodeProvider>
        );
      });
      await waitForCanvasOf(postDacpacModel(40, 1, 'first.dacpac'), 'first.dacpac');
      const firstCount = lastFlowNodeCount;
      armed = true;
      await waitForCanvasOf(postDacpacModel(90, 2, 'second.dacpac'), 'second.dacpac');
      expect(armed).toBe(false);
      expect(firstCount).toBeGreaterThan(0);
      expect(lastFlowNodeCount).toBeGreaterThan(firstCount);
    } finally {
      delete w.vscode;
    }
  }, 30000);
});
