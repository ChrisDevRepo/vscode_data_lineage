// @vitest-environment jsdom
/**
 * Pins that every object-view rebuild made while an AI preview is shown lays out with the badge and
 * footnote band for the preview's annotated nodes — a settings rebuild included, not only the
 * rebuild the preview itself triggers.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: () => null,
}));

const layoutCalls = vi.hoisted(() => ({ annotated: [] as Array<readonly string[] | undefined> }));
vi.mock('../../../src/engine/graphBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/graphBuilder')>();
  return {
    ...actual,
    buildGraph: (...args: Parameters<typeof actual.buildGraph>) => {
      layoutCalls.annotated.push(args[2]);
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
  layoutCalls.annotated = [];
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

describe('AI preview annotation band across rebuilds', () => {
  it('keeps the annotated ids on a settings rebuild while the preview is shown', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    post({ type: 'projects-list', projects: [project], lastOpenedId: 'p1' });
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'Sales', autoVisualize: true });
    await settle();

    const [a, b] = [model.nodes[0].id, model.nodes[1].id];
    post({
      type: 'ai-view-preview',
      name: 'Preview',
      nodeIds: [a, b],
      aiMetadata: {
        createdAt: '2026-09-27T00:00:00Z',
        modelName: 'test',
        highlightGroups: [],
        badges: [{ nodeId: a, text: 'Source' }],
        notes: [{ nodeId: b, text: 'Target' }],
      },
    });
    await settle();
    expect([...(layoutCalls.annotated.at(-1) ?? [])].sort()).toEqual([a, b].sort());

    layoutCalls.annotated = [];
    post({ type: 'rebuild-config', config: { ...DEFAULT_CONFIG } });
    await settle();
    expect(layoutCalls.annotated.length).toBeGreaterThan(0);
    expect([...(layoutCalls.annotated.at(-1) ?? [])].sort()).toEqual([a, b].sort());
  }, 15000);
});
