/**
 * Projection of the user's current screen into the `lineage_get_screen_state` payload.
 *
 * @remarks
 * Pure and VS Code-free. The bridge validates `uiState` and `render-state` against their
 * `bridgeContract` schemas, but the session buffers can also be seeded by non-bridge writers, so
 * every read here stays defensive: a missing, malformed, or foreign-shaped field omits its section
 * instead of throwing. The payload answers "what is on screen", never "what is in the
 * model" — the catalog, statistics, and filters stay with `lineage_get_context`.
 */
import {
  SCREEN_STATE_MAX_IDS,
  TRACE_ALL_LEVELS,
  type RenderStateSnapshot,
  type ScreenStateExtras,
} from '../../engine/shared/bridgeContract';
import { hashDdl, UNKNOWN_DDL_HASH, type StoredAiRun, type StoredRunReader } from '../session/runStore';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { checkScopeBudget, estimateTokens, type TurnTokenBudget } from '../support/tokenBudget';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { schemaKey } from '../../utils/sql';

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
  /** Zero-based offset of the id-list page to serve; `0` (default) is the first page. */
  readonly offset?: number;
}

/** Inputs of one stored-run recall query. */
export interface RunRecallInput {
  /** Latest `filter-changed` ui-state buffer, read for the applied bookmark. */
  readonly uiState: unknown;
  /** Resolver for the AI run behind an applied AI-authored bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** The session's completed run, recalled when no AI bookmark is applied. */
  readonly liveRun?: StoredAiRun;
  /** The calling turn's budget, which the recall payload is measured against. */
  readonly budget: TurnTokenBudget;
  /** Canonical object ids to recall; mutually exclusive with {@link RunRecallInput.filter}. */
  readonly ids?: readonly string[];
  /** One class of the stored run to list; mutually exclusive with {@link RunRecallInput.ids}. */
  readonly filter?: 'pruned' | 'open_leads' | 'stale';
  /** Resolver for an object's current DDL text. */
  readonly getDdl?: (id: string) => string | undefined;
  /** Predicate telling whether an id still exists in the loaded model. */
  readonly isInModel?: (id: string) => boolean;
  /** Debug sink for identifier normalization under the selected historical run's policy. */
  readonly onIdNormalized?: (raw: string, canonical: string) => void;
  /** Whether the session holds an exploration proposal awaiting approval or refinement. */
  readonly hasPendingProposal?: boolean;
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

/** Reads the ui-state buffer down to its `screenState` extras section, both defensively typed. */
function screenStateParts(uiState: unknown): { ui: Record<string, unknown> | null; extras: Record<string, unknown> | null } {
  const ui = asRecord(uiState);
  return { ui, extras: asRecord(ui?.screenState) };
}

/** One page of every screen-fact list: the shared offset and whether any list continues past it. */
interface ListPage {
  readonly offset: number;
  more: boolean;
}

/** Slices one list to the page, recording on `page` when items remain beyond it. */
function pageOf<T>(page: ListPage, items: readonly T[]): T[] {
  const end = page.offset + SCREEN_STATE_MAX_IDS;
  if (items.length > end) page.more = true;
  return items.slice(page.offset, end);
}

/**
 * Emits one page of an id list as `<key>`.
 *
 * @param page - The shared page; marked as continuing when this list has more ids.
 * @param key - The payload field name carrying the ids.
 * @param ids - The full id list.
 * @returns A spreadable fragment holding the page's ids.
 */
function spreadPaged(page: ListPage, key: string, ids: readonly string[]): Record<string, unknown> {
  return { [key]: pageOf(page, ids) };
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

/**
 * Reports a stored run's depth per side as the run bound it.
 *
 * @remarks
 * `depthIntent` is the per-side `{levels, exactness}` record (`explorationDepthContract.ts`). A
 * finite `levels` is reported only when the persisted `depthLimits` ceiling for that side actually
 * bound the run; a `null` ceiling means the count never became a border (an approximate side, or a
 * legacy checkpoint's seeded default read back as exact), so it reads back as the unstated `null`.
 */
function presentDepth(
  init: Record<string, unknown> | null,
  internals: Record<string, unknown> | null,
): { upstream: number | 'all' | null; downstream: number | 'all' | null } {
  const intent = asRecord(init?.depthIntent);
  const limits = asRecord(internals?.depthLimits);
  const sideValue = (side: 'upstream' | 'downstream'): number | 'all' | null => {
    const sideIntent = asRecord(intent?.[side]);
    if (!sideIntent) return null;
    const level = asLevel(sideIntent.levels);
    return typeof level === 'number' && limits !== null && limits[side] === null ? null : level;
  };
  let upstream = sideValue('upstream');
  let downstream = sideValue('downstream');
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
  page: ListPage,
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
    depth: presentDepth(init, internals),
    scope: asStringList(snapshot.scopeNodeIds).length,
    ...presentAnalyzedSet(run, page),
    pruned: countAction('prune'),
    stale_objects: staleIds(run, getDdl).length,
    open_questions: recallOpenLeads(run).length,
  };
}

function presentTrace(page: ListPage, uiTrace: Record<string, unknown> | null, scope: RenderStateSnapshot['traceScope']): Record<string, unknown> | null {
  const mode = asString(scope?.mode) ?? asString(uiTrace?.mode);
  if (!mode || mode === 'none') return null;
  const traced = asStringList(scope?.tracedNodeIds);
  return {
    origin: asString(scope?.origin) ?? asString(uiTrace?.selectedNodeId),
    upstream: asTraceLevel(uiTrace?.upstreamLevels),
    downstream: asTraceLevel(uiTrace?.downstreamLevels),
    mode,
    nodes: traced.length,
    ...spreadPaged(page, 'added_by_user', asStringList(scope?.manualAddedNodeIds)),
    ...spreadPaged(page, 'pruned_by_user', asStringList(scope?.manualPrunedNodeIds)),
  };
}

function presentAnalysis(page: ListPage, analytics: ScreenStateExtras['analytics']): Record<string, unknown> | null {
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
    ...spreadPaged(page, 'active_group_node_ids', activeIds),
    group_count: rows.length,
    groups: pageOf(page, rows),
  };
}

function presentBookmark(
  page: ListPage,
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
  const nodeIds = asStringList(entry.allowlistNodeIds);
  return {
    name,
    source,
    nodes: nodeIds.length,
    ...spreadPaged(page, 'node_ids', nodeIds),
    ai_run: presentAiRun(page, run, getDdl),
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
  const { ui, extras } = screenStateParts(input.uiState);
  const renderState = asRecord(input.renderState);
  const page: ListPage = { offset: input.offset ?? 0, more: false };
  const screen = {
    trace: presentTrace(
      page,
      asRecord(ui?.trace),
      asRecord(renderState?.traceScope) as RenderStateSnapshot['traceScope'],
    ),
    analysis: presentAnalysis(page, asRecord(extras?.analytics) as ScreenStateExtras['analytics']),
    bookmark: presentBookmark(
      page,
      asRecord(extras?.bookmark) as ScreenStateExtras['bookmark'],
      input.getStoredRun,
      input.getDdl,
    ),
    view: {
      level: input.graphMode === 'overview' ? 'overview' : 'object',
      visible_nodes: asCount(input.filteredCount),
      total_nodes: asCount(input.totalNodes),
    },
    ...(page.more ? { next_cursor: String(page.offset + SCREEN_STATE_MAX_IDS) } : {}),
  };
  const chars = JSON.stringify(screen).length;
  return { screen, _token_estimate: { chars, estimated_tokens: estimateTokens(chars) } };
}

function withEstimate(payload: Record<string, unknown>): Record<string, unknown> {
  const chars = JSON.stringify(payload).length;
  return { ...payload, _token_estimate: { chars, estimated_tokens: estimateTokens(chars) } };
}

/** The rejection with its own token estimate riding in `detail`, beside any facts already there. */
function rejectionWithEstimate(rejection: ToolRejection): ToolRejection {
  const chars = JSON.stringify(rejection).length;
  const detail = rejection.detail !== null && typeof rejection.detail === 'object' ? rejection.detail : {};
  return { ...rejection, detail: { ...detail, _token_estimate: { chars, estimated_tokens: estimateTokens(chars) } } };
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
  const entry = asRecord(screenStateParts(input.uiState).extras?.bookmark);
  const id = asString(entry?.id);
  const bookmarked = entry && id !== null && asString(entry.source) === 'ai' ? input.getStoredRun?.(id) : undefined;
  const run = bookmarked ?? input.liveRun;
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

/**
 * The objects the stored run analysed, as a count plus the id list — one page on the screen card, whole on a scoped recall.
 *
 * @remarks
 * Carried by the screen card and by every scoped recall alike, so a read narrowed to one class or
 * to a few ids still states the run's full analysed set instead of reading as the whole run.
 */
function presentAnalyzedSet(run: StoredAiRun, page?: ListPage): Record<string, unknown> {
  const analyzed = nodeStatesOf(run)
    .filter(state => state.action === 'analyze')
    .map(state => asString(state.nodeId) as string);
  return { analyzed: analyzed.length, analyzed_ids: page ? pageOf(page, analyzed) : analyzed };
}

function recallIds(run: StoredAiRun, input: RunRecallInput): Record<string, unknown>[] {
  const states = new Map(nodeStatesOf(run).map(state => [asString(state.nodeId) as string, state]));
  const snapshot = asRecord(run.snapshot);
  const slots = asRecord(asRecord(snapshot?.memory)?.detailSlots) ?? {};
  const hashes = storedHashes(run);
  const historicalIds = new Map([...states.keys(), ...Object.keys(slots), ...Object.keys(hashes)].map(id => [id, undefined]));
  const stale = new Set(staleIds(run, input.getDdl));
  return (input.ids ?? []).map(raw => {
    const id = resolveModelNodeId(raw, historicalIds, snapshot?.identifierCaseSensitive === true) ?? raw;
    if (id !== raw) input.onIdNormalized?.(raw, id);
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
      in_current_model: input.isInModel ? input.isInModel(id) : undefined,
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

/**
 * Unresolved leads of the run, each marked with whether its object is already on the graph.
 *
 * @remarks
 * A lead on an object the graph already shows is a deeper look, not an addition; `on_graph` lets
 * the answer tell the two apart. Resolved, scheduled and dismissed leads are history, not open.
 */
function recallOpenLeads(run: StoredAiRun): Record<string, unknown>[] {
  const snapshot = asRecord(run.snapshot);
  const internals = asRecord(snapshot?.engineInternals);
  const leads = Array.isArray(internals?.pendingLeads) ? internals.pendingLeads : [];
  const identifierKey = (id: string): string => schemaKey(id, snapshot?.identifierCaseSensitive === true);
  const idSet = (value: unknown): Set<string> =>
    new Set((Array.isArray(value) ? value : []).flatMap(item => typeof item === 'string' ? [identifierKey(item)] : []));
  const scope = idSet(snapshot?.scopeNodeIds);
  const offGraph = new Set([...idSet(snapshot?.removedSet), ...idSet(snapshot?.renderDroppedNodeIds)]);
  return leads.flatMap(raw => {
    const lead = asRecord(raw);
    const id = asString(lead?.nodeId);
    const status = optionalString(lead?.status);
    if (id === null || (status !== undefined && status !== 'pending')) return [];
    const key = identifierKey(id);
    return [definedOnly({
      id,
      on_graph: scope.has(key) && !offGraph.has(key),
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
 * nothing is truncated. An applied AI bookmark's run wins; without one the session's completed run
 * answers, and only when neither exists does the call answer `no_run_memory`.
 *
 * @param input - The resolved query and the session's read-only resolvers.
 * @returns The recall payload, or a rejection envelope, with its token estimate.
 */
export function presentRunRecall(input: RunRecallInput): Record<string, unknown> | ToolRejection {
  const run = resolveAppliedRun(input);
  if (!run) {
    return rejectionWithEstimate(makeRejection({
      code: REJECTION_CODES.noRunMemory,
      hint: input.hasPendingProposal
        ? 'No AI run is stored yet — the held proposal is still awaiting approval or refinement. Reference the proposal already in this turn, or wait for it to be approved before recalling a run.'
        : 'No AI run is stored for the applied view. Apply an AI bookmark saved after a run, or start a new exploration.',
    }));
  }
  const head = { run_id: run.runId, saved_at: run.savedAt, ...presentAnalyzedSet(run) };
  const payload: Record<string, unknown> = input.ids
    ? { ...head, objects: recallIds(run, input) }
    : input.filter === 'pruned' ? { ...head, pruned: recallPruned(run) }
    : input.filter === 'open_leads' ? { ...head, open_leads: recallOpenLeads(run) }
    : { ...head, stale: recallStale(run, input.getDdl) };
  const chars = JSON.stringify(payload).length;
  const admission = checkScopeBudget(input.budget, 0, chars);
  if (admission) {
    return rejectionWithEstimate({ ...admission, hint: overBudgetHint(input, chars, admission.detail.limits.token_budget) });
  }
  return withEstimate(payload);
}

/**
 * Summarises what is on screen in one prompt-context phrase.
 *
 * @remarks
 * Grounds the stage prompts so a bare "explain this" can reach `lineage_get_screen_state`. The
 * phrase names each surface present with its identity — the trace origin and levels, the analysis
 * type and selected group label, the applied bookmark's name — never its contents (objects,
 * findings), which stay behind the tool call.
 *
 * @param uiState - Latest `filter-changed` ui-state buffer, read defensively.
 * @returns The raw phrase — the prompt slot builder escapes it — or `null` when no trace, analysis, or bookmark is applied.
 */
export function describeScreen(uiState: unknown): string | null {
  const { ui, extras } = screenStateParts(uiState);
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
