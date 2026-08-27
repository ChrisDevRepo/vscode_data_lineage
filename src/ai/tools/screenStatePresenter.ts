/**
 * Projection of the user's current screen into the `lineage_get_screen_state` payload.
 *
 * @remarks
 * Pure and VS Code-free. The webview posts `uiState` and `render-state` as opaque passthrough
 * buffers, so every read here is defensive: a missing, malformed, or foreign-shaped field omits its
 * section instead of throwing. The payload answers "what is on screen", never "what is in the
 * model" — the catalog, statistics, and filters stay with `lineage_get_context`.
 */
import type { RenderStateSnapshot, ScreenStateExtras } from '../../bridge/debugDumpScreenState';
import { TRACE_ALL_LEVELS } from '../../engine/shared/bridgeContract';
import { hashDdl, UNKNOWN_DDL_HASH, type StoredAiRun, type StoredRunReader } from '../session/runStore';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { checkScopeBudget, estimateTokens } from '../support/tokenBudget';

/** Maximum node ids listed per screen-fact list before the remainder is reported as a count. */
const ID_CAP = 20;

/** Inputs the presenter reads; the two passthrough buffers stay `unknown` by contract. */
export interface ScreenStateInput {
  /** Latest `filter-changed` ui-state buffer. */
  readonly uiState: unknown;
  /** Latest `render-state` buffer. */
  readonly renderState: unknown;
  /** Current graph rendering mode. */
  readonly graphMode: 'full' | 'overview';
  /** Node count after all active filters. */
  readonly filteredCount: number;
  /** Node count of the loaded model. */
  readonly totalNodes: number;
  /** Resolver for the AI run behind an applied AI-authored bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** Resolver for an object's current DDL text; drives the staleness comparison. */
  readonly getDdl?: (id: string) => string | undefined;
}

/** Inputs of one stored-run recall query. */
export interface RunRecallInput {
  /** Latest `filter-changed` ui-state buffer, read for the applied bookmark. */
  readonly uiState: unknown;
  /** Resolver for the AI run behind an applied AI-authored bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** Canonical object ids to recall; mutually exclusive with {@link RunRecallInput.filter}. */
  readonly ids?: readonly string[];
  /** One class of the stored run to list; mutually exclusive with {@link RunRecallInput.ids}. */
  readonly filter?: 'pruned' | 'open_leads' | 'stale';
  /** Resolver for an object's current DDL text. */
  readonly getDdl?: (id: string) => string | undefined;
  /** Predicate telling whether an id still exists in the loaded model. */
  readonly isInModel?: (id: string) => boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function capIds(ids: readonly string[]): string[] {
  if (ids.length <= ID_CAP) return [...ids];
  return [...ids.slice(0, ID_CAP), `…and ${ids.length - ID_CAP} more`];
}

function asLevel(value: unknown): number | 'all' | null {
  if (value === 'all') return 'all';
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Renders a rendered-trace depth, decoding the unbounded sentinel the trace controls encode.
 *
 * @remarks
 * `TRACE_ALL_LEVELS` is finite, so `asCount` would pass it through as a literal depth and report
 * nine quadrillion levels where the banner shows "All".
 */
function asTraceLevel(value: unknown): number | 'all' {
  const level = asCount(value);
  return level === TRACE_ALL_LEVELS ? 'all' : level;
}

function presentDepth(init: Record<string, unknown> | null): { upstream: number | 'all' | null; downstream: number | 'all' | null } {
  const intent = asRecord(init?.depthIntent);
  let upstream: number | 'all' | null = null;
  let downstream: number | 'all' | null = null;
  if (intent?.kind === 'explicit') {
    upstream = asLevel(intent.levels);
    downstream = upstream;
  } else if (intent?.kind === 'asymmetric') {
    upstream = asLevel(intent.upstream);
    downstream = asLevel(intent.downstream);
  } else if (intent?.kind === 'full_frontier') {
    upstream = 'all';
    downstream = 'all';
  }
  const direction = asString(init?.direction);
  if (direction === 'upstream') downstream = 0;
  if (direction === 'downstream') upstream = 0;
  return { upstream, downstream };
}

function storedHashes(run: StoredAiRun): Record<string, string> {
  const hashes = asRecord(run.ddlHashes);
  return hashes ? (hashes as Record<string, string>) : {};
}

function staleIds(run: StoredAiRun, getDdl: ((id: string) => string | undefined) | undefined): string[] {
  const hashes = storedHashes(run);
  return Object.keys(hashes).filter(id => {
    const stored = hashes[id];
    if (typeof stored !== 'string' || stored === UNKNOWN_DDL_HASH) return false;
    return hashDdl(getDdl?.(id)) !== stored;
  });
}

function presentAiRun(
  run: StoredAiRun | undefined,
  getDdl: ((id: string) => string | undefined) | undefined,
): Record<string, unknown> | null {
  const snapshot = asRecord(run?.snapshot);
  if (!run || !snapshot) return null;
  const internals = asRecord(snapshot.engineInternals);
  const init = asRecord(internals?.initSnapshot);
  const nodeStates = Array.isArray(snapshot.nodeStates) ? snapshot.nodeStates : [];
  const countAction = (action: string) =>
    nodeStates.filter(entry => asRecord(entry)?.action === action).length;
  return {
    run_id: run.runId,
    question: asString(init?.question),
    origin: asString(init?.origin) ?? run.origin,
    depth: presentDepth(init),
    scope: asStringList(snapshot.scopeNodeIds).length,
    analyzed: countAction('analyze'),
    pruned: countAction('prune'),
    stale_objects: staleIds(run, getDdl).length,
    open_questions: Array.isArray(internals?.pendingLeads) ? internals.pendingLeads.length : 0,
  };
}

function presentTrace(uiTrace: Record<string, unknown> | null, scope: RenderStateSnapshot['traceScope']): Record<string, unknown> | null {
  const mode = asString(scope?.mode) ?? asString(uiTrace?.mode);
  if (!mode || mode === 'none') return null;
  const traced = asStringList(scope?.tracedNodeIds);
  return {
    origin: asString(scope?.origin) ?? asString(uiTrace?.selectedNodeId),
    upstream: asTraceLevel(uiTrace?.upstreamLevels),
    downstream: asTraceLevel(uiTrace?.downstreamLevels),
    mode,
    nodes: traced.length,
    added_by_user: capIds(asStringList(scope?.manualAddedNodeIds)),
    pruned_by_user: capIds(asStringList(scope?.manualPrunedNodeIds)),
  };
}

function presentAnalysis(analytics: ScreenStateExtras['analytics']): Record<string, unknown> | null {
  const type = asString(analytics?.type);
  if (!type) return null;
  const groups = Array.isArray(analytics?.groups) ? analytics.groups : [];
  const activeId = asString(analytics?.activeGroupId);
  const active = groups.find(group => asRecord(group)?.id === activeId);
  const activeIds = asStringList(asRecord(active)?.nodeIds);
  const rows = groups.flatMap(group => {
    const entry = asRecord(group);
    const label = asString(entry?.label);
    return label === null ? [] : [{ label, nodes: asStringList(entry?.nodeIds).length }];
  });
  return {
    type,
    active_group: asString(asRecord(active)?.label),
    active_group_node_ids: capIds(activeIds),
    // Islands can yield hundreds of groups. `group_count` keeps the cap visible rather than
    // presenting a truncated list as the whole set.
    group_count: rows.length,
    groups: rows.slice(0, ID_CAP),
  };
}

function presentBookmark(
  bookmark: ScreenStateExtras['bookmark'],
  getStoredRun: StoredRunReader | undefined,
  getDdl: ((id: string) => string | undefined) | undefined,
): Record<string, unknown> | null {
  const entry = asRecord(bookmark);
  const name = asString(entry?.name);
  if (!entry || name === null) return null;
  const source = asString(entry.source);
  const id = asString(entry.id);
  const run = source === 'ai' && id !== null ? getStoredRun?.(id) : undefined;
  return {
    name,
    source,
    nodes: asStringList(entry.allowlistNodeIds).length,
    ai_run: presentAiRun(run, getDdl),
  };
}

/**
 * Renders what the user currently sees: the active trace, graph analysis, applied bookmark, and
 * view level.
 *
 * @param input - Session-owned screen buffers and counts.
 * @returns The model-facing screen payload with its token estimate; absent sections render `null`.
 */
export function presentScreenState(input: ScreenStateInput): {
  screen: Record<string, unknown>;
  _token_estimate: { chars: number; estimated_tokens: number };
} {
  const ui = asRecord(input.uiState);
  const extras = asRecord(ui?.screenState);
  const renderState = asRecord(input.renderState);
  const screen = {
    trace: presentTrace(
      asRecord(ui?.trace),
      asRecord(renderState?.traceScope) as RenderStateSnapshot['traceScope'],
    ),
    analysis: presentAnalysis(asRecord(extras?.analytics) as ScreenStateExtras['analytics']),
    bookmark: presentBookmark(
      asRecord(extras?.bookmark) as ScreenStateExtras['bookmark'],
      input.getStoredRun,
      input.getDdl,
    ),
    view: {
      level: input.graphMode === 'overview' ? 'overview' : 'object',
      visible_nodes: asCount(input.filteredCount),
      total_nodes: asCount(input.totalNodes),
    },
  };
  const chars = JSON.stringify(screen).length;
  return { screen, _token_estimate: { chars, estimated_tokens: estimateTokens(chars) } };
}

function withEstimate(payload: Record<string, unknown>): Record<string, unknown> {
  const chars = JSON.stringify(payload).length;
  return { ...payload, _token_estimate: { chars, estimated_tokens: estimateTokens(chars) } };
}

function definedOnly(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

function optionalString(value: unknown): string | undefined {
  return asString(value) ?? undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveAppliedRun(input: RunRecallInput): StoredAiRun | undefined {
  const entry = asRecord(asRecord(asRecord(input.uiState)?.screenState)?.bookmark);
  const id = asString(entry?.id);
  if (!entry || id === null || asString(entry.source) !== 'ai') return undefined;
  const run = input.getStoredRun?.(id);
  return run && asRecord(run.snapshot) ? run : undefined;
}

function nodeStatesOf(run: StoredAiRun): Record<string, unknown>[] {
  const snapshot = asRecord(run.snapshot);
  const states = Array.isArray(snapshot?.nodeStates) ? snapshot.nodeStates : [];
  return states.flatMap(raw => {
    const state = asRecord(raw);
    return state && asString(state.nodeId) !== null ? [state] : [];
  });
}

function recallIds(run: StoredAiRun, input: RunRecallInput): Record<string, unknown>[] {
  const states = new Map(nodeStatesOf(run).map(state => [asString(state.nodeId) as string, state]));
  const slots = asRecord(asRecord(asRecord(run.snapshot)?.memory)?.detailSlots) ?? {};
  const hashes = storedHashes(run);
  const stale = new Set(staleIds(run, input.getDdl));
  return (input.ids ?? []).map(id => {
    const state = states.get(id);
    const slot = asRecord(slots[id]);
    if (!state && !slot && hashes[id] === undefined) return { id, decision: 'not_in_run' };
    const sections = (Array.isArray(slot?.sections) ? slot.sections : [])
      .flatMap(raw => {
        const text = asString(asRecord(raw)?.text);
        return text === null ? [] : [text];
      })
      .join('\n\n');
    return definedOnly({
      id,
      decision: optionalString(state?.action) ?? 'not_in_run',
      reason: optionalString(state?.reason),
      via: optionalString(state?.viaNodeId),
      hop: optionalNumber(state?.atHop),
      summary: optionalString(slot?.summary),
      section: sections.length > 0 ? sections : undefined,
      stale: stale.has(id),
      in_current_model: input.isInModel?.(id) ?? false,
    });
  });
}

function recallPruned(run: StoredAiRun): Record<string, unknown>[] {
  return nodeStatesOf(run)
    .filter(state => state.action === 'prune')
    .map(state => definedOnly({
      id: asString(state.nodeId),
      reason: optionalString(state.reason),
      via: optionalString(state.viaNodeId),
      hop: optionalNumber(state.atHop),
    }));
}

function recallOpenLeads(run: StoredAiRun): Record<string, unknown>[] {
  const internals = asRecord(asRecord(run.snapshot)?.engineInternals);
  const leads = Array.isArray(internals?.pendingLeads) ? internals.pendingLeads : [];
  return leads.flatMap(raw => {
    const lead = asRecord(raw);
    const id = asString(lead?.nodeId);
    return id === null ? [] : [definedOnly({
      id,
      from: optionalString(lead?.fromNodeId),
      reason: optionalString(lead?.reason),
      value: optionalString(lead?.valueToUser),
    })];
  });
}

function recallStale(run: StoredAiRun, getDdl: ((id: string) => string | undefined) | undefined): Record<string, unknown>[] {
  const hashes = storedHashes(run);
  return staleIds(run, getDdl).map(id => ({ id, stored_hash_known: hashes[id] !== UNKNOWN_DDL_HASH }));
}

function overBudgetHint(input: RunRecallInput, chars: number, tokenBudget: number): string {
  if (!input.ids?.length) {
    return 'That class is too large to return in one response. Ask about specific objects with ids instead.';
  }
  const fits = Math.max(1, Math.floor((input.ids.length * tokenBudget) / estimateTokens(chars)));
  return `Narrow ids to at most ${fits} or use a filter instead.`;
}

/**
 * Answers one recall query against the run stored with the applied bookmark.
 *
 * @remarks
 * Over-budget responses hard-reject with the discovery over-budget envelope and a narrowing hint;
 * nothing is truncated. An absent, non-AI, or unstored bookmark answers `no_run_memory`.
 *
 * @param input - The resolved query and the session's read-only resolvers.
 * @returns The recall payload, or a rejection envelope, with its token estimate.
 */
export function presentRunRecall(input: RunRecallInput): Record<string, unknown> {
  const run = resolveAppliedRun(input);
  if (!run) {
    return withEstimate({
      error: REJECTION_CODES.noRunMemory,
      hint: 'No AI run is stored for the applied view. Apply an AI bookmark saved after a run, or start a new exploration.',
    });
  }
  const head = { run_id: run.runId, saved_at: run.savedAt };
  const payload: Record<string, unknown> = input.ids
    ? { ...head, objects: recallIds(run, input) }
    : input.filter === 'pruned' ? { ...head, pruned: recallPruned(run) }
    : input.filter === 'open_leads' ? { ...head, open_leads: recallOpenLeads(run) }
    : { ...head, stale: recallStale(run, input.getDdl) };
  const chars = JSON.stringify(payload).length;
  const budget = checkScopeBudget(0, chars);
  if (!budget.ok) {
    return withEstimate({ ...budget, hint: overBudgetHint(input, chars, budget.limits.token_budget) });
  }
  return withEstimate(payload);
}

/**
 * Summarises what is on screen in one prompt-context phrase.
 *
 * @remarks
 * Grounds the stage prompts so a bare "explain this" can reach `lineage_get_screen_state`; the
 * phrase names the surfaces present, never their contents, which stay behind the tool call.
 *
 * @param uiState - Latest `filter-changed` ui-state buffer, unvalidated.
 * @returns The phrase, or `null` when no trace, analysis, or bookmark is applied.
 */
export function describeScreen(uiState: unknown): string | null {
  const ui = asRecord(uiState);
  const extras = asRecord(ui?.screenState);
  const parts: string[] = [];
  const trace = asRecord(ui?.trace);
  const mode = asString(trace?.mode);
  if (mode && mode !== 'none') {
    const origin = asString(trace?.selectedNodeId);
    parts.push(`a trace${origin ? ` from ${origin}` : ''} (${asTraceLevel(trace?.upstreamLevels)} up, ${asTraceLevel(trace?.downstreamLevels)} down)`);
  }
  const analytics = asRecord(extras?.analytics);
  const type = asString(analytics?.type);
  if (type) {
    const groups = Array.isArray(analytics?.groups) ? analytics.groups : [];
    const active = groups.map(asRecord).find(group => group?.id === asString(analytics?.activeGroupId));
    const label = asString(active?.label);
    parts.push(`a ${type} analysis${label ? ` with group "${label}" selected` : ''}`);
  }
  const bookmark = asRecord(extras?.bookmark);
  const name = asString(bookmark?.name);
  if (name) {
    parts.push(bookmark?.source === 'ai'
      ? `the AI bookmark "${name}" (what its run found about each object, the pruning decisions, and the open questions are stored)`
      : `the bookmark "${name}"`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
