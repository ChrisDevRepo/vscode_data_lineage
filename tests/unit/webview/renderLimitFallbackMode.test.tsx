// @vitest-environment jsdom
/**
 * Pins that an Object View over the render limit stays in Object View: nothing is drawn, the
 * render-limit notice offers "Open Schema View" as the user's choice, and choosing it shows Schema
 * View; with Schema View disabled in settings the notice offers no switch.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

interface CanvasProps {
  graphMode?: string;
  flowNodes: Array<{ type?: string; data?: { schemaName?: string } }>;
  onGraphModeChange?: (mode: 'full' | 'overview') => void;
  onExpandExpandedSchemaViewSchema?: (schema: string) => void;
  renderLimitNotice?: unknown;
}
let canvasProps: CanvasProps | null = null;

vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => {
    canvasProps = props;
    return (props.renderLimitNotice ?? null) as never;
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  canvasProps = null;
  w.vscode = { postMessage: () => {} };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
  vi.useRealTimers();
});

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

/** A 60-object graph over a 50-object Schema View threshold, so Schema View is available. */
const aboveThreshold = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, threshold: 50 } };

async function openInObjectView(model: unknown): Promise<void> {
  post({ type: 'dacpac-model', model, config: aboveThreshold, sourceName: 'm.dacpac', autoVisualize: true });
  await settle();
  expect(canvasProps?.graphMode).toBe('overview');
  act(() => canvasProps!.onGraphModeChange!('full'));
  await settle();
  expect(canvasProps?.graphMode).toBe('full');
  expect(canvasProps?.flowNodes.length).toBeGreaterThan(0);
}

const openSchemaViewButton = () =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Open Schema View');

describe('render limit in Object View', () => {
  it('stays in Object View with nothing drawn and offers Schema View in the notice', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const { model } = generateDwhModel({ objectCount: 60, seed: 1, profile: { externalRefCount: 0 } });
    await openInObjectView(model);

    post({ type: 'rebuild-config', config: { ...aboveThreshold, renderLimit: 10 } });
    await settle();

    expect(canvasProps?.flowNodes).toEqual([]);
    expect(canvasProps?.graphMode).toBe('full');
    expect(host.textContent).toContain('Render limit reached');
    expect(openSchemaViewButton()).toBeDefined();
  }, 15000);

  it('shows Schema View only when the user chooses it from the notice', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const { model } = generateDwhModel({ objectCount: 60, seed: 1, profile: { externalRefCount: 0 } });
    await openInObjectView(model);
    post({ type: 'rebuild-config', config: { ...aboveThreshold, renderLimit: 35 } });
    await settle();

    act(() => openSchemaViewButton()!.click());
    await settle();
    expect(canvasProps!.graphMode).toBe('overview');
    expect(canvasProps!.flowNodes.length).toBeGreaterThan(0);
    expect(canvasProps!.flowNodes.every((n) => n.type === 'schemaNode')).toBe(true);
    expect(openSchemaViewButton()).toBeUndefined();
  }, 30000);

  it('shows the render-limit notice, not Schema View, when Schema View is disabled in settings', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: () => {} } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const noOverview = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };
    const { model } = generateDwhModel({ objectCount: 60, seed: 1, profile: { externalRefCount: 0 } });
    post({ type: 'dacpac-model', model, config: noOverview, sourceName: 'm.dacpac', autoVisualize: true });
    await settle();
    expect(canvasProps?.flowNodes.length).toBeGreaterThan(0);

    post({ type: 'rebuild-config', config: { ...noOverview, renderLimit: 10 } });
    await settle();

    expect(canvasProps?.flowNodes).toEqual([]);
    expect(canvasProps?.graphMode).toBe('full');
    expect(openSchemaViewButton()).toBeUndefined();
  }, 15000);
});
