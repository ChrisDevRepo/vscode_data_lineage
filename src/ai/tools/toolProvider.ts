/**
 * Canonical AI tool registry, handlers, and optional VS Code LM registrations.
 *
 * @remarks
 * Acts as the Zod boundary between untrusted LM-supplied tool input and the engine + retrieval layer.
 * The native `@lineage` runtime dispatches through {@link buildAiToolRegistry}.
 * {@link registerAiTools} exposes the same catalog through `vscode.lm.registerTool` for external
 * VS Code compatibility.
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
import { getAllowedLmToolNames, activeModeOf, type LmStage } from '../tools/toolPolicy';
import { ToolRegistry, filterRegistry } from '../tools/registry';
import { TOOL_DEFS, type ToolName } from '../tools/toolDefs';
import { getToolInvocationLabel } from '../tools/toolLabels';
import { readToolError, isConsentGateRejection, makeRejection, NoProjectLoadedError, buildNoProjectLoadedError } from '../support/toolErrorEnvelope';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import { assertActiveTurnLease, type TurnLease } from '../session/turnLease';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../support/tokenBudget';
import { buildLiveRun, type StoredRunReader } from '../session/runStore';
import { presentRunRecall, presentScreenState } from './screenStatePresenter';
import { postToWebview } from '../../bridge/host';
import { resolveModelNodeId } from '../support/inputNormalization';
import { cursorOffset } from '../support/text';
import { getModelNodeMap, type AiViewPreviewMessage, type ToolServices } from './handlers/toolServices';
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
 * Deliberately five groups, not six: there is no "scope limit" group. The two budget codes are
 * non-chargeable and never reach `rejections[]`, so a sixth group for them would be unreachable and
 * would misrepresent a budget refusal as a model correction.
 */
export type RejectionChatGroup = 'column_mapping' | 'source_selection' | 'answer_format' | 'correction';

/**
 * Explicit membership for the three non-fallback groups. Every rejection code NOT listed here —
 * including any future or renamed code — resolves through {@link classifyRejectionCode} to the
 * `correction` fallback, so an unmapped code can never surface to the user as a raw machine string.
 *
 * - `column_mapping` — the CT column-recording guards (`submitFindings.ts`/`smBase.ts`).
 * - `source_selection` — routing and prune-topology guards.
 * - `answer_format` — structural/schema violations of the tool envelope itself.
 *
 * Session/state codes, transport artifacts, the budget guards, and control-flow markers are
 * deliberately absent — none says anything about the model's semantic accuracy, so they fall to
 * `correction` rather than borrowing one of the three named groups.
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
  [REJECTION_CODES.pruneOriginForbidden]: 'source_selection',
  [REJECTION_CODES.validation]: 'answer_format',
  [REJECTION_CODES.invalidInput]: 'answer_format',
  [REJECTION_CODES.ctFieldForbiddenInBb]: 'answer_format',
  [REJECTION_CODES.missingField]: 'answer_format',
  [REJECTION_CODES.fieldLengthExceeded]: 'answer_format',
  [REJECTION_CODES.emptyStructuredOutput]: 'answer_format',
  [REJECTION_CODES.missingRequiredToolCall]: 'answer_format',
  [REJECTION_CODES.classificationLockViolation]: 'answer_format',
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
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  public turnEpoch(sess: AiSession): number {
    return this.turnLease?.epoch ?? sess.turnEpoch;
  }

  public async deliverPreview(message: AiViewPreviewMessage): Promise<boolean> {
    const panel = this.getPanel();
    if (!panel) return false;
    panel.reveal();
    return postToWebview(panel, message, this.logger);
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
      this.logger.debug(`Invoking ${toolName} — input: ${inputJson}`);
    }

    sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
    const rejection = readToolError(data);
    if (rejection) {
      const hintPart = rejection.hint ? ` hint=${trunc(sanitizeForLog(rejection.hint), LOG_TRUNC_REJECTION)}` : '';
      const paths = rejection.issuePaths ?? [];
      const pathPart = paths.length > 0 ? ` issuePaths=${paths.join(',')}` : '';
      const isGate = isConsentGateRejection(rejection.code);
      const label = isGate ? '[Gate]' : '[Reject]';
      const groupPart = isGate ? '' : ` group=${classifyRejectionCode(rejection.code)}`;
      this.logger.debug(`${label} tool=${toolName}${groupPart} code=${rejection.code}${hintPart}${pathPart}`);
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
        this.turnEpoch(sess),
        sanitizeForLog(`${noProject ? 'no_project_loaded' : 'internal_error'}: ${msg}`),
      );
    }
    if (noProject) {
      this.logger.info(`Tool ${toolName} ran with no project loaded`);
      return buildNoProjectLoadedError();
    }
    this.logger.error(`Tool ${toolName} failed unexpectedly`, err);
    return JSON.stringify(makeRejection({
      code: 'internal_error',
      reason: msg || undefined,
      hint: `Unexpected internal error running ${toolName}. Retry once with the same input; if it repeats, simplify the payload.`,
      detail: { tool: toolName },
    }));
  }

  /**
   * Mechanical phase guard — enforces the per-phase tool policy at the shared
   * registry execution boundary, not just at the LM `tools[]` parameter.
   *
   * @remarks
   * The native runtime carries the full catalog; `registerAiTools` additionally exposes only the
   * read-only subset through `vscode.lm`, and both dispatch paths land on this check so the current
   * phase remains authoritative even for externally addressable reads.
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
   * Derives the {@link LmStage} from the session's current phase + engine state.
   */
  private deriveLmStage(sess: AiSession): LmStage {
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
      const getDdl = (id: string) => sess.columnStore.getDdl(id);
      const { ids, filter, cursor } = parsed.data;
      if (ids || filter) {
        const nodeMap = getModelNodeMap(model);
        const resolvedIds = ids?.map(id => {
          const resolved = resolveModelNodeId(id, nodeMap);
          if (resolved && resolved !== id) {
            this.logger.debug(`[AI] get_screen_state id resolved raw=${sanitizeForLog(id)} resolved=${sanitizeForLog(resolved)}`);
          }
          return resolved ?? id;
        });
        return this.logAndReturn('lineage_get_screen_state', presentRunRecall({
          uiState: sess.uiState,
          getStoredRun: this.getStoredRun,
          liveRun: sess.phase.kind === 'completed' ? buildLiveRun(sess.presentationArtifact) : undefined,
          budget: this.budget,
          ids: resolvedIds,
          filter,
          getDdl,
          isInModel: id => nodeMap.has(id),
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
      const bundle = getScopeBundle(this.requireModel(), this.requireGraph(), parsed.data, this.budget, sess.columnStore) as Record<string, unknown>;
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
      const stored = sess.storeDiscoveryScope({
        turnEpoch: this.turnEpoch(sess),
        origin: bundle.origin,
        direction: (bundle.direction as 'upstream' | 'downstream' | 'bidirectional') ?? 'bidirectional',
        nodeIds,
        edges,
      }, this.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return this.logAndReturn('lineage_get_scope_bundle', makeRejection({ code: REJECTION_CODES.staleTurn, hint: 'The turn no longer owns this session. Do not render this scope.' }), input);
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
      const detail = getObjectDetail(this.requireModel(), id, sess.columnStore, cursor) as Record<string, unknown>;

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
          hint: 'No active exploration. Call lineage_start_exploration first.',
        }), input);
      }

      const parsed = parseToolInput(GetNeighborColumnsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_neighbor_columns', parsed.error, input);

      const invalidIds = engine.validateNeighborIds(parsed.data.ids);
      if (invalidIds.length > 0) {
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: 'out_of_scope_or_not_neighbor',
          hint: `These ids are not direct neighbors of the current focus node and/or not in the active scope: ${invalidIds.join(', ')}. This tool only inspects direct neighbors for pruning verification.`,
          detail: { invalid_ids: invalidIds },
        }), input);
      }

      return this.logAndReturn('lineage_get_neighbor_columns', getNeighborColumns(this.requireModel(), parsed.data.ids, sess.columnStore), input);
    } catch (err) { return this.toolError('get_neighbor_columns', err); }
  }

}

/** Provider-neutral JSON text returned by every canonical lineage tool. */
type LineageToolOutput = string;

/** Executes one catalog tool from its raw model payload. */
type ToolExecutor = (input: unknown) => LineageToolOutput | Promise<LineageToolOutput>;

/**
 * Builds the shared lineage {@link ToolRegistry} — the single authoritative dispatch surface
 * for the AI tool catalog.
 *
 * @remarks
 * The native runtime calls this directly and never touches `vscode.lm.registerTool`.
 * {@link registerAiTools} reuses it when exposing externally invokable contributed tools.
 *
 * The registry is the sole dispatch entry point (`invoke`), keeping names, handlers, ordering,
 * authorization, and labels consistent.
 *
 * @param getSession - Factory for the active AI session.
 * @param outputChannel - Log channel for tracing tool activity.
 * @param getPanel - Accessor for the active webview panel (`present_result` posts to it).
 * @param turnLease - Optional host-turn ownership checked around every dispatch.
 * @param host - Optional host seam; `getStoredRun` resolves the AI run behind an applied bookmark,
 * `model`/`signal` supply the text-completion capability `start_exploration` uses to compose the
 * discovery-handoff memo shown at the bottom of the approval card, and `budget` carries the owning
 * turn's caps so a superseded turn's dispatch keeps measuring against its own model.
 * @returns A ready-to-dispatch canonical registry.
 */
export function buildAiToolRegistry(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  turnLease?: TurnLease,
  host?: { getStoredRun?: StoredRunReader; model?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>; signal?: AbortSignal; budget?: TurnTokenBudget },
): ToolRegistry<LineageToolOutput> {
  const handler = new ToolHandler(getSession, outputChannel, getPanel, turnLease, host?.getStoredRun, host?.model, host?.signal ?? turnLease?.signal, host?.budget);

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
  let effectQueue: Promise<void> = Promise.resolve();
  for (const def of TOOL_DEFS) {
    const execute = dispatch[def.name];
    registry.register({
      ...def,
      execute: async (input: unknown) => {
        const invoke = async (): Promise<LineageToolOutput> => {
          if (turnLease) assertActiveTurnLease(turnLease, getSession().turnEpoch);
          const offPolicy = handler.authorizeTool(def.name, input);
          if (offPolicy) return offPolicy;
          const result = await execute(input);
          if (turnLease) assertActiveTurnLease(turnLease, getSession().turnEpoch);
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

/**
 * The externally addressable subset of the catalog: read-only tools.
 *
 * @remarks
 * A `vscode.lm` registration is invokable by **any** extension or chat participant, with no
 * `@lineage` turn behind it; the read tools are safe there since they only answer questions about
 * an already-loaded snapshot. Every other effect class commits session lifecycle state that only
 * the owning turn may advance, so exposing them externally would let a third party drive the
 * exploration state machine out from under the participant.
 */
const EXTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_DEFS.filter(def => def.effect === 'read').map(def => def.name),
);

/**
 * Registers the **read-only** lineage tools with `vscode.lm` for external VS Code callers.
 *
 * @remarks
 * Calls {@link buildAiToolRegistry} and exposes the {@link EXTERNAL_TOOL_NAMES} subset through
 * `vscode.lm.registerTool`, using the shared {@link filterRegistry} read-only view rather than a
 * second hand-maintained list. Native `@lineage` dispatch keeps the full catalog and does not use
 * these registrations. `package.json` contributes exactly this subset — a contributed entry with no
 * `registerTool` binding is a broken tool, not merely an unused one, so the manifest and this
 * filter must move together.
 *
 * @param getSession - Factory for the active AI session.
 * @param outputChannel - Log channel for tracing tool activity.
 * @param getPanel - Accessor for the active webview panel.
 * @param host - Optional host seam forwarded to the shared registry builder.
 * @returns Disposables for the registered `vscode.lm` tool bindings.
 */
export function registerAiTools(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  host?: { getStoredRun?: StoredRunReader },
): vscode.Disposable[] {
  const external = filterRegistry(
    buildAiToolRegistry(getSession, outputChannel, getPanel, undefined, host),
    EXTERNAL_TOOL_NAMES,
  );

  return external.getTools().map((tool) =>
    vscode.lm.registerTool(tool.name, {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel(tool.name, options.input) }; },
      async invoke(options, token) {
        const abort = tokenToAbortSignal(token);
        try {
          const requestRegistry = buildAiToolRegistry(getSession, outputChannel, getPanel, undefined, { ...host, signal: abort.signal });
          const text = await requestRegistry.invoke(tool.name, options.input);
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        } finally {
          abort.dispose();
        }
      },
    }),
  );
}
