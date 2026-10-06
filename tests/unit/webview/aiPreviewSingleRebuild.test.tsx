// @vitest-environment jsdom
/**
 * Pins that one `ai-view-preview` frame rebuilds the graph exactly once, including under
 * StrictMode, where React may invoke state updaters twice.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: () => null,
}));

const buildCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/engine/graphBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/graphBuilder')>();
  return {
    ...actual,
    buildGraph: (...args: Parameters<typeof actual.buildGraph>) => {
      buildCalls.count += 1;
      return actual.buildGraph(...args);
    },
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  buildCalls.count = 0;
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

const { model } = generateDwhModel({ objectCount: 30, seed: 1, profile: { externalRefCount: 0 } });
const project = {
  id: 'p1',
  name: 'Sales',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  connection: { type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'sales.dacpac', schemas: [] },
};

describe('AI preview rebuild count', () => {
  it('rebuilds exactly once per preview frame under StrictMode', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <StrictMode>
          <VsCodeProvider api={{ postMessage: () => {} } as never}>
            <App />
          </VsCodeProvider>
        </StrictMode>
      );
    });
    post({ type: 'projects-list', projects: [project], lastOpenedId: 'p1' });
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'Sales', autoVisualize: true });
    await settle();

    buildCalls.count = 0;
    post({
      type: 'ai-view-preview',
      name: 'Preview',
      nodeIds: [model.nodes[0].id, model.nodes[1].id],
      aiMetadata: { createdAt: '2026-09-27T00:00:00Z', modelName: 'test', highlightGroups: [], badges: [] },
    });
    await settle();
    expect(buildCalls.count).toBe(1);
  }, 15000);
});
