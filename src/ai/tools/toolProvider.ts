/**
 * Canonical AI tool registry and handlers; the Zod boundary between untrusted LM tool input and the
 * engine. The AI runtime dispatches through {@link buildAiToolRegistry}. Read-only tools wrap provider-neutral functions in
 * [`tools.ts`](./tools.ts); mutating tools live in `handlers/`; this module owns their shared host
 * services, registry binding, cancellation checks and effect serialization.
 */
import type Graph from 'graphology';
import { NavigationEngine } from '../sm/smBase';
import { type AiSession } from '../session/session';
import { Logger, trunc, sanitizeForLog, LOG_TRUNC_JSON, LOG_TRUNC_REJECTION, type LogChannel } from '../../utils/log';
import {
  getContext, searchObjects, getObjectDetail,
  runAnalysis, searchDdl, getScopeBundle,
  getNeighborColumns, getTrace, getPath, getGraphPreviewScope,
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
  GetTraceInputSchema,
  GetPathInputSchema,
  CreateGraphPreviewInputSchema,
} from '../tools/toolSchemas';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../engine/types';
import { type SerializedFilterState } from '../../engine/projectStore';
import { countVisibleNodes } from '../../engine/shared/modelFilters';
import { getAllowedLmToolNames, activeModeOf, type LmStage } from '../tools/toolPolicy';
import type { z } from 'zod';
import { ToolRegistry, type ToolCallContext } from '../tools/registry';
import { TOOL_DEFS, type ToolName } from '../tools/toolDefs';
import { readToolError, isConsentGateRejection, makeRejection, NoProjectLoadedError, buildNoProjectLoadedError } from '../support/toolErrorEnvelope';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import { type TurnTokenBudget } from '../support/tokenBudget';
import { buildLiveRun, type StoredRunReader } from '../session/runStore';
import { presentRunRecall, presentScreenState } from './screenStatePresenter';
import { postToWebview, type WebviewPostTarget } from '../../bridge/host';
import { resolveModelNodeId } from '../support/inputNormalization';
import { cursorOffset } from '../support/text';
import { getModelNodeMap, type AiViewPreviewMessage, type ToolServices } from './handlers/toolServices';
import type { PreviewDelivery } from '../support/chatAnswer';
import { executeStartExploration } from './handlers/startExploration';
import { executeSubmitFindings } from './handlers/submitFindings';
import { executePresentResult } from './handlers/presentResult';
import { buildPreviewMetadata, orderAndAssemble } from './presentResult';
import type { ModelPort } from '../model/modelPort';
import { RegexSearchExecutionError } from '../support/isolatedRegexSearch';
import { REJECTION_CODES } from '../support/rejectionCodes';

type ResultPanel = WebviewPostTarget & { reveal(): void };
export type AnalysisSettings = typeof DEFAULT_CONFIG.analysis;

/**
 * Retry-messaging group for a rejection code, shared by this module's `[Reject]` debug line and
 * `graph.ts`'s chat-facing `Retry N — <group>` line, so the debug trace and the user's view cannot
 * disagree. There is no "scope limit" group: the two budget codes are non-chargeable and never
 * reach `rejections[]`, so one would be unreachable and misrepresent a budget refusal as a model
 * correction.
 */
export type RejectionChatGroup = 'column_mapping' | 'source_selection' | 'answer_format' | 'backend_fault' | 'correction';

/**
 * Explicit membership for the non-fallback groups. Every code not listed (including future or
 * renamed ones) resolves via {@link classifyRejectionCode} to `correction`, so an unmapped code
 * never reaches the user as a raw machine string.
 *
 * - `column_mapping`: the CT column-recording guards.
 * - `source_selection`: routing and prune-topology guards.
 * - `answer_format`: structural/schema violations of the tool envelope itself.
 * - `backend_fault`: a backend state or exception no model reply can correct; the run ends on the
 * first one.
 *
 * Session/state codes, transport artifacts, budget guards and control-flow markers are absent on
 * purpose: none says anything about the model's accuracy, so they fall to `correction`.
 */
const REJECTION_GROUPS: Readonly<Record<string, Exclude<RejectionChatGroup, 'correction'>>> = {
  [REJECTION_CODES.outColNotTracked]: 'column_mapping',
  [REJECTION_CODES.outColNotOnNode]: 'column_mapping',
  [REJECTION_CODES.contributorColNotOnSource]: 'column_mapping',
  [REJECTION_CODES.columnSelfLoop]: 'column_mapping',
  [REJECTION_CODES.writesToNamesReader]: 'column_mapping',
  [REJECTION_CODES.prunedContributor]: 'column_mapping',
  [REJECTION_CODES.routeValidationFailed]: 'source_selection',
  [REJECTION_CODES.validation]: 'answer_format',
  [REJECTION_CODES.invalidInput]: 'answer_format',
  [REJECTION_CODES.ctFieldForbiddenInBb]: 'answer_format',
  [REJECTION_CODES.missingField]: 'answer_format',
  [REJECTION_CODES.emptyStructuredOutput]: 'answer_format',
  [REJECTION_CODES.missingRequiredToolCall]: 'answer_format',
  [REJECTION_CODES.toolCallNotation]: 'answer_format',
  [REJECTION_CODES.engineCrash]: 'backend_fault',
  [REJECTION_CODES.internalError]: 'backend_fault',
  [REJECTION_CODES.invalidStatus]: 'backend_fault',
  [REJECTION_CODES.noActiveSession]: 'backend_fault',
  [REJECTION_CODES.toolExecutionError]: 'backend_fault',
};

/** Maps a rejection code to its retry group (default `correction`); {@link REJECTION_GROUPS}. */
export function classifyRejectionCode(code: string): RejectionChatGroup {
  return REJECTION_GROUPS[code] ?? 'correction';
}

/**
 * Private handler for AI tool execution. Owns the shared VS Code host services and thin read-tool
 * handlers; mutating tool behavior goes through the {@link ToolServices} seam.
 */
class ToolHandler implements ToolServices {
  public readonly logger: Logger;

  constructor(
    public readonly getSession: () => AiSession,
    outputChannel: LogChannel,
    private readonly getPanel: () => ResultPanel | undefined,
    private readonly analysisSettings: () => AnalysisSettings,
    public readonly getStoredRun: StoredRunReader | undefined,
    public readonly textModel: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'> | undefined,
    public readonly signal: AbortSignal | undefined,
    public readonly budget: TurnTokenBudget,
    private readonly authorName: string,
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  /**
   * Reveals the result panel and posts one preview, naming the outcome: `no_panel`, `delivered`, or
   * `post_failed` (the validated send was dropped or refused). A transport throw propagates. A
   * schema drop is only a log line here; the AI host's failed-render notice is the one
   * user-visible notice.
   */
  public async deliverPreview(message: AiViewPreviewMessage): Promise<PreviewDelivery> {
    const panel = this.getPanel();
    if (!panel) return 'no_panel';
    panel.reveal();
    return (await postToWebview(panel, message, this.logger, false)) ? 'delivered' : 'post_failed';
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
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), LOG_TRUNC_JSON);

    if (input !== undefined) {
      const inputJson = trunc(sanitizeForLog(JSON.stringify(input)), LOG_TRUNC_JSON);
      this.logger.debug(`Invoking ${toolName} — input: ${inputJson}`);
    }

    // The hop log is the chat turn's record.
    sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
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
    if (toolName === 'present_result') {
      const sess = this.getSession();
      sess.recordPresentResultFailure(
        sanitizeForLog(`${noProject ? 'no_project_loaded' : 'internal_error'}: ${msg}`),
      );
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
   * Mechanical phase guard: enforces the per-phase tool policy at the shared registry boundary, not
   * just at the LM `tools[]` parameter.
   *
   * @returns Provider-neutral JSON text carrying an `off_policy` error when the tool is not allowed
   *   in the current phase, else `null`.
   */
  public authorizeTool(toolName: ToolName, input: unknown): string | null {
    const stage = this.deriveLmStage(this.getSession());
    const violation = evaluateToolPhaseRule(toolName, stage, this.offeredTools());
    return violation ? this.logAndReturn(toolName, violation, input) : null;
  }

  /** The tools a result's hints may name: the chat stage's. */
  private offeredTools(): ReadonlySet<string> {
    return getAllowedLmToolNames(this.deriveLmStage(this.getSession()));
  }

  /** Derives the {@link LmStage} from the session's current phase + engine state. */
  private deriveLmStage(sess: AiSession): LmStage {
    if (sess.activeLmStage) return sess.activeLmStage;
    const phase = sess.phase.kind;
    const engine = sess.stateMachine;
    if (phase === 'exploring' && engine) {
      const mode = activeModeOf(engine.currentAnalysisMode === 'ct');
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
      const getDdl = (id: string) => sess.columnStore.getDdl(id);
      const liveRun = sess.phase.kind === 'completed'
        ? buildLiveRun(sess.presentationArtifact, sess.retainableReportSections())
        : undefined;
      const { ids, filter, cursor } = parsed.data;
      if (ids || filter) {
        const nodeMap = getModelNodeMap(model);
        return this.logAndReturn('lineage_get_screen_state', presentRunRecall({
          uiState: sess.uiState,
          getStoredRun: this.getStoredRun,
          liveRun,
          budget: this.budget,
          ids,
          filter,
          getDdl,
          isInModel: id => nodeMap.has(id),
          onIdNormalized: (raw, canonical) => this.logger.debug(`[AI] get_screen_state id resolved raw=${sanitizeForLog(raw)} resolved=${sanitizeForLog(canonical)}`),
          hasPendingProposal: sess.pendingExploration !== null,
        }), input);
      }
      const screen = presentScreenState({
        uiState: sess.uiState,
        renderState: sess.renderState,
        graphMode: sess.graphMode,
        visibleNodes: countVisibleNodes(model, sess.filter),
        totalNodes: model.nodes.length,
        getStoredRun: this.getStoredRun,
        liveRun,
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
      return this.logAndReturn('lineage_search_objects', await searchObjects(this.requireModel(), this.offeredTools(), query, types, schemas, mode ?? 'substring', this.getSession().filter, msg => this.logger.debug(msg), cursor, this.signal), input);
    } catch (err) {
      if ((err instanceof RegexSearchExecutionError && err.reason === 'cancelled') || this.signal?.aborted) throw err;
      return this.toolError('search_objects', err);
    }
  }

  public getTrace(input: unknown) {
    try {
      const parsed = parseToolInput(GetTraceInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_trace', parsed.error, input);
      return this.logAndReturn('lineage_get_trace', getTrace(this.requireModel(), this.getSession().filter, parsed.data), input);
    } catch (err) { return this.toolError('get_trace', err); }
  }

  public getPath(input: unknown) {
    try {
      const parsed = parseToolInput(GetPathInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_path', parsed.error, input);
      return this.logAndReturn('lineage_get_path', getPath(this.requireModel(), this.getSession().filter, parsed.data), input);
    } catch (err) { return this.toolError('get_path', err); }
  }

  /** Shows the validated scope as the AI graph preview in the graph view. */
  public async createGraphPreview(input: unknown) {
    try {
      const parsed = parseToolInput(CreateGraphPreviewInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_create_graph_preview', parsed.error, input);
      const model = this.requireModel();
      const scope = getGraphPreviewScope(model, this.getSession().filter, parsed.data);
      if (!('nodeIds' in scope)) return this.logAndReturn('lineage_create_graph_preview', scope, input);
      const { name, summary, layout_direction } = parsed.data;
      const { highlight_groups, sections, notes } = scope.view;
      const { badges, description } = orderAndAssemble(sections, { nodeMap: getModelNodeMap(model) });
      const delivery = await this.deliverPreview({
        type: 'ai-view-preview',
        name,
        nodeIds: scope.nodeIds,
        aiMetadata: buildPreviewMetadata(
          { summary, description, layout_direction, highlight_groups, badges, notes: notes.map(n => ({ nodeId: n.node_id, text: n.caption })) },
          { modelName: this.authorName },
        ),
      });
      if (delivery === 'no_panel') throw new NoProjectLoadedError();
      if (delivery === 'post_failed') {
        this.logger.warn('AI preview post failed');
        return this.logAndReturn('lineage_create_graph_preview', makeRejection({ code: REJECTION_CODES.toolExecutionError, reason: 'The graph view refused the preview.' }), input);
      }
      return this.logAndReturn('lineage_create_graph_preview', { name, nodes: scope.nodes, edges: scope.edges }, input);
    } catch (err) { return this.toolError('create_graph_preview', err); }
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
      if (
        !Array.isArray(bundle.nodes) || !Array.isArray(bundle.edges) || typeof bundle.origin !== 'string'
        || this.deriveLmStage(sess).kind !== 'discover'
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
      sess.storeDiscoveryScope({
        roundId: sess.currentRoundId,
        origin: bundle.origin,
        direction: (bundle.direction as 'upstream' | 'downstream' | 'bidirectional') ?? 'bidirectional',
        nodeIds,
        edges,
      });
      return this.logAndReturn('lineage_get_scope_bundle', bundle, input);
    } catch (err) { return this.toolError('get_scope_bundle', err); }
  }

  public startExploration(input: unknown, servedSchema?: z.ZodType) {
    return executeStartExploration(input, this, servedSchema);
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
      const configured = this.analysisSettings();
      return this.logAndReturn('lineage_detect_graph_patterns', runAnalysis(this.requireGraph(), type, this.budget, min_degree ?? configured.hubMinDegree, max_size ?? configured.islandMaxSize, configured.longestPathMinNodes), input);
    } catch (err) { return this.toolError('detect_graph_patterns', err); }
  }

  public async searchDdl(input: unknown) {
    try {
      const parsed = parseToolInput(SearchDdlInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_search_ddl', parsed.error, input);
      const { query, types } = parsed.data;
      return this.logAndReturn('lineage_search_ddl', await searchDdl(this.requireModel(), this.offeredTools(), query, this.budget, types, this.getSession().columnStore, msg => this.logger.debug(msg), this.signal), input);
    } catch (err) {
      if ((err instanceof RegexSearchExecutionError && err.reason === 'cancelled') || this.signal?.aborted) throw err;
      return this.toolError('search_ddl', err);
    }
  }

  /**
   * SM ACTIVE pruning-verification affordance: columns + FKs (no DDL) for direct neighbors of the
   * current focus, bounded by the active scope. `NavigationEngine.validateNeighborIds` enforces
   * both conditions and returns a structured error, so the tool is never a backdoor for
   * out-of-scope exploration.
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
        const invalidSet = new Set(invalidIds);
        const pointers = ids.flatMap((id, index) => (invalidSet.has(id) ? [`/ids/${index}`] : []));
        const issuePaths = ids.flatMap((id, index) => (invalidSet.has(id) ? [`ids.${index}`] : []));
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: REJECTION_CODES.outOfScopeOrNotNeighbor,
          reason: `${pointers.join(', ')}: not a direct neighbor of the current object, or outside the scope.`,
          hint: 'Send only ids listed as neighbors of the current object.',
          issuePaths,
          detail: { invalid_ids: invalidIds },
        }), input);
      }

      return this.logAndReturn('lineage_get_neighbor_columns', getNeighborColumns(model, ids, sess.columnStore), input);
    } catch (err) { return this.toolError('get_neighbor_columns', err); }
  }

}

/** Provider-neutral JSON text returned by every canonical lineage tool. */
type LineageToolOutput = string;

type ToolExecutor = (input: unknown, context?: ToolCallContext) => LineageToolOutput | Promise<LineageToolOutput>;

/**
 * Builds the shared lineage {@link ToolRegistry}, the single authoritative dispatch surface
 * (`invoke`) for names, handlers, ordering, authorization and labels. The runtime calls this
 * directly.
 *
 * @param getPanel - Accessor for the active webview panel (`present_result` posts to it).
 * @param host - Host seam: `analysisSettings` reads the configured analysis thresholds,
 *   `getStoredRun` resolves the AI run behind an applied bookmark,
 *   `model`/`signal` supply the text completion `start_exploration` uses for the discovery-handoff
 *   memo on the approval card, `budget` carries the turn's caps and `signal` cancels a dispatch;
 *   `authorName` is the display name the graph preview credits (the chat's model).
 */
export function buildAiToolRegistry(
  getSession: () => AiSession,
  outputChannel: LogChannel,
  getPanel: () => ResultPanel | undefined,
  host: { getStoredRun?: StoredRunReader; model?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>; signal?: AbortSignal; budget: TurnTokenBudget; analysisSettings: () => AnalysisSettings; authorName: string },
): ToolRegistry<LineageToolOutput> {
  const handler = new ToolHandler(getSession, outputChannel, getPanel, host.analysisSettings, host.getStoredRun, host.model, host.signal, host.budget, host.authorName);

  const dispatch = {
    lineage_get_context: (input) => handler.getContext(input),
    lineage_get_screen_state: (input) => handler.getScreenState(input),
    lineage_search_objects: (input) => handler.searchObjects(input),
    lineage_get_scope_bundle: (input) => handler.getScopeBundle(input),
    lineage_start_exploration: (input, context) => handler.startExploration(input, context?.servedSchema),
    lineage_submit_findings: (input) => handler.submitFindings(input),
    lineage_present_result: (input) => handler.presentResult(input),
    lineage_get_object_detail: (input) => handler.getObjectDetail(input),
    lineage_detect_graph_patterns: (input) => handler.runAnalysis(input),
    lineage_search_ddl: (input) => handler.searchDdl(input),
    lineage_get_neighbor_columns: (input) => handler.getNeighborColumns(input),
    lineage_get_trace: (input) => handler.getTrace(input),
    lineage_get_path: (input) => handler.getPath(input),
    lineage_create_graph_preview: (input) => handler.createGraphPreview(input),
  } satisfies Record<ToolName, ToolExecutor>;

  const registry = new ToolRegistry<LineageToolOutput>();
  let effectQueue: Promise<void> = Promise.resolve();
  for (const def of TOOL_DEFS) {
    const execute = dispatch[def.name];
    registry.register({
      ...def,
      execute: async (input: unknown, context?: ToolCallContext) => {
        const invoke = async (): Promise<LineageToolOutput> => {
          host.signal?.throwIfAborted();
          const offPolicy = handler.authorizeTool(def.name, input);
          if (offPolicy) return offPolicy;
          const result = await execute(input, context);
          host.signal?.throwIfAborted();
          return result;
        };
        if (def.effect === 'read') return invoke();

        let release!: () => void;
        const previous = effectQueue;
        effectQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await invoke();
        } finally {
          release();
        }
      },
    });
  }
  return registry;
}
