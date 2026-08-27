/**
 * Pins that deleting a project clears the AI run memory of every filter profile it carried, and
 * that deleting one project never disturbs the run memory of a profile belonging to another.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMessageHandlers } from '../../../src/bridge/messageHandlers';
import { aiRunStorageKey } from '../../../src/ai/session/runStore';
import type { ProjectStore } from '../../../src/engine/projectStore';
import type { BridgeHost } from '../../../src/bridge/host';
import type { FilterProfile } from '../../../src/engine/shared/bridgeContract';

function filterProfile(id: string): FilterProfile {
  return {
    id,
    name: `Profile ${id}`,
    createdAt: '2026-08-25T09:00:00.000Z',
    filter: {
      schemas: ['ai'], types: ['view'], hideIsolated: false, focusSchemas: [],
      showExternalRefs: false, externalRefTypes: [], allowlistNodeIds: [],
    },
    source: 'ai',
    aiMetadata: {
      createdAt: '2026-08-25T09:00:00.000Z',
      modelName: 'test-model',
      runId: `run-${id}`,
      highlightGroups: [],
      badges: [],
    },
  };
}

function seededStore(): ProjectStore {
  return {
    schemaVersion: 1,
    lastOpenedId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Project One',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        connection: { type: 'dacpac', path: 'x.dacpac', displayName: 'x', schemas: ['ai'] },
        filterProfiles: [filterProfile('bm-1'), filterProfile('bm-2')],
      },
      {
        id: 'p2',
        name: 'Project Two',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        connection: { type: 'dacpac', path: 'y.dacpac', displayName: 'y', schemas: ['ai'] },
        filterProfiles: [filterProfile('bm-3')],
      },
    ],
  } as unknown as ProjectStore;
}

/** Minimal fake globalState memento: `update(key, undefined)` deletes the key. */
function fakeMemento(seedIds: readonly string[], failingIds: readonly string[] = []) {
  const values = new Map<string, unknown>();
  for (const id of seedIds) values.set(aiRunStorageKey(id), { schemaVersion: 1 });
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      const failing = failingIds.some(id => key === aiRunStorageKey(id));
      if (failing) return Promise.reject(new Error(`update rejected for ${key}`));
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  };
}

function fakeHost(): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    withProgress: vi.fn(),
    getConfiguration: vi.fn(),
    getExtensionUri: vi.fn(),
    getGlobalState: vi.fn(),
    getWorkspaceState: vi.fn(),
  } as unknown as BridgeHost;
}

function buildHandlers(store: ProjectStore, globalState: ReturnType<typeof fakeMemento>, host: BridgeHost) {
  let savedStore: ProjectStore | undefined;
  const saveProjectStore = vi.fn().mockImplementation((_context: unknown, updated: ProjectStore) => {
    savedStore = updated;
    return Promise.resolve();
  });
  const { handlers } = createMessageHandlers(
    host,
    { globalState } as never,
    () => ({}) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    () => store,
    saveProjectStore,
    vi.fn(),
    false,
    vi.fn(),
  );
  return { handlers, saveProjectStore, getSavedStore: () => savedStore };
}

describe('delete-project run memory cleanup', () => {
  it('clears the run memory of every profile in the deleted project and leaves other projects alone', async () => {
    const store = seededStore();
    const globalState = fakeMemento(['bm-1', 'bm-2', 'bm-3']);
    const host = fakeHost();
    const { handlers, saveProjectStore, getSavedStore } = buildHandlers(store, globalState, host);

    await handlers['delete-project']({ type: 'delete-project', id: 'p1' } as never);

    expect(globalState.values.has(aiRunStorageKey('bm-1'))).toBe(false);
    expect(globalState.values.has(aiRunStorageKey('bm-2'))).toBe(false);
    expect(globalState.values.has(aiRunStorageKey('bm-3'))).toBe(true);
    expect(saveProjectStore).toHaveBeenCalledTimes(1);
    expect(getSavedStore()?.projects.map(p => p.id)).toEqual(['p2']);
  });

  it('resolves and clears what it can when one memento update rejects, logging a warning for the failed id', async () => {
    const store = seededStore();
    const globalState = fakeMemento(['bm-1', 'bm-2', 'bm-3'], ['bm-2']);
    const host = fakeHost();
    const { handlers } = buildHandlers(store, globalState, host);

    await expect(
      handlers['delete-project']({ type: 'delete-project', id: 'p1' } as never),
    ).resolves.toBeUndefined();

    expect(globalState.values.has(aiRunStorageKey('bm-1'))).toBe(false);
    expect(globalState.values.has(aiRunStorageKey('bm-2'))).toBe(true);
    expect(globalState.values.has(aiRunStorageKey('bm-3'))).toBe(true);

    const warnCall = (host.log as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'warn' && typeof call[2] === 'string' && call[2].includes('bm-2'),
    );
    expect(warnCall).toBeDefined();
  });

  it('clears nothing and resolves when the deleted project id is unknown', async () => {
    const store = seededStore();
    const globalState = fakeMemento(['bm-1', 'bm-2', 'bm-3']);
    const host = fakeHost();
    const { handlers, saveProjectStore } = buildHandlers(store, globalState, host);

    await expect(
      handlers['delete-project']({ type: 'delete-project', id: 'does-not-exist' } as never),
    ).resolves.toBeUndefined();

    expect(globalState.values.has(aiRunStorageKey('bm-1'))).toBe(true);
    expect(globalState.values.has(aiRunStorageKey('bm-2'))).toBe(true);
    expect(globalState.values.has(aiRunStorageKey('bm-3'))).toBe(true);
    expect(saveProjectStore).toHaveBeenCalledTimes(1);
  });
});
