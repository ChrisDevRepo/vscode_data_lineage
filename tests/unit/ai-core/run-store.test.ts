import { describe, expect, it } from 'vitest';
import {
  aiRunStorageKey,
  buildStoredRun,
  clearStoredRun,
  hashDdl,
  readStoredRun,
  writeStoredRun,
  UNKNOWN_DDL_HASH,
  type StoredAiRun,
} from '../../../src/ai/session/runStore';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import type { SmState } from '../../../src/ai/sm/smTypes';
import { ProjectReadSchema, ProjectSchema, type FilterProfile } from '../../../src/engine/shared/bridgeContract';

const DDL: Record<string, string> = {
  '[ai].[a]': 'CREATE VIEW [ai].[a] AS SELECT 1;',
  '[ai].[b]': 'CREATE VIEW [ai].[b] AS SELECT 2;',
};

function checkpoint(overrides: Partial<SmState> = {}): SmState {
  return {
    snapshotVersion: 1,
    columnAspect: null,
    status: 'complete',
    hopCount: 1,
    scopeSize: 3,
    scopeNodeIds: ['[ai].[a]', '[ai].[b]', '[ai].[c]'],
    visited: [],
    removedSet: [],
    nodeStates: [],
    agendaSize: 0,
    agenda: [],
    currentFocusNodeId: null,
    memory: { userQuestion: 'q', detailSlots: {}, slotCount: 0, missionBrief: '', scopeNotes: [], verdictCounts: { analyze: 0, passthrough: 0, prune: 0 }, recentRejections: [] },
    engineInternals: {
      initSnapshot: { question: 'q', origin: '[ai].[a]', analysisMode: 'bb', direction: 'upstream', depthIntent: { kind: 'default_start' } },
      pendingLeads: [],
    },
    ...overrides,
  } as unknown as SmState;
}

function artifact(overrides: Partial<PresentationArtifact> = {}): PresentationArtifact {
  return {
    name: 'Impact of [ai].[a]',
    nodeIds: ['[ai].[a]'],
    aiMetadata: {
      summary: 's',
      description: 'd',
      createdAt: '2026-08-25T09:00:00.000Z',
      modelName: 'test-model',
      runId: 'run-7',
      highlightGroups: [],
      badges: [],
    },
    runId: 'run-7',
    checkpoint: checkpoint(),
    ...overrides,
  };
}

function profile(overrides: Partial<FilterProfile> = {}): FilterProfile {
  return {
    id: 'bm-1',
    name: 'Impact of [ai].[a]',
    createdAt: '2026-08-25T09:00:00.000Z',
    filter: {
      schemas: ['ai'], types: ['view'], hideIsolated: false, focusSchemas: [],
      showExternalRefs: false, externalRefTypes: [], allowlistNodeIds: ['[ai].[a]'],
    },
    source: 'ai',
    aiMetadata: {
      createdAt: '2026-08-25T09:00:00.000Z',
      modelName: 'test-model',
      runId: 'run-7',
      highlightGroups: [],
      badges: [],
    },
    ...overrides,
  };
}

const getDdl = (id: string) => DDL[id];

describe('buildStoredRun', () => {
  it('builds a record for an AI profile whose run id matches the presentation', () => {
    const run = buildStoredRun(profile(), artifact(), getDdl);
    expect(run).not.toBeNull();
    expect(run?.schemaVersion).toBe(1);
    expect(run?.runId).toBe('run-7');
    expect(run?.snapshot).toEqual(artifact().checkpoint);
    expect(Date.parse(run?.savedAt ?? '')).not.toBeNaN();
  });

  it.each([
    { label: 'a user profile', value: profile({ source: 'user' }) },
    { label: 'a trace profile', value: profile({ source: 'trace' }) },
    { label: 'an analysis profile', value: profile({ source: 'analysis' }) },
    { label: 'a profile with no source', value: profile({ source: undefined }) },
  ])('returns null for $label', ({ value }) => {
    expect(buildStoredRun(value, artifact(), getDdl)).toBeNull();
  });

  it('returns null when the profile run id does not match the presentation', () => {
    const stale = profile({ aiMetadata: { ...profile().aiMetadata!, runId: 'run-6' } });
    expect(buildStoredRun(stale, artifact(), getDdl)).toBeNull();
  });

  it('returns null when the profile carries no run id', () => {
    const anonymous = profile({ aiMetadata: { ...profile().aiMetadata!, runId: undefined } });
    expect(buildStoredRun(anonymous, artifact(), getDdl)).toBeNull();
  });

  it('returns null without a captured checkpoint and without a presentation', () => {
    expect(buildStoredRun(profile(), artifact({ checkpoint: undefined }), getDdl)).toBeNull();
    expect(buildStoredRun(profile(), null, getDdl)).toBeNull();
  });

  it('hashes every scope node and records an unavailable DDL as unknown', () => {
    const run = buildStoredRun(profile(), artifact(), getDdl);
    expect(Object.keys(run?.ddlHashes ?? {})).toEqual(['[ai].[a]', '[ai].[b]', '[ai].[c]']);
    expect(run?.ddlHashes['[ai].[a]']).toMatch(/^[0-9a-f]{64}$/);
    expect(run?.ddlHashes['[ai].[c]']).toBe(UNKNOWN_DDL_HASH);
    expect(run?.ddlHashes['[ai].[a]']).not.toBe(run?.ddlHashes['[ai].[b]']);
  });

  it('falls back to the profile allowlist when the checkpoint carries no scope', () => {
    const scopeless = artifact({ checkpoint: checkpoint({ scopeNodeIds: undefined as unknown as string[] }) });
    const run = buildStoredRun(profile(), scopeless, getDdl);
    expect(Object.keys(run?.ddlHashes ?? {})).toEqual(['[ai].[a]']);
  });

  it('reads the origin from the checkpoint init snapshot and null when it is absent', () => {
    expect(buildStoredRun(profile(), artifact(), getDdl)?.origin).toBe('[ai].[a]');
    const originless = artifact({ checkpoint: checkpoint({ engineInternals: { pendingLeads: [] } as unknown as SmState['engineInternals'] }) });
    expect(buildStoredRun(profile(), originless, getDdl)?.origin).toBeNull();
  });

  it('hashes the same DDL to the same digest across calls', () => {
    const first = buildStoredRun(profile(), artifact(), getDdl);
    const second = buildStoredRun(profile(), artifact(), getDdl);
    expect(first?.ddlHashes).toEqual(second?.ddlHashes);
    expect(hashDdl(DDL['[ai].[a]'])).toBe(first?.ddlHashes['[ai].[a]']);
    expect(hashDdl(undefined)).toBe(UNKNOWN_DDL_HASH);
    expect(hashDdl('')).toBe(UNKNOWN_DDL_HASH);
  });
});

describe('run-store writes', () => {
  function fakeMemento() {
    const values = new Map<string, unknown>();
    return {
      values,
      update(key: string, value: unknown) {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
        return Promise.resolve();
      },
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
    };
  }

  it('writes and clears a record under the bookmark key', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl) as StoredAiRun;
    expect(await writeStoredRun(store, 'bm-1', run)).toBe(JSON.stringify(run).length);
    expect(store.values.get(aiRunStorageKey('bm-1'))).toBe(run);

    await clearStoredRun(store, 'bm-1');
    expect(store.values.has(aiRunStorageKey('bm-1'))).toBe(false);
  });

  it('writes a multi-megabyte record whole, never skipped or truncated', async () => {
    const store = fakeMemento();
    const huge = buildStoredRun(
      profile(),
      artifact({ checkpoint: checkpoint({ visited: [ 'x'.repeat(2_000_000) ] }) }),
      getDdl,
    ) as StoredAiRun;
    expect(await writeStoredRun(store, 'bm-1', huge)).toBeGreaterThan(2_000_000);
    expect(store.values.get(aiRunStorageKey('bm-1'))).toBe(huge);
  });

  it('reads back a record written by writeStoredRun', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl) as StoredAiRun;
    await writeStoredRun(store, 'bm-1', run);
    expect(readStoredRun(store, 'bm-1')).toBe(run);
  });

  it('returns undefined for a bookmark id with no record', () => {
    const store = fakeMemento();
    expect(readStoredRun(store, 'bm-missing')).toBeUndefined();
  });

  it('returns undefined for a record whose schemaVersion is not 1', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl) as StoredAiRun;
    await store.update(aiRunStorageKey('bm-1'), { ...run, schemaVersion: 2 });
    expect(readStoredRun(store, 'bm-1')).toBeUndefined();
  });

  it('returns undefined for a non-object value stored under the key', async () => {
    const store = fakeMemento();
    await store.update(aiRunStorageKey('bm-1'), 'not-a-record');
    expect(readStoredRun(store, 'bm-1')).toBeUndefined();

    await store.update(aiRunStorageKey('bm-2'), null);
    expect(readStoredRun(store, 'bm-2')).toBeUndefined();
  });

  it('returns undefined after clearStoredRun', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl) as StoredAiRun;
    await writeStoredRun(store, 'bm-1', run);
    await clearStoredRun(store, 'bm-1');
    expect(readStoredRun(store, 'bm-1')).toBeUndefined();
  });
});

describe('bookmark record compatibility', () => {
  const storedProject = (aiMetadata: Record<string, unknown>) => ({
    id: 'p1',
    name: 'Sales',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    connection: { type: 'dacpac', path: 'x.dacpac', displayName: 'x', schemas: ['ai'] },
    filterProfiles: [{ ...profile(), aiMetadata }],
  });

  it('reads a bookmark written before runId existed', () => {
    const legacy = storedProject({
      createdAt: '2026-08-01T00:00:00.000Z', modelName: 'old', highlightGroups: [], badges: [],
    });
    const parsed = ProjectReadSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.filterProfiles?.[0].aiMetadata?.runId).toBeUndefined();
  });

  it('reads a bookmark carrying an unknown future field and drops it', () => {
    const future = storedProject({
      createdAt: '2026-08-01T00:00:00.000Z', modelName: 'next', highlightGroups: [], badges: [],
      runId: 'run-9', unknownFutureField: { nested: true },
    });
    const parsed = ProjectReadSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.filterProfiles?.[0].aiMetadata?.runId).toBe('run-9');
    expect(parsed.data?.filterProfiles?.[0].aiMetadata).not.toHaveProperty('unknownFutureField');
  });

  it('still rejects an unknown field on the write path', () => {
    const future = storedProject({
      createdAt: '2026-08-01T00:00:00.000Z', modelName: 'next', highlightGroups: [], badges: [],
      unknownFutureField: true,
    });
    expect(ProjectSchema.safeParse(future).success).toBe(false);
    expect(ProjectSchema.safeParse(storedProject({
      createdAt: '2026-08-01T00:00:00.000Z', modelName: 'next', highlightGroups: [], badges: [], runId: 'run-9',
    })).success).toBe(true);
  });
});
