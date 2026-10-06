// @vitest-environment jsdom
/**
 * One schema colour per schema across the canvas: the trace navigator, the column view and the
 * column-view minimap use the collision-resolved colour the object nodes carry, not the raw
 * per-schema hash, which can give two schemas the same colour.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { buildGraph } from '../../../src/engine/graphBuilder';
import type { CustomNodeData, DatabaseModel } from '../../../src/engine/types';
import { createSchemaColorMap, getSchemaColor, getSchemaColorFromMap } from '../../../src/utils/schemaColors';
import { canvasProps, installLayoutPolyfills, mountCanvas, type MountedCanvas } from './graphCanvasHarness';

/** Two schema names whose raw hash colours collide, so the loaded-set map must separate them. */
function collidingSchemas(): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; i < 10_000; i++) {
    const name = `sch${i}`;
    const color = getSchemaColor(name);
    const other = seen.get(color);
    if (other) return [other, name];
    seen.set(color, name);
  }
  throw new Error('no colliding schema names found');
}

const [schemaA, schemaB] = collidingSchemas();
const generated = generateDwhModel({ objectCount: 6, seed: 3, profile: { externalRefCount: 0, schemaCount: 2 } }).model;
const rename = new Map(generated.schemas.map((s, i) => [s.name, i === 0 ? schemaA : schemaB]));
const model: DatabaseModel = {
  ...generated,
  schemas: generated.schemas.map(s => ({ ...s, name: rename.get(s.name)! })),
  nodes: generated.nodes.map(n => ({ ...n, schema: rename.get(n.schema) ?? n.schema })),
};
const schemas = [schemaA, schemaB];
const colorMap = createSchemaColorMap(schemas);
const built = buildGraph(model);
/** Object nodes as `useGraphology` hands them over: each carries its resolved schema colour. */
const flowNodes = (built.flowNodes as FlowNode<CustomNodeData>[]).map(n => ({
  ...n,
  data: { ...n.data, schemaColor: getSchemaColorFromMap(n.data.schema, colorMap) },
})) as FlowNode[];
const edge = model.edges.find(e => {
  const source = model.nodes.find(n => n.id === e.source)!;
  const target = model.nodes.find(n => n.id === e.target)!;
  return source.schema !== target.schema;
})!;
const resolved = (id: string) => getSchemaColorFromMap(model.nodes.find(n => n.id === id)!.schema, colorMap);

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

describe('GraphCanvas schema colours', () => {
  it('the colliding schemas resolve to distinct object-node colours', () => {
    expect(getSchemaColor(schemaA)).toBe(getSchemaColor(schemaB));
    expect(colorMap.get(schemaA)).not.toBe(colorMap.get(schemaB));
    expect(edge, 'the fixture has a cross-schema edge').toBeTruthy();
  });

  it('trace navigator rows use the object node colour of their schema', async () => {
    const traced = new Set(model.nodes.map(n => n.id));
    canvas = mountCanvas({
      ...canvasProps(flowNodes, built.flowEdges, schemas),
      model,
      graph: built.graph,
      modelGraph: built.graph,
      traceScopeGraph: built.graph,
      onToggleTraceTreeCollapsed: () => {},
      trace: {
        ...canvasProps(flowNodes, built.flowEdges, schemas).trace,
        mode: 'applied',
        selectedNodeId: edge.source,
        baseNodeIds: traced,
        tracedNodeIds: traced,
      },
    });
    await canvas.flush();
    const leaves = [...canvas.host.querySelectorAll<HTMLElement>('[data-testid^="trace-tree-row-up:"], [data-testid^="trace-tree-row-down:"]')];
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      const nodeId = leaf.getAttribute('data-testid')!.replace(/^trace-tree-row-(up|down):/, '');
      expect(leaf.style.getPropertyValue('--ln-tree-schema'), nodeId).toBe(resolved(nodeId));
    }
  });

  it('column-view nodes and their minimap blocks use the object node colour of their schema', async () => {
    const aiPreview = {
      name: 'Columns',
      nodeIds: new Set(model.nodes.map(n => n.id)),
      aiMetadata: {
        createdAt: '2026-09-27T00:00:00Z',
        modelName: 'test',
        highlightGroups: [],
        badges: [],
        columnAspect: { edges: [{ hopNode: edge.target, fromNode: edge.source, toNode: edge.target, fromCol: 'A', toCol: 'B' }] },
      },
    };
    canvas = mountCanvas({ ...canvasProps(flowNodes, built.flowEdges, schemas), model, aiPreview, onDiscardAiPreview: () => {} });
    await canvas.flush();
    act(() => {
      ([...canvas!.host.querySelectorAll('[aria-label="View detail level"] button')]
        .find(b => b.textContent?.trim() === 'Detail') as HTMLButtonElement).click();
    });
    await canvas.flush();
    for (const id of [edge.source, edge.target]) {
      const node = canvas.host.querySelector(`.react-flow__node-columnTraceNode[data-id="${CSS.escape(id)}"]`) as HTMLElement;
      expect(node, id).toBeTruthy();
      const bordered = [node, ...node.querySelectorAll<HTMLElement>('*')].find(el => el.style.borderLeftColor);
      expect(bordered?.style.borderLeftColor, id).toBe(hexToRgb(resolved(id)));
    }
    const fills = [...canvas.host.querySelectorAll<SVGElement>('.react-flow__minimap-node')].map(el => el.style.fill);
    // Detail shows every presented object, so the minimap holds one block per model node.
    expect(fills.sort()).toEqual(model.nodes.map(n => resolved(n.id)).map(hexToRgb).sort());
  });
});

/** jsdom normalises inline hex colours to `rgb(...)`. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
