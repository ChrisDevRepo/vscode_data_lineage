// @vitest-environment jsdom
/**
 * The AI view banner and the view-info card count the objects in the view: after "remove from
 * view" shrinks the filter but not the preview's id set, and while the render-limit notice hands
 * the canvas no nodes.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { buildGraph } from '../../../src/engine/graphBuilder';
import { canvasProps, installLayoutPolyfills, mountCanvas, type MountedCanvas } from './graphCanvasHarness';

const { model } = generateDwhModel({ objectCount: 6, seed: 3, profile: { externalRefCount: 0, schemaCount: 2 } });
const built = buildGraph(model);
const schemas = model.schemas.map(s => s.name);
const allIds = model.nodes.map(n => n.id);
const aiPreview = {
  name: 'Report',
  nodeIds: new Set(allIds),
  aiMetadata: { createdAt: '2026-09-27T00:00:00Z', modelName: 'test', highlightGroups: [], badges: [] },
};

let restore: () => void;
let canvas: MountedCanvas | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  restore = installLayoutPolyfills();
});
afterEach(() => {
  canvas?.unmount();
  canvas = null;
  restore();
  vi.useRealTimers();
});

const bannerCount = (host: HTMLElement) => [...host.querySelectorAll('span.font-bold')].find(el => / objects$/.test(el.textContent ?? ''))?.textContent;
const cardScope = (host: HTMLElement) => host.textContent?.match(/(\d+) objects, \d+ schemas/)?.[1];

describe('AI view object count', () => {
  it('banner counts the objects left after one is removed from the view', () => {
    const removed = allIds[0];
    const kept = (built.flowNodes as FlowNode[]).filter(n => n.id !== removed);
    canvas = mountCanvas({
      ...canvasProps(kept, built.flowEdges.filter(e => e.source !== removed && e.target !== removed), schemas),
      model,
      aiPreview,
      onDiscardAiPreview: () => {},
      filteredObjectIds: new Set(kept.map(n => n.id)),
    });
    expect(bannerCount(canvas.host)).toBe(`${allIds.length - 1} objects`);
  });

  it('view-info card counts the view objects while the render-limit notice replaces the graph', () => {
    canvas = mountCanvas({
      ...canvasProps([], [], schemas),
      model,
      aiPreview,
      onDiscardAiPreview: () => {},
      filteredObjectIds: new Set(allIds),
      renderLimitNotice: createElement('div', null, 'Render limit reached'),
    });
    expect(canvas.host.textContent).toContain('Render limit reached');
    expect(bannerCount(canvas.host)).toBe(`${allIds.length} objects`);
    expect(cardScope(canvas.host)).toBe(String(allIds.length));
  });

  it('view-info card keeps the traced node count while a trace runs under the render limit', () => {
    const traced = (built.flowNodes as FlowNode[]).slice(0, 4);
    const tracedIds = new Set(traced.map(n => n.id));
    const base = canvasProps(traced, built.flowEdges.filter(e => tracedIds.has(e.source) && tracedIds.has(e.target)), schemas);
    canvas = mountCanvas({
      ...base,
      model,
      aiPreview,
      onDiscardAiPreview: () => {},
      filteredObjectIds: new Set(allIds),
      trace: { ...base.trace, mode: 'applied', selectedNodeId: traced[0].id, baseNodeIds: tracedIds, tracedNodeIds: tracedIds },
    });
    expect(cardScope(canvas.host)).toBe('4');
    expect(bannerCount(canvas.host)).toBe(`${allIds.length} objects`);
  });
});
