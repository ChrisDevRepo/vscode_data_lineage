// @vitest-environment jsdom
/**
 * App-level view state: Reset all drops the saved pre-lock snapshot and rebuilds in the same
 * update; a refused saved-view apply changes nothing; graph error context is derived only when
 * its inputs change; transitions do not subscribe to a pending flag nobody reads.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { serializeFilter } from '../../../src/engine/projectStore';
import { DEFAULT_CONFIG, type FilterState } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

type CanvasProps = {
  filter: FilterState;
  flowNodes: unknown[];
  activeViewId: string | null;
  onToggleSchema: (schema: string) => void;
  onSelectNoneSchemas: (schemas: string[]) => void;
  onResetAll: () => void;
  onStartTraceImmediate: (nodeId: string) => void;
  onApplyView: (profile: unknown) => void;
  onToggleDetailSearch: () => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));
const spies = vi.hoisted(() => ({ connectivityCalls: 0, useTransitionCalls: 0 }));
vi.mock('../../../src/engine/renderConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/renderConnectivity')>();
  return {
    ...actual,
    summarizeRenderedConnectivity: (...args: Parameters<typeof actual.summarizeRenderedConnectivity>) => {
      spies.connectivityCalls++;
      return actual.summarizeRenderedConnectivity(...args);
    },
  };
});
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => { spies.useTransitionCalls++; return actual.useTransition(); } };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; text?: string };

let host: HTMLDivElement;
let root: Root;
let posted: Posted[];
const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
const { model } = generateDwhModel({ objectCount: 40, seed: 1, profile: { externalRefCount: 0, schemaCount: 3 } });
const schemaNames = model.schemas.map(s => s.name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
  canvas.props = null;
  spies.connectivityCalls = 0;
  spies.useTransitionCalls = 0;
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

async function mountLoaded(config = objectViewConfig): Promise<void> {
  const { App } = await import('../../../src/components/App');
  act(() => {
    root.render(
      <VsCodeProvider api={{ postMessage: (m: unknown) => { posted.push(m as Posted); } } as never}>
        <App />
      </VsCodeProvider>
    );
  });
  post({ type: 'dacpac-model', model, config, sourceName: 'big.dacpac', autoVisualize: true });
  await settle();
}

describe('Reset all', () => {
  it('rebuilds in the same update and is not undone by the pre-trace snapshot', async () => {
    await mountLoaded();
    const [first] = schemaNames;
    act(() => canvas.props!.onSelectNoneSchemas!(schemaNames));
    act(() => canvas.props!.onToggleSchema!(first));
    await settle();
    const narrowed = canvas.props!.flowNodes.length;
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThan(model.nodes.length);

    const origin = model.nodes.find(n => n.schema === first)!.id;
    act(() => canvas.props!.onStartTraceImmediate(origin));
    await settle();

    act(() => canvas.props!.onResetAll());
    expect(canvas.props!.flowNodes.length, 'rebuilt without waiting for a timer').toBeGreaterThan(narrowed);
    const rebuilt = canvas.props!.flowNodes.length;
    await settle();
    expect([...canvas.props!.filter.schemas].sort()).toEqual([...schemaNames].sort());
    expect(canvas.props!.flowNodes).toHaveLength(rebuilt);
  }, 15000);
});

describe('Apply saved view', () => {
  it('leaves the active view, filter and graph unchanged when the selection is refused', async () => {
    await mountLoaded();
    const [first, second] = schemaNames;
    const firstCount = model.nodes.filter(n => n.schema === first).length;
    act(() => canvas.props!.onSelectNoneSchemas!(schemaNames));
    act(() => canvas.props!.onToggleSchema!(first));
    post({ type: 'rebuild-config', config: { ...objectViewConfig, maxNodes: firstCount } });
    await settle();
    posted.length = 0;
    const kept = canvas.props!.flowNodes.length;

    const over = { ...canvas.props!.filter, schemas: new Set([first, second]) };
    act(() => canvas.props!.onApplyView({ id: 'v1', name: 'Over', createdAt: '2026-01-01T00:00:00Z', filter: serializeFilter(over) }));
    await settle();

    expect(canvas.props!.activeViewId).toBeNull();
    expect([...canvas.props!.filter.schemas]).toEqual([first]);
    expect(canvas.props!.flowNodes).toHaveLength(kept);
  }, 15000);
});

describe('render surface derivation', () => {
  it('does not re-derive connectivity on a render with unchanged graph inputs', async () => {
    await mountLoaded();
    expect(spies.connectivityCalls).toBeGreaterThan(0);
    spies.connectivityCalls = 0;
    act(() => canvas.props!.onToggleDetailSearch());
    act(() => canvas.props!.onToggleDetailSearch());
    expect(spies.connectivityCalls).toBe(0);
  }, 15000);
});

describe('transitions', () => {
  it('does not call useTransition where the pending flag is discarded', async () => {
    await mountLoaded();
    expect(spies.useTransitionCalls).toBe(0);
  }, 15000);
});
