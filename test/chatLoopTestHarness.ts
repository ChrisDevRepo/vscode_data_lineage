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
  autoFixCreateAiView, validateCreateAiView,
  AI_CAPS,
} from '../src/ai/tools';
import { ColumnTraceState } from '../src/ai/columnTraceState';
import { buildBareGraph } from '../src/ai/graphUtils';
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
  /** Resolved mode */
  mode: 'column_trace' | 'hop' | 'classic';
  /** Prompt variant used */
  promptVariant: string;
  /** Column trace state (if CT mode was used) */
  columnTraceState: ColumnTraceState | null;
}

// ─── Mode detection (mirrors extension.ts lines 610-670) ────────────────────

export type Mode = 'column_trace' | 'hop' | 'classic';
export type PromptVariant = 'column-trace' | 'impact' | 'biz' | 'doc' | 'sql' | 'classic';

export function detectMode(command: string | undefined): { mode: Mode; promptVariant: PromptVariant } {
  if (command === 'column-trace') return { mode: 'column_trace', promptVariant: 'column-trace' };
  if (command === 'impact') return { mode: 'hop', promptVariant: 'impact' };
  if (command === 'biz') return { mode: 'hop', promptVariant: 'biz' };
  if (command === 'doc') return { mode: 'hop', promptVariant: 'doc' };
  if (command === 'sql') return { mode: 'hop', promptVariant: 'sql' };
  if (command === 'trace' || command === 'search' || command === 'explain') return { mode: 'classic', promptVariant: 'classic' };
  return { mode: 'classic', promptVariant: 'classic' }; // free-form default
}

export function detectModeWithRouting(
  command: string | undefined,
  routerResponse?: 'hop' | 'classic',
): { mode: Mode; promptVariant: PromptVariant } {
  // Slash commands bypass routing
  const direct = detectMode(command);
  if (command) return direct;
  // Free-form: use router response
  if (routerResponse === 'hop') return { mode: 'hop', promptVariant: 'biz' }; // default hop variant
  return { mode: 'classic', promptVariant: 'classic' };
}

// ─── Tool dispatcher (calls real pure functions) ─────────────────────────────

export function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  model: DatabaseModel,
  graph: Graph,
  columnTraceState: { current: ColumnTraceState | null },
  columnStore: ColumnStore | null,
): string {
  const caps = AI_CAPS;

  switch (name) {
    case 'lineage_get_context':
      return JSON.stringify(getContext(model, null, 'TestProject', [], columnStore ?? undefined));

    case 'lineage_search_objects':
      return JSON.stringify(searchObjects(
        model, input.query as string, input.types as string[] | undefined,
        input.schemas as string[] | undefined, input.mode as string | undefined, caps,
      ));

    case 'lineage_get_object_detail':
      return JSON.stringify(getObjectDetail(model, input.id as string, caps, columnStore ?? undefined));

    case 'lineage_run_bfs_trace':
      return JSON.stringify(runBfsTrace(
        model, graph, input.origin as string,
        input.hops_up as number ?? 3, input.hops_down as number ?? 3,
        input.types as string[] | undefined, input.schemas as string[] | undefined,
        input.include_ddl as boolean ?? true, caps, columnStore ?? undefined,
      ));

    case 'lineage_run_analysis':
      return JSON.stringify(runAnalysis(model, graph, input.type as string, caps));

    case 'lineage_search_ddl':
      return JSON.stringify(searchDdl(model, input.pattern as string, caps));

    case 'lineage_get_ddl_batch':
      return JSON.stringify(getDdlBatch(model, input.ids as string[], caps));

    case 'lineage_create_ai_view': {
      const { input: fixed } = autoFixCreateAiView(model, input as any);
      return JSON.stringify(validateCreateAiView(model, fixed));
    }

    case 'lineage_start_column_trace': {
      const columns = (input.columns ?? []) as string[];
      const direction = (input.direction ?? 'up') as 'up' | 'down' | 'both';
      const state = new ColumnTraceState(model, (l, m) => { /* silent */ }, undefined, columnStore ?? undefined);
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

    case 'lineage_route_mode':
      // Router tool — just echo back the input (in real extension, it's a no-op that logs)
      return JSON.stringify({ mode: input.mode, reason: input.reason });

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
  /** Router response for free-form routing (default: 'classic') */
  routerResponse?: 'hop' | 'classic';
}

export function runChatLoop(params: RunLoopParams): LoopResult {
  const { prompt, command, script, model, graph, columnStore = null, maxRounds = 25, routerResponse } = params;

  // Mode detection (mirrors extension.ts lines 610-670)
  const { mode, promptVariant } = detectModeWithRouting(command, routerResponse);
  const isColumnTraceMode = mode === 'column_trace' || mode === 'hop';

  // Tool filtering (mirrors extension.ts lines 679-681)
  // CT mode: only start_column_trace + submit_hop_analysis
  // Classic mode: all 8 classic tools
  const CT_TOOLS = new Set(['lineage_start_column_trace', 'lineage_submit_hop_analysis']);
  const CLASSIC_TOOLS = new Set([
    'lineage_get_context', 'lineage_search_objects', 'lineage_get_object_detail',
    'lineage_run_bfs_trace', 'lineage_run_analysis', 'lineage_search_ddl',
    'lineage_get_ddl_batch', 'lineage_create_ai_view',
  ]);
  const allowedTools = isColumnTraceMode ? CT_TOOLS : CLASSIC_TOOLS;

  const markdownOutput: string[] = [];
  const toolSequence: string[] = [];
  const toolResults: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
  const historyOps: string[] = [];
  const columnTraceState: { current: ColumnTraceState | null } = { current: null };

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
      const result = dispatchTool(call.name, call.input, model, graph, columnTraceState, columnStore);
      toolCallCache.set(cacheKey, result);
      toolResults.push({ name: call.name, input: call.input, result });
      toolSequence.push(call.name.replace('lineage_', ''));

      // History: DROP noise results
      const compact = compactNoiseResult(call.name, result);
      if (compact) {
        historyOps.push(`DROP: ${call.name} → ${compact}`);
      }

      // CT context control: track successful CT tool results
      if (isColumnTraceMode && (call.name === 'lineage_start_column_trace' || call.name === 'lineage_submit_hop_analysis')) {
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
    mode,
    promptVariant,
    columnTraceState: columnTraceState.current,
  };
}
