import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useExpandedSchemaView, type ExpandedSchemaViewState } from '../../../src/hooks/useExpandedSchemaView';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../../src/engine/types';
import { notifyUser } from '../../../src/utils/notify';

vi.mock('../../../src/utils/notify', () => ({
  notifyUser: vi.fn(),
}));

function makeModel(): DatabaseModel {
  return {
    nodes: [
      { id: '[sales].[orders]', name: 'Orders', schema: 'sales', fullName: '[sales].[Orders]', type: 'table' },
      { id: '[sales].[customer]', name: 'Customer', schema: 'sales', fullName: '[sales].[Customer]', type: 'table' },
      { id: '[ops].[loadorders]', name: 'LoadOrders', schema: 'ops', fullName: '[ops].[LoadOrders]', type: 'procedure' },
      { id: '[audit].[auditorders]', name: 'AuditOrders', schema: 'audit', fullName: '[audit].[AuditOrders]', type: 'table' },
    ],
    edges: [
      { source: '[sales].[customer]', target: '[sales].[orders]', type: 'body' },
      { source: '[ops].[loadorders]', target: '[sales].[orders]', type: 'body' },
      { source: '[sales].[orders]', target: '[audit].[auditorders]', type: 'body' },
    ],
    schemas: [
      { name: 'sales', nodeCount: 2, types: { table: 2, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'ops', nodeCount: 1, types: { table: 0, view: 0, procedure: 1, function: 0, external: 0 } },
      { name: 'audit', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
    ],
    catalog: {},
    neighborIndex: {},
  };
}

function renderExpandedSchemaViewHook(
  overrides: Partial<{
    config: typeof DEFAULT_CONFIG;
    filterSchemas: Set<string>;
    graphMode: 'full' | 'overview';
    preserveViewportOnNextGraphChange: () => void;
  }> = {},
) {
  const model = makeModel();
  const graph = buildGraphologyGraph(model);
  const config = overrides.config ?? { ...DEFAULT_CONFIG, renderLimit: 10 };
  const preserveViewportOnNextGraphChange = overrides.preserveViewportOnNextGraphChange ?? vi.fn();
  const filterSchemas = overrides.filterSchemas ?? new Set<string>();
  const graphMode = overrides.graphMode ?? 'overview';

  const hook = renderHook((props: {
    config: typeof DEFAULT_CONFIG;
    filterSchemas: Set<string>;
    graphMode: 'full' | 'overview';
    preserveViewportOnNextGraphChange: () => void;
  }) => {
    const [expandedSchemaView, setExpandedSchemaView] = useState<ExpandedSchemaViewState | null>(null);
    const [showExpandedSchemaClusters, setShowExpandedSchemaClusters] = useState(true);

    return useExpandedSchemaView({
      config: props.config,
      expandedSchemaView,
      filterSchemas: props.filterSchemas,
      graph,
      graphMode: props.graphMode,
      model,
      preserveViewportOnNextGraphChange: props.preserveViewportOnNextGraphChange,
      setExpandedSchemaView,
      setShowExpandedSchemaClusters,
      showExpandedSchemaClusters,
    });
  }, {
    initialProps: {
      config,
      filterSchemas,
      graphMode,
      preserveViewportOnNextGraphChange,
    },
  });

  return {
    ...hook,
    graph,
    model,
    preserveViewportOnNextGraphChange,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useExpandedSchemaView', () => {
  it('opens a node schema and derives the expanded render state', () => {
    const { result } = renderExpandedSchemaViewHook();

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });

    expect(result.current.expandedSchemaCount).toBe(1);
    expect(result.current.expandedSchemaViewGraph).not.toBeNull();
    expect(
      result.current.expandedSchemaViewGraph?.flowNodes.find((node) => node.id === '[sales].[orders]')?.data.highlighted
    ).toBe(true);
    expect(result.current.collapsedSchemaNodeIds?.has('[ops].[loadorders]')).toBe(true);
  });

  it('supports expanding, centering, collapsing, and clearing schemas', () => {
    const { result } = renderExpandedSchemaViewHook();

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });
    act(() => {
      result.current.expandExpandedSchemaViewSchema('ops');
    });

    expect(result.current.expandedSchemaCount).toBe(2);
    expect(result.current.expandedSchemaViewGraph?.flowNodes.some((node) => node.id === '[ops].[loadorders]')).toBe(true);

    act(() => {
      result.current.centerExpandedSchemaViewSchema('audit');
    });

    expect(result.current.expandedSchemaCount).toBe(1);
    expect(result.current.expandedSchemaViewGraph?.flowNodes.some((node) => node.id === '[audit].[auditorders]')).toBe(true);

    act(() => {
      result.current.collapseExpandedSchemaViewSchema('audit');
    });

    expect(result.current.expandedSchemaCount).toBe(0);

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });
    act(() => {
      result.current.clearExpandedSchemaView();
    });

    expect(result.current.expandedSchemaCount).toBe(0);
    expect(result.current.expandedSchemaViewGraph).toBeNull();
  });

  it('rejects expansions that would exceed the render limit', () => {
    const { result } = renderExpandedSchemaViewHook({
      config: { ...DEFAULT_CONFIG, renderLimit: 2 },
    });

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });

    expect(result.current.expandedSchemaCount).toBe(0);
    expect(notifyUser).toHaveBeenCalledWith(
      'Cannot expand schema "sales": Expanded Schema View would render 4 nodes, over the render limit of 2.'
    );
  });

  it('prunes expanded schemas when the active schema filter narrows', () => {
    const { result, rerender } = renderExpandedSchemaViewHook();

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });
    act(() => {
      result.current.expandExpandedSchemaViewSchema('ops');
    });

    rerender({
      config: { ...DEFAULT_CONFIG, renderLimit: 10 },
      filterSchemas: new Set(['sales']),
      graphMode: 'overview',
      preserveViewportOnNextGraphChange: vi.fn(),
    });

    expect(result.current.expandedSchemaCount).toBe(1);
    expect(result.current.expandedSchemaViewGraph?.flowNodes.some((node) => node.id === '[ops].[loadorders]')).toBe(false);

    rerender({
      config: { ...DEFAULT_CONFIG, renderLimit: 10 },
      filterSchemas: new Set(['audit']),
      graphMode: 'overview',
      preserveViewportOnNextGraphChange: vi.fn(),
    });

    expect(result.current.expandedSchemaCount).toBe(0);
  });

  it('preserves the viewport when toggling collapsed schema clusters', () => {
    const preserveViewportOnNextGraphChange = vi.fn();
    const { result } = renderExpandedSchemaViewHook({ preserveViewportOnNextGraphChange });

    act(() => {
      result.current.openExpandedSchemaViewForNode('[sales].[orders]');
    });

    expect(result.current.expandedSchemaViewRenderedCount).toBe(4);

    act(() => {
      result.current.toggleExpandedSchemaClusters();
    });

    expect(preserveViewportOnNextGraphChange).toHaveBeenCalledTimes(1);
    expect(result.current.expandedSchemaViewRenderedCount).toBe(2);
  });
});
