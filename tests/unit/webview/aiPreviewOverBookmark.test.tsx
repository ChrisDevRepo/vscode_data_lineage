// @vitest-environment jsdom
/**
 * Pins that an AI preview arriving while a bookmark view is shown replaces the bookmark and stays
 * shown, and that discarding it returns the user's selection from before the bookmark — not the
 * widened filter the bookmark was saved with.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

type CanvasProps = {
  aiPreview?: unknown;
  activeAdvancedProfile?: unknown;
  onSaveAiBookmark?: (name: string) => void;
  onDiscardAiPreview?: () => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; uiState?: { filter?: { hideIsolated?: boolean } } };

let host: HTMLDivElement;
let root: Root;
let posted: Posted[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
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
const preview = (name: string, nodeIds: string[]) => ({
  type: 'ai-view-preview',
  name,
  nodeIds,
  aiMetadata: { createdAt: '2026-09-27T00:00:00Z', modelName: 'test', highlightGroups: [], badges: [] },
});
const lastHostFilter = () => posted.filter((m) => m.type === 'filter-changed').at(-1)?.uiState?.filter;

describe('AI preview over a bookmark view', () => {
  it('replaces the bookmark, stays shown, and discards back to the pre-bookmark selection', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: (m: unknown) => { posted.push(m as Posted); } } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    post({ type: 'projects-list', projects: [project], lastOpenedId: 'p1' });
    post({ type: 'dacpac-model', model, config: { ...DEFAULT_CONFIG }, sourceName: 'Sales', autoVisualize: true });
    await settle();
    expect(lastHostFilter()?.hideIsolated).toBe(true);

    post(preview('First', [model.nodes[0].id]));
    act(() => canvas.props?.onSaveAiBookmark?.('First'));
    expect(canvas.props?.activeAdvancedProfile).toBeTruthy();
    expect(canvas.props?.aiPreview).toBeNull();

    post(preview('Second', [model.nodes[1].id]));
    expect(canvas.props?.activeAdvancedProfile).toBeNull();
    expect(canvas.props?.aiPreview).toBeTruthy();

    act(() => canvas.props?.onDiscardAiPreview?.());
    expect(canvas.props?.aiPreview).toBeNull();
    expect(lastHostFilter()?.hideIsolated).toBe(true);
  }, 15000);
});
