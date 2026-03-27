/**
 * CreateFlow save-project integration tests
 *
 * Proves that after dacpac-schema-preview (with filePath), clicking Visualize
 * triggers onVisualize with a DacpacConnection — not null — so that App.tsx
 * sends save-project to the extension host.
 *
 * These tests FAIL when loader.filePath is null (old bug: filePath missing from
 * dacpac-schema-preview message) and PASS when the fix is in place.
 */
import { renderHook, render, act, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { VsCodeProvider } from '../../src/contexts/VsCodeContext';
import { useDacpacLoader } from '../../src/hooks/useDacpacLoader';
import { CreateFlow } from '../../src/components/CreateFlow';
import type { DacpacLoaderState } from '../../src/hooks/useDacpacLoader';
import type { DacpacConnection, DatabaseConnection } from '../../src/engine/projectStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let mockApi: { postMessage: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn>; setState: ReturnType<typeof vi.fn> };

function wrapper({ children }: { children: React.ReactNode }) {
  return <VsCodeProvider api={mockApi}>{children}</VsCodeProvider>;
}

function dispatch(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function makePreview(schemaNames: string[]) {
  return {
    schemas: schemaNames.map(name => ({ name, nodeCount: 5, types: { table: 5, view: 0, procedure: 0, function: 0, external: 0 } })),
    totalObjects: schemaNames.length * 5,
  };
}

beforeEach(() => {
  mockApi = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
});

// ─── Suite E — save-project: CreateFlow routes to DacpacConnection ─────────────

describe('Suite E — save-project: CreateFlow passes DacpacConnection to onVisualize', () => {
  it('onVisualize receives DacpacConnection (not null) after dacpac-schema-preview WITH filePath', async () => {
    const onVisualize = vi.fn<[string, DacpacConnection | DatabaseConnection | null]>();

    // Get a live loader to feed into CreateFlow
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo']),
        config: {},
        filePath: '/workspace/MyDb.dacpac',
        sourceName: 'MyDb',
      });
    });

    // Verify filePath is set in loader (RC1 fix)
    expect(result.current.filePath).toBe('/workspace/MyDb.dacpac');

    // Render CreateFlow with the live loader
    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <CreateFlow
          loader={result.current}
          maxNodes={750}
          onBack={vi.fn()}
          onVisualize={onVisualize}
        />
      </VsCodeProvider>
    );

    // Click Visualize
    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    // Assert: onVisualize was called with a DacpacConnection
    expect(onVisualize).toHaveBeenCalledTimes(1);
    const [, conn] = onVisualize.mock.calls[0];
    expect(conn).not.toBeNull();
    expect((conn as DacpacConnection).type).toBe('dacpac');
    expect((conn as DacpacConnection).path).toBe('/workspace/MyDb.dacpac');

    unmount();
  });

  it('onVisualize receives null after dacpac-schema-preview WITHOUT filePath (old bug reproduced)', async () => {
    const onVisualize = vi.fn<[string, DacpacConnection | DatabaseConnection | null]>();
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      // Simulate OLD extension behavior: no filePath in message
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo']),
        config: {},
        // filePath intentionally omitted — reproduces RC1 bug
        sourceName: 'MyDb',
      });
    });

    expect(result.current.filePath).toBeNull();  // bug: filePath never set

    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <CreateFlow
          loader={result.current}
          maxNodes={750}
          onBack={vi.fn()}
          onVisualize={onVisualize}
        />
      </VsCodeProvider>
    );

    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    // With old bug: onVisualize gets null → save-project is never sent
    expect(onVisualize).toHaveBeenCalledTimes(1);
    const [, conn] = onVisualize.mock.calls[0];
    expect(conn).toBeNull();

    unmount();
  });

  it('DacpacConnection.schemas contains all selected schemas', async () => {
    const onVisualize = vi.fn<[string, DacpacConnection | DatabaseConnection | null]>();
    const { result } = renderHook(() => useDacpacLoader(vi.fn()), { wrapper });

    await act(async () => {
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo', 'Sales', 'HumanResources']),
        config: {},
        filePath: '/workspace/MyDb.dacpac',
        sourceName: 'MyDb',
      });
    });

    // Deselect 'Sales'
    act(() => { result.current.toggleSchema('Sales'); });

    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <CreateFlow
          loader={result.current}
          maxNodes={750}
          onBack={vi.fn()}
          onVisualize={onVisualize}
        />
      </VsCodeProvider>
    );

    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    const [, conn] = onVisualize.mock.calls[0];
    expect((conn as DacpacConnection).schemas).toContain('dbo');
    expect((conn as DacpacConnection).schemas).toContain('HumanResources');
    expect((conn as DacpacConnection).schemas).not.toContain('Sales');

    unmount();
  });
});
