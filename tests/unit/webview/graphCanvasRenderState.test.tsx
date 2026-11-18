// @vitest-environment jsdom
/**
 * The canvas mirrors its render state to the host after every change that alters it, and posts
 * nothing when its inputs are unchanged, so the host buffer behind `get_screen_state` is never stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { canvasProps, installLayoutPolyfills, mountCanvas, type MountedCanvas } from './graphCanvasHarness';

type RenderState = { type: 'render-state'; renderState: { renderedNodeCount: number; traceScope: { manualAddedNodeIds: string[] } | null } };

const nodes = ['a', 'b'].map((id, i) => ({
  id, type: 'lineageNode', position: { x: i * 300, y: 0 },
  data: { label: id, schema: 'dbo', objectType: 'table', schemaColor: '#888', inDegree: 0, outDegree: 0 },
})) as unknown as FlowNode[];

let restore: () => void;
let canvas: MountedCanvas | null = null;
let posted: unknown[];
const renderStates = () => posted.filter((m): m is RenderState => (m as { type?: string }).type === 'render-state');
const latest = () => renderStates().at(-1)!.renderState;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  restore = installLayoutPolyfills();
  posted = [];
});
afterEach(() => {
  canvas?.unmount();
  canvas = null;
  restore();
  vi.useRealTimers();
});

const base = () => ({ ...canvasProps(nodes, [], ['dbo']), graphErrorResetKey: 'k' });
const withTrace = (manual: string[]) => ({
  ...base(),
  graphErrorContext: { renderedNodeCount: 2 },
  trace: {
    ...base().trace,
    mode: 'applied' as const,
    selectedNodeId: 'a',
    baseNodeIds: new Set(['a', 'b']),
    manualAddedNodeIds: new Set(manual),
    tracedNodeIds: new Set(['a', 'b']),
  },
});

describe('GraphCanvas render-state post', () => {
  it('posts the current graph context when it changes under an unchanged reset key', async () => {
    const props = { ...base(), graphErrorContext: { renderedNodeCount: 2 } };
    canvas = mountCanvas(props, m => posted.push(m));
    await canvas.flush();
    expect(latest().renderedNodeCount).toBe(2);
    canvas.render({ ...props, graphErrorContext: { renderedNodeCount: 5 } });
    await canvas.flush();
    expect(latest().renderedNodeCount).toBe(5);
  });

  it('posts the current trace scope when a manual addition keeps the traced count', async () => {
    const props = withTrace([]);
    canvas = mountCanvas(props, m => posted.push(m));
    await canvas.flush();
    expect(latest().traceScope!.manualAddedNodeIds).toEqual([]);
    canvas.render({ ...props, trace: { ...props.trace, manualAddedNodeIds: new Set(['b']) } });
    await canvas.flush();
    expect(latest().traceScope!.manualAddedNodeIds).toEqual(['b']);
  });

  it('posts nothing again when every input is unchanged', async () => {
    const props = withTrace(['b']);
    canvas = mountCanvas(props, m => posted.push(m));
    await canvas.flush();
    const before = renderStates().length;
    expect(before).toBeGreaterThan(0);
    canvas.render({ ...props });
    await canvas.flush();
    expect(renderStates()).toHaveLength(before);
  });
});
