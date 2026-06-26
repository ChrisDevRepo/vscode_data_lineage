/**
 * Pure helper utilities extracted from the `@lineage` chat-participant turn handler.
 *
 * @remarks
 * Stateless functions for tool-call/result field extraction, trailing tool-pair
 * lookup in rebuilt history, ACTIVE/COMPLETED replay-payload minimization,
 * follow-up trigger normalization, and transient-LM-error classification. The
 * participant class and the LM round loop live in
 * [`lineageParticipant.ts`](./lineageParticipant.ts).
 */
import * as vscode from 'vscode';
import { AiSession } from '../session/session';
import { trunc } from '../../utils/log';
import { NavigationEngine } from '../sm/smBase';
import { type ToolPair } from '../participant/messageEnvelope';
import { matchesTransientNetPattern } from '../infra/transientErrors';
export { classifyGateReply } from '../session/sessionPhase';

/**
 * Normalizes the extraction of key fields from a VS Code language model tool call part.
 *
 * @remarks
 * Provides a stable interface for the participant loop by abstracting the extraction
 * of `callId`, `name`, and `input` from various versions of the tool call part.
 *
 * @param tc - The tool call part received from the language model response.
 * @returns An object containing the normalized call identifier, tool name, and input arguments.
 */
export function extractToolCallFields(tc: vscode.LanguageModelToolCallPart): { callId: string; name: string; input: Record<string, unknown> } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input as Record<string, unknown>,
  };
}

/**
 * Returns true when the message contains at least one tool-result part.
 */
export function hasToolResultParts(msg: vscode.LanguageModelChatMessage): boolean {
  return (msg.content as readonly unknown[]).some(p => p instanceof vscode.LanguageModelToolResultPart);
}

/**
 * Returns true when the message contains at least one tool-call part.
 */
export function hasToolCallParts(msg: vscode.LanguageModelChatMessage): boolean {
  return (msg.content as readonly unknown[]).some(p => p instanceof vscode.LanguageModelToolCallPart);
}

/**
 * Finds the trailing assistant(tool_call) -> user(tool_result) pair in rebuilt
 * history messages.
 */
export function findLastToolPairInHistory(
  history: readonly vscode.LanguageModelChatMessage[],
): ToolPair | undefined {
  for (let i = history.length - 1; i > 0; i--) {
    const result = history[i];
    const assistant = history[i - 1];
    if (result.role !== vscode.LanguageModelChatMessageRole.User) continue;
    if (assistant.role !== vscode.LanguageModelChatMessageRole.Assistant) continue;
    if (!hasToolResultParts(result) || !hasToolCallParts(assistant)) continue;
    return { assistant, result };
  }
  return undefined;
}

/**
 * Appends a block to text once per turn.
 *
 * @returns Updated text plus whether a duplicate append was avoided.
 */
export function appendBlockOnce(base: string, block: string): { text: string; skippedDuplicate: boolean } {
  if (!block) return { text: base, skippedDuplicate: false };
  if (base.includes(block)) return { text: base, skippedDuplicate: true };
  return { text: `${base}\n\n${block}`, skippedDuplicate: false };
}

/**
 * Removes overlay-only focus anchors from markdown replayed into chat.
 *
 * @remarks
 * The description overlay supports `#focus-node:<id>` links for graph focus.
 * Chat replay should remain readable without exposing anchor payloads.
 */
export function sanitizeDescriptionForChat(description: string): string {
  return description
    .replace(/^### Objects\s+(.+)$/gm, (_m, tail: string) => {
      const cleaned = tail.replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
      return `### Objects ${cleaned}`;
    })
    .replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
}

export function lastAssistantMarkdownFromHistory(history: readonly vscode.ChatRequestTurn[] | readonly vscode.ChatResponseTurn[] | readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!(turn instanceof vscode.ChatResponseTurn)) continue;
    const text = turn.response
      .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
      .map(p => (p as vscode.ChatResponseMarkdownPart).value.value)
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Minimizes replayed tool-result payload for ACTIVE phase.
 *
 * @remarks
 * Keeps only current-hop evidence fields. Hop counters and mission intent are
 * emitted by canonical prompt blocks (`<mission_state>`, `<mission_brief>`),
 * so they are removed from replay to avoid duplicate carriers in one envelope.
 */
export function minimizeActiveToolResultPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  if (typeof payload.sm_status === 'string') out.sm_status = payload.sm_status;
  if (isRecord(payload.focus_node)) out.focus_node = payload.focus_node;
  if (Array.isArray(payload.neighbors)) out.neighbors = payload.neighbors;
  const workingMemory = isRecord(payload.working_memory) ? payload.working_memory : undefined;
  const columnAspect = isRecord(workingMemory?.column_aspect) ? workingMemory.column_aspect : undefined;
  const activeColumns = columnAspect?.active_columns;
  if (Array.isArray(activeColumns)) {
    out.column_state = {
      active_columns: activeColumns.slice(0, 12),
      active_count: activeColumns.length,
    };
  }
  // Guard against accidental evidence loss: if the compact projection would
  // drop focus evidence, preserve the original payload.
  if (!out.focus_node || !Array.isArray(out.neighbors)) return payload;
  if (Object.keys(out).length > 0) return out;
  return payload;
}

/**
 * Builds an ACTIVE-safe minimal replay pair from a full tool pair.
 */
export function buildActiveMinimalToolPair(pair: ToolPair | undefined): ToolPair | undefined {
  if (!pair) return undefined;

  const toolCallParts = (pair.assistant.content as readonly unknown[])
    .filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
  const firstCall = toolCallParts[0];
  if (!firstCall) return undefined;

  const rawInput = (firstCall.input as Record<string, unknown>) || {};
  let compactInput: Record<string, unknown> = { replay_compacted: true, trace_replay: true };
  if (firstCall.name === 'lineage_submit_findings') {
    const isCtSubmit = Array.isArray(rawInput.column_flow);
    const routeRequestCount = Array.isArray(rawInput.route_requests) ? rawInput.route_requests.length : 0;
    const pruneNeighborCount = Array.isArray(rawInput.prune_neighbors) ? rawInput.prune_neighbors.length : 0;
    const outCols = isCtSubmit
      ? (rawInput.column_flow as Array<Record<string, unknown>>)
        .map(cf => typeof cf.out_col === 'string' ? cf.out_col : '')
        .filter(Boolean)
        .slice(0, 12)
      : [];
    compactInput = {
      replay_compacted: true,
      trace_replay: true,
      focus_node_id: rawInput.focus_node_id,
      verdict: rawInput.verdict,
      mode: isCtSubmit ? 'ct' : 'bb',
      ...(isCtSubmit
        ? {
            column_flow_entries: (rawInput.column_flow as unknown[]).length,
            column_flow_out_cols: outCols,
          }
        : {
            route_request_count: routeRequestCount,
            prune_neighbor_count: pruneNeighborCount,
          }),
    };
  } else if (firstCall.name === 'lineage_start_exploration') {
    compactInput = {
      replay_compacted: true,
      trace_replay: true,
      origin: rawInput.origin,
      direction: rawInput.direction,
      classification: rawInput.classification,
    };
  }

  const assistant = new vscode.LanguageModelChatMessage(
    vscode.LanguageModelChatMessageRole.Assistant,
    [new vscode.LanguageModelToolCallPart(firstCall.callId, firstCall.name, compactInput)],
  );

  const compactResults: vscode.LanguageModelToolResultPart[] = [];
  for (const part of (pair.result.content as readonly unknown[])) {
    if (!(part instanceof vscode.LanguageModelToolResultPart)) continue;
    const textPart = part.content.find(c => c instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
    if (!textPart) {
      compactResults.push(part);
      continue;
    }
    try {
      const payload: unknown = JSON.parse(textPart.value);
      const compact = minimizeActiveToolResultPayload(payload);
      compactResults.push(new vscode.LanguageModelToolResultPart(
        part.callId,
        [new vscode.LanguageModelTextPart(JSON.stringify(compact))],
      ));
    } catch {
      compactResults.push(part);
    }
  }
  const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, compactResults);
  return { assistant, result };
}

/**
 * Builds a compact follow-up snapshot so completed-phase turns keep only the
 * currently editable result contract instead of replaying all prior rounds.
 */
export function buildCompletedResultSnapshot(sess: AiSession): string {
  const rg = sess.resultGraph;
  if (!rg) return '';

  const sectionLines = (rg.sections ?? [])
    .slice(0, 8)
    .map((s, i) => `${i + 1}. ${s.label}${s.angle ? ` [${s.angle}]` : ''} (${s.node_ids?.length ?? 0} node${(s.node_ids?.length ?? 0) === 1 ? '' : 's'})`)
    .join('\n');

  const desc = (sess.lastPresentResultDescription ?? rg.description ?? '').trim();
  const descExcerpt = desc.length > 2200
    ? `${desc.slice(0, 2200)}\n\n…[description truncated; ${desc.length - 2200} chars omitted]`
    : desc;

  return [
    '## Current Rendered Result Snapshot',
    `- view: ${rg.summary ?? '(none)'}`,
    `- title: ${rg.title ?? '(none)'}`,
    `- sections: ${(rg.sections ?? []).length}`,
    `- notes: ${(rg.notes ?? []).length}`,
    '- archive_status: complete (details are stored in SM state and can be requested/updated)',
    sectionLines ? '\n### Section map\n' + sectionLines : '',
    descExcerpt ? '\n### Current description excerpt\n' + descExcerpt : '',
  ].filter(Boolean).join('\n');
}

/**
 * Minimizes replayed tool-result payload for COMPLETED phase.
 *
 * @remarks
 * Keeps only success/error envelope and compact graph identifiers. The detailed
 * rendered body is supplied via {@link buildCompletedResultSnapshot}.
 */
export function minimizeCompletedToolResultPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.error) {
    return { error: payload.error, hint: payload.hint, next_action: payload.next_action };
  }
  if (payload.success === true) {
    return {
      success: true,
      view_name: payload.view_name,
      node_count: payload.node_count,
      graph_source: payload.graph_source,
      compacted: true,
    };
  }
  if (payload.compacted) return payload;
  return { compacted: true, summary: 'completed_replay_compacted' };
}

/**
 * Builds a COMPLETED-safe minimal replay pair from a full tool pair.
 */
export function buildCompletedMinimalToolPair(pair: ToolPair | undefined): ToolPair | undefined {
  if (!pair) return undefined;

  const toolCallParts = (pair.assistant.content as readonly unknown[])
    .filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
  const firstCall = toolCallParts[0];
  if (!firstCall) return undefined;

  const rawInput = (firstCall.input as Record<string, unknown>) || {};
  let compactInput: Record<string, unknown> = { replay_compacted: true };
  if (firstCall.name === 'lineage_present_result') {
    compactInput = {
      replay_compacted: true,
      is_update: rawInput.is_update === true,
      summary: rawInput.summary,
      title: rawInput.title,
      section_labels: Array.isArray(rawInput.sections)
        ? (rawInput.sections as Array<Record<string, unknown>>).map(s => String(s.label ?? '')).filter(Boolean).slice(0, 8)
        : [],
    };
  } else if (firstCall.name === 'lineage_submit_findings') {
    compactInput = {
      replay_compacted: true,
      focus_node_id: rawInput.focus_node_id,
      verdict: rawInput.verdict,
      badge_label: rawInput.badge_label,
    };
  } else if (firstCall.name === 'lineage_start_exploration') {
    compactInput = {
      replay_compacted: true,
      origin: rawInput.origin,
      direction: rawInput.direction,
      classification: rawInput.classification,
      depth: rawInput.depth,
    };
  }

  const assistant = new vscode.LanguageModelChatMessage(
    vscode.LanguageModelChatMessageRole.Assistant,
    [new vscode.LanguageModelToolCallPart(firstCall.callId, firstCall.name, compactInput)],
  );

  const compactResults: vscode.LanguageModelToolResultPart[] = [];
  for (const part of (pair.result.content as readonly unknown[])) {
    if (!(part instanceof vscode.LanguageModelToolResultPart)) continue;
    const textPart = part.content.find(c => c instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
    if (!textPart) {
      compactResults.push(part);
      continue;
    }
    try {
      const payload: unknown = JSON.parse(textPart.value);
      const compact = minimizeCompletedToolResultPayload(payload);
      compactResults.push(new vscode.LanguageModelToolResultPart(
        part.callId,
        [new vscode.LanguageModelTextPart(JSON.stringify(compact))],
      ));
    } catch {
      compactResults.push(part);
    }
  }
  const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, compactResults);
  return { assistant, result };
}

/**
 * Compacts `present_result` tool-call input for same-turn replay.
 *
 * @remarks
 * The tool invocation itself still receives the full model-emitted input.
 * This compact form is used only when replaying assistant tool-calls back
 * into the envelope for subsequent rounds, reducing repeated payload bloat.
 */
export function compactPresentResultReplayInput(rawInput: Record<string, unknown>): Record<string, unknown> {
  const sections = Array.isArray(rawInput.sections)
    ? (rawInput.sections as Array<Record<string, unknown>>)
      .slice(0, 12)
      .map((s) => ({
        label: s.label,
        angle: s.angle,
        node_ids: Array.isArray(s.node_ids) ? (s.node_ids as unknown[]).slice(0, 20) : [],
        text: typeof s.text === 'string' ? trunc(s.text, 240) : '',
      }))
    : [];

  return {
    replay_compacted: true,
    is_update: rawInput.is_update === true,
    name: rawInput.name,
    title: rawInput.title,
    summary: rawInput.summary,
    layout_direction: rawInput.layout_direction,
    sections,
    add_node_ids: Array.isArray(rawInput.add_node_ids) ? (rawInput.add_node_ids as unknown[]).slice(0, 50) : [],
    prune_node_ids: Array.isArray(rawInput.prune_node_ids) ? (rawInput.prune_node_ids as unknown[]).slice(0, 50) : [],
    note_count: Array.isArray(rawInput.notes) ? rawInput.notes.length : 0,
    highlight_group_count: Array.isArray(rawInput.highlight_groups) ? rawInput.highlight_groups.length : 0,
  };
}

/**
 * Compacts assistant tool-call parts for same-turn envelope replay.
 *
 * @remarks
 * Applied only in synthesis/completed phases and only to `present_result`
 * calls, where retries otherwise replay large unchanged payloads.
 */
export function compactAssistantReplayParts(
  parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
  phase: 'discover' | 'active' | 'synthesis' | 'completed',
): Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
  if (phase !== 'synthesis' && phase !== 'completed') return parts;
  let changed = false;
  const compacted = parts.map((p) => {
    if (!(p instanceof vscode.LanguageModelToolCallPart)) return p;
    if (p.name !== 'lineage_present_result') return p;
    const compactInput = compactPresentResultReplayInput((p.input as Record<string, unknown>) || {});
    changed = true;
    return new vscode.LanguageModelToolCallPart(p.callId, p.name, compactInput);
  });
  return changed ? compacted : parts;
}

/**
 * Extracts the error code from a tool result's JSON envelope.
 *
 * @remarks
 * Inspects the result content for a JSON-formatted error envelope (`{ error: 'code', ... }`).
 * Returns `null` if the result is successful, absent, or does not contain a valid error code.
 *
 * @param result - The tool result to inspect.
 * @returns The error code string, or `null` if the result is successful or invalid.
 */
export function extractToolErrorCode(result: vscode.LanguageModelToolResult | undefined): string | null {
  if (!result) return null;
  for (const p of result.content) {
    if (!(p instanceof vscode.LanguageModelTextPart)) continue;
    try {
      const data = JSON.parse(p.value);
      if (data && typeof data.error !== 'undefined') return String(data.error);
    } catch { /* Ignore non-JSON parts */ }
  }
  return null;
}

/**
 * Parses the first JSON payload from a tool result.
 *
 * @param result - The tool result to inspect.
 * @returns Parsed object payload, or null when absent / invalid.
 */
export function extractToolResultJson(result: vscode.LanguageModelToolResult | undefined): Record<string, unknown> | null {
  if (!result) return null;
  for (const p of result.content) {
    if (!(p instanceof vscode.LanguageModelTextPart)) continue;
    try {
      const data = JSON.parse(p.value);
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    } catch { /* Ignore non-JSON parts */ }
  }
  return null;
}

/**
 * Normalizes follow-up trigger text for resilient matching across UI variants.
 *
 * @param value - Raw chat prompt text.
 * @returns Lower-cased, trimmed string with unified ellipsis.
 */
export function normalizeFollowupTrigger(value: string): string {
  return value.trim().toLowerCase().replace(/…/g, '...');
}

/**
 * Render the per-hop User-message directive from current engine state.
 *
 * @remarks
 * Called at every sliding-memory wipe so the trailing User msg reflects the engine's
 * advanced focus + hop number, not the gate-approval text frozen at session start.
 */
export function renderHopDirective(engine: NavigationEngine | null): string {
  return engine?.currentFocus
    ? 'Continue the hop-by-hop analysis — call submit_findings for this node.'
    : 'Continue the hop-by-hop analysis — call submit_findings for the current focus node.';
}

/**
 * Classifies an LM `sendRequest` exception as a transient network failure that is safe to retry.
 *
 * @remarks
 * `vscode.LanguageModelError` codes (Cancelled / NotFound / NoPermissions / Blocked) are
 * intentional model-side decisions and must never be retried. The transient-network text match
 * is delegated to the vscode-free helper so unit tests can exercise it under tsx.
 */
export function isTransientLmError(err: unknown): boolean {
  if (err instanceof vscode.LanguageModelError) return false;
  return matchesTransientNetPattern(err);
}
