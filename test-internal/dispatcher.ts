/**
 * Tool dispatcher — routes tool names to real pure functions from src/ai/tools.ts.
 * Used by ai-test-server.ts (HTTP bridge) and any test harness.
 *
 * No VS Code dependencies. No history management. Pure dispatch only.
 */

import type { DatabaseModel } from '../src/engine/types.js';
import type Graph from 'graphology';
import {
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch,
  autoFixEnrichView, validateEnrichView, orderAndAssemble,
  estimateTokens, shouldSmInline,
} from '../src/ai/tools.js';
import type { EnrichViewInput } from '../src/ai/tools.js';
import { ColumnTraceState } from '../src/ai/columnTraceState.js';
import { BlackboardState } from '../src/ai/blackboardState.js';
import { buildBareGraph } from '../src/ai/graphUtils.js';
import type { SerializedFilterState } from '../src/engine/projectStore.js';
import type { ColumnStore } from '../src/engine/columnStore.js';
import type { LogFn } from '../src/ai/smGuards.js';

/** Noop logger — used when caller passes no logger. */
const noopLog: LogFn = () => {};

export function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  model: DatabaseModel,
  graph: Graph,
  columnTraceState: { current: ColumnTraceState | null },
  columnStore: ColumnStore | null,
  blackboardState?: { current: BlackboardState | null },
  activeFilter?: SerializedFilterState | null,
  log: LogFn = noopLog,
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
        (input.hops_up as number) ?? 3, (input.hops_down as number) ?? 3,
        input.types as string[] | undefined, input.schemas as string[] | undefined,
        (input.include_ddl as boolean) ?? true, columnStore ?? undefined,
      ));

    case 'lineage_run_analysis':
      return JSON.stringify(runAnalysis(model, graph, input.type as string));

    case 'lineage_search_ddl':
      return JSON.stringify(searchDdl(model, input.pattern as string));

    case 'lineage_get_ddl_batch':
      return JSON.stringify(getDdlBatch(model, input.ids as string[]));

    case 'lineage_enrich_view': {
      const rawInput = input as EnrichViewInput;

      // 1. Resolve node set from SM result (BB or CT)
      const bbState = blackboardState?.current;
      const ctState = columnTraceState.current;
      let smResult: {
        fullNodes: Array<Record<string, unknown>>;
        edges: Array<[string, string, string]>;
        suggested_labels: Array<{ node_id: string; text: string }>;
        suggested_notes: Array<{ node_id: string; text: string }>;
      } | null = null;

      if (bbState) {
        const r = bbState.getResult();
        if (!('error' in r)) smResult = r;
      } else if (ctState) {
        const r = ctState.getResult();
        if (!('error' in r)) smResult = r;
      }

      if (!smResult) {
        return JSON.stringify({
          success: false,
          errors: ['No state-machine result available — enrich_view requires a completed column_trace or blackboard exploration.'],
          hint: 'Call start_exploration or start_column_trace to analyze the graph first, then retry enrich_view.',
        });
      }

      let resolvedNodeIds = smResult.fullNodes.map(n => n.id as string);
      let resolvedEdges = smResult.edges;

      // Apply prune_node_ids if provided
      if (rawInput.prune_node_ids?.length) {
        const pruneSet = new Set(rawInput.prune_node_ids);
        resolvedNodeIds = resolvedNodeIds.filter(id => !pruneSet.has(id));
        resolvedEdges = resolvedEdges.filter(([src, tgt]) => !pruneSet.has(src) && !pruneSet.has(tgt));
      }

      // 1b. Auto-populate notes from SM suggested_notes
      if (smResult.suggested_notes.length) {
        const userNoteIds = new Set((rawInput.notes ?? []).map(n => n.node_id));
        const resolvedSet = new Set(resolvedNodeIds);
        const autoNotes: Array<{ node_id: string; text: string }> = [];
        for (const { node_id, text } of smResult.suggested_notes) {
          if (resolvedSet.has(node_id) && !userNoteIds.has(node_id) && text) {
            autoNotes.push({ node_id, text });
          }
        }
        if (autoNotes.length > 0) {
          rawInput.notes = [...(rawInput.notes ?? []), ...autoNotes];
        }
      }

      // 1c. Auto-populate section node_ids from SM suggested_labels
      if (smResult.suggested_labels.length && rawInput.sections?.length) {
        const hasNodeIds = rawInput.sections.some(s => s.node_ids && s.node_ids.length > 0);
        if (!hasNodeIds) {
          const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
          const labelToNodeIds = new Map<string, string[]>();
          for (const sl of smResult.suggested_labels) {
            if (!sl.text) continue;
            const label = stripNum(sl.text);
            if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, []);
            labelToNodeIds.get(label)!.push(sl.node_id);
          }
          rawInput.sections = rawInput.sections.map(sec => {
            const norm = stripNum(sec.label);
            const ids = labelToNodeIds.get(norm);
            if (ids?.length) return { ...sec, node_ids: ids };
            return sec;
          });
        }
      }

      // 1e. orderAndAssemble: number sections, derive badges, assemble description
      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      if (rawInput.sections?.length) {
        const assembled = orderAndAssemble(rawInput.sections, {
          title: rawInput.title,
          intro: rawInput.intro,
          closing: rawInput.closing,
        });
        assembledBadges = assembled.badges;
        if (!rawInput.description) rawInput.description = assembled.description;
        rawInput.sections = undefined;
      }

      // 2. Auto-fix
      const { input: fixed } = autoFixEnrichView(model, rawInput, resolvedNodeIds);

      // 3. Validate
      return JSON.stringify(validateEnrichView(fixed, resolvedNodeIds, assembledBadges));
    }

    case 'lineage_start_column_trace': {
      const columns = (input.columns ?? []) as string[];
      const direction = (input.direction ?? 'up') as 'up' | 'down' | 'both';
      const state = new ColumnTraceState(
        model, buildBareGraph(model), log,
        { activeFilter: activeFilter ?? undefined }, columnStore ?? undefined,
      );
      columnTraceState.current = state;
      const initResult = state.init({ targetColumns: columns, origin: input.origin as string | undefined, direction });
      if ('error' in initResult) return JSON.stringify(initResult);
      // Token budget + node count gate: inline (all DDL at once) vs hop-by-hop (sliding memory)
      const scopeDdlChars = state.estimateScopeDdlChars();
      const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
      if (inline) state.setInlineMode(true);
      log('info', `[CT] Scope ${initResult.scopeSize} nodes, ~${scopeDdlChars} chars (~${estimateTokens(scopeDdlChars)} tokens) → ${inline ? 'inline' : 'state machine'}`);
      const hopCtx = state.getHopContext();
      return JSON.stringify({
        ...initResult, hop_context: hopCtx,
        ...(inline && { scope_nodes: state.getAllScopeNodesWithDdl(), delivery: 'inline' }),
      });
    }

    case 'lineage_submit_hop_analysis': {
      const state = columnTraceState.current;
      if (!state) return JSON.stringify({ error: 'no_active_trace' });
      const subResult = state.submitVerdicts({
        focusNodeId: input.focus_node_id as string,
        notes: input.notes as string | undefined,
        verdicts: (input.verdicts as Array<{
          neighbor_id: string; verdict: string;
          columns?: string[]; columns_to_trace?: string[];
          summary?: string; question?: string;
        }>).map(v => ({
          nodeId: v.neighbor_id,
          verdict: v.verdict as 'trace' | 'prune' | 'pass' | 'revisit',
          columnsOut: v.columns ?? v.columns_to_trace,
          summary: v.summary,
          question: v.question,
        })),
      });
      if ('error' in subResult) return JSON.stringify(subResult);
      const nextHop = state.getHopContext();
      if ('done' in nextHop) return JSON.stringify({ ...subResult, result: state.getResult() });
      return JSON.stringify({ ...subResult, hop_context: nextHop });
    }

    case 'lineage_submit_batch_hop': {
      const state = columnTraceState.current;
      if (!state) return JSON.stringify({ error: 'no_active_trace', hint: 'No active column trace.' });
      const entries = (input.entries as Array<{
        node_id: string; notes?: string; badge_label?: string; note_caption?: string;
        verdicts: Array<{ neighbor_id: string; verdict: string; columns?: string[]; summary?: string; question?: string }>;
      }>).map(e => ({
        nodeId: e.node_id,
        notes: e.notes,
        badge_label: e.badge_label,
        note_caption: e.note_caption,
        verdicts: (e.verdicts ?? []).map(v => ({
          nodeId: v.neighbor_id,
          verdict: v.verdict as 'trace' | 'prune' | 'pass' | 'revisit',
          columnsOut: v.columns,
          summary: v.summary,
          question: v.question,
        })),
      }));
      return JSON.stringify(state.submitBatch(entries));
    }

    case 'lineage_submit_batch_findings': {
      const bb = blackboardState ?? { current: null };
      const state = bb.current;
      if (!state) return JSON.stringify({ error: 'no_active_exploration', hint: 'No active exploration.' });
      const entries = (input.entries as Array<{
        node_id: string; findings: string; summary: string; verdict: string;
        badge_label?: string; note_caption?: string;
        prune_ids?: string[]; add_ids?: string[];
        questions?: Array<{ node_id: string; question: string }>;
        complete?: boolean;
      }>).map(e => ({
        nodeId: e.node_id,
        findings: e.findings,
        summary: e.summary,
        verdict: e.verdict as 'relevant' | 'pass' | 'irrelevant',
        badge_label: e.badge_label,
        note_caption: e.note_caption,
        prune_ids: e.prune_ids,
        add_ids: e.add_ids,
        questions: e.questions,
        complete: e.complete,
      }));
      return JSON.stringify(state.submitBatch(entries));
    }

    case 'lineage_start_exploration': {
      const bb = blackboardState ?? { current: null };
      const scopeDir = (['upstream', 'downstream', 'bidirectional'].includes((input.scope_direction as string) ?? '')
        ? input.scope_direction as 'upstream' | 'downstream' | 'bidirectional'
        : 'bidirectional');
      const state = new BlackboardState(
        model, graph, log,
        { activeFilter: activeFilter ?? undefined, scopeDirection: scopeDir },
        columnStore ?? undefined,
      );
      bb.current = state;
      const initResult = state.init({ question: (input.question as string) ?? '', origin: (input.origin as string) ?? '' });
      if ('error' in initResult) return JSON.stringify(initResult);

      // Token budget + node count gate: inline (all DDL at once) vs hop-by-hop (sliding memory)
      const scopeDdlChars = state.estimateScopeDdlChars();
      const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
      if (inline) state.setInlineMode(true);
      log('info', `[BB] Scope ${initResult.scopeSize} nodes, ~${scopeDdlChars} chars (~${estimateTokens(scopeDdlChars)} tokens) → ${inline ? 'inline' : 'state machine'}`);

      const hopCtx = state.getHopContext();
      if ('error' in hopCtx) return JSON.stringify(hopCtx);
      if ('done' in hopCtx) return JSON.stringify({ ...initResult, status: 'complete', message: 'No neighbors to explore.' });

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
        recommendation: `Agenda (${agendaSize}) exceeds round budget (~${estimatedHops} hops). Prune aggressively.`,
      } : undefined;

      return JSON.stringify({
        ...initResult, ...hopCtx,
        scope_preview: scopePreview,
        ...(scopeGuidance && { scope_guidance: scopeGuidance }),
        ...(inline && { scope_nodes: state.getAllScopeNodesWithDdl(), delivery: 'inline' }),
        ai_hint: `Scope: ${scopePreview.total_scope_nodes} nodes (${scopePreview.in_user_filter} match user filter).${inline ? ' All DDL included — reason about all nodes, then submit verdicts.' : ' Proceed with exploration.'}`,
      });
    }

    case 'lineage_submit_findings': {
      const bb = blackboardState ?? { current: null };
      const state = bb.current;
      if (!state) return JSON.stringify({ error: 'no_active_exploration', hint: 'No active exploration. Call start_exploration first.' });

      const verdict = input.verdict as string | undefined;
      if (!verdict || !['relevant', 'noted', 'irrelevant'].includes(verdict)) {
        return JSON.stringify({ error: 'verdict_required', hint: 'verdict must be "relevant", "noted", or "irrelevant".' });
      }

      const subResult = state.submitFindings({
        focusNodeId: (input.focus_node_id as string) ?? '',
        findings: (input.findings as string) ?? '',
        summary: (input.summary as string) ?? '',
        tags: input.tags as string[] | undefined,
        questions: ((input.questions as Array<{ node_id: string; question: string }>) ?? []).map(q => ({
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
      if ('early_complete' in subResult && subResult.early_complete) return JSON.stringify(subResult.early_complete);
      const nextHop = state.getHopContext();
      if ('done' in nextHop) return JSON.stringify(state.getResult());
      return JSON.stringify({ ...subResult, ...nextHop });
    }

    default:
      return JSON.stringify({ error: 'unknown_tool', name });
  }
}
