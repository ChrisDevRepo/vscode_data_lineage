import type { ToolFactContext } from '../support/toolValidation';
/** Canonical AI tool registry, handlers, and the surfaces for callers without a chat turn. */
import * as vscode from 'vscode';
import { redactMissionBriefForLog } from '../support/missionBriefDiagnostics';
import { ingestToolInput, toolInputReceipt } from '../support/toolIngestion';
import { z } from 'zod';
import { modelUpdateSchema } from './jsonSchema';
import type Graph from 'graphology';
import { NavigationEngine } from '../sm/smBase';
import { type AiSession } from '../session/session';
import { Logger, trunc, LOG_TRUNC_JSON } from '../../utils/log';
import {
  getContext, searchObjects, executeObjectDetail, prepareModelObject, type ModelObjectPlan,
  runAnalysis, searchDdl, executeScopeBundle,
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
import { at, readToolError, readToolErrorText, isConsentGateRejection, makeRejection, renderProblem, NoProjectLoadedError, buildNoProjectLoadedError } from '../support/toolErrorEnvelope';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import { assertActiveTurnLease, type TurnLease } from '../session/turnLease';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../support/tokenBudget';
import { buildLiveRun, type StoredRunReader } from '../session/runStore';
import { presentRunRecall, presentScreenState } from './screenStatePresenter';
import { postToWebview } from '../../bridge/host';
import { createSavedReferenceResolver } from '../../engine/shared/nodeIdResolution';
import { cursorOffset } from '../support/text';
import { type AiViewPreviewMessage, type ToolCaller, type ToolServices } from './handlers/toolServices';
import type { PreviewDelivery } from '../support/chatAnswer';
import { executeStartExploration } from './handlers/startExploration';
import { executeSubmitFindings } from './handlers/submitFindings';
import { executePruneCurrent } from './handlers/pruneCurrent';
import { executePresentResult } from './handlers/presentResult';
import type { ModelPort } from '../model/modelPort';
import { tokenToAbortSignal } from '../providers/cancellation';
import { RegexSearchExecutionError } from '../support/isolatedRegexSearch';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { errorMessage } from '../../utils/errorMessage';

/** Metadata lookup is receipt-scoped; cached native validators retain no session facts. */
function modelObjectAdmission(model: DatabaseModel): ToolFactContext & { plan?: ModelObjectPlan } {
  const receipt: ToolFactContext & { plan?: ModelObjectPlan } = { strings: new Map([['modelObject', (value, context) => {
    const plan = prepareModelObject(model, value, context.instancePath.slice(1));
    if ('code' in plan) return plan;
    receipt.plan = plan;
  }]]) };
  return receipt;
}

/** Diagnostic group shared by rejection logging and backend-fault policy. */
type RejectionChatGroup = 'column_mapping' | 'source_selection' | 'answer_format' | 'backend_fault' | 'correction';

/** Explicit membership for the non-fallback groups. Every rejection code NOT listed here — including any future or renamed code — resolves through {@link classifyRejectionCode} to the `correction` fallback, so diagnostic grouping remains defined for future codes. */
const REJECTION_GROUPS: Readonly<Record<string, Exclude<RejectionChatGroup, 'correction'>>> = {
  [REJECTION_CODES.outColNotOnNode]: 'column_mapping',
  [REJECTION_CODES.contributorColNotOnSource]: 'column_mapping',
  [REJECTION_CODES.columnSelfLoop]: 'column_mapping',
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
  [REJECTION_CODES.staleTurn]: 'backend_fault',
  [REJECTION_CODES.toolExecutionError]: 'backend_fault',
  [REJECTION_CODES.noProjectLoaded]: 'backend_fault',
};

/** Resolves a rejection code to its diagnostic group, defaulting an unmapped code to the `correction` fallback. See {@link REJECTION_GROUPS} for the membership this implements and why a "scope limit" group is intentionally absent. */
export function classifyRejectionCode(code: string): RejectionChatGroup {
  return REJECTION_GROUPS[code] ?? 'correction';
}

/** Reveals the result panel and posts one preview, naming the outcome. */
async function deliverToPanel(
  panel: vscode.WebviewPanel | undefined,
  message: AiViewPreviewMessage,
  logger: Logger,
): Promise<PreviewDelivery> {
  if (!panel) return 'no_panel';
  panel.reveal();
  return (await postToWebview(panel, message, logger, false)) ? 'delivered' : 'post_failed';
}

/** Private handler for AI tool execution. */
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
    input = toolInputReceipt.getStore()?.input ?? input;
    const sess = this.getSession();
    if (this.turnLease) assertActiveTurnLease(this.turnLease, sess.turnEpoch);
    const json = JSON.stringify(data);
    const chars = json.length;
    if (input !== undefined) {
      // One call site for every caller: a caller without a chat turn (`vscode.lm`) is marked, nothing else differs.
      const callerPart = this.caller === 'external' ? ' [external]' : '';
      this.logger.debug(`Invoking ${toolName}${callerPart} inputChars=${JSON.stringify(input)?.length ?? 0}`);
    }

    if (this.caller === 'turn') sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
    const rejection = readToolError(data);
    if (rejection) {
      const paths = rejection.issuePaths ?? [];
      const isGate = isConsentGateRejection(rejection.code);
      const label = isGate ? '[Gate]' : '[Reject]';
      const groupPart = isGate ? '' : ` group=${classifyRejectionCode(rejection.code)}`;
      this.logger.debug(`${label} tool=${toolName}${groupPart} code=${rejection.code} issueCount=${paths.length} resultChars=${chars}`);
    } else {
      this.logger.debug(`${toolName} resultChars=${chars}`);
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
    const msg = errorMessage(err);
    const noProject = err instanceof NoProjectLoadedError;
    if (noProject) {
      this.logger.info(`Tool ${toolName} ran with no project loaded`);
      return buildNoProjectLoadedError();
    }
    this.logger.error(`Tool ${toolName} failed unexpectedly`, err);
    return JSON.stringify(makeRejection({
      code: REJECTION_CODES.internalError,
      reason: msg || `Unexpected internal error running ${toolName}.`,
      errors: at('backend_fault'),
      detail: { tool: toolName },
    }));
  }

  /** Mechanical phase guard — enforces the per-phase tool policy at the shared registry execution boundary beyond the LM `tools[]` parameter. */
  public authorizeTool(toolName: ToolName, input: unknown): string | null {
    const sess = this.getSession();
    const stage = this.deriveLmStage(sess);
    const allowed = getAllowedLmToolNames(stage);
    const violation = evaluateToolPhaseRule(toolName, allowed);
    return violation ? this.logAndReturn(toolName, violation, input) : null;
  }

  /** Derives the {@link LmStage}: the `external` stage for a caller without a chat turn, otherwise the session's current phase + engine state. */
  private deriveLmStage(sess: AiSession): LmStage {
    if (this.caller === 'external') return { kind: 'external' };
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
      // Built on first saved-id lookup only: each resolver indexes every node and its legacy aliases.
      let legacyIds: ReturnType<typeof createSavedReferenceResolver> | undefined;
      let currentIds: ReturnType<typeof createSavedReferenceResolver> | undefined;
      const savedId = (id: string, version?: 2) => (version === 2
        ? currentIds ??= createSavedReferenceResolver(model, 2)
        : legacyIds ??= createSavedReferenceResolver(model)).nodeId(id);
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
      return this.logAndReturn('lineage_search_objects', await searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter, cursor, this.signal), input);
    } catch (err) {
      if ((err instanceof RegexSearchExecutionError && err.reason === 'cancelled') || this.turnLease?.signal.aborted || this.signal?.aborted) throw err;
      if (this.turnLease) assertActiveTurnLease(this.turnLease, this.getSession().turnEpoch);
      return this.toolError('search_objects', err);
    }
  }

  public getScopeBundle(input: unknown) {
    try {
      const model = this.requireModel(), facts = modelObjectAdmission(model);
      const outcome = ingestToolInput({ input, schema: GetScopeBundleInputSchema, context: '', facts, inspect: view => {
        const parsed = view.parsed, plan = facts.plan;
        return parsed.success && plan ? () => {
      const sess = this.getSession();
      const bundle = executeScopeBundle(model, this.requireGraph(), parsed.data, this.budget, plan, sess.columnStore) as Record<string, unknown>;
      if (parsed.data.include_ddl === undefined && bundle.include_ddl === true) {
        this.logger.debug(`get_scope_bundle include_ddl omitted — auto-attached (origin=${trunc(String(bundle.origin), LOG_TRUNC_JSON)})`);
      }
      const stage = this.deriveLmStage(sess).kind;
      if (
        !Array.isArray(bundle.nodes) || !Array.isArray(bundle.edges) || typeof bundle.origin !== 'string'
        || stage !== 'discover'
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
      const stored = sess.storeDiscoveryScope({
        turnEpoch: this.turnEpoch(sess),
        origin: bundle.origin,
        direction,
        nodeIds,
        edges,
      }, this.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return this.logAndReturn('lineage_get_scope_bundle', makeRejection({ code: REJECTION_CODES.staleTurn, reason: 'The turn no longer owns this session; the scope was not stored.', errors: at('backend_fault') }), input);
      }
      return this.logAndReturn('lineage_get_scope_bundle', bundle, input);
        } : undefined;
      } });
      return typeof outcome === 'string' ? outcome : this.logAndReturn('lineage_get_scope_bundle', outcome, input);
    } catch (err) { return this.toolError('get_scope_bundle', err); }
  }

  public startExploration(input: unknown) {
    return executeStartExploration(input, this);
  }


  public submitFindings(input: unknown) {
    return executeSubmitFindings(input, this);
  }

  /** Commits removal of an eligible unresolved current candidate. */
  public pruneCurrent(input: unknown) {
    return executePruneCurrent(input, this);
  }

  public presentResult(input: unknown) {
    return executePresentResult(input, this);
  }

  public getObjectDetail(input: unknown) {
    try {
      const sess = this.getSession();
      const model = this.requireModel(), facts = modelObjectAdmission(model);
      const outcome = ingestToolInput({ input, schema: GetObjectDetailInputSchema, context: '', facts, inspect: view => {
        const parsed = view.parsed, plan = facts.plan;
        return parsed.success && plan ? () => this.logAndReturn('lineage_get_object_detail',
          executeObjectDetail(model, plan, sess.columnStore, parsed.data.cursor), input) : undefined;
      } });
      return typeof outcome === 'string' ? outcome : this.logAndReturn('lineage_get_object_detail', outcome, input);
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

  /** SM ACTIVE pruning-verification affordance. Returns columns + FKs (no DDL) for direct neighbors of the current focus node, bounded by the active scope. */
  public getNeighborColumns(input: unknown) {
    try {
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) {
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: REJECTION_CODES.noActiveSession,
          reason: 'No exploration is active.',
          errors: at('no_session'),
        }), input);
      }

      const parsed = parseToolInput(GetNeighborColumnsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_neighbor_columns', parsed.error, input);

      const model = this.requireModel();
      const ids = parsed.data.ids;
      const invalidIds = engine.validateNeighborIds(ids);
      if (invalidIds.length > 0) {
        return this.logAndReturn('lineage_get_neighbor_columns', makeRejection({
          code: REJECTION_CODES.outOfScopeOrNotNeighbor,
          reason: 'Not a direct neighbor of the current object, or outside the scope.',
          errors: at('not_neighbor', ids.flatMap((id, index) => invalidIds.includes(id) ? [`ids.${index}`] : []), engine.neighborColumnIds),
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
type EffectSerializer = <T>(run: () => Promise<T>) => Promise<T>;

/** Creates an {@link EffectSerializer}: each run starts after the previous one settled. */
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
interface AiToolHost {
  /** Resolves the AI run behind an applied bookmark. */
  readonly getStoredRun?: StoredRunReader;
  /** Request-selected model for completion and physical generation ownership. */
  readonly model?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'> & Partial<Pick<ModelPort, 'modelCalls'>>;
  /** Cooperative cancellation of the dispatch. */
  readonly signal?: AbortSignal;
  /** Caps of the owning turn, so a superseded turn's dispatch keeps measuring against its own model. */
  readonly budget?: TurnTokenBudget;
  /** Who dispatches; `external` evaluates the read-only tool policy. Default `turn`. */
  readonly caller?: ToolCaller;
  /** Serializer shared by registries whose effects must not interleave; default one per registry. */
  readonly serialize?: EffectSerializer;
}

/** Builds the shared lineage {@link ToolRegistry} — the single authoritative dispatch surface for the AI tool catalog. */
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
    lineage_prune_current: (input) => handler.pruneCurrent(input),
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
    let owner: z.ZodType = def.inputSchema;
    let group = { context: '', generation: -1, calls: 0 };
    const project = (schema: z.ZodType) => { owner = schema; return ['session_start', 'presentation_commit'].includes(def.effect) ? modelUpdateSchema(schema) : schema; };
    registry.register({
      ...def,
      get inputSchema() { return project(owner); },
      inputRepairSchema: project,
      execute: async (input: unknown) => {
        handler.signal?.throwIfAborted();
        const sess = getSession();
        const receipt = { input: redactMissionBriefForLog(input), generation: handler.caller === 'external' ? undefined : host?.model?.modelCalls, signal: handler.signal,
          context: JSON.stringify([sess.turnEpoch, sess.phase.kind, sess.activeLmStage, sess.stateMachine?.currentFocus, sess.pendingExploration?.revision]), group };
        if (group.context !== receipt.context || group.generation !== receipt.generation) group = { context: receipt.context, generation: receipt.generation ?? -1, calls: 0 };
        receipt.group = group; group.calls++;
        const invoke = async (): Promise<LineageToolOutput> => {
          handler.signal?.throwIfAborted();
          if (turnLease) assertActiveTurnLease(turnLease, getSession().turnEpoch);
          const offPolicy = handler.authorizeTool(def.name, input);
          if (offPolicy) return offPolicy;
          const result = await toolInputReceipt.run(receipt, () => execute(input));
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
interface ExternalToolSource {
  /** Catalog entries in the `external` stage, in catalog order. */
  readonly tools: readonly ToolContract[];
  /** Dispatches one call through the canonical registry as an `external` caller. */
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<string>;
}

/** Creates the single tool source shared by every surface without a chat turn: the `vscode.lm` registration. */
export function createExternalToolSource(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  host?: Pick<AiToolHost, 'getStoredRun'>,
): ExternalToolSource {
  return {
    tools: EXTERNAL_TOOL_DEFS,
    invoke: async (name, input, signal) => {
      if (!EXTERNAL_TOOL_NAMES.has(name)) throw new Error(`No external lineage tool "${name}"`);
      const registry = buildAiToolRegistry(getSession, outputChannel, getPanel, undefined, {
        getStoredRun: host?.getStoredRun, signal, caller: 'external',
      });
      return registry.invoke(name, input);
    },
  };
}

/** Registers the external lineage tools with `vscode.lm` for other VS Code agents. */
export function registerAiTools(source: ExternalToolSource): vscode.Disposable[] {
  return source.tools.map((tool) =>
    vscode.lm.registerTool(tool.name, {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel(tool.name, options.input) }; },
      async invoke(options, token) {
        const abort = tokenToAbortSignal(token);
        try {
          const text = await source.invoke(tool.name, options.input, abort.signal);
          const rejection = readToolErrorText(text);
          if (rejection) throw new Error(renderProblem(rejection, 2));
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        } finally {
          abort.dispose();
        }
      },
    }),
  );
}
