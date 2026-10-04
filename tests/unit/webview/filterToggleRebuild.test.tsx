// @vitest-environment jsdom
/**
 * Pins that filter toggles and schema selection rebuild the graph from the next filter after the
 * state update, not from inside the setState updater. A rebuild there calls startTransition during render.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG, type ObjectType } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

const RENDER_PHASE_TRANSITION = 'Cannot call startTransition while rendering';

type FilterProps = {
  hideIsolated: boolean;
  types: Set<ObjectType>;
  schemas: Set<string>;
  showExternalRefs: boolean;
  externalRefTypes: Set<'file' | 'db'>;
  exclusionPatterns: string[];
};

type CanvasProps = {
  flowNodes: { id: string }[];
  filter: FilterProps;
  onToggleIsolated: () => void;
  onToggleType: (type: ObjectType) => void;
  onToggleSchema: (schema: string) => void;
  onSelectAllSchemas: (schemas: string[]) => void;
  onSelectNoneSchemas: (schemas: string[]) => void;
  onToggleExternalRefs: () => void;
  onToggleExternalRefType: (subType: 'file' | 'db') => void;
  onAddExclusionPattern: (pattern: string) => void;
  onRemoveExclusionPattern: (pattern: string) => void;
};

const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  canvas.props = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
const { model } = generateDwhModel({ objectCount: 40, seed: 1, profile: { externalRefCount: 4 } });

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

/** Runs a toggle and returns any render-phase startTransition reports React emitted. */
async function toggle(run: (props: CanvasProps) => void): Promise<string[]> {
  const hits: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
    if (text.includes(RENDER_PHASE_TRANSITION)) hits.push(text);
  });
  try {
    await act(async () => { run(canvas.props as CanvasProps); });
  } finally {
    spy.mockRestore();
  }
  return hits;
}

describe('filter toggles rebuild outside the setState updater', () => {
  it('toggles Hide Isolated Nodes, object type, external refs, and an exclusion without rebuilding during render', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    post({ type: 'dacpac-model', model, config: objectViewConfig, sourceName: 'Sales', autoVisualize: true });
    await settle();

    const loaded = canvas.props as CanvasProps;
    expect(loaded.filter.hideIsolated).toBe(true);
    const hiddenCount = loaded.flowNodes.length;
    expect(hiddenCount).toBeGreaterThan(0);

    expect(await toggle((props) => props.onToggleIsolated())).toEqual([]);
    const shown = canvas.props as CanvasProps;
    expect(shown.filter.hideIsolated).toBe(false);
    expect(shown.flowNodes.length).toBeGreaterThan(hiddenCount);

    const withTables = shown.flowNodes.length;
    expect(await toggle((props) => props.onToggleType('table'))).toEqual([]);
    const withoutTables = canvas.props as CanvasProps;
    expect(withoutTables.filter.types.has('table')).toBe(false);
    expect(withoutTables.flowNodes.length).toBeLessThan(withTables);

    expect(await toggle((props) => props.onToggleExternalRefs())).toEqual([]);
    const refsOff = canvas.props as CanvasProps;
    expect(refsOff.filter.showExternalRefs).toBe(false);
    expect(refsOff.flowNodes.length).toBeLessThan(withoutTables.flowNodes.length);

    expect(await toggle((props) => props.onToggleExternalRefs())).toEqual([]);
    expect(await toggle((props) => props.onToggleExternalRefType('file'))).toEqual([]);
    const filesOff = canvas.props as CanvasProps;
    expect(filesOff.filter.externalRefTypes.has('file')).toBe(false);
    expect(filesOff.flowNodes.length).toBeLessThan(withoutTables.flowNodes.length);

    const excluded = model.nodes.find((node) => node.type === 'view');
    expect(excluded).toBeDefined();
    const pattern = excluded!.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await act(async () => { (canvas.props as CanvasProps).onAddExclusionPattern(pattern); });
    const excludedCount = (canvas.props as CanvasProps).flowNodes.length;
    expect(excludedCount).toBeLessThan(filesOff.flowNodes.length);

    expect(await toggle((props) => props.onRemoveExclusionPattern(pattern))).toEqual([]);
    const restored = canvas.props as CanvasProps;
    expect(restored.filter.exclusionPatterns).toEqual([]);
    expect(restored.flowNodes.length).toBe(filesOff.flowNodes.length);
  }, 15000);

  it('toggles a schema, selects all, and selects none without rebuilding during render', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    post({ type: 'dacpac-model', model, config: objectViewConfig, sourceName: 'Sales', autoVisualize: true });
    await settle();

    const loaded = canvas.props as CanvasProps;
    const visibleIds = new Set(loaded.flowNodes.map((node) => node.id));
    const schema = model.schemas.find((entry) =>
      model.nodes.some((node) => node.schema === entry.name && visibleIds.has(node.id))
    )?.name;
    expect(schema).toBeTruthy();
    expect(loaded.filter.schemas.has(schema!)).toBe(true);
    const fullCount = loaded.flowNodes.length;
    const fullSchemas = loaded.filter.schemas.size;
    expect(fullCount).toBeGreaterThan(0);

    expect(await toggle((props) => props.onToggleSchema(schema!))).toEqual([]);
    const hidden = canvas.props as CanvasProps;
    expect(hidden.filter.schemas.has(schema!)).toBe(false);
    expect(hidden.filter.schemas.size).toBe(fullSchemas - 1);
    expect(hidden.flowNodes.length).toBeLessThan(fullCount);

    expect(await toggle((props) => props.onSelectAllSchemas(model.schemas.map((entry) => entry.name)))).toEqual([]);
    const selected = canvas.props as CanvasProps;
    expect(selected.filter.schemas.has(schema!)).toBe(true);
    expect(selected.filter.schemas.size).toBe(fullSchemas);
    expect(selected.flowNodes.length).toBe(fullCount);

    expect(await toggle((props) => props.onSelectNoneSchemas([schema!]))).toEqual([]);
    const cleared = canvas.props as CanvasProps;
    expect(cleared.filter.schemas.has(schema!)).toBe(false);
    expect(cleared.filter.schemas.size).toBe(fullSchemas - 1);
    expect(cleared.flowNodes.length).toBeLessThan(fullCount);
  }, 15000);
});
