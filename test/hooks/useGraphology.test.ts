/**
 * useGraphology filter pipeline tests.
 *
 * Suite A — Schema filter
 * Suite B — Type filter
 * Suite C — Isolation filter (hideIsolated)
 * Suite D — Exclusion pattern filter
 * Suite E — focusSchemas is UI-only (no pipeline filtering)
 * Suite F — Allowlist filter
 * Suite G — External ref filter
 * Suite H — Graph + metrics state
 * Suite I — Rebuild with different filter
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useGraphology } from '../../src/hooks/useGraphology';
import type { DatabaseModel, FilterState, LineageNode, LineageEdge } from '../../src/engine/types';
import { DEFAULT_CONFIG } from '../../src/engine/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function node(schema: string, name: string, type: LineageNode['type'] = 'table', extra?: Partial<LineageNode>): LineageNode {
  return {
    id: `[${schema}].[${name}]`,
    schema,
    name,
    fullName: `[${schema}].[${name}]`,
    type,
    ...extra,
  };
}

function edge(source: string, target: string): LineageEdge {
  return { source, target, type: 'body' };
}

function makeModel(nodes: LineageNode[], edges: LineageEdge[]): DatabaseModel {
  return {
    nodes,
    edges,
    schemas: [],
    catalog: {},
    neighborIndex: {},
  };
}

const ALL_TYPES = new Set(['table', 'view', 'procedure', 'function', 'external'] as const);

function makeFilter(overrides?: Partial<FilterState>): FilterState {
  return {
    schemas: new Set(['dbo', 'sales']),
    types: ALL_TYPES,
    searchTerm: '',
    hideIsolated: false,
    focusSchemas: new Set(),
    showExternalRefs: false,
    externalRefTypes: new Set(),
    exclusionPatterns: [],
    ...overrides,
  };
}

// ─── Reference model ──────────────────────────────────────────────────────────
// dbo.sp1 → dbo.t1   (edge)
// dbo.v1             (isolated)
// sales.t2           (isolated)

const DBO_SP1 = node('dbo', 'sp1', 'procedure');
const DBO_T1  = node('dbo', 't1',  'table');
const DBO_V1  = node('dbo', 'v1',  'view');
const SALES_T2 = node('sales', 't2', 'table');

const MODEL = makeModel(
  [DBO_SP1, DBO_T1, DBO_V1, SALES_T2],
  [edge(DBO_SP1.id, DBO_T1.id)],
);

// ─── Suite A — Schema filter ──────────────────────────────────────────────────

describe('Suite A — schema filter', () => {
  it('all schemas → all nodes; case-insensitive', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter()); });
    expect(result.current.flowNodes.length).toBe(4);
    // Case-insensitive: 'DBO' matches 'dbo'
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ schemas: new Set(['DBO']) })); });
    expect(result.current.flowNodes.length).toBe(3);
  });

  it('only dbo selected → sales.t2 excluded', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ schemas: new Set(['dbo']) })); });
    expect(result.current.flowNodes.length).toBe(3);
    expect(result.current.flowNodes.some(n => n.id === SALES_T2.id)).toBe(false);
  });

  it('only sales selected → only sales.t2 visible', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ schemas: new Set(['sales']) })); });
    expect(result.current.flowNodes.length).toBe(1);
    expect(result.current.flowNodes[0].id).toBe(SALES_T2.id);
  });
});

// ─── Suite B — Type filter ────────────────────────────────────────────────────

describe('Suite B — type filter', () => {
  it('tables only → 2 nodes (t1 + t2)', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ types: new Set(['table']) })); });
    expect(result.current.flowNodes.length).toBe(2);
    expect(result.current.flowNodes.every(n => n.data.objectType === 'table')).toBe(true);
  });

  it('procedures only → 1 node (sp1)', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ types: new Set(['procedure']) })); });
    expect(result.current.flowNodes.length).toBe(1);
    expect(result.current.flowNodes[0].id).toBe(DBO_SP1.id);
  });

  it('empty type set → 0 nodes', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ types: new Set() })); });
    expect(result.current.flowNodes.length).toBe(0);
  });
});

// ─── Suite C — Isolation filter ───────────────────────────────────────────────

describe('Suite C — isolation filter (hideIsolated)', () => {
  it('hideIsolated=false → all 4 nodes; true → only connected nodes', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ hideIsolated: false })); });
    expect(result.current.flowNodes.length).toBe(4);

    act(() => { result.current.buildFromModel(MODEL, makeFilter({ hideIsolated: true })); });
    expect(result.current.flowNodes.length).toBe(2);
    const ids = result.current.flowNodes.map(n => n.id);
    expect(ids).toContain(DBO_SP1.id);
    expect(ids).toContain(DBO_T1.id);
    expect(result.current.flowNodes.some(n => n.id === DBO_V1.id)).toBe(false);
  });

  it('no edges in model → hideIsolated removes all nodes', () => {
    const emptyEdgeModel = makeModel([DBO_SP1, DBO_T1], []);
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(emptyEdgeModel, makeFilter({ hideIsolated: true, schemas: new Set(['dbo']) })); });
    expect(result.current.flowNodes.length).toBe(0);
  });
});

// ─── Suite D — Exclusion pattern filter ───────────────────────────────────────

describe('Suite D — exclusion pattern filter', () => {
  it('no exclusion patterns → 4 nodes', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ exclusionPatterns: [] })); });
    expect(result.current.flowNodes.length).toBe(4);
  });

  it('exact pattern dbo.v1 removes v1', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ exclusionPatterns: ['dbo.v1'] })); });
    expect(result.current.flowNodes.some(n => n.id === DBO_V1.id)).toBe(false);
    expect(result.current.flowNodes.length).toBe(3);
  });

  it('wildcard dbo.* removes all dbo nodes', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ exclusionPatterns: ['dbo.*'] })); });
    const ids = result.current.flowNodes.map(n => n.id);
    expect(ids).not.toContain(DBO_SP1.id);
    expect(ids).not.toContain(DBO_T1.id);
    expect(ids).not.toContain(DBO_V1.id);
    expect(ids).toContain(SALES_T2.id);
  });

  it('exclusion removes associated edges', () => {
    // Exclude dbo.sp1 → the sp1→t1 edge should disappear
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ exclusionPatterns: ['dbo.sp1'] })); });
    expect(result.current.flowEdges.length).toBe(0);
  });
});

// ─── Suite E — focusSchemas is UI-only (no pipeline filtering) ──────────────
// After the star-schema unification, focusSchemas drives only the star icon in
// the dropdown. Schema narrowing is done by the handler setting filter.schemas.
// The pipeline must NOT filter based on focusSchemas.

describe('Suite E — focusSchemas is UI-only', () => {
  it('no focus schemas → all nodes pass through', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ focusSchemas: new Set() })); });
    expect(result.current.flowNodes.length).toBe(4);
  });

  // Redundant focusSchemas tests removed: 'no focus schemas' already proves UI-only behavior;
  // schema filtering is tested in Suite A

  it('cross-schema: both schemas selected → both nodes appear regardless of focusSchemas', () => {
    const salesSp = node('sales', 'sp', 'procedure');
    const dboT = node('dbo', 't', 'table');
    const crossModel = makeModel([salesSp, dboT], [edge(salesSp.id, dboT.id)]);
    const { result } = renderHook(() => useGraphology());
    act(() => {
      result.current.buildFromModel(
        crossModel,
        makeFilter({ schemas: new Set(['sales', 'dbo']), focusSchemas: new Set(['sales']) })
      );
    });
    expect(result.current.flowNodes.length).toBe(2);
  });
});

// ─── Suite F — Allowlist filter ───────────────────────────────────────────────

describe('Suite F — allowlist filter', () => {
  it('empty allowlist → no-op, all nodes pass', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ allowlistNodeIds: new Set() })); });
    expect(result.current.flowNodes.length).toBe(4);
  });

  it('undefined allowlist → no-op', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ allowlistNodeIds: undefined })); });
    expect(result.current.flowNodes.length).toBe(4);
  });

  it('allowlist with one node → only that node visible', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ allowlistNodeIds: new Set([DBO_T1.id]) })); });
    expect(result.current.flowNodes.length).toBe(1);
    expect(result.current.flowNodes[0].id).toBe(DBO_T1.id);
  });

  it('allowlist removes edges whose endpoints are not both allowlisted', () => {
    // Only t1 in allowlist; sp1→t1 edge should be removed (sp1 not in allowlist)
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(MODEL, makeFilter({ allowlistNodeIds: new Set([DBO_T1.id]) })); });
    expect(result.current.flowEdges.length).toBe(0);
  });

  it('allowlist with both endpoints preserves edge', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => {
      result.current.buildFromModel(MODEL, makeFilter({
        allowlistNodeIds: new Set([DBO_SP1.id, DBO_T1.id]),
      }));
    });
    expect(result.current.flowNodes.length).toBe(2);
    expect(result.current.flowEdges.length).toBe(1);
  });
});

// ─── Suite G — External ref filter ───────────────────────────────────────────

describe('Suite G — external ref filter (virtual nodes)', () => {
  const virtualFile = node('', 'ext', 'external', {
    id: '[__ext__].[abc123]',
    fullName: '[__ext__].[abc123]',
    externalType: 'file',
    externalUrl: 'abfss://container@storage.dfs.core.windows.net/file.csv',
  });
  const modelWithVirtual = makeModel(
    [DBO_SP1, DBO_T1, virtualFile],
    [
      edge(DBO_SP1.id, DBO_T1.id),
      edge(DBO_SP1.id, virtualFile.id), // sp1 writes to virtual file
    ]
  );

  it('showExternalRefs=false → virtual node excluded', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => {
      result.current.buildFromModel(
        modelWithVirtual,
        makeFilter({ schemas: new Set(['dbo']), types: ALL_TYPES, showExternalRefs: false })
      );
    });
    expect(result.current.flowNodes.some(n => n.id === virtualFile.id)).toBe(false);
  });

  it('showExternalRefs=true, file in externalRefTypes → virtual node included', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => {
      result.current.buildFromModel(
        modelWithVirtual,
        makeFilter({
          schemas: new Set(['dbo']),
          types: ALL_TYPES,
          showExternalRefs: true,
          externalRefTypes: new Set(['file', 'db']),
        })
      );
    });
    expect(result.current.flowNodes.some(n => n.id === virtualFile.id)).toBe(true);
  });
});

// ─── Suite H — graph and metrics state ───────────────────────────────────────

describe('Suite H — graph and metrics state', () => {
  it('graph/metrics lifecycle: null before build, populated after', () => {
    const { result } = renderHook(() => useGraphology());
    expect(result.current.graph).toBeNull();

    act(() => { result.current.buildFromModel(MODEL, makeFilter()); });
    expect(result.current.graph).not.toBeNull();
    expect(result.current.graph!.order).toBe(4);
    expect(result.current.metrics).not.toBeNull();
  });

  it('empty model → graph has 0 nodes', () => {
    const { result } = renderHook(() => useGraphology());
    act(() => { result.current.buildFromModel(makeModel([], []), makeFilter({ schemas: new Set() })); });
    expect(result.current.flowNodes.length).toBe(0);
  });
});

// ─── Suite I — Rebuild with different filter ──────────────────────────────────

describe('Suite I — rebuild with different filter', () => {
  it('second buildFromModel call replaces previous state', () => {
    const { result } = renderHook(() => useGraphology());

    // First build: all schemas
    act(() => { result.current.buildFromModel(MODEL, makeFilter()); });
    expect(result.current.flowNodes.length).toBe(4);

    // Second build: only sales
    act(() => {
      result.current.buildFromModel(MODEL, makeFilter({ schemas: new Set(['sales']) }));
    });
    expect(result.current.flowNodes.length).toBe(1);
  });

  it('graph is updated on each rebuild', () => {
    const { result } = renderHook(() => useGraphology());

    act(() => { result.current.buildFromModel(MODEL, makeFilter()); });
    const firstGraph = result.current.graph;

    act(() => {
      result.current.buildFromModel(MODEL, makeFilter({ schemas: new Set(['dbo']) }));
    });
    const secondGraph = result.current.graph;

    // Different graph instance after rebuild
    expect(secondGraph).not.toBe(firstGraph);
    expect(secondGraph!.order).toBe(3); // only dbo nodes
  });
});
