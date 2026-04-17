import * as vscode from 'vscode';
import type Graph from 'graphology';
import { NavigationEngine } from './smBase';
import type { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import {
  shouldSmInline,
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch,
  validateToolInput,
  type EnrichViewInput,
} from './tools';
import { ViewSynthesisService } from './viewSynthesisService';
import { buildSynthesisReminder } from './smPrompts';
import { type ObjectType, type AnalysisType, type DatabaseModel } from '../engine/types';
import { type SerializedFilterState } from '../engine/projectStore';

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
      prepareInvocation(_options, _token) {
        const sess = getSession();
        if (sess.stateMachine && sess.stateMachine.status !== 'complete' && !sess.isStale()) {
          return { invocationMessage: 'Starting exploration…', confirmationMessages: { title: 'Wipe active exploration?', message: new vscode.MarkdownString('An active exploration exists. Continue and wipe progress?') } };
        }
        return { invocationMessage: 'Starting exploration…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const input = options.input as any;
          
          sess.resetIfStale();

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
            initial_summary: input.initial_summary
          });

          if ('error' in initResult) return logAndReturn('start_exploration', initResult, options.input);

          const scopeDdlChars = engine.estimateScopeDdlChars();
          if (shouldSmInline(scopeDdlChars, initResult.scopeSize)) engine.setInlineMode(true);
          
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
          if (!engine) return logAndReturn('submit_findings', { error: 'no_active_session' }, options.input);

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', narrative_update: 'string', detail_analysis: 'string', summary: 'string' });
          if (inputErr) return toolResult(inputErr);

          const result = engine.submitFindings(options.input as any);
          if ('error' in result) return logAndReturn('submit_findings', result, options.input);

          if (result.early_complete) {
            sess.storeBbResult(result.early_complete);
            return logAndReturn('submit_findings', result.early_complete, options.input);
          }

          const nextHop = engine.getHopContext();
          if (nextHop.done) {
            const finalResult = engine.getResult();
            sess.storeBbResult(finalResult);
            return logAndReturn('submit_findings', finalResult, options.input);
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
