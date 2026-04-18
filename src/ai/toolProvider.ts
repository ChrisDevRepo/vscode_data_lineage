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
  type EnrichViewInput,
} from './tools';
import { ViewSynthesisService } from './viewSynthesisService';
import { type ObjectType, type AnalysisType, type DatabaseModel } from '../engine/types';
import { type SerializedFilterState } from '../engine/projectStore';
import { PendingGateSchema } from './sessionPhase';

/**
 * Registers all language model tools associated with the `@lineage` chat participant.
 *
 * @remarks
 * This function is the central registration point for the AI toolset. It consolidates
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
  const logger = Logger.create(outputChannel, 'AI');

  
  function isAiEnabled(): boolean {
    return vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled') ?? true;
  }

  function requireModel(): DatabaseModel {
    const m = getSession().model;
    if (!m) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return m;
  }

  function requireGraph(): Graph {
    const g = getSession().graph;
    if (!g) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return g;
  }

  function toolResult(data: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
  }

  function logAndReturn(toolName: string, data: object, input?: any): vscode.LanguageModelToolResult {
    const sess = getSession();
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), 300);

    if (input !== undefined) {
      const inputJson = trunc(sanitizeForLog(JSON.stringify(input)), 300);
      logger.debug(`Invoking ${toolName} — input: ${inputJson}`);
    }

    sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });

    const isError = 'error' in data || ('success' in data && !(data as any).success);
    if (isError) logger.warn(`${toolName}: ${preview}`);
    logger.debug(`${toolName} → ${chars} chars: ${preview}`);
    return toolResult(data);
  }

  function toolError(toolName: string, err: unknown): vscode.LanguageModelToolResult {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${toolName}: unhandled`, err instanceof Error ? err : new Error(msg));
    return toolResult({ error: 'internal_error', tool: toolName, message: msg });
  }

  const disabled = () => toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' });

  
  return [
    vscode.lm.registerTool('lineage_get_context', {
      prepareInvocation(_options, _token) { return { invocationMessage: 'Loading lineage context…' }; },
      invoke(_options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const ctx = getContext(requireModel(), sess.filter, sess.projectName, sess.views, sess.columnStore);
          return logAndReturn('get_context', ctx, _options.input);
        } catch (err) { return toolError('get_context', err); }
      },
    }),

    vscode.lm.registerTool('lineage_search_objects', {
      prepareInvocation(options, _token) { return { invocationMessage: `Searching for "${(options.input as any).query}"…` }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { query, types, schemas, mode } = options.input as any;
          return logAndReturn('search_objects', searchObjects(requireModel(), query, types, schemas, mode ?? 'substring', getSession().filter), options.input);
        } catch (err) { return toolError('search_objects', err); }
      },
    }),

    vscode.lm.registerTool('lineage_start_exploration', {
      prepareInvocation(_options, _token) { return { invocationMessage: 'Starting exploration…' }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const input = options.input as any;

          sess.resetIfStale();

          // Mechanical parallel-call guard: reject calls 2..N of start_exploration within one LM round.
          // Prompt-level "Do NOT call start_exploration" hints have been observed to be ignored across
          // models (see docs/AI_ARCHITECTURE.md "Known Failure Modes"). This is the structural enforcement.
          if (sess.startExplorationRoundId !== null && sess.startExplorationRoundId === sess.currentRoundId) {
            return logAndReturn('start_exploration', {
              error: 'parallel_call_forbidden',
              hint: 'start_exploration is strictly serial and one-shot per round. Use submit_findings for the queued neighbors — after complete_rejected they are queued at priority 3 and will be served on the next submit_findings.',
              next_action: 'submit_findings',
            }, options.input);
          }
          // Stamp the round BEFORE running: any subsequent parallel call in this same round is rejected.
          sess.startExplorationRoundId = sess.currentRoundId;

          const prior = sess.stateMachine as NavigationEngine | null;
          const priorLive = !!prior && prior.status !== 'complete';
          if (priorLive && prior!.sessionId && prior!.sessionId !== sess.id) {
            sess.pendingUserNotice.add(
              'A previous exploration was still running when you started this one. Its in-memory findings were discarded.'
            );
            sess.resetExploration();
            sess.startExplorationRoundId = sess.currentRoundId;
          } else if (priorLive && prior!.sessionId === sess.id) {
            return logAndReturn('start_exploration', {
              error: 'already_started',
              hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 — the next submit_findings will present one of them.',
              next_action: 'submit_findings',
            }, options.input);
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

          const mode = input.targetColumns ? 'column_trace' : 'blackboard';
          const engineLog = (l: 'info' | 'debug' | 'warn' | 'trace', msg: string) => {
            const line = `[Engine] ${msg}`;
            if (l === 'debug' || l === 'trace') logger.debug(line);
            else if (l === 'warn') logger.warn(line);
            else logger.info(line);
          };
          const engine = new NavigationEngine(m, g, engineLog, mode, { activeFilter, memory: sess.memory }, sess.columnStore);
          
          engine.sessionId = sess.id;
          sess.stateMachine = engine;

          const initResult = engine.init({
            question: input.question || 'Explore lineage',
            origin: input.origin,
            targetColumns: input.targetColumns,
            direction: input.direction || 'bidirectional',
            depth: input.depth,
            depth_enforcement: input.depth_enforcement,
          });

          if ('error' in initResult) return logAndReturn('start_exploration', initResult, options.input);

          const scopeDdlChars = engine.estimateScopeDdlChars();
          const useInline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
          if (useInline) {
            engine.setInlineMode(true);
          } else {
            // Sliding-memory preflight: compare initial BFS scope against the user-configured round budget.
            // Reserve 30% of rounds for retries, route rejections, cascade prunes, and synthesis.
            const aiCfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
            const maxRounds = aiCfg.get<number>('maxRounds', 50);
            const SAFETY_RATIO = 0.7;
            const safeMax = Math.max(1, Math.floor(maxRounds * SAFETY_RATIO));
            if (initResult.scopeSize > safeMax) {
              const safeDepth = suggestNarrowerDepth(g, input.origin, input.direction || 'bidirectional', safeMax);
              sess.resetExploration();
              return logAndReturn('start_exploration', {
                error: 'scope_exceeds_budget',
                scope_size: initResult.scopeSize,
                max_rounds: maxRounds,
                safe_max_hops: safeMax,
                safe_depth_hint: safeDepth,
                hint: `Scope has ${initResult.scopeSize} nodes; sliding-memory budget allows ~${safeMax} hops (of ${maxRounds} with 30% reserve). Restart with depth=${safeDepth || 1}, narrow the direction, or raise 'dataLineageViz.ai.maxRounds'.`,
                next_action: 'retry_with_smaller_depth',
              }, options.input);
            }

            // SM-entry consent gate: prime the engine BEFORE emitting the envelope so that when
            // the user approves on the next turn, the AI's first submit_findings lands on an
            // already-primed engine (status='awaiting_findings'). Including hop_context in the
            // envelope lets the AI pick focus_node_id from its history without any further
            // engine mutation on resume — pure trust-on-yes.
            //
            // State mutation before consent is safe: on no/redirect, sess.resetExploration() in
            // the participant discards the engine entirely.
            if (sess.phase.kind === 'idle') {
              const hopCtx = engine.getHopContext();
              const direction = input.direction || 'bidirectional';
              const gate = PendingGateSchema.parse({
                gate: 'confirm_sm_start',
                classes: ['sliding_memory'],
                nodeIds: [],
                detail:
                  `Large task — ${initResult.scopeSize} nodes to analyze, budget ~${safeMax} hops.\n` +
                  `Schemas in scope: ${activeFilter.schemas.join(', ') || '(none filtered)'}\n` +
                  `Depth: ${input.depth ?? 'default'} (${input.depth_enforcement ?? 'silent'} enforcement)\n` +
                  `Direction: ${direction}`,
              });
              logger.info(`[${sess.id}] Session-start scope=${initResult.scopeSize} agenda=${initResult.agendaSize} depth=${input.depth ?? 'default'} enforcement=${input.depth_enforcement ?? 'silent'} mode=sm schemas=${activeFilter.schemas.length} (primed, awaiting confirm_sm_start)`);
              return logAndReturn('start_exploration', {
                error: 'action_required',
                ...gate,
                hop_context: hopCtx,
                hint: 'Tool paused — awaiting user confirmation before first hop. Hop context delivered for use after approval.',
              }, options.input);
            }
          }

          logger.info(`[${sess.id}] Session-start scope=${initResult.scopeSize} agenda=${initResult.agendaSize} depth=${input.depth ?? 'default'} enforcement=${input.depth_enforcement ?? 'silent'} mode=${useInline ? 'inline' : 'sm'} schemas=${activeFilter.schemas.length}`);

          const hopResult = engine.getHopContext();
          return logAndReturn('start_exploration', { ...initResult, ...hopResult }, options.input);
        } catch (err) { return toolError('start_exploration', err); }
      },
    }),

    vscode.lm.registerTool('lineage_submit_findings', {
      prepareInvocation(options, _token) {
        const input = options.input as any;
        const name = input.focus_node_id?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
        return { invocationMessage: `Analyzing ${name}…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const engine = sess.stateMachine as NavigationEngine | null;
          if (!engine) return logAndReturn('submit_findings', {
            error: 'no_active_session',
            hint: 'No active state machine. Call start_exploration first to begin a hop-by-hop investigation. If the session was idle for 30 minutes or completed previously, it was auto-reset.',
            next_action: 'start_exploration',
          }, options.input);

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', detail_analysis: 'string', summary: 'string' });
          if (inputErr) return toolResult(inputErr);

          const result = engine.submitFindings(options.input as any);
          if ('error' in result) return logAndReturn('submit_findings', result, options.input);

          // Inline-mode `complete=true` shortcut: engine has already set done + result.
          if ('done' in result && result.done && result.result) {
            sess.storeBbResult(result.result);
            return logAndReturn('submit_findings', result, options.input);
          }

          // Structured per-hop diagnostic line. See .claude/rules/logging.md ([AI] [Hop N]).
          const diag = engine.getHopDiagnostics();
          logger.debug(
            `[Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} ` +
            `verdict=${(options.input as any).verdict} detail=${diag.detailChars} summary=${diag.summaryChars} archive=${diag.archiveChars} ` +
            `routed=${diag.routedNew}/${diag.routedRejected}/${diag.routedDeferred} deferred_queued=${diag.deferredQueued} agenda=${diag.agendaRemaining} ` +
            `tally=R${diag.tally.relevant}/P${diag.tally.pass}/I${diag.tally.irrelevant} ` +
            `expansions=${diag.scopeExpansions} allowed_schemas=${diag.allowedSchemaCount}`
          );

          const nextHop = engine.getHopContext();
          if (nextHop.done) {
            // SM sliding-memory: the last verdict drained the agenda. Deliver the final result
            // in the same call so the model can synthesize + call enrich_view without another round.
            const finalResult = engine.getResult();
            sess.storeBbResult(finalResult);
            return logAndReturn('submit_findings', { ok: true, done: true, result: finalResult }, options.input);
          }

          return logAndReturn('submit_findings', nextHop, options.input);
        } catch (err) { return toolError('submit_findings', err); }
      },
    }),

    vscode.lm.registerTool('lineage_enrich_view', {
      prepareInvocation(options, _token) { return { invocationMessage: 'Creating AI lineage view…' }; },
      async invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const service = new ViewSynthesisService(sess, getPanel, logger);
          const result = service.synthesizeView(requireModel(), options.input as any);
          return logAndReturn('enrich_view', result, options.input);
        } catch (err) { return toolError('enrich_view', err); }
      },
    }),

    vscode.lm.registerTool('lineage_run_bfs_trace', {
      prepareInvocation(options, _token) { return { invocationMessage: 'Running structural trace…' }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const { id, upstream_hops, downstream_hops, types, schemas, include_ddl, target } = options.input as any;
          const result = runBfsTrace(requireModel(), requireGraph(), id, upstream_hops ?? 3, downstream_hops ?? 3, types, schemas, include_ddl ?? true, getSession().columnStore, target);
          return logAndReturn('run_bfs_trace', result, options.input);
        } catch (err) { return toolError('run_bfs_trace', err); }
      },
    }),

    vscode.lm.registerTool('lineage_get_object_detail', {
      prepareInvocation(options, _token) { return { invocationMessage: `Loading detail for ${(options.input as any).id}…` }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const inputErr = validateToolInput(options.input, { id: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { id } = options.input as any;
          return logAndReturn('get_object_detail', getObjectDetail(requireModel(), id, getSession().columnStore), options.input);
        } catch (err) { return toolError('get_object_detail', err); }
      },
    }),

    vscode.lm.registerTool('lineage_run_analysis', {
      prepareInvocation(options, _token) { return { invocationMessage: `Running analysis: ${(options.input as any).type}…` }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const inputErr = validateToolInput(options.input, { type: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { type, min_degree, max_size } = options.input as any;
          const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
          const resolvedMinDegree = min_degree ?? anaCfg.get<number>('analysis.hubMinDegree');
          const resolvedMaxSize   = max_size   ?? anaCfg.get<number>('analysis.islandMaxSize');
          const resolvedLongestPath = anaCfg.get<number>('analysis.longestPathMinNodes');
          return logAndReturn('run_analysis', runAnalysis(requireModel(), requireGraph(), type as AnalysisType, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), options.input);
        } catch (err) { return toolError('run_analysis', err); }
      },
    }),

    vscode.lm.registerTool('lineage_search_ddl', {
      prepareInvocation(options, _token) { return { invocationMessage: `Searching DDL for "${(options.input as any).query}"…` }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { query, types } = options.input as any;
          return logAndReturn('search_ddl', searchDdl(requireModel(), query, types, getSession().columnStore), options.input);
        } catch (err) { return toolError('search_ddl', err); }
      },
    }),

    vscode.lm.registerTool('lineage_get_ddl_batch', {
      prepareInvocation(options, _token) { return { invocationMessage: `Fetching DDL for ${(options.input as any).ids?.length ?? 0} objects…` }; },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const { ids } = options.input as any;
          if (!Array.isArray(ids)) return toolResult({ error: 'invalid_input', message: 'ids must be an array' });
          return logAndReturn('get_ddl_batch', getDdlBatch(requireModel(), ids, getSession().columnStore), options.input);
        } catch (err) { return toolError('get_ddl_batch', err); }
      },
    }),
  ];
}
