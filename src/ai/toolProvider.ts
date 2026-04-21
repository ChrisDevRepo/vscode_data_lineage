import * as vscode from 'vscode';
import type Graph from 'graphology';
import { NavigationEngine } from './smBase';
import type { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import {
  suggestNarrowerDepth,
  shouldSmInline,
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch,
  validateToolInput,
  StartExplorationInputSchema,
  autoFixPresentResult, validatePresentResult, orderAndAssemble,
  type PresentResultInput,
} from './tools';
import { edgeApiType } from './aiPresenter';
import { prunePreserveOnly } from './viewPrune';
import { type ObjectType, type AnalysisType, type DatabaseModel, type LineageNode } from '../engine/types';
import { type SerializedFilterState, type AIViewMetadata } from '../engine/projectStore';
import { PendingGateSchema } from './sessionPhase';
import { buildSynthesisReminder } from './smPrompts';
import { renderMetadataBand } from './templateRenderer';
import { ClassificationSchema, CLASSIFICATION_LABEL } from './classification';

/**
 * Private handler for AI tool execution.
 * 
 * Consolidates business logic, state-machine orchestration, and validation
 * for all lineage tools into a single testable class.
 */
class ToolHandler {
  private readonly logger: Logger;

  constructor(
    private readonly getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private readonly getPanel: () => vscode.WebviewPanel | undefined
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  private isAiEnabled(): boolean {
    return vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled') ?? true;
  }

  private requireModel(): DatabaseModel {
    const m = this.getSession().model;
    if (!m) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return m;
  }

  private requireGraph(): Graph {
    const g = this.getSession().graph;
    if (!g) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return g;
  }

  private toolResult(data: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
  }

  private logAndReturn(toolName: string, data: object, input?: any): vscode.LanguageModelToolResult {
    const sess = this.getSession();
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), 300);

    if (input !== undefined) {
      const inputJson = trunc(sanitizeForLog(JSON.stringify(input)), 300);
      this.logger.debug(`Invoking ${toolName} — input: ${inputJson}`);
    }

    sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
    this.logger.debug(`${toolName} → ${chars} chars: ${preview}`);
    return this.toolResult(data);
  }

  private toolError(toolName: string, err: unknown): vscode.LanguageModelToolResult {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`${toolName}: unhandled`, err instanceof Error ? err : new Error(msg));
    return this.toolResult({ error: 'internal_error', tool: toolName, message: msg });
  }

  private disabled() { 
    return this.toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' }); 
  }

  public getContext(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const ctx = getContext(this.requireModel(), sess.filter, sess.projectName, sess.views, sess.columnStore);
      return this.logAndReturn('get_context', ctx, input);
    } catch (err) { return this.toolError('get_context', err); }
  }

  public searchObjects(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types, schemas, mode } = input;
      return this.logAndReturn('search_objects', searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter), input);
    } catch (err) { return this.toolError('search_objects', err); }
  }

  public startExploration(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const m = this.requireModel();
      const g = this.requireGraph();

      const parsed = StartExplorationInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') || '(root)';
        return this.logAndReturn('start_exploration', {
          error: 'missing_field',
          hint: `Invalid start_exploration input: field "${field}" — ${issue?.message ?? 'validation failed'}. Required: origin (non-empty string). Optional: question, direction, depth, depth_enforcement, excludeTypes, mission_brief, targetColumns.`,
        }, input);
      }
      const data = parsed.data;

      sess.resetIfStale();

      if (sess.startExplorationRoundId !== null && sess.startExplorationRoundId === sess.currentRoundId) {
        return this.logAndReturn('start_exploration', {
          error: 'parallel_call_forbidden',
          hint: 'start_exploration is strictly serial and one-shot per round. Use submit_findings for the queued neighbors — after complete_rejected they are queued at priority 3 and will be served on the next submit_findings.',
          next_action: 'submit_findings',
        }, input);
      }
      sess.startExplorationRoundId = sess.currentRoundId;

      const prior = sess.stateMachine as NavigationEngine | null;
      const priorLive = !!prior && prior.status !== 'complete';
      if (priorLive && prior!.sessionId && prior!.sessionId !== sess.id) {
        sess.pendingUserNotice.add('A previous exploration was still running when you started this one. Its in-memory findings were discarded.');
        sess.resetExploration();
        sess.startExplorationRoundId = sess.currentRoundId;
      } else if (priorLive && prior!.sessionId === sess.id) {
        return this.logAndReturn('start_exploration', {
          error: 'already_started',
          hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 — the next submit_findings will present one of them.',
          next_action: 'submit_findings',
        }, input);
      }

      const filter = sess.filter;
      if (!filter) throw new Error('No filter state available.');

      const activeFilter: SerializedFilterState = {
        schemas: filter.schemas || [],
        types: filter.types || [],
        searchTerm: filter.searchTerm || '',
        hideIsolated: !!filter.hideIsolated,
        focusSchemas: filter.focusSchemas || [],
        showExternalRefs: !!filter.showExternalRefs,
        externalRefTypes: filter.externalRefTypes || [],
        exclusionPatterns: filter.exclusionPatterns || [],
      };

      const mode = data.targetColumns ? 'column_trace' : 'blackboard';
      const engineLog = (l: 'info' | 'debug' | 'warn' | 'trace', msg: string) => {
        const line = `[Engine] ${msg}`;
        if (l === 'debug' || l === 'trace') this.logger.debug(line);
        else if (l === 'warn') this.logger.warn(line);
        else this.logger.info(line);
      };
      const engine = new NavigationEngine(m, g, engineLog, mode, { activeFilter, memory: sess.memory }, sess.columnStore);
      
      engine.sessionId = sess.id;
      sess.stateMachine = engine;

      const excludeTypes: string[] = Array.isArray(data.excludeTypes)
        ? (data.excludeTypes as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];

      const initResult = engine.init({
        question: data.question || 'Explore lineage',
        origin: data.origin,
        targetColumns: data.targetColumns,
        direction: data.direction || 'bidirectional',
        depth: data.depth,
        depth_enforcement: data.depth_enforcement,
        excludeTypes,
        mission_brief: typeof data.mission_brief === 'string' ? data.mission_brief : undefined,
      });

      if ('error' in initResult) return this.logAndReturn('start_exploration', initResult, input);

      const scopeDdlChars = engine.estimateScopeDdlChars();
      const useInline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
      if (useInline) {
        engine.setInlineMode(true);
        if (!sess.classification) {
          const parsed = ClassificationSchema.safeParse(data.classification);
          sess.setClassification(parsed.success ? parsed.data : 'business');
          this.logger.info(`[${sess.id}] [Classification] fired=${sess.classification} (inline mode, AI-declared)`);
        }
      } else {
        const aiCfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
        const maxRounds = aiCfg.get<number>('maxRounds', 50);
        const SAFETY_RATIO = 0.7;
        const safeMax = Math.max(1, Math.floor(maxRounds * SAFETY_RATIO));
        if (initResult.scopeSize > safeMax) {
          const safeDepth = suggestNarrowerDepth(g, data.origin, data.direction || 'bidirectional', safeMax);
          sess.resetExploration();
          return this.logAndReturn('start_exploration', {
            error: 'scope_exceeds_budget',
            scope_size: initResult.scopeSize,
            max_rounds: maxRounds,
            safe_max_hops: safeMax,
            safe_depth_hint: safeDepth,
            hint: `Scope has ${initResult.scopeSize} nodes; sliding-memory budget allows ~${safeMax} hops (of ${maxRounds} with 30% reserve). Restart with depth=${safeDepth || 1}, narrow the direction, or raise 'dataLineageViz.ai.maxRounds'.`,
            next_action: 'retry_with_smaller_depth',
          }, input);
        }

        if (sess.phase.kind === 'idle') {
          if (!sess.classification) {
            const parsed = ClassificationSchema.safeParse(data.classification);
            sess.setClassification(parsed.success ? parsed.data : 'business');
          }
          const hopCtx = engine.getHopContext();
          const direction = data.direction || 'bidirectional';
          const gate = PendingGateSchema.parse({
            gate: 'confirm_sm_start',
            classes: ['sliding_memory'],
            nodeIds: [],
            detail: `Large task — ${initResult.scopeSize} nodes to analyze, budget ~${safeMax} hops.\n` +
                    `Analysis: ${CLASSIFICATION_LABEL[sess.classification!]}\n` +
                    `Schemas in scope: ${activeFilter.schemas.join(', ') || '(none filtered)'}\n` +
                    `Depth: ${data.depth ?? 'default'} (${data.depth_enforcement ?? 'silent'} enforcement)\n` +
                    `Direction: ${direction}`,
          });
          return this.logAndReturn('start_exploration', {
            error: 'action_required',
            ...gate,
            hop_context: hopCtx,
            hint: 'Tool paused — awaiting user confirmation before first hop. Hop context delivered for use after approval.',
          }, input);
        }
      }

      const hopResult = engine.getHopContext();
      return this.logAndReturn('start_exploration', { ...initResult, ...hopResult }, input);
    } catch (err) {
      const sess = this.getSession();
      sess.stateMachine = null;
      sess.startExplorationRoundId = null;
      return this.toolError('start_exploration', err);
    }
  }

  public submitFindings(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) return this.logAndReturn('submit_findings', {
        error: 'no_active_session',
        hint: 'No active state machine. Call start_exploration first to begin a hop-by-hop investigation.',
        next_action: 'start_exploration',
      }, input);

      const inputErr = validateToolInput(input, { focus_node_id: 'string', detail_analysis: 'string', summary: 'string' });
      if (inputErr) return this.toolResult(inputErr);

      const result = engine.submitFindings(input);
      if ('error' in result) return this.logAndReturn('submit_findings', result, input);

      if ('done' in result && result.done && result.result) {
        sess.storeBbResult(result.result);
        return this.logAndReturn('submit_findings', result, input);
      }

      const diag = engine.getHopDiagnostics();
      this.logger.debug(
        `[Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} ` +
        `verdict=${input.verdict} detail=${diag.detailChars} summary=${diag.summaryChars} archive=${diag.archiveChars} ` +
        `routed=${diag.routedNew}/${diag.routedRejected} agenda=${diag.agendaRemaining}`
      );

      const nextHop = engine.getHopContext();
      if (nextHop.done) {
        const finalResult = engine.getResult();
        sess.storeBbResult(finalResult);
        if (!sess.classification) sess.setClassification('business');
        const synthesisReminder = buildSynthesisReminder(sess.memory.getUserQuestion(), sess.classification, sess.outputTemplates.technical_subsection);
        return this.logAndReturn('submit_findings', {
          ok: true,
          done: true,
          result: finalResult,
          deferred_questions: sess.stateMachine?.deferredQuestions ?? [],
          synthesis_reminder: synthesisReminder,
        }, input);
      }
      return this.logAndReturn('submit_findings', nextHop, input);
    } catch (err) { return this.toolError('submit_findings', err); }
  }

  public async presentResult(input: PresentResultInput) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const model = this.requireModel();

      if (input.sections !== undefined && !Array.isArray(input.sections)) input.sections = undefined;
      if (input.notes !== undefined && !Array.isArray(input.notes)) input.notes = undefined;
      if (input.add_node_ids !== undefined && !Array.isArray(input.add_node_ids)) input.add_node_ids = undefined;
      if (input.prune_node_ids !== undefined && !Array.isArray(input.prune_node_ids)) input.prune_node_ids = undefined;
      if (input.highlight_groups !== undefined && !Array.isArray(input.highlight_groups)) input.highlight_groups = undefined;

      if (!sess.resultGraph) {
        return this.logAndReturn('present_result', {
          success: false,
          errors: ['No state-machine result available — present_result requires a completed blackboard or column_trace exploration.'],
        }, input);
      }

      let resolvedNodeIds: string[] = [...sess.resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...sess.resultGraph.edges];
      const graphSource = sess.resultGraph.source;

      if (input.is_update && input.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const toAdd = input.add_node_ids.filter(id => model.nodes.some(n => n.id === id) && !currentSet.has(id));
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);
      }

      if (input.prune_node_ids?.length) {
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, input.prune_node_ids);
        resolvedNodeIds = pruned.nodeIds;
        resolvedEdges = pruned.edges;
      }

      if (sess.resultGraph.notes?.length) {
        const userNoteIds = new Set((input.notes ?? []).map(n => (n as { node_id: string }).node_id));
        const resolvedSet = new Set(resolvedNodeIds);
        const autoNotes: Array<{ node_id: string; text: string }> = [];
        for (const { nodeId, summary } of sess.resultGraph.notes) {
          if (resolvedSet.has(nodeId) && !userNoteIds.has(nodeId) && summary) {
            autoNotes.push({ node_id: nodeId, text: summary });
          }
        }
        if (autoNotes.length > 0) input.notes = [...(input.notes ?? []), ...autoNotes];
      }

      if (sess.resultGraph.suggested_labels?.length && input.sections?.length) {
        const hasNodeIds = input.sections.some(s => s.node_ids && s.node_ids.length > 0);
        if (!hasNodeIds) {
          const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
          const labelToNodeIds = new Map<string, string[]>();
          for (const sl of sess.resultGraph.suggested_labels) {
            if (!sl.text) continue;
            const label = stripNum(sl.text);
            if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, []);
            labelToNodeIds.get(label)!.push(sl.node_id);
          }
          input.sections = input.sections.map(sec => {
            const ids = labelToNodeIds.get(stripNum(sec.label));
            return ids?.length ? { ...sec, node_ids: ids } : sec;
          });
        }
      }

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      if (input.sections?.length) {
        const originId = sess.resultGraph?.originNodeId;
        const nodeMap = new Map<string, LineageNode>((model.nodes as LineageNode[]).map(n => [n.id, n]));
        const metadataBand = originId ? renderMetadataBand(originId, nodeMap, input.loading_pattern) : '';
        const assembled = orderAndAssemble(input.sections, { title: input.title, intro: input.intro, closing: input.closing, metadataBand, nodeMap });
        assembledBadges = assembled.badges;
        if (!input.description) input.description = assembled.description;
        input.sections = undefined;
      }

      const { input: fixedInput } = autoFixPresentResult(model, input, resolvedNodeIds);
      const validation = validatePresentResult(fixedInput, resolvedNodeIds, assembledBadges);

      if (!validation.success) return this.logAndReturn('present_result', validation, input);

      const aiMetadata: AIViewMetadata = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName || 'unknown',
        highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
        badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
        notes: validation.notes.map(n => ({ nodeId: n.node_id, text: n.text })),
        layoutDirection: validation.layout_direction,
      };

      const panel = this.getPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata });
        panel.reveal(vscode.ViewColumn.One);
      }

      if (input.is_update && sess.resultGraph) {
        sess.resultGraph.nodeIds = resolvedNodeIds;
        sess.resultGraph.edges = resolvedEdges;
        const existingNotes = new Map((sess.resultGraph.notes ?? []).map(n => [n.nodeId, n]));
        for (const n of validation.notes) existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
        sess.resultGraph.notes = Array.from(existingNotes.values());
      }
      sess.lastPresentResultDescription = validation.description ?? null;

      this.logger.info(`AI view "${validation.name}" displayed (${validation.node_ids.length} objects)`);
      return this.logAndReturn('present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, input);
    } catch (err) { return this.toolError('present_result', err); }
  }

  public runBfsTrace(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const { id, upstream_hops, downstream_hops, types, schemas, include_ddl, target } = input;
      const result = runBfsTrace(this.requireModel(), this.requireGraph(), id, upstream_hops ?? 3, downstream_hops ?? 3, types, schemas, include_ddl ?? true, this.getSession().columnStore, target);
      return this.logAndReturn('run_bfs_trace', result, input);
    } catch (err) { return this.toolError('run_bfs_trace', err); }
  }

  public getObjectDetail(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { id: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { id } = input;
      return this.logAndReturn('get_object_detail', getObjectDetail(this.requireModel(), id, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('get_object_detail', err); }
  }

  public runAnalysis(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { type: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { type, min_degree, max_size } = input;
      const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
      const resolvedMinDegree = min_degree ?? anaCfg.get<number>('analysis.hubMinDegree');
      const resolvedMaxSize   = max_size   ?? anaCfg.get<number>('analysis.islandMaxSize');
      const resolvedLongestPath = anaCfg.get<number>('analysis.longestPathMinNodes');
      return this.logAndReturn('run_analysis', runAnalysis(this.requireModel(), this.requireGraph(), type as AnalysisType, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), input);
    } catch (err) { return this.toolError('run_analysis', err); }
  }

  public searchDdl(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types } = input;
      return this.logAndReturn('search_ddl', searchDdl(this.requireModel(), query, types, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('search_ddl', err); }
  }

  public getDdlBatch(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const { ids } = input;
      if (!Array.isArray(ids)) return this.toolResult({ error: 'invalid_input', message: 'ids must be an array' });
      return this.logAndReturn('get_ddl_batch', getDdlBatch(this.requireModel(), ids, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('get_ddl_batch', err); }
  }
}

/**
 * Registers all language model tools associated with the `@lineage` chat participant.
 *
 * @remarks
 * This function is the "central registration point for the AI toolset. It consolidates
 * various lineage operations (searching, tracing, exploring) into a set of VS Code
 * language model tools.
 *
 * It manages the lifecycle of the `NavigationEngine` for multi-hop exploration and
 * provides a unified logging and error-handling wrapper around tool invocations.
 *
 * @param getSession - A factory function to retrieve the current active AI session.
 * @param outputChannel - The log output channel for tracing tool activity.
 * @param getPanel - A function to retrieve the currently active webview panel.
 * @returns An array of disposables representing the registered tools.
 */
export function registerAiTools(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined
): vscode.Disposable[] {
  const handler = new ToolHandler(getSession, outputChannel, getPanel);

  return [
    vscode.lm.registerTool('lineage_get_context', {
      prepareInvocation(_options, _token) { return { invocationMessage: 'Loading lineage context…' }; },
      invoke(options, _token) { return handler.getContext(options.input); },
    }),

    vscode.lm.registerTool('lineage_search_objects', {
      prepareInvocation(options, _token) { return { invocationMessage: `Searching for "${(options.input as any).query}"…` }; },
      invoke(options, _token) { return handler.searchObjects(options.input); },
    }),

    vscode.lm.registerTool('lineage_start_exploration', {
      prepareInvocation(_options, _token) { return { invocationMessage: 'Starting exploration…' }; },
      invoke(options, _token) { return handler.startExploration(options.input); },
    }),

    vscode.lm.registerTool('lineage_submit_findings', {
      prepareInvocation(options, _token) {
        const input = options.input as any;
        const name = input.focus_node_id?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
        return { invocationMessage: `Analyzing ${name}…` };
      },
      invoke(options, _token) { return handler.submitFindings(options.input); },
    }),

    vscode.lm.registerTool('lineage_present_result', {
      prepareInvocation(_options, _token) { return { invocationMessage: 'Creating AI lineage view…' }; },
      invoke(options, _token) { return handler.presentResult(options.input as PresentResultInput); },
    }),

    vscode.lm.registerTool('lineage_run_bfs_trace', {
      prepareInvocation(options, _token) { return { invocationMessage: 'Running structural trace…' }; },
      invoke(options, _token) { return handler.runBfsTrace(options.input); },
    }),

    vscode.lm.registerTool('lineage_get_object_detail', {
      prepareInvocation(options, _token) { return { invocationMessage: `Loading detail for ${(options.input as any).id}…` }; },
      invoke(options, _token) { return handler.getObjectDetail(options.input); },
    }),

    vscode.lm.registerTool('lineage_run_analysis', {
      prepareInvocation(options, _token) { return { invocationMessage: `Running analysis: ${(options.input as any).type}…` }; },
      invoke(options, _token) { return handler.runAnalysis(options.input); },
    }),

    vscode.lm.registerTool('lineage_search_ddl', {
      prepareInvocation(options, _token) { return { invocationMessage: `Searching DDL for "${(options.input as any).query}"…` }; },
      invoke(options, _token) { return handler.searchDdl(options.input); },
    }),

    vscode.lm.registerTool('lineage_get_ddl_batch', {
      prepareInvocation(options, _token) { return { invocationMessage: `Fetching DDL for ${(options.input as any).ids?.length ?? 0} objects…` }; },
      invoke(options, _token) { return handler.getDdlBatch(options.input); },
    }),
  ];
}
