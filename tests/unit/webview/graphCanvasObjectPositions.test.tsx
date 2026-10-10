// @vitest-environment jsdom
/**
 * Bookmarks and exports are object-view artifacts. While the column view is on stage React Flow
 * holds column nodes under the same ids, in another coordinate space; every bookmark save and the
 * Draw.io export must still read the object nodes and edges. Switching views clears a graph error,
 * and a new column relation set drops the hand-placed column positions and the pinned thread.
 */
import { act, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { buildGraph } from '../../../src/engine/graphBuilder';
import type { AIViewMetadata } from '../../../src/engine/projectStore';
import { canvasProps, installLayoutPolyfills, mountCanvas, type MountedCanvas } from './graphCanvasHarness';

const exporter = vi.hoisted(() => ({ nodes: null as FlowNode[] | null, edges: null as FlowEdge[] | null }));
vi.mock('../../../src/export/drawioExporter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/export/drawioExporter')>();
  return {
    ...actual,
    exportToDrawio: (nodes: FlowNode[], edges: FlowEdge[], ...rest: unknown[]) => {
      exporter.nodes = nodes;
      exporter.edges = edges;
      return (actual.exportToDrawio as (...args: unknown[]) => string)(nodes, edges, ...rest);
    },
  };
});

const columnNodeFault = vi.hoisted(() => ({ throws: false }));
vi.mock('../../../src/components/ColumnTraceNode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/components/ColumnTraceNode')>();
  const Original = actual.ColumnTraceNode as unknown as (props: object) => ReactElement;
  return {
    ...actual,
    ColumnTraceNode: (props: object) => {
      if (columnNodeFault.throws) throw new Error('column node render failure');
      return <Original {...props} />;
    },
  };
});

const { model } = generateDwhModel({ objectCount: 6, seed: 3, profile: { externalRefCount: 0, schemaCount: 2 } });
const built = buildGraph(model);
const flowNodes = built.flowNodes as FlowNode[];
const schemas = model.schemas.map(s => s.name);
const edge = model.edges[0];
const objectPositions = Object.fromEntries(flowNodes.map(n => [n.id, n.position]));

const metadata = (fromCol = 'A'): AIViewMetadata => ({
  createdAt: '2026-09-27T00:00:00Z',
  modelName: 'test',
  highlightGroups: [],
  badges: [],
  columnAspect: { edges: [{ hopNode: edge.target, fromNode: edge.source, toNode: edge.target, fromCol, toCol: 'B' }] },
});
const aiPreview = (aiMetadata = metadata()) => ({ name: 'Columns', nodeIds: new Set(model.nodes.map(n => n.id)), aiMetadata });

let restore: () => void;
let canvas: MountedCanvas | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  restore = installLayoutPolyfills();
  exporter.nodes = null;
  exporter.edges = null;
  columnNodeFault.throws = false;
});
afterEach(() => {
  canvas?.unmount();
  canvas = null;
  restore();
  vi.useRealTimers();
});

function buttonByText(text: string): HTMLButtonElement {
  const button = [...canvas!.host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, `a "${text}" button`).toBeTruthy();
  return button as HTMLButtonElement;
}

/** Switches the AI banner between the object and the column view. */
function showView(label: 'Detail' | 'Objects'): void {
  act(() => {
    ([...canvas!.host.querySelectorAll('[aria-label="View detail level"] button')]
      .find(b => b.textContent?.trim() === label) as HTMLButtonElement).click();
  });
}

/** Saves through the one banner offering "Save as Bookmark", with positions. */
function saveBookmarkWithPositions(): void {
  act(() => { buttonByText('Save as Bookmark').click(); });
  const input = canvas!.host.querySelector('input[placeholder="Bookmark name..."]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Saved');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const positions = input.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  act(() => { positions.click(); });
  act(() => { buttonByText('Save').click(); });
}

function columnNodeTransform(id: string): string {
  return (canvas!.host.querySelector(`.react-flow__node-columnTraceNode[data-id="${CSS.escape(id)}"]`) as HTMLElement).style.transform;
}

async function mountColumnView(extra: object = {}): Promise<void> {
  canvas = mountCanvas({ ...canvasProps(flowNodes, built.flowEdges, schemas), model, aiPreview: aiPreview(), onDiscardAiPreview: () => {}, ...extra });
  await canvas.flush();
  showView('Detail');
  await canvas.flush();
  expect(canvas.host.querySelector('.react-flow__node-columnTraceNode'), 'the column view is on stage').not.toBeNull();
}

describe('GraphCanvas object-space artifacts while the column view is on stage', () => {
  it('saves an AI bookmark with the object positions, not the column positions', async () => {
    const onSaveAiBookmark = vi.fn();
    await mountColumnView({ onSaveAiBookmark });
    saveBookmarkWithPositions();
    expect(onSaveAiBookmark).toHaveBeenCalledWith('Saved', objectPositions);
  });

  it('saves a trace bookmark with the object positions of the traced nodes', async () => {
    const onSaveTraceBookmark = vi.fn();
    const traced = new Set([edge.source, edge.target]);
    await mountColumnView({
      onSaveTraceBookmark,
      trace: { ...canvasProps(flowNodes, built.flowEdges, schemas).trace, mode: 'applied', selectedNodeId: edge.source, baseNodeIds: traced, tracedNodeIds: traced },
    });
    saveBookmarkWithPositions();
    expect(onSaveTraceBookmark).toHaveBeenCalledWith('Saved', [...traced], {
      [edge.source]: objectPositions[edge.source],
      [edge.target]: objectPositions[edge.target],
    });
  });

  it('saves an analysis bookmark with the object positions', async () => {
    const onSaveAnalysisBookmark = vi.fn();
    await mountColumnView({
      onSaveAnalysisBookmark,
      onCloseAnalysis: () => {},
      analysisMode: {
        type: 'hubs',
        activeGroupId: null,
        result: { type: 'hubs', summary: '', groups: [{ id: 'g', label: 'Hub', nodeIds: [edge.source] }] },
      },
    });
    saveBookmarkWithPositions();
    expect(onSaveAnalysisBookmark).toHaveBeenCalledWith('Saved', [edge.source], objectPositions);
  });

  it('exports the object nodes and object edges to Draw.io', async () => {
    await mountColumnView();
    act(() => { (canvas!.host.querySelector('button[aria-label="Export as Draw.io"]') as HTMLButtonElement).click(); });
    await vi.waitFor(async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(exporter.nodes).not.toBeNull();
    }, { timeout: 5000, interval: 20 });
    expect(exporter.nodes!.map(n => n.type)).toEqual(flowNodes.map(n => n.type));
    expect(Object.fromEntries(exporter.nodes!.map(n => [n.id, n.position]))).toEqual(objectPositions);
    expect(exporter.edges!.map(e => e.id).sort()).toEqual(built.flowEdges.map(e => e.id).sort());
  });
});

describe('GraphCanvas view-scoped state', () => {
  it('clears a graph render error when the view switches back to objects', async () => {
    canvas = mountCanvas({ ...canvasProps(flowNodes, built.flowEdges, schemas), model, aiPreview: aiPreview(), onDiscardAiPreview: () => {} });
    await canvas.flush();
    columnNodeFault.throws = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      showView('Detail');
      expect(canvas.host.textContent).toContain('The graph view hit an error');
      columnNodeFault.throws = false;
      showView('Objects');
      await canvas.flush();
    } finally {
      consoleError.mockRestore();
    }
    expect(canvas.host.textContent).not.toContain('The graph view hit an error');
    expect(canvas.host.querySelectorAll('.react-flow__node-lineageNode')).toHaveLength(flowNodes.length);
  });

  it('drops the pinned column thread when the column relation set changes', async () => {
    await mountColumnView();
    const row = canvas!.host.querySelector('[role="listitem"][aria-label$=" column A"]') as HTMLElement;
    act(() => { row.click(); });
    expect(canvas!.host.querySelector('[role="listitem"][aria-current="true"]'), 'the thread is pinned').not.toBeNull();

    canvas!.render({ ...canvasProps(flowNodes, built.flowEdges, schemas), model, aiPreview: aiPreview(metadata('A')), onDiscardAiPreview: () => {} });
    await canvas!.flush();
    expect(canvas!.host.querySelector('[role="listitem"][aria-current="true"]')).toBeNull();
  });

  it('drops hand-placed column positions when the column relation set changes', async () => {
    await mountColumnView();
    const laidOut = columnNodeTransform(edge.source);
    const node = canvas!.host.querySelector(`.react-flow__node-columnTraceNode[data-id="${CSS.escape(edge.source)}"]`) as HTMLElement;
    const mouse = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'view', { value: window });
      return event;
    };
    act(() => {
      node.dispatchEvent(mouse('mousedown', 100, 100));
      window.dispatchEvent(mouse('mousemove', 140, 160));
      window.dispatchEvent(mouse('mousemove', 180, 220));
    });
    // React Flow's edge auto-pan re-arms its frame after an awaited pan; let that settle so the
    // release cancels the armed frame, as it does when a real pointer is released later.
    await act(async () => { await Promise.resolve(); });
    act(() => { window.dispatchEvent(mouse('mouseup', 180, 220)); });
    await canvas!.flush();
    expect(columnNodeTransform(edge.source), 'the drag moved the column node').not.toBe(laidOut);

    canvas!.render({ ...canvasProps(flowNodes, built.flowEdges, schemas), model, aiPreview: aiPreview(metadata('A')), onDiscardAiPreview: () => {} });
    await canvas!.flush();
    expect(columnNodeTransform(edge.source)).toBe(laidOut);
  });
});
