import { describe, expect, it } from 'vitest';
import {
  aiRunStorageKey,
  buildStoredRun,
  clearStoredRun,
  hashDdl,
  readStoredRun,
  writeStoredRun,
  UNKNOWN_DDL_HASH,
} from '../../../src/ai/session/runStore';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import type { SmState } from '../../../src/ai/sm/smTypes';
import type { LineageNode } from '../../../src/engine/types';
import { ProjectReadSchema, ProjectSchema, type FilterProfile } from '../../../src/engine/shared/bridgeContract';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

const DDL: Record<string, string> = {
  '[ai].[a]': 'CREATE VIEW [ai].[a] AS SELECT 1;',
  '[ai].[b]': 'CREATE VIEW [ai].[b] AS SELECT 2;',
};

// A real engine checkpoint, not a hand-shaped stand-in: the record is read back through the same
// navigation-snapshot contract the engine restores from, so a fictional snapshot would prove the
// wrong thing about what survives a read.
const SNAPSHOT_NODES: LineageNode[] = [
  makeNode({ id: '[ai].[a]', schema: 'ai', name: 'a', type: 'view' }),
  makeNode({ id: '[ai].[b]', schema: 'ai', name: 'b', type: 'view' }),
  makeNode({ id: '[ai].[c]', schema: 'ai', name: 'c', type: 'view' }),
];
const SNAPSHOT_EDGES: Array<[string, string]> = [['[ai].[b]', '[ai].[a]'], ['[ai].[c]', '[ai].[b]']];

/** Builds one real `engine.toJSON()` checkpoint over the three-view fixture chain. */
function engineCheckpoint(): SmState {
  const engine = new NavigationEngine(
    makeModel(SNAPSHOT_NODES, SNAPSHOT_EDGES, ['ai']),
    makeGraph(SNAPSHOT_NODES, SNAPSHOT_EDGES),
    () => {},
    {},
  );
  engine.init({ origin: '[ai].[a]', question: 'q', direction: 'upstream', depthIntent: { kind: 'full_frontier' } });
  return JSON.parse(JSON.stringify(engine.toJSON())) as SmState;
}

function checkpoint(overrides: Partial<SmState> = {}): SmState {
  return { ...engineCheckpoint(), ...overrides } as SmState;
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
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
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
    )!;
    expect(await writeStoredRun(store, 'bm-1', huge)).toBeGreaterThan(2_000_000);
    expect(store.values.get(aiRunStorageKey('bm-1'))).toBe(huge);
  });

  it('reads back a record written by writeStoredRun', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
    await writeStoredRun(store, 'bm-1', run);
    // Value equality, not identity: the read validates the stored record rather than handing back
    // whatever object the store holds.
    expect(readStoredRun(store, 'bm-1')).toEqual(run);
  });

  it('returns undefined for a bookmark id with no record', () => {
    const store = fakeMemento();
    expect(readStoredRun(store, 'bm-missing')).toBeUndefined();
  });

  it('returns undefined for a record whose schemaVersion is not 1', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
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
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
    await writeStoredRun(store, 'bm-1', run);
    await clearStoredRun(store, 'bm-1');
    expect(readStoredRun(store, 'bm-1')).toBeUndefined();
  });

  it('ignores a record whose snapshot is not a navigation checkpoint, and says so once at debug', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
    await store.update(aiRunStorageKey('bm-1'), { ...run, snapshot: { nonsense: true } });
    const debug: string[] = [];
    expect(readStoredRun(store, 'bm-1', { debug: (line: string) => debug.push(line) })).toBeUndefined();
    expect(debug.length).toBe(1);
    expect(debug[0]).toContain('bm-1');
  });

  it('keeps a record carrying an unknown top-level key from a newer build', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
    await store.update(aiRunStorageKey('bm-1'), { ...run, unknownFutureField: { nested: true } });
    expect(readStoredRun(store, 'bm-1')?.runId).toBe('run-7');
  });

  it('keeps a record whose origin or ddlHashes are the wrong shape, without them', async () => {
    const store = fakeMemento();
    const run = buildStoredRun(profile(), artifact(), getDdl)!;
    await store.update(aiRunStorageKey('bm-1'), { ...run, origin: 42, ddlHashes: 'not-a-map' });
    const read = readStoredRun(store, 'bm-1');
    expect(read?.runId).toBe('run-7');
    expect(read?.origin).toBeNull();
    expect(read?.ddlHashes).toEqual({});
  });

  it('round-trips a real engine checkpoint unchanged', async () => {
    const store = fakeMemento();
    const nodes: LineageNode[] = [
      makeNode({ id: '[ai].[a]', schema: 'ai', name: 'a', type: 'view' }),
      makeNode({ id: '[ai].[b]', schema: 'ai', name: 'b', type: 'view' }),
    ];
    const edges: Array<[string, string]> = [['[ai].[b]', '[ai].[a]']];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['ai']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    engine.init({ origin: '[ai].[a]', question: 'trace', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 1 } });
    const snapshot = JSON.parse(JSON.stringify(engine.toJSON()));
    await store.update(aiRunStorageKey('bm-1'), {
      schemaVersion: 1, runId: 'run-7', savedAt: new Date().toISOString(),
      origin: '[ai].[a]', ddlHashes: {}, snapshot,
    });
    expect(readStoredRun(store, 'bm-1')?.snapshot).toEqual(snapshot);
  });
});

describe('exploration run id', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: '[ai].[a]', schema: 'ai', name: 'a', type: 'view' }),
    makeNode({ id: '[ai].[b]', schema: 'ai', name: 'b', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['[ai].[b]', '[ai].[a]']];
  const model = makeModel(nodes, edges, ['ai']);

  const EMPTY_FILTER = {
    schemas: [], types: [], hideIsolated: false, focusSchemas: [],
    showExternalRefs: false, externalRefTypes: [],
  };

  /** Approves one exploration on `session` exactly as the gate does, and returns its run id. */
  function approve(session: AiSession): string {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: '[ai].[a]', question: 'trace', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 1 } });
    const epoch = session.beginTurn();
    session.storePendingExploration({
      init: { question: 'trace', origin: '[ai].[a]', analysisMode: 'bb', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 1 } },
      classification: 'business',
      activeFilter: EMPTY_FILTER,
      summary: engine.getScopeSummary(),
    }, epoch);
    const outcome = session.activatePendingExploration(session.pendingExploration!.revision, epoch, () => engine);
    expect(outcome.kind).toBe('accepted');
    return session.explorationRunId ?? session.id;
  }

  it('mints a fresh id per approved exploration, prefixed with the chat session id', () => {
    const session = new AiSession();
    const first = approve(session);
    const second = approve(session);
    expect(first).not.toBe(second);
    expect(first.startsWith(session.id)).toBe(true);
    expect(second.startsWith(session.id)).toBe(true);
  });

  it('carries no run id before an approval and drops it again on reset', () => {
    const session = new AiSession();
    expect(session.explorationRunId).toBeNull();
    approve(session);
    expect(session.explorationRunId).not.toBeNull();
    session.resetExploration();
    expect(session.explorationRunId).toBeNull();
  });

  it('files a bookmark against the run that produced it, not the next run in the same chat', () => {
    const session = new AiSession();
    const firstRunId = approve(session);
    const firstProfile = profile({ aiMetadata: { ...profile().aiMetadata!, runId: firstRunId } });
    const secondRunId = approve(session);
    const secondArtifact = artifact({ runId: secondRunId, aiMetadata: { ...artifact().aiMetadata, runId: secondRunId } });

    expect(buildStoredRun(firstProfile, secondArtifact, getDdl)).toBeNull();
    const secondProfile = profile({ aiMetadata: { ...profile().aiMetadata!, runId: secondRunId } });
    expect(buildStoredRun(secondProfile, secondArtifact, getDdl)?.runId).toBe(secondRunId);
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
