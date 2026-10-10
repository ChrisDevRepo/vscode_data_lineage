// @vitest-environment jsdom
/**
 * Pins two App contracts on a source opened without a saved project: a render that changes no
 * host-visible state posts no `filter-changed` frame, and Reset All from a trace ends it and shows
 * the default filter on both the toolbar and the canvas in the same update — the view saved on
 * trace entry is not restored over the reset, and no timer stands between the two.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG, type ObjectType, type TraceState } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

type CanvasProps = {
  flowNodes: { id: string; data: { objectType?: ObjectType } }[];
  filter: { types: Set<ObjectType> };
  trace: TraceState;
  onToggleDetailSearch: () => void;
  onToggleType: (type: ObjectType) => void;
  onStartTraceImmediate: (nodeId: string) => void;
  onResetAll: () => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));

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
  canvas.props = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
const { model } = generateDwhModel({ objectCount: 30, seed: 3, profile: { externalRefCount: 0 } });

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

async function openUnsavedSource(): Promise<CanvasProps> {
  const { App } = await import('../../../src/components/App');
  act(() => {
    root.render(
      <VsCodeProvider api={{ postMessage: (m: unknown) => { posted.push(m as { type: string }); } } as never}>
        <App />
      </VsCodeProvider>
    );
  });
  post({ type: 'dacpac-model', model, config: objectViewConfig, sourceName: 'Sales', autoVisualize: true });
  await settle();
  expect(canvas.props).not.toBeNull();
  return canvas.props!;
}

const hostSyncCount = () => posted.filter((m) => m.type === 'filter-changed').length;
const shownTypes = () => new Set(canvas.props!.flowNodes.map((n) => n.data.objectType));

describe('App without a saved project', () => {
  it('posts no filter-changed frame for a render that changes no host-visible state', async () => {
    await openUnsavedSource();
    const before = hostSyncCount();
    expect(before).toBeGreaterThan(0);

    act(() => canvas.props!.onToggleDetailSearch());
    act(() => canvas.props!.onToggleDetailSearch());

    expect(hostSyncCount()).toBe(before);
  }, 15000);

  it('Reset All ends the trace and shows the default view without waiting on a timer', async () => {
    await openUnsavedSource();
    expect(shownTypes().has('table')).toBe(true);

    act(() => canvas.props!.onToggleType('table'));
    await settle();
    expect(shownTypes().has('table')).toBe(false);

    const origin = canvas.props!.flowNodes[0].id;
    act(() => canvas.props!.onStartTraceImmediate(origin));
    expect(canvas.props!.trace.mode).toBe('filtered');

    act(() => canvas.props!.onResetAll());

    expect(canvas.props!.trace.mode).toBe('none');
    expect(canvas.props!.filter.types.has('table')).toBe(true);
    expect(shownTypes().has('table')).toBe(true);

    await settle();
    expect(canvas.props!.filter.types.has('table')).toBe(true);
    expect(shownTypes().has('table')).toBe(true);
  }, 15000);
});
