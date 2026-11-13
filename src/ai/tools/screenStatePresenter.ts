/** Projection of the user's current screen into the `lineage_get_screen_state` payload. */
import {
  SCREEN_STATE_MAX_IDS,
  TRACE_ALL_LEVELS,
  type RenderStateSnapshot,
  type ScreenStateExtras,
  type UiStateSnapshot,
} from '../../engine/shared/bridgeContract';
import type {
  EngineInitSnapshot,
  EngineInternalsSnapshot,
} from '../sm/smTypes';
import {
  hashDdl,
  UNKNOWN_DDL_HASH,
  type StoredAiRun,
  type StoredRunReader,
} from '../session/runStore';
import { REJECTION_CODES } from '../support/rejectionCodes';
import {
  checkScopeBudget,
  estimateTokens,
  type TurnTokenBudget,
} from '../support/tokenBudget';
import {
  at,
  makeRejection,
  type ToolRejection,
} from '../support/toolErrorEnvelope';
import { schemaKey } from '../../utils/sql';

/** Inputs the presenter reads; the two buffers are the bridge-parsed snapshots. */
interface ScreenStateInput {
  /** Latest `filter-changed` ui-state buffer. */
  readonly uiState: UiStateSnapshot | null;
  readonly renderState: RenderStateSnapshot | null;
  readonly graphMode: 'full' | 'overview';
  /** Node count after all active filters. */
  readonly filteredCount: number;
  /** Node count of the loaded model. */
  readonly totalNodes: number;
  /** Resolver for the AI run behind an applied AI-authored bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** Resolver for an object's current DDL text; drives the staleness comparison. */
  readonly getDdl?: (
    id: string,
    nodeIdEncodingVersion?: 2,
  ) => string | undefined;
  /** Zero-based offset of the id-list page to serve; `0` (default) is the first page. */
  readonly offset?: number;
}

interface RunRecallInput {
  /** Latest `filter-changed` ui-state buffer, read for the applied bookmark. */
  readonly uiState: UiStateSnapshot | null;
  /** Resolver for the AI run behind an applied AI-authored bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** The session's completed run, recalled when no AI bookmark is applied. */
  readonly liveRun?: StoredAiRun;
  /** The calling turn's budget, which the recall payload is measured against. */
  readonly budget: TurnTokenBudget;
  /** Canonical object ids to recall; when sent with a filter, the ids are recalled. */
  readonly ids?: readonly string[];
  /** One class of the stored run to list; read only when no ids are sent. */
  readonly filter?: 'pruned' | 'open_leads' | 'stale';
  /** Resolver for an object's current DDL text. */
  readonly getDdl?: (
    id: string,
    nodeIdEncodingVersion?: 2,
  ) => string | undefined;
  /** Predicate telling whether an id still exists in the loaded model. */
  readonly isInModel?: (id: string, nodeIdEncodingVersion?: 2) => boolean;
  /** Whether the session holds an exploration proposal awaiting approval or refinement. */
  readonly hasPendingProposal?: boolean;
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

/** Emits one page of an id list as `<key>`. */
function spreadPaged(
  page: ListPage,
  key: string,
  ids: readonly string[],
): Record<string, unknown> {
  return { [key]: pageOf(page, ids) };
}

/** Renders a rendered-trace depth, decoding the unbounded sentinel the trace controls encode. */
function traceLevel(level: number | undefined): number | 'all' | null {
  if (level === undefined) return null;
  return level === TRACE_ALL_LEVELS ? 'all' : level;
}

/** Reports a stored run's depth per side as the run bound it. */
function presentDepth(
  init: EngineInitSnapshot | null,
  internals: EngineInternalsSnapshot,
): { upstream: number | 'all' | null; downstream: number | 'all' | null } {
  const sideValue = (
    side: 'upstream' | 'downstream',
  ): number | 'all' | null => {
    if (!init) return null;
    const { levels } = init.depthIntent[side];
    return typeof levels === 'number' && internals.depthLimits?.[side] === null
      ? null
      : levels;
  };
  let upstream = sideValue('upstream');
  let downstream = sideValue('downstream');
  if (init?.direction === 'upstream') downstream = 0;
  if (init?.direction === 'downstream') upstream = 0;
  return { upstream, downstream };
}

function staleIds(
  run: StoredAiRun,
  getDdl: ScreenStateInput['getDdl'],
): string[] {
  return Object.entries(run.ddlHashes)
    .filter(
      ([id, stored]) =>
        stored !== UNKNOWN_DDL_HASH &&
        hashDdl(getDdl?.(id, run.nodeIdEncodingVersion)) !== stored,
    )
    .map(([id]) => id);
}

function presentAiRun(
  page: ListPage,
  run: StoredAiRun | undefined,
  getDdl: ((id: string) => string | undefined) | undefined,
): Record<string, unknown> | null {
  if (!run) return null;
  const { snapshot } = run;
  const internals = snapshot.engineInternals;
  const init = internals.initSnapshot;
  return {
    run_id: run.runId,
    question: init?.question ?? null,
    origin: init?.origin ?? run.origin,
    depth: presentDepth(init, internals),
    scope: snapshot.scopeNodeIds.length,
    ...presentAnalyzedSet(run, page),
    pruned: snapshot.nodeStates.filter((state) => state.action === 'prune')
      .length,
    stale_objects: staleIds(run, getDdl).length,
    open_questions: recallOpenLeads(run).length,
  };
}

function presentTrace(
  page: ListPage,
  uiTrace: UiStateSnapshot['trace'] | undefined,
  scope: RenderStateSnapshot['traceScope'],
): Record<string, unknown> | null {
  const mode = scope?.mode ?? uiTrace?.mode;
  if (!mode || mode === 'none') return null;
  const traced = scope?.tracedNodeIds ?? [];
  return {
    origin: scope?.origin ?? uiTrace?.selectedNodeId ?? null,
    upstream: traceLevel(uiTrace?.upstreamLevels),
    downstream: traceLevel(uiTrace?.downstreamLevels),
    mode,
    nodes: traced.length,
    ...spreadPaged(page, 'added_by_user', scope?.manualAddedNodeIds ?? []),
    ...spreadPaged(page, 'pruned_by_user', scope?.manualPrunedNodeIds ?? []),
  };
}

function presentAnalysis(
  page: ListPage,
  analytics: ScreenStateExtras['analytics'],
): Record<string, unknown> | null {
  if (!analytics?.type) return null;
  const active = analytics.groups.find(
    (group) => group.id === analytics.activeGroupId,
  );
  const rows = analytics.groups.map((group) => ({
    label: group.label,
    nodes: group.nodeIds.length,
  }));
  return {
    type: analytics.type,
    active_group: active?.label ?? null,
    ...spreadPaged(page, 'active_group_node_ids', active?.nodeIds ?? []),
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
  if (!bookmark) return null;
  const run =
    bookmark.source === 'ai' ? getStoredRun?.(bookmark.id) : undefined;
  return {
    name: bookmark.name,
    source: bookmark.source,
    nodes: bookmark.allowlistNodeIds.length,
    ...spreadPaged(page, 'node_ids', bookmark.allowlistNodeIds),
    ai_run: presentAiRun(page, run, getDdl),
  };
}

/** Renders what the user currently sees: trace, graph analysis, bookmark and view level. */
export function presentScreenState(input: ScreenStateInput): {
  screen: Record<string, unknown>;
  _token_estimate: { chars: number; estimated_tokens: number };
} {
  const { uiState, renderState } = input;
  const extras = uiState?.screenState;
  const page: ListPage = { offset: input.offset ?? 0, more: false };
  const screen = {
    trace: presentTrace(page, uiState?.trace, renderState?.traceScope),
    analysis: presentAnalysis(page, extras?.analytics),
    bookmark: presentBookmark(
      page,
      extras?.bookmark,
      input.getStoredRun,
      input.getDdl,
    ),
    view: {
      level: input.graphMode === 'overview' ? 'overview' : 'object',
      visible_nodes: input.filteredCount,
      total_nodes: input.totalNodes,
    },
    ...(page.more
      ? { next_cursor: String(page.offset + SCREEN_STATE_MAX_IDS) }
      : {}),
  };
  const chars = JSON.stringify(screen).length;
  return {
    screen,
    _token_estimate: { chars, estimated_tokens: estimateTokens(chars) },
  };
}

function withEstimate(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const chars = JSON.stringify(payload).length;
  return {
    ...payload,
    _token_estimate: { chars, estimated_tokens: estimateTokens(chars) },
  };
}

/** The rejection with its own token estimate riding in `detail`, beside any facts already there. */
function rejectionWithEstimate(rejection: ToolRejection): ToolRejection {
  const chars = JSON.stringify(rejection).length;
  const detail =
    rejection.detail !== null && typeof rejection.detail === 'object'
      ? rejection.detail
      : {};
  return {
    ...rejection,
    detail: {
      ...detail,
      _token_estimate: { chars, estimated_tokens: estimateTokens(chars) },
    },
  };
}

function definedOnly(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  );
}

function resolveAppliedRun(input: {
  readonly uiState: UiStateSnapshot | null;
  readonly getStoredRun?: StoredRunReader;
  readonly liveRun?: StoredAiRun;
}): StoredAiRun | undefined {
  const entry = input.uiState?.screenState?.bookmark;
  const bookmarked =
    entry?.source === 'ai' ? input.getStoredRun?.(entry.id) : undefined;
  return bookmarked ?? input.liveRun;
}

/**
 * The objects the stored run analysed, as a count plus the id list — one page on the screen card,
 * whole on a scoped recall.
 */
function presentAnalyzedSet(
  run: StoredAiRun,
  page?: ListPage,
): Record<string, unknown> {
  const analyzed = run.snapshot.nodeStates
    .filter((state) => state.action === 'analyze')
    .map((state) => state.nodeId);
  return {
    analyzed: analyzed.length,
    analyzed_ids: page ? pageOf(page, analyzed) : analyzed,
  };
}

function recallIds(
  run: StoredAiRun,
  input: RunRecallInput,
): Record<string, unknown>[] {
  const { nodeStates, memory } = run.snapshot;
  const states = new Map(nodeStates.map((state) => [state.nodeId, state]));
  const slots = memory.detailSlots;
  const stale = new Set(staleIds(run, input.getDdl));
  return (input.ids ?? []).map((id) => {
    const state = states.get(id);
    const slot = slots[id];
    if (!state && !slot && run.ddlHashes[id] === undefined)
      return { id, decision: 'not_in_run' };
    const sections = slot?.sections.map((section) => section.text).join('\n\n');
    return definedOnly({
      id,
      decision: state?.action ?? 'not_in_run',
      reason: state?.reason,
      via: state?.viaNodeId,
      hop: state?.atHop,
      summary: slot?.summary,
      section: sections ? sections : undefined,
      stale: stale.has(id),
      in_current_model: input.isInModel
        ? input.isInModel(id, run.nodeIdEncodingVersion)
        : undefined,
    });
  });
}

function recallPruned(run: StoredAiRun): Record<string, unknown>[] {
  return run.snapshot.nodeStates
    .filter((state) => state.action === 'prune')
    .map((state) =>
      definedOnly({
        id: state.nodeId,
        reason: state.reason,
        via: state.viaNodeId,
        hop: state.atHop,
      }),
    );
}

/** Unresolved leads of the run, each marked with whether its object is already on the graph. */
function recallOpenLeads(run: StoredAiRun): Record<string, unknown>[] {
  const { snapshot } = run;
  const identifierKey = (id: string): string =>
    schemaKey(id, snapshot.identifierCaseSensitive === true);
  const onGraph = new Set(
    snapshot.nodeStates
      .filter((state) => state.action !== 'prune')
      .map((state) => identifierKey(state.nodeId)),
  );
  return snapshot.engineInternals.pendingLeads
    .filter((lead) => lead.status === 'pending')
    .map((lead) =>
      definedOnly({
        id: lead.nodeId,
        on_graph: onGraph.has(identifierKey(lead.nodeId)),
        from: lead.fromNodeId,
        reason: lead.reason,
        value: lead.valueToUser,
      }),
    );
}

function recallStale(
  run: StoredAiRun,
  getDdl: ((id: string) => string | undefined) | undefined,
): Record<string, unknown>[] {
  return staleIds(run, getDdl).map((id) => ({
    id,
    stored_hash_known: run.ddlHashes[id] !== UNKNOWN_DDL_HASH,
  }));
}

/**
 * Object ids a stored-run recall admits, with the case policy saved on that run. Dispatch binds
 * spellings before the recall reads them.
 */
export function recallObjectIdCatalog(input: {
  readonly uiState: UiStateSnapshot | null;
  readonly getStoredRun?: StoredRunReader;
  readonly liveRun?: StoredAiRun;
}):
  | {
      readonly ids: Map<string, unknown>;
      readonly identifierCaseSensitive: boolean;
      readonly cacheKey: object;
    }
  | undefined {
  const run = resolveAppliedRun(input);
  if (!run) return undefined;
  const { snapshot } = run;
  const ids = new Map<string, unknown>(
    [
      ...snapshot.nodeStates.map((state) => state.nodeId),
      ...Object.keys(snapshot.memory.detailSlots),
      ...Object.keys(run.ddlHashes),
    ].map((id) => [id, true]),
  );
  return {
    ids,
    identifierCaseSensitive: snapshot.identifierCaseSensitive === true,
    cacheKey: snapshot,
  };
}

/** Answers one recall query against the run stored with the applied bookmark. */
export function presentRunRecall(
  input: RunRecallInput,
): Record<string, unknown> | ToolRejection {
  const run = resolveAppliedRun(input);
  if (!run) {
    return rejectionWithEstimate(
      makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: input.hasPendingProposal
          ? 'No AI run stored; the proposal awaits approval.'
          : 'No AI run stored for the applied view.',
        errors: at(
          input.hasPendingProposal ? 'awaiting_approval' : 'no_run_memory',
        ),
      }),
    );
  }
  const head = {
    run_id: run.runId,
    saved_at: run.savedAt,
    ...presentAnalyzedSet(run),
  };
  const payload: Record<string, unknown> = input.ids
    ? { ...head, objects: recallIds(run, input) }
    : input.filter === 'pruned'
      ? { ...head, pruned: recallPruned(run) }
      : input.filter === 'open_leads'
        ? { ...head, open_leads: recallOpenLeads(run) }
        : { ...head, stale: recallStale(run, input.getDdl) };
  const chars = JSON.stringify(payload).length;
  const admission = checkScopeBudget(input.budget, 0, chars);
  if (admission) {
    return rejectionWithEstimate({
      ...admission,
      errors: at('result_too_large', [input.ids?.length ? 'ids' : 'filter']),
    });
  }
  return withEstimate(payload);
}

/** Summarises what is on screen in one prompt-context phrase. */
export function describeScreen(uiState: UiStateSnapshot | null): string | null {
  const parts: string[] = [];
  const trace = uiState?.trace;
  if (trace && trace.mode !== 'none') {
    const origin = trace.selectedNodeId;
    parts.push(
      `a trace${origin ? ` from ${origin}` : ''} (${traceLevel(trace.upstreamLevels)} up, ${traceLevel(trace.downstreamLevels)} down)`,
    );
  }
  const analytics = uiState?.screenState?.analytics;
  if (analytics?.type) {
    const label = analytics.groups.find(
      (group) => group.id === analytics.activeGroupId,
    )?.label;
    parts.push(
      `a ${analytics.type} analysis${label ? ` with group "${label}" selected` : ''}`,
    );
  }
  const bookmark = uiState?.screenState?.bookmark;
  if (bookmark?.name) {
    parts.push(
      bookmark.source === 'ai'
        ? `the AI bookmark "${bookmark.name}" (what its run found about each object, the pruning decisions, and the open questions are stored)`
        : `the bookmark "${bookmark.name}"`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
