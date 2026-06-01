import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { DEFAULT_CONFIG, type FilterState, type TraceState } from '../../../src/engine/types';
import { GraphCanvas } from '../../../src/components/GraphCanvas';
import type { CustomNodeData } from '../../../src/components/CustomNode';
import type { SchemaNodeData } from '../../../src/engine/types';
import { getExternalNodeColor } from '../../../src/utils/schemaColors';

const reactFlowMocks = vi.hoisted(() => ({
  fitView: vi.fn(),
  getNode: vi.fn(),
  setCenter: vi.fn(),
  setViewport: vi.fn(),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  return {
    Position: { Top: 'top', Left: 'left', Right: 'right', Bottom: 'bottom' },
    Background: () => <div data-testid="background" />,
    Controls: () => <div data-testid="controls" />,
    MiniMap: () => <div data-testid="minimap" />,
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Handle: () => <span data-testid="handle" />,
    NodeToolbar: ({ children, isVisible }: { children: ReactNode; isVisible?: boolean }) => (
      isVisible === false ? null : <div data-testid="node-toolbar">{children}</div>
    ),
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    useReactFlow: () => ({
      fitView: reactFlowMocks.fitView,
      getNode: reactFlowMocks.getNode,
      setCenter: reactFlowMocks.setCenter,
      getNodes: () => [],
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport: reactFlowMocks.setViewport,
    }),
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
    ReactFlow: ({
      nodes,
      nodeTypes,
      onNodeClick,
      onNodeDoubleClick,
      onNodeContextMenu,
      children,
    }: {
      nodes: Array<{ id: string; type?: string; data: unknown; selected?: boolean }>;
      nodeTypes: Record<string, React.ComponentType<any>>;
      onNodeClick?: (event: React.MouseEvent, node: unknown) => void;
      onNodeDoubleClick?: (event: React.MouseEvent, node: unknown) => void;
      onNodeContextMenu?: (event: React.MouseEvent, node: unknown) => void;
      children?: ReactNode;
    }) => (
      <div data-testid="react-flow">
        {nodes.map((node) => {
          const NodeComponent = nodeTypes[node.type ?? ''] ?? (() => <span>{node.id}</span>);
          return (
            <div
              key={node.id}
              data-testid={`flow-node-${node.id}`}
              data-selected={String(!!node.selected)}
              onClick={(event) => onNodeClick?.(event, node)}
              onDoubleClick={(event) => onNodeDoubleClick?.(event, node)}
              onContextMenu={(event) => onNodeContextMenu?.(event, node)}
            >
              <NodeComponent
                id={node.id}
                type={node.type}
                data={node.data}
                selected={!!node.selected}
                dragging={false}
                zIndex={0}
                isConnectable={false}
                positionAbsoluteX={0}
                positionAbsoluteY={0}
              />
            </div>
          );
        })}
        {children}
      </div>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const trace: TraceState = {
  mode: 'none',
  selectedNodeId: null,
  targetNodeId: null,
  upstreamLevels: 0,
  downstreamLevels: 0,
  baseNodeIds: new Set(),
  baseEdgeIds: new Set(),
  manualAddedNodeIds: new Set(),
  manualPrunedNodeIds: new Set(),
  tracedNodeIds: new Set(),
  tracedEdgeIds: new Set(),
};

const filter: FilterState = {
  schemas: new Set(['sales']),
  types: new Set(['table', 'view', 'procedure', 'function', 'external']),
  searchTerm: '',
  hideIsolated: false,
  focusSchemas: new Set(),
  showExternalRefs: true,
  externalRefTypes: new Set(),
  exclusionPatterns: [],
};

const schemaNode = {
  id: '__schema__sales',
  type: 'schemaNode',
  position: { x: 0, y: 0 },
  draggable: true,
  selectable: true,
  data: {
    schemaName: 'sales',
    objectCount: 2,
    typeBreakdown: { table: 2 },
    color: '#336699',
    isExpandedSchemaViewCluster: true,
  } satisfies SchemaNodeData,
};

const externalSchemaNode = {
  id: '__schema__ext',
  type: 'schemaNode',
  position: { x: 0, y: 140 },
  draggable: true,
  selectable: true,
  data: {
    schemaName: 'ext',
    objectCount: 1,
    typeBreakdown: { external: 1 },
    color: getExternalNodeColor(),
    isExternalOnly: true,
    isExpandedSchemaViewCluster: true,
  } satisfies SchemaNodeData,
};

const objectNode = {
  id: '[sales].[orders]',
  type: 'lineageNode',
  position: { x: 160, y: 0 },
  draggable: true,
  selectable: true,
  data: {
    label: 'orders',
    schema: 'sales',
    fullName: '[sales].[orders]',
    objectType: 'table',
    inDegree: 0,
    outDegree: 0,
  } satisfies CustomNodeData,
};

function renderGraphCanvasElement(props: React.ComponentProps<typeof GraphCanvas>) {
  return (
    <VsCodeProvider api={{ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }}>
      <GraphCanvas {...props} />
    </VsCodeProvider>
  );
}

function renderGraphCanvas(overrides: Partial<React.ComponentProps<typeof GraphCanvas>> = {}) {
  const props: React.ComponentProps<typeof GraphCanvas> = {
    flowNodes: [schemaNode, objectNode],
    flowEdges: [],
    trace,
    filter,
    metrics: null,
    graph: null,
    config: DEFAULT_CONFIG,
    onNodeClick: vi.fn(),
    onNodeContextMenu: vi.fn(),
    onStartTraceImmediate: vi.fn(),
    onTraceApply: vi.fn(),
    onTraceEnd: vi.fn(),
    onResetAll: vi.fn(),
    onToggleType: vi.fn(),
    onToggleIsolated: vi.fn(),
    onToggleFocusSchema: vi.fn(),
    availableSchemas: ['sales'],
    renderedSchemas: ['sales'],
    onRefresh: vi.fn(),
    onBack: vi.fn(),
    graphMode: 'overview',
    filteredObjectIds: new Set([objectNode.id]),
    isExpandedSchemaViewActive: true,
    onResetExpandedSchemaView: vi.fn(),
    showExpandedSchemaClusters: true,
    onToggleExpandedSchemaClusters: vi.fn(),
    expandedSchemaCount: 1,
    onExpandExpandedSchemaViewSchema: vi.fn(),
    onCenterExpandedSchemaViewSchema: vi.fn(),
    ...overrides,
  };

  const renderResult = render(renderGraphCanvasElement(props));

  return { props, ...renderResult };
}

describe('GraphCanvas schema node interactions', () => {
  it('double-click uses Expand Only by default and clears stale toolbar selection', async () => {
    const onExpandExpandedSchemaViewSchema = vi.fn();
    const onCenterExpandedSchemaViewSchema = vi.fn();
    renderGraphCanvas({ onExpandExpandedSchemaViewSchema, onCenterExpandedSchemaViewSchema });

    const node = screen.getByTestId('flow-node-__schema__sales');
    fireEvent.contextMenu(node);
    expect(await screen.findByRole('button', { name: 'Expand Only' })).toBeTruthy();

    fireEvent.doubleClick(node);

    expect(onCenterExpandedSchemaViewSchema).toHaveBeenCalledTimes(1);
    expect(onCenterExpandedSchemaViewSchema).toHaveBeenCalledWith('sales');
    expect(onExpandExpandedSchemaViewSchema).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Expand Only' })).toBeNull());
  }, 15000);

  it('double-click uses additive Expand when configured', () => {
    const onExpandExpandedSchemaViewSchema = vi.fn();
    const onCenterExpandedSchemaViewSchema = vi.fn();
    renderGraphCanvas({
      config: {
        ...DEFAULT_CONFIG,
        overview: { ...DEFAULT_CONFIG.overview, schemaDoubleClickBehavior: 'expand' },
      },
      onExpandExpandedSchemaViewSchema,
      onCenterExpandedSchemaViewSchema,
    });

    fireEvent.doubleClick(screen.getByTestId('flow-node-__schema__sales'));

    expect(onExpandExpandedSchemaViewSchema).toHaveBeenCalledTimes(1);
    expect(onExpandExpandedSchemaViewSchema).toHaveBeenCalledWith('sales');
    expect(onCenterExpandedSchemaViewSchema).not.toHaveBeenCalled();
  });

  it('right-click selects a schema node and exposes schema actions', async () => {
    const onNodeContextMenu = vi.fn();
    renderGraphCanvas({ onNodeContextMenu });

    fireEvent.contextMenu(screen.getByTestId('flow-node-__schema__sales'));

    expect(await screen.findByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Only' })).toBeTruthy();
    expect(onNodeContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: '__schema__sales' }), 0, 0);
  });

  it('right-click exposes schema actions in initial schema-only view', async () => {
    renderGraphCanvas({
      flowNodes: [{
        ...schemaNode,
        data: {
          ...schemaNode.data,
          isExpandedSchemaViewCluster: undefined,
        } satisfies SchemaNodeData,
      }],
      filteredObjectIds: new Set([objectNode.id]),
      isExpandedSchemaViewActive: false,
      expandedSchemaCount: 0,
    });

    fireEvent.contextMenu(screen.getByTestId('flow-node-__schema__sales'));

    expect(await screen.findByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Only' })).toBeTruthy();
  });

  it('keeps object-node right-click routed to the object context menu handler', () => {
    const onNodeContextMenu = vi.fn();
    renderGraphCanvas({ onNodeContextMenu });

    fireEvent.contextMenu(screen.getByTestId('flow-node-[sales].[orders]'));

    expect(onNodeContextMenu).toHaveBeenCalledTimes(1);
    expect(onNodeContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: '[sales].[orders]' }), 0, 0);
    expect(screen.queryByRole('button', { name: 'Expand Only' })).toBeNull();
  });

  it('does not fit the viewport for preserve-viewport graph updates', async () => {
    const { props, rerender } = renderGraphCanvas({ viewportPreserveVersion: 0 });

    await waitFor(() => expect(reactFlowMocks.fitView).toHaveBeenCalled());
    reactFlowMocks.fitView.mockClear();

    rerender(renderGraphCanvasElement({
      ...props,
      flowNodes: [schemaNode],
      filteredObjectIds: new Set<string>(),
      viewportPreserveVersion: 1,
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reactFlowMocks.fitView).not.toHaveBeenCalled();
  });

  it('renders an external-only ext schema cluster in the legend without schema-color lookup failure', () => {
    renderGraphCanvas({
      flowNodes: [schemaNode, externalSchemaNode, objectNode],
      availableSchemas: ['sales', 'ext'],
      renderedSchemas: ['sales', 'ext'],
    });

    expect(screen.getAllByText('ext').length).toBeGreaterThanOrEqual(1);
  });
});
