/**
 * Canonical AI tool registry, handlers, and the surfaces for callers without a chat turn.
 *
 * @remarks
 * Acts as the Zod boundary between untrusted LM-supplied tool input and the engine + retrieval layer.
 * The native `@lineage` runtime dispatches through {@link buildAiToolRegistry}.
 * {@link createExternalToolSource} serves the `external` policy stage of the same catalog to other
 * VS Code agents ({@link registerAiTools}) and to the localhost MCP server.
 *
 * Read-only tools remain thin wrappers around provider-neutral functions in
 * [`tools.ts`](./tools.ts). Mutating exploration and presentation tools live in
 * per-tool handler modules under `handlers/`; this module owns their shared host
 * services, registry binding, turn-lease checks, and effect serialization.
 */
import * as vscode from 'vscode';
import type Graph from 'graphology';
import { NavigationEngine } from '../sm/smBase';
import { type AiSession } from '../session/session';
import { Logger, trunc, sanitizeForLog, LOG_TRUNC_JSON, LOG_TRUNC_REJECTION } from '../../utils/log';
import {
  getContext, searchObjects, getObjectDetail,
  runAnalysis, searchDdl, getScopeBundle,
  getNeighborColumns,
} from '../tools/tools';
import {
  parseToolInput,
  GetScopeBundleInputSchema,
  GetNeighborColumnsInputSchema,
  SearchObjectsInputSchema,
  GetObjectDetailInputSchema,
  DetectGraphPatternsInputSchema,
  SearchDdlInputSchema,
  GetContextInputSchema,
  GetScreenStateInputSchema,
} from '../tools/toolSchemas';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../engine/types';
import { readDeclaredNumericSetting } from '../../configCore';
import { type SerializedFilterState } from '../../engine/projectStore';
import { getAllowedLmToolNames, activeModeOf, EXTERNAL_TOOL_NAMES, type LmStage } from '../tools/toolPolicy';
import { ToolRegistry } from '../tools/registry';
import { TOOL_DEFS, EXTERNAL_TOOL_DEFS, type ToolContract, type ToolName } from '../tools/toolDefs';
import { getToolInvocationLabel } from '../tools/toolLabels';
import { readToolError, readToolErrorText, isConsentGateRejection, makeRejection, rejectionProse, NoProjectLoadedError, buildNoProjectLoadedError } from '../support/toolErrorEnvelope';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import { assertActiveTurnLease, type TurnLease } from '../session/turnLease';
import { DEFAULT_TURN_TOKEN_BUDGET, EXTERNAL_OVER_DISCOVERY_BUDGET_HINT, type TurnTokenBudget } from '../support/tokenBudget';
import { buildLiveRun, type StoredRunReader } from '../session/runStore';
import { presentRunRecall, presentScreenState } from './screenStatePresenter';
import { postToWebview } from '../../bridge/host';
import { resolveModelNodeId } from '../support/inputNormalization';
import { createSavedReferenceResolver } from '../../engine/shared/nodeIdResolution';
import { cursorOffset } from '../support/text';
import { getModelNodeMap, type AiViewPreviewMessage, type ToolCaller, type ToolServices } from './handlers/toolServices';
import type { PreviewDelivery } from '../support/chatAnswer';
import { executeStartExploration } from './handlers/startExploration';
import { executeSubmitFindings } from './handlers/submitFindings';
import { executePresentResult } from './handlers/presentResult';
import type { ModelPort } from '../model/modelPort';
import { tokenToAbortSignal } from '../providers/cancellation';
import { RegexSearchExecutionError } from '../support/isolatedRegexSearch';
import { REJECTION_CODES } from '../support/rejectionCodes';

/**
 * Retry-messaging group for a rejection code, shared by this module's `[Reject]` debug line and
 * `graph.ts`'s chat-facing `Retry N — <group>` line — ONE classification, read by both surfaces, so
 * a debug trace and what the user saw can never disagree about which group a code belongs to.
 *
 * @remarks
 * There is no "scope limit" group. The two budget codes are non-chargeable and never reach
 * `rejections[]`, so a group for them would be unreachable and would misrepresent a budget refusal
 * as a model correction.
 */
export type RejectionChatGroup = 'column_mapping' | 'source_selection' | 'answer_format' | 'backend_fault' | 'correction';

/**
 * Explicit membership for the non-fallback groups. Every rejection code NOT listed here —
 * including any future or renamed code — resolves through {@link classifyRejectionCode} to the
 * `correction` fallback, so an unmapped code can never surface to the user as a raw machine string.
 *
 * - `column_mapping` — the CT column-recording guards (`submitFindings.ts`/`smBase.ts`).
 * - `source_selection` — routing and prune-topology guards.
 * - `answer_format` — structural/schema violations of the tool envelope itself.
 * - `backend_fault` — a backend state or exception no model reply can correct (a closed panel
 *   included); the run ends on the first one instead of spending the step's replies.
 *
 * Other session/state codes, transport artifacts, the budget guards, and control-flow markers are
 * deliberately absent — none says anything about the model's semantic accuracy, so they fall to
 * `correction` rather than borrowing one of the named groups.
 */
const REJECTION_GROUPS: Readonly<Record<string, Exclude<RejectionChatGroup, 'correction'>>> = {
  [REJECTION_CODES.outColNotTracked]: 'column_mapping',
  [REJECTION_CODES.outColNotOnNode]: 'column_mapping',
  [REJECTION_CODES.contributorColNotOnSource]: 'column_mapping',
  [REJECTION_CODES.continuationNotWriter]: 'column_mapping',
  [REJECTION_CODES.columnSelfLoop]: 'column_mapping',
  [REJECTION_CODES.writesToNamesReader]: 'column_mapping',
  [REJECTION_CODES.prunedContributor]: 'column_mapping',
  [REJECTION_CODES.routeValidationFailed]: 'source_selection',
  [REJECTION_CODES.validation]: 'answer_format',
  [REJECTION_CODES.invalidInput]: 'answer_format',
  [REJECTION_CODES.ctFieldForbiddenInBb]: 'answer_format',
  [REJECTION_CODES.missingField]: 'answer_format',
  [REJECTION_CODES.fieldLengthExceeded]: 'answer_format',
  [REJECTION_CODES.emptyStructuredOutput]: 'answer_format',
  [REJECTION_CODES.missingRequiredToolCall]: 'answer_format',
  [REJECTION_CODES.toolCallNotation]: 'answer_format',
  [REJECTION_CODES.engineCrash]: 'backend_fault',
  [REJECTION_CODES.internalError]: 'backend_fault',
  [REJECTION_CODES.invalidStatus]: 'backend_fault',
  [REJECTION_CODES.noActiveSession]: 'backend_fault',
  [REJECTION_CODES.staleTurn]: 'backend_fault',
  [REJECTION_CODES.toolExecutionError]: 'backend_fault',
  [REJECTION_CODES.noProjectLoaded]: 'backend_fault',
};

/**
 * Resolves a rejection code to its retry-messaging group, defaulting an unmapped code to the
 * `correction` fallback. See {@link REJECTION_GROUPS} for the membership this implements and why a
 * "scope limit" group is intentionally absent.
 */
export function classifyRejectionCode(code: string): RejectionChatGroup {
  return REJECTION_GROUPS[code] ?? 'correction';
}

/**
 * Reveals the result panel and posts one preview, naming the outcome.
 *
 * @param panel - The open result panel, or `undefined` when none is open.
 * @returns `no_panel` without a panel, `delivered` when the webview accepted the message,
 * `post_failed` when the validated send was dropped or refused. A transport throw propagates. A schema drop
 * is a log line here: the participant's failed-render toast is the one user-visible notice.
 */
export async function deliverToPanel(
  panel: vscode.WebviewPanel | undefined,
  message: AiViewPreviewMessage,
  logger: Logger,
): Promise<PreviewDelivery> {
  if (!panel) return 'no_panel';
  panel.reveal();
  return (await postToWebview(panel, message, logger, false)) ? 'delivered' : 'post_failed';
}

/**
 * Private handler for AI tool execution.
 *
 * Owns the shared VS Code host services and thin read-tool handlers. Mutating
 * tool behavior is delegated through the explicit {@link ToolServices} seam.
 */
class ToolHandler implements ToolServices {
  public readonly logger: Logger;

  constructor(
    public readonly getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private readonly getPanel: () => vscode.WebviewPanel | undefined,
    private readonly turnLease?: TurnLease,
    public readonly getStoredRun?: StoredRunReader,
    public readonly textModel?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>,
    public readonly signal?: AbortSignal,
    public readonly budget: TurnTokenBudget = DEFAULT_TURN_TOKEN_BUDGET,
    public readonly caller: ToolCaller = 'turn',
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  public turnEpoch(sess: AiSession): number {
    return this.turnLease?.epoch ?? sess.turnEpoch;
  }

  public deliverPreview(message: AiViewPreviewMessage): Promise<PreviewDelivery> {
    return deliverToPanel(this.getPanel(), message, this.logger);
  }

  public requireModel(): DatabaseModel {
    const m = this.getSession().model;
    if (!m) throw new NoProjectLoadedError();
    return m;
  }

  public requireGraph(): Graph {
    const g = this.getSession().graph;
    if (!g) throw new NoProjectLoadedError();
    return g;
  }

  public logAndReturn(toolName: ToolName, data: object, input?: unknown): string {
    const sess = this.getSession();
    if (this.turnLease) assertActiveTurnLease(this.turnLease, sess.turnEpoch);
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), LOG_TRUNC_JSON);

    if (input !== undefined) {
      const inputJson = trunc(sanitizeForLog(JSON.stringify(input)), LOG_TRUNC_JSON);
      // One call site for every caller: a caller without a chat turn (`vscode.lm`, MCP) is marked, nothing else differs.
      const callerPart = this.caller === 'external' ? ' [external]' : '';
      this.logger.debug(`Invoking ${toolName}${callerPart} — input: ${inputJson}`);
    }

    if (this.caller === 'turn') sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
    const rejection = readToolError(data);
    if (rejection) {
      const hintPart = rejection.hint ? ` hint=${trunc(sanitizeForLog(rejection.hint), LOG_TRUNC_REJECTION)}` : '';
      const paths = rejection.issuePaths ?? [];
      const pathPart = paths.length > 0 ? ` issuePaths=${paths.join(',')}` : '';
      const isGate = isConsentGateRejection(rejection.code);
      const label = isGate ? '[Gate]' : '[Reject]';
      const groupPart = isGate ? '' : ` group=${classifyRejectionCode(rejection.code)}`;
      const reasonPart = ` reason=${sanitizeForLog(rejection.reason)}`;
      this.logger.debug(`${label} tool=${toolName}${groupPart} code=${rejection.code}${reasonPart}${hintPart}${pathPart}`);
    } else {
      this.logger.debug(`${toolName} → ${chars} chars: ${preview}`);
    }
    return json;
  }

  public buildActiveFilter(sess: AiSession): SerializedFilterState {
    const filter: Partial<SerializedFilterState> = sess.filter ?? {};
    return {
      schemas: filter.schemas || [],
      types: filter.types || [],
      searchTerm: filter.searchTerm || '',
      hideIsolated: !!filter.hideIsolated,
      focusSchemas: filter.focusSchemas || [],
      showExternalRefs: !!filter.showExternalRefs,
      externalRefTypes: filter.externalRefTypes || [],
      exclusionPatterns: filter.exclusionPatterns || [],
    };
  }

  public toolError(toolName: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const noProject = err instanceof NoProjectLoadedError;
    if (toolName === 'present_result' && this.caller === 'turn') {
      const sess = this.getSession();
      sess.recordPresentResultFailure(this.turnEpoch(sess));
    }
    if (noProject) {
      this.logger.info(`Tool ${toolName} ran with no project loaded`);
      return buildNoProjectLoadedError();
    }
    this.logger.error(`Tool ${toolName} failed unexpectedly`, err);
    return JSON.stringify(makeRejection({
      code: REJECTION_CODES.internalError,
      reason: msg || `Unexpected internal error running ${toolName}.`,
      detail: { tool: toolName },
    }));
  }

  /**
   * Mechanical phase guard — enforces the per-phase tool policy at the shared
   * registry execution boundary, not just at the LM `tools[]` parameter.
   *
   * @remarks
   * The native runtime carries the full catalog; callers without a chat turn (`vscode.lm`, MCP) are
   * evaluated against the `external` stage, and every dispatch path lands on this check.
   *
   * @returns Provider-neutral JSON text carrying an `off_policy` error when the
   *   tool is not allowed in the current phase, or `null` when execution is
   *   permitted.
   */
  public authorizeTool(toolName: ToolName, input: unknown): string | null {
    const sess = this.getSession();
    const stage = this.deriveLmStage(sess);
    const allowed = getAllowedLmToolNames(stage);
    const violation = evaluateToolPhaseRule(toolName, stage, allowed);
    return violation ? this.logAndReturn(toolName, violation, input) : null;
  }

  /**
   * Derives the {@link LmStage}: the `external` stage for a caller without a chat turn, otherwise
   * the session's current phase + engine state.
   */
  private deriveLmStage(sess: AiSession): LmStage {
    if (this.caller === 'external') return { kind: 'external', chatTurnActive: sess.chatTurnActive };
    if (sess.activeLmStage) return sess.activeLmStage;
    const phase = sess.phase.kind;
    const engine = sess.stateMachine;
    if (phase === 'exploring' && engine) {
      const mode = activeModeOf(engine.currentHopAnalysisMode === 'ct');
      return { kind: 'active', mode };
    }
    if (phase === 'completed') return { kind: 'completed' };
    return { kind: 'discover' };
  }

  public getContext(input: unknown) {
    try {
      const parsed = parseToolInput(GetContextInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_context', parsed.error, input);
      const sess = this.getSession();
      const ctx = getContext(this.requireModel(), sess.filter, sess.projectName);
      return this.logAndReturn('lineage_get_context', ctx, input);
    } catch (err) { return this.toolError('get_context', err); }
  }

  public getScreenState(input: unknown) {
    try {
      const parsed = parseToolInput(GetScreenStateInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_screen_state', parsed.error, input);
      const sess = this.getSession();
      const model = this.requireModel();
      const legacyIds = createSavedReferenceResolver(model);
      const currentIds = createSavedReferenceResolver(model, 2);
      const savedId = (id: string, version?: 2) => (version === 2 ? currentIds : legacyIds).nodeId(id);
      const getDdl = (id: string, version?: 2) => {
        const resolved = savedId(id, version);
        return resolved === null ? undefined : sess.columnStore.getDdl(resolved);
      };
      const { ids, filter, cursor } = parsed.data;
      if (ids || filter) {
        return this.logAndReturn('lineage_get_screen_state', presentRunRecall({
          uiState: sess.uiState,
          getStoredRun: this.getStoredRun,
          liveRun: sess.phase.kind === 'completed' ? buildLiveRun(sess.presentationArtifact) : undefined,
          budget: this.budget,
          ids,
          filter,
          getDdl,
          isInModel: (id, version) => savedId(id, version) !== null,
          onIdNormalized: (raw, canonical) => this.logger.debug(`[AI] get_screen_state id resolved raw=${sanitizeForLog(raw)} resolved=${sanitizeForLog(canonical)}`),
          hasPendingProposal: sess.pendingExploration !== null,
        }), input);
      }
      const screen = presentScreenState({
        uiState: sess.uiState,
        renderState: sess.renderState,
        graphMode: sess.graphMode,
        filteredCount: sess.filteredCount,
        totalNodes: model.nodes.length,
        getStoredRun: this.getStoredRun,
        getDdl,
        offset: cursorOffset(cursor),
      });
      return this.logAndReturn('lineage_get_screen_state', screen, input);
    } catch (err) { return this.toolError('get_screen_state', err); }
  }

  public async searchObjects(input: unknown) {
    try {
      const parsed = parseToolInput(SearchObjectsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_search_objects', parsed.error, input);
      const { query, types, schemas, mode, cursor } = parsed.data;
      return this.logAndReturn('lineage_search_objects', await searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter, msg => this.logger.debug(msg), cursor, this.signal), input);
    } catch (err) {
      if ((err instanceof RegexSearchExecutionError && err.reason === 'cancelled') || this.turnLease?.signal.aborted || this.signal?.aborted) throw err;
      if (this.turnLease) assertActiveTurnLease(this.turnLease, this.getSession().turnEpoch);
      return this.toolError('search_objects', err);
    }
  }

  public getScopeBundle(input: unknown) {
    try {
      const parsed = parseToolInput(GetScopeBundleInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_scope_bundle', parsed.error, input);
      const sess = this.getSession();
      const bundle = getScopeBundle(this.requireModel(), this.requireGraph(), parsed.data, this.budget, sess.columnStore, msg => this.logger.debug(msg)) as Record<string, unknown>;
      if (parsed.data.include_ddl === undefined && bundle.include_ddl === true) {
        this.logger.debug(`get_scope_bundle include_ddl omitted — auto-attached (origin=${trunc(String(bundle.origin), LOG_TRUNC_JSON)})`);
      }
      const stage = this.deriveLmStage(sess).kind;
      if (stage === 'external' && readToolError(bundle)?.code === REJECTION_CODES.overDiscoveryBudget) {
        // The chat escalates an oversized scope to an approved exploration; an external caller narrows it.
        return this.logAndReturn('lineage_get_scope_bundle', { ...bundle, hint: EXTERNAL_OVER_DISCOVERY_BUDGET_HINT }, input);
      }
      if (
        !Array.isArray(bundle.nodes) || !Array.isArray(bundle.edges) || typeof bundle.origin !== 'string'
        || (stage !== 'discover' && stage !== 'external')
      ) {
        return this.logAndReturn('lineage_get_scope_bundle', bundle, input);
      }
      const nodeIds = bundle.nodes.flatMap((node) => {
        if (!node || typeof node !== 'object') return [];
        const id = (node as { id?: unknown }).id;
        return typeof id === 'string' ? [id] : [];
      });
      const edges = bundle.edges.filter((edge): edge is [string, string, string] =>
        Array.isArray(edge) && edge.length === 3 && edge.every(value => typeof value === 'string'));
      const direction = (bundle.direction as 'upstream' | 'downstream' | 'bidirectional') ?? 'bidirectional';
      if (stage === 'external') {
        const scopeId = sess.storeExternalScope({ origin: bundle.origin, direction, nodeIds, edges });
        return this.logAndReturn('lineage_get_scope_bundle', { ...bundle, scope_id: scopeId }, input);
      }
      const stored = sess.storeDiscoveryScope({
        turnEpoch: this.turnEpoch(sess),
        origin: bundle.origin,
        direction,
        nodeIds,
        edges,
      }, this.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return this.logAndReturn('lineage_get_scope_bundle', makeRejection({ code: REJECTION_CODES.staleTurn, reason: 'The turn no longer owns this session; the scope was not stored.' }), input);
      }
      return this.logAndReturn('lineage_get_scope_bundle', bundle, input);
    } catch (err) { return this.toolError('get_scope_bundle', err); }
  }

  public startExploration(input: unknown) {
    return executeStartExploration(input, this);
  }


  public submitFindings(input: unknown) {
    return executeSubmitFindings(input, this);
  }

  public presentResult(input: unknown) {
    return executePresentResult(input, this);
  }

  public getObjectDetail(input: unknown) {
    try {
      const sess = this.getSession();
      const parsed = parseToolInput(GetObjectDetailInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_object_detail', parsed.error, input);
      const { id, cursor } = parsed.data;
      const detail = getObjectDetail(this.requireModel(), id, sess.columnStore, cursor, msg => this.logger.debug(msg)) as Record<string, unknown>;

      return this.logAndReturn('lineage_get_object_detail', detail, input);
    } catch (err) { return this.toolError('get_object_detail', err); }
  }

  public runAnalysis(input: unknown) {
    try {
      const parsed = parseToolInput(DetectGraphPatternsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_detect_graph_patterns', parsed.error, input);
      const { type, min_degree, max_size } = parsed.data;
      const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
      const resolvedMinDegree = min_degree ?? readDeclaredNumericSetting(anaCfg, 'analysis.hubMinDegree', DEFAULT_CONFIG.analysis.hubMinDegree);
      const resolvedMaxSize   = max_size   ?? readDeclaredNumericSetting(anaCfg, 'analysis.islandMaxSize', DEFAULT_CONFIG.analysis.islandMaxSize);
      const resolvedLongestPath = readDeclaredNumericSetting(anaCfg, 'analysis.longestPathMinNodes', DEFAULT_CONFIG.analysis.longestPathMinNodes);
      return this.logAndReturn('lineage_detect_graph_patterns', runAnalysis(this.requireGraph(), type, this.budget, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), input);
    } catch (err) { return this.toolError('detect_graph_patterns', err); }
  }

  public async searchDdl(input: unknown) {
    try {
      const parsed = parseToolInput(SearchDdlInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_search_ddl', parsed.error, input);
      const { query, types } = parsed.data;
      return this.logAndReturn('lineage_search_ddl', await searchDdl(this.requireModel(), query, this.budget, types, this.getSession().columnStore, msg => this.logger.debug(msg), this.signal), input);
    } catch (err) {
      if ((err instanceof RegexSearchExecutionError && err.reason === 'cancelled') || this.turnLease?.signal.aborted || this.signal?.aborted) throw err;
      if (this.turnLease) assertActiveTurnLease(this.turnLease, this.getSession().turnEpoch);
      return this.toolError('search_ddl', err);
    }
  }

  /**
   * SM ACTIVE pruning-verification affordance. Returns columns + FKs (no DDL)
   * for direct neighbors of the current focus node, bounded by the active scope.
   *
   * @remarks
   * Structural contract: ids must be direct neighbors of the current focus AND
   * within the active BFS scope. `NavigationEngine.validateNeighborIds` enforces
   * both conditions and returns a structured error on violation — the tool is
   * never a backdoor for out-of-scope exploration.
   */
  public getNeighborColumns(input: unknown) {
    try {
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) {
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: REJECTION_CODES.noActiveSession,
          reason: 'No exploration is active.',
        }), input);
      }

      const parsed = parseToolInput(GetNeighborColumnsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_neighbor_columns', parsed.error, input);

      const model = this.requireModel();
      const nodeMap = getModelNodeMap(model);
      const ids = parsed.data.ids.map((raw, index) => {
        const canonical = resolveModelNodeId(raw, nodeMap, model.identifierCaseSensitive);
        if (canonical && canonical !== raw) {
          this.logger.debug(`[Normalize] tool=get_neighbor_columns field=ids.${index} from=${sanitizeForLog(raw)} to=${sanitizeForLog(canonical)}`);
        }
        return canonical ?? raw;
      });
      const invalidIds = engine.validateNeighborIds(ids);
      if (invalidIds.length > 0) {
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: 'out_of_scope_or_not_neighbor',
          reason: `Not a direct neighbor of the current object, or outside the scope: ${invalidIds.join(', ')}.`,
          hint: 'Send only ids listed as neighbors of the current object.',
          detail: { invalid_ids: invalidIds },
        }), input);
      }

      return this.logAndReturn('lineage_get_neighbor_columns', getNeighborColumns(model, ids, sess.columnStore), input);
    } catch (err) { return this.toolError('get_neighbor_columns', err); }
  }

}

/** Provider-neutral JSON text returned by every canonical lineage tool. */
type LineageToolOutput = string;

/** Executes one catalog tool from its raw model payload. */
type ToolExecutor = (input: unknown) => LineageToolOutput | Promise<LineageToolOutput>;

/** Runs state-changing dispatches one at a time, in arrival order. */
export type EffectSerializer = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * Creates an {@link EffectSerializer}: each run starts after the previous one settled.
 *
 * @returns A serializer owning its own queue.
 */
export function createEffectSerializer(): EffectSerializer {
  let queue: Promise<void> = Promise.resolve();
  return async <T>(run: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };
}

/** Optional host seam of {@link buildAiToolRegistry}. */
export interface AiToolHost {
  /** Resolves the AI run behind an applied bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** Text-completion capability `start_exploration` uses for the discovery-handoff memo. */
  readonly model?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>;
  /** Cooperative cancellation of the dispatch. */
  readonly signal?: AbortSignal;
  /** Caps of the owning turn, so a superseded turn's dispatch keeps measuring against its own model. */
  readonly budget?: TurnTokenBudget;
  /** Who dispatches; `external` evaluates the `external` stage and uses the external view slot. Default `turn`. */
  readonly caller?: ToolCaller;
  /** Serializer shared by registries whose effects must not interleave; default one per registry. */
  readonly serialize?: EffectSerializer;
}

/**
 * Builds the shared lineage {@link ToolRegistry} — the single authoritative dispatch surface
 * for the AI tool catalog.
 *
 * @remarks
 * The native runtime calls this with a turn lease; {@link createExternalToolSource} calls it for
 * callers without a chat turn. The registry is the sole dispatch entry point (`invoke`), keeping
 * names, handlers, ordering, authorization, and labels consistent.
 *
 * @param getSession - Factory for the active AI session.
 * @param outputChannel - Log channel for tracing tool activity.
 * @param getPanel - Accessor for the active webview panel (`present_result` posts to it).
 * @param turnLease - Optional host-turn ownership checked around every dispatch.
 * @param host - Optional host seam, see {@link AiToolHost}.
 * @returns A ready-to-dispatch canonical registry.
 */
export function buildAiToolRegistry(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  turnLease?: TurnLease,
  host?: AiToolHost,
): ToolRegistry<LineageToolOutput> {
  const handler = new ToolHandler(getSession, outputChannel, getPanel, turnLease, host?.getStoredRun, host?.model, host?.signal ?? turnLease?.signal, host?.budget, host?.caller);

  const dispatch = {
    lineage_get_context: (input) => handler.getContext(input),
    lineage_get_screen_state: (input) => handler.getScreenState(input),
    lineage_search_objects: (input) => handler.searchObjects(input),
    lineage_get_scope_bundle: (input) => handler.getScopeBundle(input),
    lineage_start_exploration: (input) => handler.startExploration(input),
    lineage_submit_findings: (input) => handler.submitFindings(input),
    lineage_present_result: (input) => handler.presentResult(input),
    lineage_get_object_detail: (input) => handler.getObjectDetail(input),
    lineage_detect_graph_patterns: (input) => handler.runAnalysis(input),
    lineage_search_ddl: (input) => handler.searchDdl(input),
    lineage_get_neighbor_columns: (input) => handler.getNeighborColumns(input),
  } satisfies Record<ToolName, ToolExecutor>;

  const registry = new ToolRegistry<LineageToolOutput>();
  const serialize = host?.serialize ?? createEffectSerializer();
  for (const def of TOOL_DEFS) {
    const execute = dispatch[def.name];
    registry.register({
      ...def,
      execute: async (input: unknown) => {
        handler.signal?.throwIfAborted();
        const invoke = async (): Promise<LineageToolOutput> => {
          handler.signal?.throwIfAborted();
          if (turnLease) assertActiveTurnLease(turnLease, getSession().turnEpoch);
          const offPolicy = handler.authorizeTool(def.name, input);
          if (offPolicy) return offPolicy;
          const result = await execute(input);
          if (turnLease) assertActiveTurnLease(turnLease, getSession().turnEpoch);
          return result;
        };
        return def.effect === 'read' ? invoke() : serialize(invoke);
      },
    });
  }
  return registry;
}

/** The core tools a caller without a chat turn reaches, and their dispatch. */
export interface ExternalToolSource {
  /** Catalog entries in the `external` stage, in catalog order. */
  readonly tools: readonly ToolContract[];
  /**
   * Dispatches one call through the canonical registry as an `external` caller.
   *
   * @returns The tool's JSON text — a result or a rejection envelope.
   * @throws When `name` is not an external tool or the caller's signal is aborted.
   */
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<string>;
}

/**
 * Creates the single tool source shared by every surface without a chat turn: the `vscode.lm`
 * registration and the MCP server.
 *
 * @remarks
 * The tool set is the `external` stage of the core tool policy ({@link EXTERNAL_TOOL_NAMES}), so a
 * catalog tool reaches every external surface by being allowed there, and hop-by-hop tools never
 * do. Each call builds a registry bound to its own cancellation signal; one serializer orders the
 * state-changing calls of every surface. Already aborted calls never enter the queue; calls aborted
 * while queued are rejected before their handler runs.
 *
 * @param getSession - Factory for the active AI session.
 * @param outputChannel - Log channel.
 * @param getPanel - Accessor for the active webview panel.
 * @param host - Optional stored-run reader; `readBudget`, read at each call (the user's discovery
 *   caps; the shipped defaults without it); and the `serialize` queue shared with the chat
 *   registries, so a render never interleaves with a chat turn's commits.
 * @returns The external tool source.
 */
export function createExternalToolSource(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  host?: Pick<AiToolHost, 'getStoredRun' | 'serialize'> & { readonly readBudget?: () => TurnTokenBudget },
): ExternalToolSource {
  const serialize = host?.serialize ?? createEffectSerializer();
  return {
    tools: EXTERNAL_TOOL_DEFS,
    invoke: async (name, input, signal) => {
      if (!EXTERNAL_TOOL_NAMES.has(name)) throw new Error(`No external lineage tool "${name}"`);
      const registry = buildAiToolRegistry(getSession, outputChannel, getPanel, undefined, {
        getStoredRun: host?.getStoredRun, signal, caller: 'external', serialize, budget: host?.readBudget?.(),
      });
      return registry.invoke(name, input);
    },
  };
}

/**
 * Registers the external lineage tools with `vscode.lm` for other VS Code agents.
 *
 * @remarks
 * `package.json` contributes exactly {@link ExternalToolSource.tools} (generated by
 * `scripts/generate-tool-manifest.mjs`) — a contributed entry with no `registerTool` binding is a
 * broken tool, not merely an unused one. Native `@lineage` dispatch keeps the full catalog and does
 * not use these registrations. A rejection is thrown as an `Error` whose message is the reason and
 * the hint, the way the VS Code tools guide asks ("throw an error with a message that makes sense
 * to the LLM"); the host shows it to the calling model as the tool's failure, and a result is a
 * success with the tool's JSON text.
 *
 * @param source - The shared external tool source.
 * @returns Disposables for the registered `vscode.lm` tool bindings.
 */
export function registerAiTools(source: ExternalToolSource): vscode.Disposable[] {
  return source.tools.map((tool) =>
    vscode.lm.registerTool(tool.name, {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel(tool.name, options.input) }; },
      async invoke(options, token) {
        const abort = tokenToAbortSignal(token);
        try {
          const text = await source.invoke(tool.name, options.input, abort.signal);
          const rejection = readToolErrorText(text);
          if (rejection) throw new Error(rejectionProse(rejection));
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        } finally {
          abort.dispose();
        }
      },
    }),
  );
}
