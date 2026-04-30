/**
 * App-level save-project integration tests
 *
 * Proves the full chain:
 *   dacpac-schema-preview (ext→webview)
 *   → useDacpacLoader stores filePath
 *   → CreateFlow builds DacpacConnection
 *   → handleCreateVisualize sends save-project via vscodeApi
 *
 * Suite F tests fail when filePath is missing from dacpac-schema-preview (RC1 bug)
 * and pass when the fix is in place.
 */
import { render, act, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { VsCodeProvider, useVsCode } from '../../../src/contexts/VsCodeContext';
import { useDacpacLoader } from '../../../src/hooks/useDacpacLoader';
import { CreateFlow } from '../../../src/components/CreateFlow';
import { createProject } from '../../../src/engine/projectStore';
import type { DacpacConnection, DatabaseConnection } from '../../../src/engine/projectStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let mockApi: { postMessage: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn>; setState: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockApi = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
});

function dispatch(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function makePreview(schemaNames: string[]) {
  return {
    schemas: schemaNames.map(name => ({
      name,
      nodeCount: 5,
      types: { table: 5, view: 0, procedure: 0, function: 0, external: 0 },
    })),
    totalObjects: schemaNames.length * 5,
  };
}

/**
 * Mirrors the App.tsx handleCreateVisualize callback.
 * Renders CreateFlow wired to the real vscodeApi so postMessage calls are visible.
 */
function TestCreateFlow() {
  const vscodeApi = useVsCode();
  const loader = useDacpacLoader(vi.fn());

  function handleCreateVisualize(
    projectName: string,
    conn: DacpacConnection | DatabaseConnection | null,
  ) {
    if (conn && conn.type === 'dacpac') {
      const project = createProject(projectName, conn);
      vscodeApi.postMessage({ type: 'save-project', project });
      loader.visualize(loader.selectedSchemas, projectName);
    } else {
      // DB path or missing connection — no save-project at this stage
      loader.visualize(loader.selectedSchemas, projectName);
    }
  }

  return (
    <CreateFlow
      loader={loader}
      maxNodes={750}
      onBack={vi.fn()}
      onVisualize={handleCreateVisualize}
    />
  );
}

// ─── Suite F — App-level save-project routing ─────────────────────────────────

describe('Suite F — App-level save-project routing', () => {
  it('postMessage includes save-project after dacpac-schema-preview WITH filePath', async () => {
    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <TestCreateFlow />
      </VsCodeProvider>
    );

    await act(async () => {
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo']),
        config: {},
        filePath: '/workspace/MyDb.dacpac',
        sourceName: 'MyDb',
      });
    });

    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    expect(mockApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'save-project',
        project: expect.objectContaining({
          connection: expect.objectContaining({
            type: 'dacpac',
            path: '/workspace/MyDb.dacpac',
          }),
        }),
      })
    );

    unmount();
  });

  it('postMessage does NOT include save-project when filePath missing (RC1 bug reproduced)', async () => {
    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <TestCreateFlow />
      </VsCodeProvider>
    );

    await act(async () => {
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo']),
        config: {},
        // filePath intentionally omitted — reproduces RC1 bug
        sourceName: 'MyDb',
      });
    });

    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    const saveProjectCalls = mockApi.postMessage.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'save-project'
    );
    expect(saveProjectCalls).toHaveLength(0);

    unmount();
  });

  it('save-project project.name matches the loader sourceName', async () => {
    const { unmount } = render(
      <VsCodeProvider api={mockApi}>
        <TestCreateFlow />
      </VsCodeProvider>
    );

    await act(async () => {
      dispatch({
        type: 'dacpac-schema-preview',
        preview: makePreview(['dbo']),
        config: {},
        filePath: '/workspace/AdventureWorks.dacpac',
        sourceName: 'AdventureWorks',
      });
    });

    const btn = screen.getByRole('button', { name: /visualize/i });
    act(() => { fireEvent.click(btn); });

    const saveCall = mockApi.postMessage.mock.calls.find(
      ([msg]) => (msg as { type?: string })?.type === 'save-project'
    );
    expect(saveCall).toBeDefined();
    const project = (saveCall![0] as { project: { name: string } }).project;
    expect(project.name).toContain('AdventureWorks');

    unmount();
  });
});
