import { describe, expect, it } from 'vitest';
import { describeScreen, presentRunRecall, presentScreenState, type RunRecallInput } from '../../../src/ai/tools/screenStatePresenter';
import { aiRunStorageKey, AI_RUN_KEY_PREFIX, hashDdl, type StoredAiRun } from '../../../src/ai/session/runStore';
import { GetScreenStateInputSchema, parseToolInput } from '../../../src/ai/tools/toolSchemas';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';
import type { SmState } from '../../../src/ai/sm/smTypes';

const EMPTY = {
  uiState: null,
  renderState: null,
  graphMode: 'full' as const,
  filteredCount: 0,
  totalNodes: 0,
};

function ids(count: number, prefix = 'n'): string[] {
  return Array.from({ length: count }, (_, index) => `[dbo].[${prefix}${index}]`);
}

const SEEDED_UI = {
  trace: { mode: 'applied', selectedNodeId: '[dbo].[factsales]', upstreamLevels: 2, downstreamLevels: 1 },
  screenState: {
    analytics: {
      type: 'longest-path',
      activeGroupId: 'g1',
      groups: [
        { id: 'g1', label: 'Path A', nodeIds: ids(9, 'a') },
        { id: 'g2', label: 'Path B', nodeIds: ids(3, 'b') },
      ],
    },
    bookmark: { id: 'bm-1', name: 'Q3 impact check', source: 'ai', allowlistNodeIds: ids(8, 'k') },
    detailOpen: true,
  },
};

const SEEDED_RENDER = {
  traceScope: {
    mode: 'applied',
    origin: '[dbo].[factsales]',
    baseNodeIds: ids(14),
    manualAddedNodeIds: ids(2, 'add'),
    manualPrunedNodeIds: ids(1, 'cut'),
    tracedNodeIds: ids(14),
  },
};

function storedRun(overrides: Partial<StoredAiRun> = {}): StoredAiRun {
  const snapshot = {
    snapshotVersion: 1,
    columnAspect: null,
    status: 'completed',
    hopCount: 2,
    scopeSize: 7,
    scopeNodeIds: ids(7, 's'),
    visited: [],
    removedSet: [],
    nodeStates: [
      { nodeId: '[ai].[a]', action: 'analyze', source: 'ai', reason: 'ai_analyzed' },
      { nodeId: '[ai].[b]', action: 'analyze', source: 'ai', reason: 'ai_analyzed' },
      { nodeId: '[ai].[c]', action: 'prune', source: 'ai', reason: 'ai_pruned' },
      { nodeId: '[ai].[d]', action: 'passthrough', source: 'engine', reason: 'auto_passthrough' },
    ],
    agendaSize: 0,
    agenda: [],
    currentFocusNodeId: null,
    memory: {},
    engineInternals: {
      pendingLeads: [{ id: 'lead_1' }, { id: 'lead_2' }, { id: 'lead_3' }],
      initSnapshot: {
        question: 'Trace all dependencies upstream from [ai].[spImportOrders]',
        origin: '[ai].[spimportorders]',
        analysisMode: 'bb',
        direction: 'bidirectional',
        depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
      },
    },
  } as unknown as SmState;
  return {
    schemaVersion: 1,
    runId: 'run-42',
    savedAt: '2026-08-20T10:00:00.000Z',
    origin: '[ai].[spimportorders]',
    ddlHashes: {},
    snapshot,
    ...overrides,
  };
}

describe('screen-state presenter', () => {
  it('renders every section null for an empty session', () => {
    const { screen, _token_estimate } = presentScreenState(EMPTY);
    expect(screen.trace).toBeNull();
    expect(screen.analysis).toBeNull();
    expect(screen.bookmark).toBeNull();
    expect(screen.view).toEqual({ level: 'object', visible_nodes: 0, total_nodes: 0 });
    expect(_token_estimate.chars).toBeGreaterThan(0);
    expect(_token_estimate.estimated_tokens).toBe(Math.ceil(_token_estimate.chars / 4));
  });

  it.each([
    { label: 'string', value: 'garbage' },
    { label: 'number', value: 42 },
    { label: 'array', value: [1, 2, 3] },
    { label: 'numeric screenState', value: { screenState: 42 } },
    { label: 'numeric sections', value: { trace: 7, screenState: { analytics: 'x', bookmark: 9 } } },
  ])('tolerates $label ui-state without throwing', ({ value }) => {
    const run = () => presentScreenState({ ...EMPTY, uiState: value, renderState: value });
    expect(run).not.toThrow();
    const { screen } = run();
    expect(screen.trace).toBeNull();
    expect(screen.analysis).toBeNull();
    expect(screen.bookmark).toBeNull();
  });

  it('omits the trace section while the trace mode is none', () => {
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: { trace: { mode: 'none', selectedNodeId: null, upstreamLevels: 2, downstreamLevels: 1 } },
    });
    expect(screen.trace).toBeNull();
  });

  it('renders seeded trace, analysis, bookmark, and view sections', () => {
    const { screen } = presentScreenState({
      uiState: SEEDED_UI,
      renderState: SEEDED_RENDER,
      graphMode: 'overview',
      filteredCount: 14,
      totalNodes: 1240,
    });
    expect(screen.trace).toEqual({
      origin: '[dbo].[factsales]',
      upstream: 2,
      downstream: 1,
      mode: 'applied',
      nodes: 14,
      added_by_user: ids(2, 'add'),
      pruned_by_user: ids(1, 'cut'),
    });
    expect(screen.analysis).toEqual({
      type: 'longest-path',
      active_group: 'Path A',
      active_group_node_ids: ids(9, 'a'),
      group_count: 2,
      groups: [{ label: 'Path A', nodes: 9 }, { label: 'Path B', nodes: 3 }],
    });
    expect(screen.bookmark).toEqual({
      name: 'Q3 impact check',
      source: 'ai',
      nodes: 8,
      ai_run: null,
    });
    expect(screen.view).toEqual({ level: 'overview', visible_nodes: 14, total_nodes: 1240 });
  });

  it('caps manual id lists at 20 entries and reports the remainder', () => {
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: SEEDED_UI,
      renderState: { traceScope: { ...SEEDED_RENDER.traceScope, manualAddedNodeIds: ids(26, 'add') } },
    });
    const added = (screen.trace as { added_by_user: string[] }).added_by_user;
    expect(added).toHaveLength(21);
    expect(added.at(-1)).toBe('…and 6 more');
    expect(added.slice(0, 20)).toEqual(ids(26, 'add').slice(0, 20));
  });

  it('reports an All-levels trace as "all" rather than the raw sentinel', () => {
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: {
        ...SEEDED_UI,
        trace: { ...SEEDED_UI.trace, upstreamLevels: TRACE_ALL_LEVELS, downstreamLevels: 0 },
      },
      renderState: SEEDED_RENDER,
    });
    const trace = screen.trace as { upstream: number | 'all'; downstream: number | 'all' };
    expect(trace.upstream, 'the banner shows "All"; the model must not be told a literal depth').toBe('all');
    expect(trace.downstream, 'a real depth still renders as a number').toBe(0);
  });

  it('caps the analysis group list at 20 and reports the full count', () => {
    const groups = ids(26, 'g').map((id, index) => ({ id, label: `Island ${index}`, nodeIds: ids(2, `m${index}`) }));
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: { ...SEEDED_UI, screenState: { ...SEEDED_UI.screenState, analytics: { type: 'islands', activeGroupId: null, groups } } },
    });
    const analysis = screen.analysis as { group_count: number; groups: unknown[] };
    expect(analysis.groups).toHaveLength(20);
    expect(analysis.group_count, 'the cap must stay visible, not silently truncate').toBe(26);
  });

  it('resolves the stored run for an AI-authored bookmark by bookmark id', () => {
    const seen: string[] = [];
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: SEEDED_UI,
      renderState: null,
      getStoredRun: (bookmarkId) => {
        seen.push(bookmarkId);
        return bookmarkId === 'bm-1' ? storedRun() : undefined;
      },
    });
    expect(seen).toEqual(['bm-1']);
    expect((screen.bookmark as { ai_run: unknown }).ai_run).toEqual({
      run_id: 'run-42',
      question: 'Trace all dependencies upstream from [ai].[spImportOrders]',
      origin: '[ai].[spimportorders]',
      depth: { upstream: 'all', downstream: 1 },
      scope: 7,
      analyzed: 2,
      pruned: 1,
      stale_objects: 0,
      open_questions: 3,
    });
  });

  it('never queries the run store for a user-authored bookmark', () => {
    const seen: string[] = [];
    const { screen } = presentScreenState({
      ...EMPTY,
      uiState: {
        screenState: { bookmark: { id: 'bm-2', name: 'My view', source: 'user', allowlistNodeIds: ids(4) } },
      },
      getStoredRun: (bookmarkId) => { seen.push(bookmarkId); return storedRun(); },
    });
    expect(seen).toEqual([]);
    expect(screen.bookmark).toEqual({ name: 'My view', source: 'user', nodes: 4, ai_run: null });
  });

  it('renders ai_run null when the store resolves nothing and tolerates a malformed snapshot', () => {
    const absent = presentScreenState({
      ...EMPTY, uiState: SEEDED_UI, getStoredRun: () => undefined,
    });
    expect((absent.screen.bookmark as { ai_run: unknown }).ai_run).toBeNull();

    const malformed = presentScreenState({
      ...EMPTY,
      uiState: SEEDED_UI,
      getStoredRun: () => storedRun({ snapshot: 'not-a-snapshot' as unknown as SmState }),
    });
    expect((malformed.screen.bookmark as { ai_run: unknown }).ai_run).toBeNull();
  });

  it('mirrors the exploration direction onto the disabled depth side', () => {
    const upstreamOnly = storedRun();
    const init = (upstreamOnly.snapshot as unknown as {
      engineInternals: { initSnapshot: { direction: string; depthIntent: unknown } };
    }).engineInternals.initSnapshot;
    init.direction = 'upstream';
    init.depthIntent = { kind: 'explicit', levels: 3 };
    const { screen } = presentScreenState({
      ...EMPTY, uiState: SEEDED_UI, getStoredRun: () => upstreamOnly,
    });
    expect((screen.bookmark as { ai_run: { depth: unknown } }).ai_run.depth)
      .toEqual({ upstream: 3, downstream: 0 });
  });

  it('keys the run store by bookmark id under the declared prefix', () => {
    expect(aiRunStorageKey('bm-1')).toBe(`${AI_RUN_KEY_PREFIX}bm-1`);
  });
});

const RECALL_DDL: Record<string, string> = {
  '[ai].[a]': 'CREATE VIEW [ai].[a] AS SELECT 1;',
  '[ai].[b]': 'CREATE VIEW [ai].[b] AS SELECT 2;',
};

function recallRun(): StoredAiRun {
  const base = storedRun();
  const snapshot = base.snapshot as unknown as Record<string, unknown>;
  snapshot.memory = {
    detailSlots: {
      '[ai].[a]': {
        nodeId: '[ai].[a]', schema: 'ai', name: 'a', type: 'view',
        summary: 'Filters orders to the eligible set.',
        sections: [{ angle: 'business', text: 'Eligibility rules.' }, { angle: 'technical', text: 'Joins on OrderId.' }],
      },
    },
  };
  const nodeStates = snapshot.nodeStates as Array<Record<string, unknown>>;
  nodeStates[0] = {
    nodeId: '[ai].[a]', action: 'analyze', source: 'ai', reason: 'submitted_analyze', viaNodeId: '[ai].[root]', atHop: 1,
  };
  nodeStates[1] = { nodeId: '[ai].[b]', action: 'analyze', source: 'ai', reason: 'submitted_analyze' };
  nodeStates[2] = {
    nodeId: '[ai].[c]', action: 'prune', source: 'ai', reason: 'submitted_prune', viaNodeId: '[ai].[a]', atHop: 2,
  };
  (snapshot.engineInternals as Record<string, unknown>).pendingLeads = [
    { id: 'lead_1', nodeId: '[ai].[lead]', fromNodeId: '[ai].[a]', reason: 'schema_boundary', valueToUser: 'Confirms where regions come from.' },
  ];
  return {
    ...base,
    ddlHashes: {
      '[ai].[a]': hashDdl(RECALL_DDL['[ai].[a]']),
      '[ai].[b]': hashDdl('CREATE VIEW [ai].[b] AS SELECT 999;'),
      '[ai].[d]': 'unknown',
    },
  };
}

function recallInput(overrides: Partial<RunRecallInput> = {}): RunRecallInput {
  return {
    uiState: SEEDED_UI,
    getStoredRun: (bookmarkId) => (bookmarkId === 'bm-1' ? recallRun() : undefined),
    getDdl: (id) => RECALL_DDL[id],
    isInModel: (id) => id in RECALL_DDL,
    ...overrides,
  };
}

describe('stored-run recall', () => {
  it('recalls a known object with its decision, reason, summary and sections', () => {
    const result = presentRunRecall(recallInput({ ids: ['[ai].[a]'] }));
    expect(result.run_id).toBe('run-42');
    expect(result.saved_at).toBe('2026-08-20T10:00:00.000Z');
    expect((result.objects as unknown[])[0]).toEqual({
      id: '[ai].[a]',
      decision: 'analyze',
      reason: 'submitted_analyze',
      via: '[ai].[root]',
      hop: 1,
      summary: 'Filters orders to the eligible set.',
      section: 'Eligibility rules.\n\nJoins on OrderId.',
      stale: false,
      in_current_model: true,
    });
    expect(result._token_estimate).toBeDefined();
  });

  it('answers an id the run never saw without throwing', () => {
    const result = presentRunRecall(recallInput({ ids: ['[ai].[never]'] }));
    expect((result.objects as unknown[])[0]).toEqual({ id: '[ai].[never]', decision: 'not_in_run' });
  });

  it('marks an object whose DDL changed since the run as stale', () => {
    const result = presentRunRecall(recallInput({ ids: ['[ai].[b]', '[ai].[d]'] }));
    const [changed, unknownHash] = result.objects as Array<Record<string, unknown>>;
    expect(changed).toMatchObject({ id: '[ai].[b]', stale: true, in_current_model: true, decision: 'analyze' });
    expect(unknownHash).toMatchObject({ id: '[ai].[d]', stale: false, in_current_model: false });
  });

  it('lists the pruned objects with their reason', () => {
    const result = presentRunRecall(recallInput({ filter: 'pruned' }));
    expect(result.pruned).toEqual([
      { id: '[ai].[c]', reason: 'submitted_prune', via: '[ai].[a]', hop: 2 },
    ]);
  });

  it('lists the open leads with their value to the user', () => {
    const result = presentRunRecall(recallInput({ filter: 'open_leads' }));
    expect(result.open_leads).toEqual([
      { id: '[ai].[lead]', from: '[ai].[a]', reason: 'schema_boundary', value: 'Confirms where regions come from.' },
    ]);
  });

  it('lists only the changed objects under the stale filter', () => {
    const result = presentRunRecall(recallInput({ filter: 'stale' }));
    expect(result.stale).toEqual([{ id: '[ai].[b]', stored_hash_known: true }]);
  });

  it.each([
    { label: 'no bookmark is applied', input: { uiState: null } },
    { label: 'the bookmark is user-authored', input: { uiState: { screenState: { bookmark: { id: 'bm-9', name: 'Mine', source: 'user' } } } } },
    { label: 'no run is stored for the bookmark', input: { getStoredRun: () => undefined } },
  ])('answers no_run_memory when $label', ({ input }) => {
    const result = presentRunRecall(recallInput({ ids: ['[ai].[a]'], ...input }));
    expect(result.error).toBe('no_run_memory');
    expect(result.hint).toBe('No AI run is stored for the applied view. Apply an AI bookmark saved after a run, or start a new exploration.');
    expect(result._token_estimate).toBeDefined();
  });

  it('hard-rejects an over-budget recall with a narrowing hint instead of truncating', () => {
    const bulky = recallRun();
    const slots = (bulky.snapshot as unknown as { memory: { detailSlots: Record<string, unknown> } }).memory.detailSlots;
    slots['[ai].[a]'] = {
      nodeId: '[ai].[a]', summary: 'x'.repeat(60_000),
      sections: [{ angle: 'business', text: 'y'.repeat(60_000) }],
    };
    const result = presentRunRecall(recallInput({ ids: ['[ai].[a]'], getStoredRun: () => bulky }));
    expect(result.reason).toBe('over_discovery_budget');
    expect(result.hint).toMatch(/^Narrow ids to at most \d+ or use a filter instead\.$/);
    expect(result.objects).toBeUndefined();
  });
});

describe('lineage_get_screen_state input contract', () => {
  it('accepts an empty call, ids alone, and a filter alone', () => {
    expect(parseToolInput(GetScreenStateInputSchema, {}).ok).toBe(true);
    expect(parseToolInput(GetScreenStateInputSchema, { ids: ['[ai].[a]'] }).ok).toBe(true);
    expect(parseToolInput(GetScreenStateInputSchema, { filter: 'pruned' }).ok).toBe(true);
  });

  it('rejects ids together with filter and names the repair', () => {
    const parsed = parseToolInput(GetScreenStateInputSchema, { ids: ['[ai].[a]'], filter: 'pruned' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('mutually exclusive input must reject');
    expect(parsed.error.error).toBe('invalid_input');
    expect(parsed.error.field).toBe('filter');
    expect(parsed.error.hint).toContain('Send either ids or filter, never both.');
  });

  it.each([
    { label: 'an empty ids array', input: { ids: [] } },
    { label: 'more than 20 ids', input: { ids: Array.from({ length: 21 }, (_, index) => `[ai].[n${index}]`) } },
    { label: 'an unknown filter class', input: { filter: 'everything' } },
    { label: 'an undeclared field', input: { limit: 5 } },
  ])('rejects $label', ({ input }) => {
    expect(parseToolInput(GetScreenStateInputSchema, input).ok).toBe(false);
  });
});

describe('describeScreen', () => {
  it('returns null when nothing is applied or the buffer is garbage', () => {
    expect(describeScreen(null)).toBeNull();
    expect(describeScreen('nonsense')).toBeNull();
    expect(describeScreen({ trace: { mode: 'none' }, screenState: { analytics: null, bookmark: null } })).toBeNull();
  });

  it('names a trace with its origin and decoded depths', () => {
    expect(describeScreen({
      trace: { mode: 'trace', selectedNodeId: '[ai].[factsalesreport]', upstreamLevels: TRACE_ALL_LEVELS, downstreamLevels: 1 },
    })).toBe('a trace from [ai].[factsalesreport] (all up, 1 down)');
  });

  it('names an analysis with the selected group and a bookmark with its source', () => {
    expect(describeScreen({
      screenState: {
        analytics: { type: 'longest-path', activeGroupId: 'g1', groups: [{ id: 'g1', label: 'Path A', nodeIds: [] }] },
        bookmark: { id: 'bm-1', name: 'Q3 impact check', source: 'ai', allowlistNodeIds: [] },
      },
    })).toBe('a longest-path analysis with group "Path A" selected; the AI bookmark "Q3 impact check" (what its run found about each object, the pruning decisions, and the open questions are stored)');
    expect(describeScreen({ screenState: { bookmark: { id: 'bm-2', name: 'Mine', source: 'user' } } })).toBe('the bookmark "Mine"');
  });
});
