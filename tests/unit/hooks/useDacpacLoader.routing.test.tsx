/**
 * useDacpacLoader routing tests
 *
 * Suite A — Routing regression: which postMessage type is sent after each Phase 1 message
 * Suite B — State transitions: isLoading, loadingContext, status, schemaPreview after each message
 * Suite C — Callbacks: connectToDatabase, resetToStart
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';
import { useDacpacLoader } from '../../../src/hooks/useDacpacLoader';
import type { SchemaPreview, SchemaInfo, DatabaseModel } from '../../../src/engine/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePreview(schemaNames: string[]): SchemaPreview {
  const schemas: SchemaInfo[] = schemaNames.map((name) => ({
    name,
    nodeCount: 5,
    types: { table: 5, view: 0, procedure: 0, function: 0, external: 0 },
  }));
  return { schemas, totalObjects: schemaNames.length * 5 };
}

function makeModel(schemaNames: string[]): DatabaseModel {
  const schemas: SchemaInfo[] = schemaNames.map((name) => ({
    name,
    nodeCount: 3,
    types: { table: 3, view: 0, procedure: 0, function: 0, external: 0 },
  }));
  return {
    nodes: schemaNames.map((s) => ({
      id: `[${s}].[t1]`, schema: s, name: 't1', fullName: `[${s}].[t1]`, type: 'table' as const,
    })),
    edges: [],
    schemas,
    catalog: {},
    neighborIndex: {},
  };
}

function dispatch(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

// ─── Mock VsCodeAPI ───────────────────────────────────────────────────────────

let mockApi: { postMessage: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn>; setState: ReturnType<typeof vi.fn> };

function wrapper({ children }: { children: React.ReactNode }) {
  return <VsCodeProvider api={mockApi}>{children}</VsCodeProvider>;
}

beforeEach(() => {
  mockApi = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
});

// ─── Suite A — Routing regression ────────────────────────────────────────────

describe('Suite A — visualize() routing', () => {
  it('sends db-visualize (not dacpac-visualize) after db-schema-preview', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo']), config: {} });
    });

    // loadingContext must be 'database' so visualize() takes the DB path
    expect(result.current.loadingContext).toBe('database');
    expect(result.current.schemaPreview).not.toBeNull();

    act(() => {
      result.current.visualize(new Set(['dbo']));
    });

    const types = mockApi.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('db-visualize');
    expect(types).not.toContain('dacpac-visualize');
  });

  it('sends dacpac-visualize (not db-visualize) after dacpac-schema-preview', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-schema-preview', preview: makePreview(['dbo']), config: {}, filePath: '/tmp/test.dacpac', sourceName: 'test.dacpac' });
    });

    // loadingContext must NOT be 'database' so visualize() takes the dacpac path
    expect(result.current.loadingContext).not.toBe('database');
    expect(result.current.schemaPreview).not.toBeNull();
    expect(result.current.model).toBeNull();

    act(() => {
      result.current.visualize(new Set(['dbo']));
    });

    const types = mockApi.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('dacpac-visualize');
    expect(types).not.toContain('db-visualize');
  });

  it('passes selected schemas in db-visualize payload', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo', 'Sales']), config: {} });
    });

    act(() => {
      result.current.visualize(new Set(['dbo', 'Sales']));
    });

    const dbVizCall = mockApi.postMessage.mock.calls.find((c) => c[0]?.type === 'db-visualize');
    expect(dbVizCall).toBeDefined();
    expect(dbVizCall![0].schemas).toEqual(expect.arrayContaining(['dbo', 'Sales']));
  });

  it('passes selected schemas in dacpac-visualize payload', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-schema-preview', preview: makePreview(['dbo', 'HumanResources']), config: {}, filePath: '/tmp/test.dacpac' });
    });

    act(() => {
      result.current.visualize(new Set(['dbo']));
    });

    const dacpacVizCall = mockApi.postMessage.mock.calls.find((c) => c[0]?.type === 'dacpac-visualize');
    expect(dacpacVizCall).toBeDefined();
    expect(dacpacVizCall![0].schemas).toContain('dbo');
  });
});

// ─── Suite B — State transitions ──────────────────────────────────────────────

describe('Suite B — state after messages', () => {
  it('db-schema-preview: sets schemaPreview, loadingContext=database, isLoading=false', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo']), config: {} });
    });

    expect(result.current.schemaPreview).not.toBeNull();
    expect(result.current.schemaPreview!.schemas).toHaveLength(1);
    expect(result.current.loadingContext).toBe('database');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.model).toBeNull();
  });

  it('dacpac-schema-preview: sets schemaPreview, loadingContext=null, isLoading=false, filePath', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-schema-preview', preview: makePreview(['dbo']), config: {}, filePath: '/a/b.dacpac', sourceName: 'b.dacpac' });
    });

    expect(result.current.schemaPreview).not.toBeNull();
    expect(result.current.loadingContext).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.filePath).toBe('/a/b.dacpac');
    expect(result.current.fileName).toBe('b.dacpac');
    expect(result.current.model).toBeNull();  // cleared so Phase 2 routes to dacpac path
  });

  it('dacpac-model: sets model, clears schemaPreview, sets pendingVisualize', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {}, sourceName: 'test.dacpac' });
    });

    expect(result.current.model).not.toBeNull();
    expect(result.current.schemaPreview).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.pendingVisualize).toBe(true);
  });

  it('dacpac-model with autoVisualize: sets pendingAutoVisualize (not pendingVisualize)', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {}, sourceName: 'test.dacpac', autoVisualize: true });
    });

    expect(result.current.pendingAutoVisualize).toBe(true);
    expect(result.current.pendingVisualize).toBe(false);
  });

  it('db-model: sets model, pendingVisualize=true, loadingContext=null', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-model', model: makeModel(['dbo']), config: {}, sourceName: 'AdventureWorks' });
    });

    expect(result.current.model).not.toBeNull();
    expect(result.current.pendingVisualize).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
  });

  it('db-error: sets error status, isLoading=false, loadingContext=null', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-error', message: 'Connection refused' });
    });

    expect(result.current.status).not.toBeNull();
    expect(result.current.status!.type).toBe('error');
    expect(result.current.status!.text).toBe('Connection refused');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
  });

  it('db-cancelled: clears loading state and status', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-cancelled' });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('mssql-status: sets mssqlAvailable', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'mssql-status', available: true });
    });

    expect(result.current.mssqlAvailable).toBe(true);
  });

  it('last-dacpac-gone: sets error status, clears loading', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'last-dacpac-gone' });
    });

    expect(result.current.status!.type).toBe('error');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
  });

  it('db-progress: sets info status text with step/total', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-progress', label: 'nodes', step: 1, total: 4 });
    });

    expect(result.current.status).not.toBeNull();
    expect(result.current.status!.type).toBe('info');
    expect(result.current.status!.text).toContain('1');
    expect(result.current.status!.text).toContain('4');
  });

  it('selectedSchemas populated from db-schema-preview schemas', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo', 'Sales', 'HumanResources']), config: {} });
    });

    expect(result.current.selectedSchemas.has('dbo')).toBe(true);
    expect(result.current.selectedSchemas.has('Sales')).toBe(true);
    expect(result.current.selectedSchemas.has('HumanResources')).toBe(true);
    expect(result.current.selectedSchemas.size).toBe(3);
  });
});

// ─── Suite C — Callbacks ──────────────────────────────────────────────────────

describe('Suite C — callbacks', () => {
  it('connectToDatabase: posts db-connect, sets isLoading=true, loadingContext=database', () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    act(() => {
      result.current.connectToDatabase();
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.loadingContext).toBe('database');
    const types = mockApi.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('db-connect');
  });

  it('resetToStart: clears all state', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo']), config: {} });
    });

    act(() => {
      result.current.resetToStart();
    });

    expect(result.current.model).toBeNull();
    expect(result.current.schemaPreview).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
    expect(result.current.fileName).toBeNull();
    expect(result.current.filePath).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.pendingAutoVisualize).toBe(false);
    expect(result.current.pendingVisualize).toBe(false);
    expect(result.current.selectedSchemas.size).toBe(0);
  });

  it('openFile: posts open-dacpac', () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    act(() => {
      result.current.openFile();
    });

    const types = mockApi.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('open-dacpac');
  });

  it('cancelLoading: clears isLoading and status', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    act(() => {
      result.current.connectToDatabase();
    });

    act(() => {
      result.current.cancelLoading();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadingContext).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('toggleSchema: adds missing schema, removes existing schema', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo', 'Sales']), config: {} });
    });

    // dbo is selected — toggle it off
    act(() => { result.current.toggleSchema('dbo'); });
    expect(result.current.selectedSchemas.has('dbo')).toBe(false);

    // toggle dbo back on
    act(() => { result.current.toggleSchema('dbo'); });
    expect(result.current.selectedSchemas.has('dbo')).toBe(true);
  });

  it('selectAllSchemas / clearAllSchemas', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo', 'Sales']), config: {} });
    });

    // Pass the full list (no search filter active) — callbacks now take explicit name list
    act(() => { result.current.clearAllSchemas(['dbo', 'Sales']); });
    expect(result.current.selectedSchemas.size).toBe(0);

    act(() => { result.current.selectAllSchemas(['dbo', 'Sales']); });
    expect(result.current.selectedSchemas.size).toBe(2);
  });

  it('clearAutoVisualize: clears pendingAutoVisualize flag', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {}, autoVisualize: true });
    });

    expect(result.current.pendingAutoVisualize).toBe(true);

    act(() => { result.current.clearAutoVisualize(); });
    expect(result.current.pendingAutoVisualize).toBe(false);
  });

  it('clearPendingVisualize: clears pendingVisualize flag', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {} });
    });

    expect(result.current.pendingVisualize).toBe(true);

    act(() => { result.current.clearPendingVisualize(); });
    expect(result.current.pendingVisualize).toBe(false);
  });

  it('onConfigReceived called when message includes config', async () => {
    const onConfig = vi.fn();
    renderHook(() => useDacpacLoader(onConfig), { wrapper });

    await act(async () => {
      dispatch({ type: 'db-schema-preview', preview: makePreview(['dbo']), config: { layout: { direction: 'LR' } } });
    });

    expect(onConfig).toHaveBeenCalledTimes(1);
  });
});

// ─── Suite D — isDemo flag ────────────────────────────────────────────────────

describe('Suite D — isDemo flag', () => {
  it('isDemo=false initially', () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    expect(result.current.isDemo).toBe(false);
  });

  it('isDemo=true after loadDemo()', () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    act(() => { result.current.loadDemo(); });
    expect(result.current.isDemo).toBe(true);
  });

  it('isDemo=false after openFile() and extension dacpac-schema-preview response', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    act(() => { result.current.loadDemo(); });
    expect(result.current.isDemo).toBe(true);
    // openFile() sets isDemoRef.current=false but doesn't trigger a re-render by itself.
    // isDemo reflects the ref only on the next render, which happens when the extension responds.
    act(() => { result.current.openFile(); });
    await act(async () => {
      dispatch({ type: 'dacpac-schema-preview', preview: makePreview(['dbo']), config: {}, filePath: '/a/b.dacpac', sourceName: 'b' });
    });
    expect(result.current.isDemo).toBe(false);
  });

  it('isDemo=false after loadProject() clears demo flag', () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    act(() => { result.current.loadDemo(); });
    expect(result.current.isDemo).toBe(true);
    act(() => { result.current.loadProject('proj-123'); });
    expect(result.current.isDemo).toBe(false);
  });

  it('isDemo=true when pendingAutoVisualize set after loadDemo (demo restore)', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    act(() => { result.current.loadDemo(); });
    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {}, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
    });
    expect(result.current.pendingAutoVisualize).toBe(true);
    expect(result.current.isDemo).toBe(true);
  });

  it('isDemo=false when pendingAutoVisualize set without loadDemo (panel restore)', async () => {
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });
    // Panel restore: dacpac-model arrives without prior loadDemo()
    await act(async () => {
      dispatch({ type: 'dacpac-model', model: makeModel(['dbo']), config: {}, sourceName: 'MyProject', autoVisualize: true });
    });
    expect(result.current.pendingAutoVisualize).toBe(true);
    expect(result.current.isDemo).toBe(false);
  });
});
