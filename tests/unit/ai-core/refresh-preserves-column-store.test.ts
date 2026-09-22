/**
 * Pins that a settings-only refresh leaves the column store intact.
 *
 * The store is a pure projection of the session model — `populateColumnStore` is its only writer —
 * and a rebuild re-reads configuration without touching the model. Clearing it there emptied the
 * store with nothing to refill it, which blanked the detail panel's columns and made every stored
 * run report `stale`, because an absent DDL hashes to `unknown` and never matches the saved digest.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMessageHandlers } from '../../../src/bridge/messageHandlers';
import { ColumnStore } from '../../../src/engine/columnStore';
import { populateColumnStore } from '../../../src/engine/modelBuilder';
import { hashDdl } from '../../../src/ai/session/runStore';
import type { BridgeHost } from '../../../src/bridge/host';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';

const VIEW_DDL = 'CREATE VIEW [dbo].[v] AS SELECT [id] FROM [dbo].[t];';

function modelWithBody(): DatabaseModel {
  const nodes: LineageNode[] = [
    {
      id: '[dbo].[v]', schema: 'dbo', name: 'v', type: 'view',
      columns: [{ name: 'id', dataType: 'int', nullable: false }],
      bodyScript: VIEW_DDL,
      dependencies: [], dependents: [],
    } as unknown as LineageNode,
  ];
  return { nodes, edges: [], schemas: [{ name: 'dbo', nodeCount: 1 }] } as unknown as DatabaseModel;
}

function fakeHost(): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: () => undefined }),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    withProgress: vi.fn(),
    getExtensionUri: vi.fn(),
    getGlobalState: vi.fn(),
    getWorkspaceState: vi.fn(),
  };
}

/** A session carrying a column store populated from `model`, as a real model load leaves it. */
function seededSession(model: DatabaseModel) {
  const columnStore = new ColumnStore();
  populateColumnStore(model, columnStore);
  return { model, columnStore, uiState: {}, renderState: null };
}

describe('rebuild preserves the column store', () => {
  it('leaves DDL and columns resolvable after a settings-only rebuild', async () => {
    const model = modelWithBody();
    const session = seededSession(model);
    const host = fakeHost();
    const { handlers } = createMessageHandlers(
      host,
      { globalState: { get: () => undefined, update: () => Promise.resolve() } } as never,
      () => session as never,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      () => ({ schemaVersion: 1, projects: [] }) as never,
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
    );

    expect(session.columnStore.getDdl('[dbo].[v]')).toBe(VIEW_DDL);

    await handlers.rebuild({ type: 'rebuild' } as never);

    // The detail panel reads both of these; before the fix each came back undefined.
    expect(session.columnStore.getDdl('[dbo].[v]')).toBe(VIEW_DDL);
    expect(session.columnStore.getColumns('[dbo].[v]')).toHaveLength(1);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rebuild-config' }),
    );
  });

  it('keeps a stored run\'s DDL digest matching after a rebuild, so nothing reports stale', async () => {
    const model = modelWithBody();
    const session = seededSession(model);
    // The digest a run stores at save time.
    const storedHash = hashDdl(session.columnStore.getDdl('[dbo].[v]'));
    const host = fakeHost();
    const { handlers } = createMessageHandlers(
      host,
      { globalState: { get: () => undefined, update: () => Promise.resolve() } } as never,
      () => session as never,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      () => ({ schemaVersion: 1, projects: [] }) as never,
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
    );

    await handlers.rebuild({ type: 'rebuild' } as never);

    expect(hashDdl(session.columnStore.getDdl('[dbo].[v]'))).toBe(storedHash);
  });
});
