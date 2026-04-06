/**
 * Chat loop test harness — fake Copilot response streams for testing
 * the orchestration loop WITHOUT VS Code or real AI.
 *
 * Reimplements the runWithTools pattern from extension.ts using plain types.
 * Real tool functions from src/ai/tools.ts are called; only the LM is faked.
 */

import type { DatabaseModel } from '../src/engine/types';
import type Graph from 'graphology';
import {
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch,
  autoFixEnrichView, validateEnrichView,
  shouldInline, estimateTokens, getEffectiveBudget,
} from '../src/ai/tools';
import { ColumnTraceState } from '../src/ai/columnTraceState';
import { BlackboardState } from '../src/ai/blackboardState';
import { buildBareGraph } from '../src/ai/graphUtils';
import type { SerializedFilterState } from '../src/engine/projectStore';
import { compactNoiseResult, findMergeableCallIds } from '../src/ai/historyManager';
import type { ColumnStore } from '../src/engine/columnStore';

// ─── VS Code-free types (mirrors vscode.LanguageModel* shapes) ──────────────

export interface TextPart { type: 'text'; value: string }
export interface ToolCallPart { type: 'toolCall'; callId: string; name: string; input: Record<string, unknown> }
export type StreamPart = TextPart | ToolCallPart;

/** One scripted round of what the fake Copilot "responds" with. */
export interface ScriptedRound {
  /** Text the AI says before/between tool calls (optional) */
  text?: string;
  /** Tool calls the AI makes this round (empty = AI is done, loop exits) */
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

/** Result from running the loop. */
export interface LoopResult {
  /** All markdown text the "AI" produced */
  markdownOutput: string[];
  /** Tool call sequence: tool names in order */
  toolSequence: string[];
  /** All tool results (name → JSON string) */
  toolResults: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  /** Number of rounds executed */
  rounds: number;
  /** Whether the loop hit the round limit */
  hitRoundLimit: boolean;
  /** History management operations applied */
  historyOps: string[];
  /** Active phase at end of loop */
  phase: ActivePhase;
  /** Column trace state (if CT mode was used) */
  columnTraceState: ColumnTraceState | null;
  /** Blackboard state (if BB exploration mode was used) */
  blackboardState: BlackboardState | null;
}

// ─── Explore-first: no upfront mode detection. Phase transitions in the loop. ──

export type ActivePhase = 'discover' | 'ct_active' | 'ct_done' | 'bb_active' | 'bb_done';

// ─── Tool dispatcher (calls real pure functions) ─────────────────────────────

export function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  model: DatabaseModel,
  graph: Graph,
  columnTraceState: { current: ColumnTraceState | null },
  columnStore: ColumnStore | null,
  blackboardState?: { current: BlackboardState | null },
  activeFilter?: SerializedFilterState | null,
): string {
  switch (name) {
    case 'lineage_get_context':
      return JSON.stringify(getContext(model, activeFilter ?? null, 'TestProject', [], columnStore ?? undefined));

    case 'lineage_search_objects':
      return JSON.stringify(searchObjects(
        model, input.query as string, input.types as string[] | undefined,
        input.schemas as string[] | undefined, input.mode as string | undefined,
        activeFilter ?? null,
      ));

    case 'lineage_get_object_detail':
      return JSON.stringify(getObjectDetail(model, input.id as string, columnStore ?? undefined));

    case 'lineage_run_bfs_trace':
      return JSON.stringify(runBfsTrace(
        model, graph, input.origin as string,
        input.hops_up as number ?? 3, input.hops_down as number ?? 3,
        input.types as string[] | undefined, input.schemas as string[] | undefined,
        input.include_ddl as boolean ?? true, columnStore ?? undefined,
      ));

    case 'lineage_run_analysis':
      return JSON.stringify(runAnalysis(model, graph, input.type as string));

    case 'lineage_search_ddl':
      return JSON.stringify(searchDdl(model, input.pattern as string));

    case 'lineage_get_ddl_batch':
      return JSON.stringify(getDdlBatch(model, input.ids as string[]));

    case 'lineage_enrich_view': {
      const rawInput = input as any;
      // Simulate stored graph: use node_ids from input as fallback
      const resolvedNodeIds = rawInput.node_ids as string[] | undefined;
      const { input: fixed } = autoFixEnrichView(model, rawInput, resolvedNodeIds);
      return JSON.stringify(validateEnrichView(fixed, resolvedNodeIds ?? []));
    }

    case 'lineage_start_column_trace': {
      const columns = (input.columns ?? []) as string[];
      const direction = (input.direction ?? 'up') as 'up' | 'down' | 'both';
      const state = new ColumnTraceState(model, buildBareGraph(model), (l, m) => { /* silent */ }, { activeFilter: activeFilter ?? undefined }, columnStore ?? undefined);
      columnTraceState.current = state;
      const initResult = state.init({ targetColumns: columns, origin: input.origin as string | undefined, direction });
      if ('error' in initResult) return JSON.stringify(initResult);
      const hopCtx = state.getHopContext();
      return JSON.stringify({ ...initResult, hop_context: hopCtx });
    }

    case 'lineage_submit_hop_analysis': {
      const state = columnTraceState.current;
      if (!state) return JSON.stringify({ error: 'no_active_trace' });
      const subResult = state.submitVerdicts({
        focusNodeId: input.focus_node_id as string,
        notes: input.notes as string | undefined,
        verdicts: (input.verdicts as Array<{
          neighbor_id: string; verdict: string;
          columns_to_trace?: string[]; summary?: string; question?: string;
        }>).map(v => ({
          nodeId: v.neighbor_id,
          verdict: v.verdict as 'trace' | 'prune' | 'pass',
          columnsOut: v.columns_to_trace,
          summary: v.summary,
          question: v.question,
        })),
      });
      if ('error' in subResult) return JSON.stringify(subResult);
      const nextHop = state.getHopContext();
      if ('done' in nextHop) return JSON.stringify({ ...subResult, result: state.getResult() });
      return JSON.stringify({ ...subResult, hop_context: nextHop });
    }

    case 'lineage_start_exploration': {
      const bb = blackboardState ?? { current: null };
      const scopeDir = (['upstream', 'downstream', 'bidirectional'].includes(input.scope_direction as string ?? '')
        ? input.scope_direction as 'upstream' | 'downstream' | 'bidirectional'
        : 'bidirectional');
      const state = new BlackboardState(model, graph, () => {}, { activeFilter: activeFilter ?? undefined, scopeDirection: scopeDir }, columnStore ?? undefined);
      bb.current = state;
      const initResult = state.init({ question: input.question as string ?? '', origin: input.origin as string ?? '' });
      if ('error' in initResult) return JSON.stringify(initResult);

      // Token budget gate — same logic as extension.ts:792-813
      const scopeDdlChars = state.estimateScopeDdlChars();
      const scopeTokens = estimateTokens(scopeDdlChars);
      const budget = getEffectiveBudget();
      const scopeInline = shouldInline(scopeDdlChars);
      // Log for debugging parity with extension
      console.log(`[BB] Scope ${initResult.scopeSize} nodes, ~${scopeDdlChars} chars (~${scopeTokens} tokens), budget ${budget} → ${scopeInline ? 'inline' : 'exploration mode (state machine)'}`);
      if (scopeInline) {
        const originId = (initResult.originNode as { id?: string }).id;
        if (originId) {
          const bfsResult = runBfsTrace(model, graph, originId, 5, 5, undefined, undefined, true, columnStore ?? undefined);
          bb.current = null;
          return JSON.stringify({
            status: 'inline',
            action_required: 'analyze_and_respond',
            reason: 'scope_fits_inline',
            scope_size: initResult.scopeSize,
            origin: initResult.originNode,
            bfs_result: bfsResult,
            hint: 'All DDL provided inline. Analyze this data and present your findings. Do NOT call more tools.',
          });
        }
      }

      const hopCtx = state.getHopContext();
      if ('error' in hopCtx) return JSON.stringify(hopCtx);
      if ('done' in hopCtx) return JSON.stringify({ ...initResult, status: 'complete', message: 'No neighbors to explore.' });

      // Scope preview + guidance — same as extension.ts:824-845
      const scopePreview = {
        total_scope_nodes: state.filterBreakdown.total,
        in_user_filter: state.filterBreakdown.in_filter,
        outside_filter: state.filterBreakdown.outside_filter,
        schemas: state.schemaBreakdown(),
      };
      const maxRounds = 25;
      const agendaSize = initResult.agendaSize ?? 0;
      const estimatedHops = Math.floor(maxRounds * 0.8);
      const scopeGuidance = agendaSize > estimatedHops ? {
        agenda_size: agendaSize,
        estimated_max_hops: estimatedHops,
        recommendation: `Agenda (${agendaSize}) exceeds round budget (~${estimatedHops} hops). Prune aggressively and use complete:true in submit_findings when you have enough findings to answer the question.`,
      } : undefined;

      return JSON.stringify({
        ...initResult, ...hopCtx,
        scope_preview: scopePreview,
        ...(scopeGuidance && { scope_guidance: scopeGuidance }),
        ai_hint: `Scope: ${scopePreview.total_scope_nodes} nodes (${scopePreview.in_user_filter} match user filter). Proceed with exploration.`,
      });
    }

    case 'lineage_submit_findings': {
      const bb = blackboardState ?? { current: null };
      const state = bb.current;
      if (!state) return JSON.stringify({ error: 'no_active_exploration', hint: 'No active exploration. Call start_exploration first.' });

      // Verdict validation — same as extension.ts:881-883
      const verdict = input.verdict as string | undefined;
      if (!verdict || !['relevant', 'noted', 'irrelevant'].includes(verdict)) {
        return JSON.stringify({ error: 'verdict_required', hint: 'verdict must be "relevant", "noted", or "irrelevant".' });
      }

      const subResult = state.submitFindings({
        focusNodeId: input.focus_node_id as string ?? '',
        findings: input.findings as string ?? '',
        summary: input.summary as string ?? '',
        tags: input.tags as string[] | undefined,
        questions: (input.questions as Array<{ node_id: string; question: string }> ?? []).map(q => ({
          nodeId: q.node_id, question: q.question,
        })),
        verdict: verdict as 'relevant' | 'noted' | 'irrelevant',
        pruneIds: input.prune_ids as string[] | undefined,
        addIds: input.add_ids as string[] | undefined,
        complete: input.complete as boolean | undefined,
        badge_label: input.badge_label as string | undefined,
        note_caption: input.note_caption as string | undefined,
      });
      if ('error' in subResult) return JSON.stringify(subResult);

      // Early completion — return raw result (same as extension.ts:907-910)
      if ('early_complete' in subResult && subResult.early_complete) {
        return JSON.stringify(subResult.early_complete);
      }
      // Normal completion — return raw result (same as extension.ts:916-920)
      const nextHop = state.getHopContext();
      if ('done' in nextHop) return JSON.stringify(state.getResult());
      // Next hop — merge submit metadata with hop context (same as extension.ts:923)
      return JSON.stringify({ ...subResult, ...nextHop });
    }

    default:
      return JSON.stringify({ error: 'unknown_tool', name });
  }
}

// ─── The fake chat loop (mirrors runWithTools in extension.ts) ───────────────

export interface RunLoopParams {
  /** User's prompt text */
  prompt: string;
  /** Slash command (undefined = free-form) */
  command?: string;
  /** Scripted rounds — what the fake Copilot "responds" */
  script: ScriptedRound[];
  /** Loaded database model */
  model: DatabaseModel;
  /** Graphology graph */
  graph: Graph;
  /** Optional column store */
  columnStore?: ColumnStore | null;
  /** Max rounds (default 25) */
  maxRounds?: number;
}

export function runChatLoop(params: RunLoopParams): LoopResult {
  const { prompt, command, script, model, graph, columnStore = null, maxRounds = 25 } = params;

  // Explore-first: all tools visible during discovery. Dynamic filtering in real extension.
  // Test harness allows all tools — phase transitions are tested via CT context control.
  const ALL_TOOLS = new Set([
    'lineage_get_context', 'lineage_search_objects', 'lineage_get_object_detail',
    'lineage_run_bfs_trace', 'lineage_run_analysis', 'lineage_search_ddl',
    'lineage_get_ddl_batch', 'lineage_enrich_view',
    'lineage_start_column_trace', 'lineage_submit_hop_analysis',
    'lineage_start_exploration', 'lineage_submit_findings',
  ]);
  const allowedTools = ALL_TOOLS;

  const markdownOutput: string[] = [];
  const toolSequence: string[] = [];
  const toolResults: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
  const historyOps: string[] = [];
  const columnTraceState: { current: ColumnTraceState | null } = { current: null };
  const blackboardState: { current: BlackboardState | null } = { current: null };

  // Dedup cache (mirrors extension.ts line 839)
  const toolCallCache = new Map<string, string>();
  let roundCount = 0;
  let hitRoundLimit = false;

  // CT context control (mirrors extension.ts lines 870-871)
  const ctToolResults: Array<{ round: number; callId: string }> = [];

  for (const round of script) {
    if (roundCount >= maxRounds) {
      hitRoundLimit = true;
      break;
    }
    roundCount++;

    // AI text output
    if (round.text) {
      markdownOutput.push(round.text);
    }

    // No tool calls = AI is done
    if (!round.toolCalls?.length) break;

    // Process tool calls
    for (const call of round.toolCalls) {
      // Tool filtering — reject tools not allowed in this mode
      if (!allowedTools.has(call.name)) {
        toolResults.push({ name: call.name, input: call.input, result: JSON.stringify({ error: 'tool_not_available', mode }) });
        historyOps.push(`BLOCKED: ${call.name} not in ${mode} mode`);
        continue;
      }

      // Dedup (mirrors extension.ts lines 924-938)
      const sortedInput = Object.keys(call.input).sort().reduce((acc, k) => {
        if (call.input[k] !== undefined && call.input[k] !== null && call.input[k] !== false) acc[k] = call.input[k];
        return acc;
      }, {} as Record<string, unknown>);
      const cacheKey = `${call.name}::${JSON.stringify(sortedInput)}`;
      if (toolCallCache.has(cacheKey)) {
        toolResults.push({ name: call.name, input: call.input, result: '{"_dedup":true}' });
        historyOps.push(`DEDUP: ${call.name}`);
        continue;
      }

      // Dispatch to real tool function
      const result = dispatchTool(call.name, call.input, model, graph, columnTraceState, columnStore, blackboardState);
      toolCallCache.set(cacheKey, result);
      toolResults.push({ name: call.name, input: call.input, result });
      toolSequence.push(call.name.replace('lineage_', ''));

      // History: DROP noise results
      const compact = compactNoiseResult(call.name, result);
      if (compact) {
        historyOps.push(`DROP: ${call.name} → ${compact}`);
      }

      // CT context control: track successful CT tool results
      if (call.name === 'lineage_start_column_trace' || call.name === 'lineage_submit_hop_analysis') {
        const isSuccess = result.includes('ct_mode') || result.includes('"ok"') || result.includes('hop_context');
        if (isSuccess) {
          ctToolResults.push({ round: roundCount, callId: `call_${roundCount}_${call.name}` });
          // Compaction: compact all but the last CT result (mirrors extension.ts lines 1002-1013)
          if (ctToolResults.length > 1) {
            const compacted = ctToolResults.length - 1;
            historyOps.push(`CT_COMPACT: ${compacted} previous hop(s) compacted`);
          }
        }
      }

      // BB context control: track successful BB tool results (same pattern as CT)
      if (call.name === 'lineage_start_exploration' || call.name === 'lineage_submit_findings') {
        const isSuccess = result.includes('bb_mode') || result.includes('"ok"') || result.includes('exploring');
        if (isSuccess) {
          if (call.name === 'lineage_submit_findings' && ctToolResults.length > 0) {
            // Reuse counter for compaction tracking
          }
          historyOps.push(`BB_TRACK: ${call.name} round=${roundCount}`);
        }
      }
    }
  }

  if (roundCount >= maxRounds && !hitRoundLimit) {
    hitRoundLimit = roundCount >= maxRounds;
  }

  return {
    markdownOutput,
    toolSequence,
    toolResults,
    rounds: roundCount,
    hitRoundLimit,
    historyOps,
    phase: (blackboardState.current ? 'bb_active' : columnTraceState.current ? 'ct_active' : 'discover') as ActivePhase,
    columnTraceState: columnTraceState.current,
    blackboardState: blackboardState.current,
  };
}
