// @vitest-environment jsdom
/**
 * The canvas leaves room for the docked AI report by its measured size. A size measured on one
 * dock edge is meaningless on another, so switching the dock drops it until the panel reports its
 * size on the new edge.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { buildGraph } from '../../../src/engine/graphBuilder';
import { canvasProps, installLayoutPolyfills, mountCanvas, type MountedCanvas } from './graphCanvasHarness';

const { model } = generateDwhModel({ objectCount: 6, seed: 3, profile: { externalRefCount: 0, schemaCount: 2 } });
const built = buildGraph(model);
const schemas = model.schemas.map(s => s.name);
/** Sizes the report panel reports on each dock edge; other observed elements report the pane size. */
const SIDE = { width: 440, height: 800 };
const BOTTOM = { width: 1200, height: 300 };
const sizeOf = (el: Element) => el.classList.contains('ln-ai-description-anchor-bottom') ? BOTTOM
  : el.classList.contains('ln-ai-description-anchor') ? SIDE
    : { width: 1200, height: 800 };

let restore: () => void;
let canvas: MountedCanvas | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  restore = installLayoutPolyfills(sizeOf);
});
afterEach(() => {
  canvas?.unmount();
  canvas = null;
  restore();
  vi.useRealTimers();
});

/** The absolutely positioned box the React Flow pane lives in; its insets reserve the report's room. */
function canvasBox(host: HTMLElement): HTMLElement {
  return host.querySelector('.react-flow')!.parentElement as HTMLElement;
}

/** Waits, bounded, for the lazily loaded report rail, opens the report and returns its dock menu trigger. */
async function openReport(host: HTMLElement): Promise<HTMLElement> {
  await vi.waitFor(async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(host.querySelector('.ln-ai-description-rail-toggle')).not.toBeNull();
  }, { timeout: 5000, interval: 20 });
  act(() => { (host.querySelector('.ln-ai-description-rail-toggle') as HTMLElement).click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  return host.querySelector('button[aria-label="Report panel dock position"]') as HTMLElement;
}

const aiPreview = {
  name: 'Report',
  nodeIds: new Set(model.nodes.map(n => n.id)),
  aiMetadata: { createdAt: '2026-09-27T00:00:00Z', modelName: 'test', highlightGroups: [], badges: [], description: 'Body text' },
};

function dockTo(label: 'Dock left' | 'Dock bottom' | 'Dock right', trigger: HTMLElement): void {
  act(() => { trigger.click(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el => el.textContent?.endsWith(label))!;
  act(() => { item.click(); });
}

describe('AI report dock reserve', () => {
  it('reserves the size the panel reports on its new edge, not the one measured on the old edge', async () => {
    canvas = mountCanvas({ ...canvasProps(built.flowNodes as FlowNode[], built.flowEdges, schemas), model, aiPreview, onDiscardAiPreview: () => {} });
    const trigger = await openReport(canvas.host);
    const box = canvasBox(canvas.host);
    expect(box.style.right, 'the right-docked panel reported its measured width').toBe(`${SIDE.width}px`);

    dockTo('Dock bottom', trigger);
    expect(box.style.right).toBe('0px');
    expect(box.style.bottom, 'the bottom edge reserves the height measured there').toBe(`${BOTTOM.height}px`);

    dockTo('Dock left', trigger);
    expect(box.style.bottom).toBe('0px');
    expect(box.style.left, 'the left edge reserves the width measured there').toBe(`${SIDE.width}px`);
  });
});
