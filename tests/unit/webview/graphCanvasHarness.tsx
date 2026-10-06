/**
 * Mounts the real `GraphCanvas` under jsdom for camera, colour and position behaviour tests.
 *
 * @remarks
 * React Flow measures nodes through `ResizeObserver` and element offsets, which jsdom lacks; the
 * polyfills here give every node a fixed size so `useNodesInitialized` and the fit readiness check
 * settle.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react';
import { vi } from 'vitest';
import { GraphCanvas } from '../../../src/components/GraphCanvas';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { DEFAULT_CONFIG, type ExtensionConfig, type FilterState, type TraceState } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NODE_SIZE = { width: 180, height: 60 };

/**
 * Installs the jsdom layout polyfills React Flow needs; returns a restore.
 *
 * @param sizeOf - Content-box size an observed element reports to `ResizeObserver` on `observe()`;
 * every element reports 1200x800 by default.
 */
export function installLayoutPolyfills(sizeOf: (el: Element) => { width: number; height: number } = () => ({ width: 1200, height: 800 })): () => void {
  const g = globalThis as Record<string, unknown>;
  const previousResizeObserver = g.ResizeObserver;
  const previousDomMatrix = g.DOMMatrixReadOnly;
  class ImmediateResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: sizeOf(target) } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  g.ResizeObserver = ImmediateResizeObserver;
  g.DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  };
  const svgProto = SVGElement.prototype as SVGElement & { getBBox?: () => DOMRect };
  const previousGetBBox = svgProto.getBBox;
  svgProto.getBBox = () => ({ x: 0, y: 0, width: 40, height: 12 }) as DOMRect;
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('react-flow__node') ? NODE_SIZE.width : 1200; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('react-flow__node') ? NODE_SIZE.height : 800; },
  });
  return () => {
    g.ResizeObserver = previousResizeObserver;
    g.DOMMatrixReadOnly = previousDomMatrix;
    svgProto.getBBox = previousGetBBox;
    if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
  };
}

/** An idle trace: nothing selected, nothing traced. */
export function idleTrace(config: ExtensionConfig = DEFAULT_CONFIG): TraceState {
  return {
    mode: 'none',
    selectedNodeId: null,
    targetNodeId: null,
    upstreamLevels: config.trace.defaultUpstreamLevels,
    downstreamLevels: config.trace.defaultDownstreamLevels,
    baseNodeIds: new Set(),
    baseEdgeIds: new Set(),
    manualAddedNodeIds: new Set(),
    manualPrunedNodeIds: new Set(),
    tracedNodeIds: new Set(),
    tracedEdgeIds: new Set(),
  };
}

/** A filter that shows every listed schema and object type. */
export function openFilter(schemas: readonly string[]): FilterState {
  return {
    schemas: new Set(schemas),
    types: new Set(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: false,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set(['file', 'db']),
    exclusionPatterns: [],
  };
}

type CanvasProps = ComponentProps<typeof GraphCanvas>;

/** Required `GraphCanvas` props with inert handlers, for `nodes`/`edges` over `schemas`. */
export function canvasProps(nodes: FlowNode[], edges: FlowEdge[], schemas: readonly string[]): CanvasProps {
  const noop = () => {};
  return {
    flowNodes: nodes,
    flowEdges: edges,
    trace: idleTrace(),
    filter: openFilter(schemas),
    metrics: null,
    config: DEFAULT_CONFIG,
    onNodeClick: noop,
    onNodeContextMenu: noop,
    onStartTraceImmediate: noop,
    onTraceApply: noop,
    onTraceEnd: noop,
    onResetAll: noop,
    onToggleType: noop,
    onToggleIsolated: noop,
    onToggleFocusSchema: noop,
    onRefresh: noop,
    onBack: noop,
    availableSchemas: [...schemas],
    renderedSchemas: [...schemas],
    graphMode: 'full',
  };
}

/** A mounted canvas: re-render with new props, flush frames and timers, unmount. */
export interface MountedCanvas {
  host: HTMLDivElement;
  render(props: CanvasProps): void;
  /** Runs pending animation frames and timers until none remain, bounded. */
  flush(): Promise<void>;
  unmount(): void;
  vscodeState: Record<string, unknown>;
}

/** Mounts `GraphCanvas` in a `ReactFlowProvider` with a stub VS Code API. Requires fake timers that include `requestAnimationFrame`. */
export function mountCanvas(props: CanvasProps): MountedCanvas {
  const host = document.createElement('div');
  host.style.width = '1200px';
  host.style.height = '800px';
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const vscodeState: Record<string, unknown> = {};
  const api = {
    postMessage: () => {},
    getState: () => ({ ...vscodeState }),
    setState: (next: Record<string, unknown>) => { Object.assign(vscodeState, next); },
  } as unknown as VsCodeAPI;
  let mounted = true;
  const render = (next: CanvasProps) => act(() => {
    root.render(
      <VsCodeProvider api={api}>
        <ReactFlowProvider>
          <div style={{ width: 1200, height: 800 }}>
            <GraphCanvas {...next} />
          </div>
        </ReactFlowProvider>
      </VsCodeProvider>,
    );
  });
  render(props);
  return {
    host,
    render,
    vscodeState,
    async flush() {
      for (let i = 0; i < 20 && vi.getTimerCount() > 0; i++) {
        await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
      }
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      act(() => root.unmount());
      host.remove();
    },
  };
}
