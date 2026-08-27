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
import { type DatabaseModel } from '../../engine/types';
import { type SerializedFilterState } from '../../engine/projectStore';
import { getAllowedLmToolNames, activeModeOf, type LmStage } from '../tools/toolPolicy';
import { ToolRegistry, filterRegistry } from '../tools/registry';
import { TOOL_DEFS, type ToolName } from '../tools/toolDefs';
import { getToolInvocationLabel } from '../tools/toolLabels';
import { readToolError, rejectionIssuePaths, isConsentGateRejection } from '../support/toolErrorEnvelope';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import { assertActiveTurnLease, type TurnLease } from '../session/turnLease';
import type { StoredRunReader } from '../session/runStore';
import { presentRunRecall, presentScreenState } from './screenStatePresenter';
import { resolveModelNodeId } from '../support/inputNormalization';
import { getModelNodeMap, type ToolServices } from './handlers/toolServices';
import { executeStartExploration } from './handlers/startExploration';
import { executeSubmitFindings } from './handlers/submitFindings';
import { executePresentResult } from './handlers/presentResult';

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
    public readonly getPanel: () => vscode.WebviewPanel | undefined,
    private readonly turnLease?: TurnLease,
    public readonly getStoredRun?: StoredRunReader,
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  public turnEpoch(sess: AiSession): number {
    return this.turnLease?.epoch ?? sess.turnEpoch;
  }

  public requireModel(): DatabaseModel {
    const m = this.getSession().model;
    if (!m) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return m;
  }

  public requireGraph(): Graph {
    const g = this.getSession().graph;
    if (!g) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return g;
  }

  public logAndReturn(toolName: string, data: object, input?: unknown): string {
    const sess = this.getSession();
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
      const reason = trunc(sanitizeForLog(rejection.reason), LOG_TRUNC_REJECTION);
      const hintPart = rejection.hint ? ` hint=${trunc(sanitizeForLog(rejection.hint), LOG_TRUNC_REJECTION)}` : '';
      const paths = rejectionIssuePaths(rejection.detail);
      const pathPart = paths.length > 0 ? ` issuePaths=${paths.join(',')}` : '';
      // The consent gate shares the rejection envelope but is the gate firing on plan — labelling
      // it `[Reject]` made a healthy refine round read as a retry loop in the log.
      const label = isConsentGateRejection(rejection.code) ? '[Gate]' : '[Reject]';
      this.logger.debug(`${label} tool=${toolName} code=${rejection.code} reason=${reason}${hintPart}${pathPart}`);
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
    if (toolName === 'present_result') {
      const sess = this.getSession();
      sess.recordPresentResultFailure(
        this.turnEpoch(sess),
        trunc(sanitizeForLog(`internal_error: ${msg}`), 240),
      );
    }
    this.logger.error(`Tool ${toolName} failed unexpectedly`, err);
    return JSON.stringify({
      error: 'internal_error',
      tool: toolName,
      message: msg,
      hint: `Unexpected internal error running ${toolName}. Retry once with the same input; if it repeats, simplify the payload.`,
    });
  }

  /**
   * Mechanical phase guard — enforces the per-phase tool policy at the shared
   * registry execution boundary, not just at the LM `tools[]` parameter.
   *
   * @remarks
   * The native runtime carries the full catalog. `registerAiTools` additionally exposes only the
   * read-only subset through `vscode.lm`; both dispatch paths land on this check so the current
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
      const mode = activeModeOf(engine.columnAspect !== null);
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
      const ctx = getContext(this.requireModel(), sess.filter, sess.projectName, sess.columnStore);
      return this.logAndReturn('get_context', ctx, input);
    } catch (err) { return this.toolError('get_context', err); }
  }

  public getScreenState(input: unknown) {
    try {
      const parsed = parseToolInput(GetScreenStateInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_get_screen_state', parsed.error, input);
      const sess = this.getSession();
      const model = this.requireModel();
      const getDdl = (id: string) => sess.columnStore.getDdl(id);
      const { ids, filter } = parsed.data;
      if (ids || filter) {
        const nodeMap = getModelNodeMap(model);
        return this.logAndReturn('get_screen_state', presentRunRecall({
          uiState: sess.uiState,
          getStoredRun: this.getStoredRun,
          ids: ids?.map(id => resolveModelNodeId(id, nodeMap) ?? id),
          filter,
          getDdl,
          isInModel: id => nodeMap.has(id),
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
      });
      return this.logAndReturn('get_screen_state', screen, input);
    } catch (err) { return this.toolError('get_screen_state', err); }
  }

  public searchObjects(input: unknown) {
    try {
      const parsed = parseToolInput(SearchObjectsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_search_objects', parsed.error, input);
      const { query, types, schemas, mode } = parsed.data;
      return this.logAndReturn('search_objects', searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter), input);
    } catch (err) { return this.toolError('search_objects', err); }
  }

  public getScopeBundle(input: unknown) {
    try {
      const parsed = GetScopeBundleInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') || '(root)';
        return this.logAndReturn('lineage_get_scope_bundle', {
          error: 'invalid_input',
          hint: `Invalid get_scope_bundle input: field "${field}" — ${issue?.message ?? 'validation failed'}. Required: origin. Optional: direction, depth, upstream_depth, downstream_depth, include_ddl.`,
        }, input);
      }
      const sess = this.getSession();
      const bundle = getScopeBundle(this.requireModel(), this.requireGraph(), parsed.data, sess.columnStore) as Record<string, unknown>;
      // Normalization-with-log: silence on `include_ddl` is filled by a declared default, so the
      // decision the model did not make has to be visible. An explicit `false` is never overridden.
      if (parsed.data.include_ddl === undefined && bundle.include_ddl === true) {
        this.logger.debug(`get_scope_bundle include_ddl omitted — auto-attached (origin=${trunc(String(bundle.origin), LOG_TRUNC_JSON)})`);
      }
      if (!Array.isArray(bundle.nodes) || !Array.isArray(bundle.edges) || typeof bundle.origin !== 'string') {
        return this.logAndReturn('get_scope_bundle', bundle, input);
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
        return this.logAndReturn('get_scope_bundle', { error: 'stale_turn', hint: 'The turn no longer owns this session. Do not render this scope.' }, input);
      }
      return this.logAndReturn('get_scope_bundle', bundle, input);
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
      const { id } = parsed.data;
      const detail = getObjectDetail(this.requireModel(), id, sess.columnStore) as Record<string, unknown>;

      return this.logAndReturn('get_object_detail', detail, input);
    } catch (err) { return this.toolError('get_object_detail', err); }
  }

  public runAnalysis(input: unknown) {
    try {
      const parsed = parseToolInput(DetectGraphPatternsInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_detect_graph_patterns', parsed.error, input);
      const { type, min_degree, max_size } = parsed.data;
      const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
      const resolvedMinDegree = min_degree ?? anaCfg.get<number>('analysis.hubMinDegree');
      const resolvedMaxSize   = max_size   ?? anaCfg.get<number>('analysis.islandMaxSize');
      const resolvedLongestPath = anaCfg.get<number>('analysis.longestPathMinNodes');
      return this.logAndReturn('detect_graph_patterns', runAnalysis(this.requireGraph(), type, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), input);
    } catch (err) { return this.toolError('detect_graph_patterns', err); }
  }

  public searchDdl(input: unknown) {
    try {
      const parsed = parseToolInput(SearchDdlInputSchema, input);
      if (!parsed.ok) return this.logAndReturn('lineage_search_ddl', parsed.error, input);
      const { query, types } = parsed.data;
      return this.logAndReturn('search_ddl', searchDdl(this.requireModel(), query, types, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('search_ddl', err); }
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
        return this.logAndReturn('get_neighbor_columns', {
          error: 'no_active_session',
          hint: 'No active exploration. Call lineage_start_exploration first.',
        }, input);
      }

      const parsed = GetNeighborColumnsInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') || '(root)';
        return this.logAndReturn('get_neighbor_columns', {
          error: 'invalid_input',
          hint: `Invalid get_neighbor_columns input: field "${field}" — ${issue?.message ?? 'validation failed'}. Required: ids (non-empty array of node IDs).`,
        }, input);
      }

      const invalidIds = engine.validateNeighborIds(parsed.data.ids);
      if (invalidIds.length > 0) {
        return this.logAndReturn('get_neighbor_columns', {
          error: 'out_of_scope_or_not_neighbor',
          invalid_ids: invalidIds,
          hint: `These ids are not direct neighbors of the current focus node and/or not in the active scope: ${invalidIds.join(', ')}. This tool only inspects direct neighbors for pruning verification.`,
        }, input);
      }

      return this.logAndReturn('get_neighbor_columns', getNeighborColumns(this.requireModel(), parsed.data.ids, sess.columnStore), input);
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
 * @param host - Optional host seam; `getStoredRun` resolves the AI run behind an applied bookmark.
 * @returns A ready-to-dispatch canonical registry.
 */
export function buildAiToolRegistry(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined,
  turnLease?: TurnLease,
  host?: { getStoredRun?: StoredRunReader },
): ToolRegistry<LineageToolOutput> {
  const handler = new ToolHandler(getSession, outputChannel, getPanel, turnLease, host?.getStoredRun);

  // Exhaustive catalog binding: adding or removing a tool requires a matching handler entry.
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
 * A `vscode.lm` registration is invokable by **any** extension or chat participant in the window,
 * with no `@lineage` turn behind it. The read tools are safe there — they answer questions about
 * an already-loaded snapshot. Every other effect class (`session_start`, `hop_commit`,
 * `preview_commit`, `presentation_commit`, `scope_store`) commits session lifecycle state that only
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

  // Register the read-only catalog subset with VS Code, dispatching through the filtered view so a
  // mutating name fails as an unknown tool even if a manifest entry were reintroduced by hand. The
  // model-facing input schema still lives in `package.json` (VS Code reads it statically); the
  // Zod-SSOT drift guard pins that manifest to the catalog so they cannot diverge.
  return external.getTools().map((tool) =>
    vscode.lm.registerTool(tool.name, {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel(tool.name, options.input) }; },
      async invoke(options, _token) {
        const text = await external.invoke(tool.name, options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
      },
    }),
  );
}
