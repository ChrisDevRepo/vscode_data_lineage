import * as vscode from 'vscode';
import type Graph from 'graphology';
import { ColumnTraceState } from './columnTraceState';
import { BlackboardState } from './blackboardState';
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
import { edgeApiType } from './aiPresenter';
import { buildSynthesisReminder } from './smPrompts';
import { type ObjectType, type AnalysisType, type DatabaseModel } from '../engine/types';
import { type AIViewMetadata, type SerializedFilterState } from '../engine/projectStore';
import { type IHopStateMachine } from './smBase';

/**
 * Registers all 12 @lineage AI Language Model tools.
 * Returns an array of disposables to be added to context.subscriptions.
 */
export function registerAiTools(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined
): vscode.Disposable[] {
  const logger = Logger.create(outputChannel, 'AI');

  // ─── Helpers ───────────────────────────────────────────────────────────────

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
    
    // Capture in hop log for regression testing
    sess.hopLog.push({
      tool: toolName,
      input: input,
      output: data,
      timestamp: new Date().toISOString()
    });

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

  function validateSchemas(m: DatabaseModel, inputSchemas?: string[]): { valid: Set<string> | null; error?: string } {
    if (!inputSchemas || inputSchemas.length === 0) return { valid: null };
    const validNames = new Set(m.schemas.map(s => s.name.toLowerCase()));
    const invalid = inputSchemas.filter(s => !validNames.has(s.toLowerCase()));
    if (invalid.length > 0) {
      return { 
        valid: null, 
        error: `Invalid schemas provided: ${invalid.join(', ')}. Available schemas: ${[...validNames].join(', ')}` 
      };
    }
    return { valid: new Set(inputSchemas.map(s => s.toLowerCase())) };
  }

  // ─── Registrations ─────────────────────────────────────────────────────────

  return [
    vscode.lm.registerTool('lineage_get_context', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Loading lineage context…' };
      },
      invoke(_options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const ctx = getContext(m, sess.filter, sess.projectName, sess.views, sess.columnStore);
          return logAndReturn('get_context', ctx, _options.input);
        } catch (err) { return toolError('get_context', err); }
      },
    }),

    vscode.lm.registerTool('lineage_search_objects', {
      prepareInvocation(options, _token) {
        const { query } = options.input as { query: string };
        return { invocationMessage: `Searching for "${query}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { query, types, schemas, mode } = options.input as {
            query: string; types?: string[]; schemas?: string[];
            mode?: 'substring' | 'regex';
          };
          return logAndReturn('search_objects', searchObjects(m, query, types as ObjectType[] | undefined, schemas, mode ?? 'substring', sess.filter), options.input);
        } catch (err) { return toolError('search_objects', err); }
      },
    }),

    vscode.lm.registerTool('lineage_get_object_detail', {
      prepareInvocation(options, _token) {
        const { id } = options.input as { id: string };
        return { invocationMessage: `Getting details for "${id}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { id: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { id } = options.input as { id: string };
          return logAndReturn('get_object_detail', getObjectDetail(m, id, sess.columnStore), options.input);
        } catch (err) { return toolError('get_object_detail', err); }
      },
    }),

    vscode.lm.registerTool('lineage_run_bfs_trace', {
      prepareInvocation(options, _token) {
        const { id, upstream_hops, downstream_hops } = options.input as { id: string; upstream_hops?: number; downstream_hops?: number };
        return { invocationMessage: `Tracing lineage from "${id}" (↑${upstream_hops ?? 3} ↓${downstream_hops ?? 3} hops)…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { id: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { id, upstream_hops, downstream_hops, types, schemas, include_ddl, target } =
            options.input as {
              id: string; upstream_hops?: number; downstream_hops?: number;
              types?: string[]; schemas?: string[];
              include_ddl?: boolean; target?: string;
            };
          const bfsResult = runBfsTrace(m, g, id, upstream_hops ?? 3, downstream_hops ?? 3,
            types as ObjectType[] | undefined, schemas, include_ddl ?? true, sess.columnStore, target) as Record<string, unknown>;
          return logAndReturn('run_bfs_trace', bfsResult, options.input);
        } catch (err) { return toolError('run_bfs_trace', err); }
      },
    }),

    vscode.lm.registerTool('lineage_run_analysis', {
      prepareInvocation(options, _token) {
        const { type } = options.input as { type: string };
        return { invocationMessage: `Running ${type} analysis…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { type: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { type, min_degree, max_size } = options.input as {
            type: string; min_degree?: number; max_size?: number;
          };
          return logAndReturn('run_analysis', runAnalysis(m, g, type as AnalysisType, min_degree, max_size), options.input);
        } catch (err) { return toolError('run_analysis', err); }
      },
    }),

    vscode.lm.registerTool('lineage_search_ddl', {
      prepareInvocation(options, _token) {
        const { query } = options.input as { query: string };
        return { invocationMessage: `Searching DDL for "${trunc(query, 40)}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) return toolResult(inputErr);
          const { query, types } = options.input as { query: string; types?: string[] };
          return logAndReturn('search_ddl', searchDdl(m, query, types as ('view' | 'procedure' | 'function')[] | undefined, sess.columnStore), options.input);
        } catch (err) { return toolError('search_ddl', err); }
      },
    }),

    vscode.lm.registerTool('lineage_enrich_view', {
      prepareInvocation(options, _token) {
        const input = options.input as EnrichViewInput;
        const sess = getSession();
        const source = sess.resultGraph ? sess.resultGraph.source : 'manual';
        const nodeCount = sess.resultGraph ? sess.resultGraph.nodeIds.length : 0;
        const msg = input.is_update ? `Updating view "${input.name}"…` : `Enrich view "${input.name}" (${nodeCount} nodes from ${source})`;
        return {
          invocationMessage: msg,
          confirmationMessages: {
            title: input.is_update ? 'Update AI lineage view?' : 'Create AI lineage view?',
            message: new vscode.MarkdownString(
              `**${input.name ?? 'Unnamed'}** · ${nodeCount} nodes\n\nSaved to project and applied.`
            ),
          },
        };
      },
      async invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          requireGraph();
          const inputErr = validateToolInput(options.input, { name: 'string' });
          if (inputErr) return toolResult(inputErr);
          const rawInput = options.input as EnrichViewInput;

          const service = new ViewSynthesisService(sess, getPanel);
          const result = service.synthesizeView(m, rawInput);
          
          return logAndReturn('enrich_view', result, options.input);
        } catch (err) { return toolError('enrich_view', err); }
      },
    }),

    vscode.lm.registerTool('lineage_get_ddl_batch', {
      prepareInvocation(options, _token) {
        const { ids } = options.input as { ids: string[] };
        return { invocationMessage: `Loading DDL for ${ids.length} object(s)…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { ids: 'array' });
          if (inputErr) return toolResult(inputErr);
          const { ids } = options.input as { ids: string[] };
          return logAndReturn('get_ddl_batch', getDdlBatch(m, ids, sess.columnStore), options.input);
        } catch (err) { return toolError('get_ddl_batch', err); }
      },
    }),

    vscode.lm.registerTool('lineage_start_column_trace', {
      prepareInvocation(_options, _token) {
        const sess = getSession();
        // Condition: Show confirmation ONLY if there is an active session (not complete) AND it's not stale (< 2 hours)
        if (sess.stateMachine && sess.stateMachine.status !== 'complete' && !sess.isStale()) {
          return {
            invocationMessage: 'Starting column-level trace…',
            confirmationMessages: {
              title: 'Wipe active exploration?',
              message: new vscode.MarkdownString(
                'There is an active exploration in another chat or previous context. Starting a new one will wipe the current progress. Continue?'
              ),
            },
          };
        }
        return { invocationMessage: 'Starting column-level trace…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { columns: 'array' });
          if (inputErr) return toolResult(inputErr);
          const input = options.input as { columns?: string[]; direction?: string; origin?: string; depth?: number; schemas?: string[]; initial_summary?: string };
          const columns = input.columns ?? [];
          const direction = (input.direction ?? 'up') as 'up' | 'down' | 'both';
          const depth = typeof input.depth === 'number' ? Math.max(1, Math.min(Math.round(input.depth), 20)) : 5;

          // Silently reset if stale or complete (user already confirmed or no confirmation needed)
          sess.resetIfStale();

          // Validate and prepare schema override
          const schemaVal = validateSchemas(m, input.schemas);
          if (schemaVal.error) return toolResult({ error: 'invalid_schemas', message: schemaVal.error });

          const filter = sess.filter;
          if (!filter) throw new Error('No filter state available in session.');

          const activeFilter: SerializedFilterState = {
            schemas: schemaVal.valid ? [...schemaVal.valid] : (filter.schemas || []),
            types: filter.types || [],
            searchTerm: filter.searchTerm || '',
            hideIsolated: !!filter.hideIsolated,
            focusSchemas: filter.focusSchemas || [],
            showExternalRefs: !!filter.showExternalRefs,
            externalRefTypes: filter.externalRefTypes || [],
            exclusionPatterns: filter.exclusionPatterns || [],
            allowlistNodeIds: filter.allowlistNodeIds ? Array.from(filter.allowlistNodeIds) : undefined,
          };

          const ct = new ColumnTraceState(m, g, (level, msg) => {
            if (level === 'info') logger.info(`[CT] ${msg}`);
            else if (level === 'warn') logger.warn(`[CT] ${msg}`);
            else logger.debug(`[CT] ${msg}`);
          }, { activeFilter, memory: sess.memory }, sess.columnStore);
          
          ct.sessionId = sess.id;
          sess.stateMachine = ct;

          const initResult = ct.init({ targetColumns: columns, origin: input.origin, direction, depth, initial_summary: input.initial_summary });
          if ('error' in initResult) return logAndReturn('start_column_trace', initResult, options.input);

          const scopeDdlChars = ct.estimateScopeDdlChars();
          const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
          if (inline) ct.setInlineMode(true);
          
          const hopResult = ct.getHopContext();
          if ('error' in hopResult) return logAndReturn('start_column_trace', hopResult, options.input);
          if ('done' in hopResult) return logAndReturn('start_column_trace', { ...initResult, status: 'complete', message: 'No neighbors to trace.' }, options.input);

          return logAndReturn('start_column_trace', {
            ...initResult, ...hopResult,
            ...(inline && { scope_nodes: ct.getAllScopeNodesWithDdl(), delivery: 'inline' }),
          }, options.input);
        } catch (err) { return toolError('start_column_trace', err); }
      },
    }),

    vscode.lm.registerTool('lineage_submit_hop_analysis', {
      prepareInvocation(options, _token) {
        const input = options.input as { focus_node_id?: string };
        const name = input.focus_node_id?.replace(/\[|\]/g, '').split('.').pop() ?? '';
        const sess = getSession();
        const sm = sess.stateMachine;
        const visited = (sm && 'visitedCount' in sm) ? (sm as any).visitedCount : 0;
        const total = sm?.scopeSize ?? 0;
        return { invocationMessage: name ? `Node ${visited} of ${total} · Tracing ${name}…` : 'Processing hop verdicts…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const ct = sess.stateMachine as ColumnTraceState | null;
          if (!ct || !(ct instanceof ColumnTraceState)) {
            return logAndReturn('submit_hop_analysis', { error: 'no_active_trace', hint: 'No active column trace.' }, options.input);
          }

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', verdicts: 'array' });
          if (inputErr) return toolResult(inputErr);

          const input = options.input as {
            focus_node_id?: string; notes?: string; badge_label?: string; note_caption?: string;
            verdicts?: Array<{ neighbor_id?: string; verdict?: string; columns?: string[]; summary?: string; question?: string }>;
          };
          const focusNodeId = input.focus_node_id ?? '';
          const verdicts = (input.verdicts ?? []).map(v => ({
            nodeId: v.neighbor_id ?? '',
            verdict: (v.verdict ?? 'prune') as 'trace' | 'prune' | 'pass' | 'revisit',
            columnsOut: v.columns,
            summary: v.summary,
            question: v.question,
          }));

          const submitResult = ct.submitVerdicts({ focusNodeId, notes: input.notes, verdicts, badge_label: input.badge_label, note_caption: input.note_caption });
          if ('error' in submitResult) return logAndReturn('submit_hop_analysis', submitResult, options.input);

          const hopResult = ct.getHopContext();
          if ('error' in hopResult) return logAndReturn('submit_hop_analysis', hopResult, options.input);
          if ('done' in hopResult) {
            const fullResult = ct.getResult();
            if (!('error' in fullResult)) {
              sess.storeCtResult(fullResult);
              (fullResult as any).synthesis_reminder = buildSynthesisReminder('column trace — focus on data flow and column transformations');
            }
            return logAndReturn('submit_hop_analysis', fullResult, options.input);
          }

          return logAndReturn('submit_hop_analysis', hopResult, options.input);
        } catch (err) { return toolError('submit_hop_analysis', err); }
      },
    }),

    vscode.lm.registerTool('lineage_start_exploration', {
      prepareInvocation(_options, _token) {
        const sess = getSession();
        // Condition: Show confirmation ONLY if there is an active session (not complete) AND it's not stale (< 2 hours)
        if (sess.stateMachine && sess.stateMachine.status !== 'complete' && !sess.isStale()) {
          return {
            invocationMessage: 'Starting exploration…',
            confirmationMessages: {
              title: 'Wipe active exploration?',
              message: new vscode.MarkdownString(
                'There is an active exploration in another chat or previous context. Starting a new one will wipe the current progress. Continue?'
              ),
            },
          };
        }
        return { invocationMessage: 'Starting exploration…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { question: 'string', origin: 'string' });
          if (inputErr) return toolResult(inputErr);
          const input = options.input as { question?: string; origin?: string; scope_direction?: string; depth?: number; schemas?: string[]; initial_summary?: string };
          const question = input.question ?? '';
          const origin = input.origin ?? '';
          const scopeDirection = (['upstream', 'downstream', 'bidirectional'].includes(input.scope_direction ?? '')
            ? input.scope_direction as 'upstream' | 'downstream' | 'bidirectional'
            : 'bidirectional');
          const depth = typeof input.depth === 'number' ? Math.max(1, Math.min(Math.round(input.depth), 20)) : 5;

          // Silently reset if stale or complete (user already confirmed or no confirmation needed)
          sess.resetIfStale();

          // Validate and prepare schema override
          const schemaVal = validateSchemas(m, input.schemas);
          if (schemaVal.error) return toolResult({ error: 'invalid_schemas', message: schemaVal.error });

          const filter = sess.filter;
          if (!filter) throw new Error('No filter state available in session.');

          const activeFilter: SerializedFilterState = {
            schemas: schemaVal.valid ? [...schemaVal.valid] : (filter.schemas || []),
            types: filter.types || [],
            searchTerm: filter.searchTerm || '',
            hideIsolated: !!filter.hideIsolated,
            focusSchemas: filter.focusSchemas || [],
            showExternalRefs: !!filter.showExternalRefs,
            externalRefTypes: filter.externalRefTypes || [],
            exclusionPatterns: filter.exclusionPatterns || [],
            allowlistNodeIds: filter.allowlistNodeIds ? Array.from(filter.allowlistNodeIds) : undefined,
          };

          const bb = new BlackboardState(m, g, (level, msg) => {
            if (level === 'info') logger.info(`[BB] ${msg}`);
            else if (level === 'warn') logger.warn(`[BB] ${msg}`);
            else if (level === 'trace') logger.trace(`[BB] ${msg}`);
            else logger.debug(`[BB] ${msg}`);
          }, { activeFilter, scopeDirection, memory: sess.memory }, sess.columnStore);
          
          bb.sessionId = sess.id;
          sess.stateMachine = bb;

          const initResult = bb.init({ question, origin, depth, initial_summary: input.initial_summary });
          if ('error' in initResult) return logAndReturn('start_exploration', initResult, options.input);

          const scopeDdlChars = bb.estimateScopeDdlChars();
          const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
          if (inline) bb.setInlineMode(true);

          const hopResult = bb.getHopContext();
          if ('error' in hopResult) return logAndReturn('start_exploration', hopResult, options.input);
          if ('done' in hopResult) return logAndReturn('start_exploration', { ...initResult, status: 'complete', message: 'No neighbors to explore.' }, options.input);

          const scopePreview = { total_scope_nodes: bb.filterBreakdown.total, in_user_filter: bb.filterBreakdown.in_filter, outside_filter: bb.filterBreakdown.outside_filter, schemas: bb.schemaBreakdown() };

          return logAndReturn('start_exploration', {
            ...initResult, ...hopResult,
            scope_preview: scopePreview,
            ...(inline && { scope_nodes: bb.getAllScopeNodesWithDdl(), delivery: 'inline' }),
            ai_hint: `Scope: ${scopePreview.total_scope_nodes} nodes. Proceed with exploration.`,
          }, options.input);
        } catch (err) { return toolError('start_exploration', err); }
      },
    }),

    vscode.lm.registerTool('lineage_expand_frontier', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Expanding exploration scope…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const bb = sess.stateMachine as BlackboardState | null;
          if (!bb || !(bb instanceof BlackboardState)) {
            return logAndReturn('expand_frontier', { error: 'no_active_exploration', hint: 'No active exploration.' }, options.input);
          }
          const input = options.input as { extra_hops?: number };
          const extraHops = typeof input.extra_hops === 'number' ? Math.max(1, Math.min(Math.round(input.extra_hops), 5)) : 2;
          const result = bb.expandFrontier(extraHops);
          return logAndReturn('expand_frontier', { ok: true, ...result }, options.input);
        } catch (err) { return toolError('expand_frontier', err); }
      },
    }),

    vscode.lm.registerTool('lineage_submit_findings', {
      prepareInvocation(options, _token) {
        const input = options.input as { focus_node_id?: string };
        const name = input.focus_node_id?.replace(/\[|\]/g, '').split('.').pop() ?? '';
        const sess = getSession();
        const sm = sess.stateMachine;
        const visited = (sm && 'visitedCount' in sm) ? (sm as any).visitedCount : 0;
        const total = sm?.scopeSize ?? 0;
        return { invocationMessage: name ? `Node ${visited} of ${total} · Analyzing ${name}…` : 'Recording findings…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const bb = sess.stateMachine as BlackboardState | null;
          if (!bb || !(bb instanceof BlackboardState)) {
            return logAndReturn('submit_findings', { error: 'no_active_exploration', hint: 'No active exploration.' }, options.input);
          }

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', findings: 'string', summary: 'string' });
          if (inputErr) return toolResult(inputErr);

          const input = options.input as {
            focus_node_id?: string; findings?: string; summary?: string;
            tags?: string[]; questions?: Array<{ node_id?: string; question?: string }>;
            verdict?: string; prune_ids?: string[]; add_ids?: string[];
            badge_label?: string; note_caption?: string; complete?: boolean;
          };
          const questions = (input.questions ?? []).map(q => ({ nodeId: q.node_id ?? '', question: q.question ?? '' }));
          
          const submitResult = bb.submitFindings({
            focusNodeId: input.focus_node_id ?? '', findings: input.findings ?? '', summary: input.summary ?? '',
            tags: input.tags, questions, verdict: input.verdict as any,
            pruneIds: input.prune_ids ?? [], addIds: input.add_ids ?? [], complete: !!input.complete,
            badge_label: input.badge_label, note_caption: input.note_caption,
          });
          if ('error' in submitResult) return logAndReturn('submit_findings', submitResult, options.input);

          const earlyResult = submitResult.early_complete ?? null;
          if (earlyResult && !('error' in earlyResult)) {
            sess.storeBbResult(earlyResult);
            return logAndReturn('submit_findings', earlyResult, options.input);
          }

          const hopResult = bb.getHopContext();
          if ('error' in hopResult) return logAndReturn('submit_findings', hopResult, options.input);
          if ('done' in hopResult) {
            const fullResult = bb.getResult();
            if (!('error' in fullResult)) {
              sess.storeBbResult(fullResult);
              (fullResult as any).synthesis_reminder = buildSynthesisReminder(bb.question);
            }
            return logAndReturn('submit_findings', fullResult, options.input);
          }

          return logAndReturn('submit_findings', hopResult, options.input);
        } catch (err) { return toolError('submit_findings', err); }
      },
    }),
  ];
}
