/**
 * `@lineage` chat-participant turn handler.
 *
 * @remarks
 * Implements the agent loop end-to-end:
 * - Resolves history, applies context-pressure eviction, and seeds the
 *   {@link MessageEnvelope} for the LM round.
 * - Composes the per-phase system prompt via `buildStageSystemPrompt`
 *   (stable prefix + dynamic suffix), driving the discover → active →
 *   synthesis → completed FSM in [`sessionPhase.ts`](./sessionPhase.ts).
 * - Runs the multi-round tool loop with `RepeatRejectGuard`, `toolPolicy`
 *   filtering, and a single `dispatchExit` finalizer that owns post-loop
 *   cleanup (gate re-emit, partial result handling, hop-cap rerun message).
 *
 * The hop-loop body and finalizer here are the only places that touch
 * `vscode.lm.sendRequest` and `ChatResponseStream` for the participant —
 * keep stream writes funneled through {@link ChatResponseWriter}.
 */
import * as vscode from 'vscode';
import { AiSession } from '../session/session';
import { Logger, trunc, sanitizeForLog } from '../../utils/log';
import { setCatalogInlineTokenBudget, setDiscoveryNodeCap, setDiscoveryTokenBudget, SCRIPT_TYPES } from '../tools/tools';
import {
  buildGeneralSystemPrompt, buildPhasePrompt, buildFollowUpPrompt,
  buildTracePrompt, buildSearchPrompt, buildActionRequiredGate,
  buildMissionBriefBlock, buildCurrentTaskBlock, buildMemoryBlock, buildMissionStateBlock,
  buildDeferredQuestionsPrompt, buildFollowupFallbackPrompt, RECOMMEND_FOLLOWUPS_TRIGGER, SHOW_DESCRIPTION_TRIGGER,
  START_DEEPER_ANALYSIS_TRIGGER, buildStartDeeperAnalysisTriggerPrompt,
  buildDiscoverySummaryBlock, buildDiscoverySummaryComposePrompt,
  ACTION_REQUIRED_PENDING_HINT
} from '../prompting/prompts';
import { getToolInvocationLabel } from '../tools/toolLabels';
import { buildSmProtocol } from '../prompting/smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from '../participant/historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from '../infra/tokenBudget';
import { NavigationEngine } from '../sm/smBase';
import { RepeatRejectGuard } from '../participant/repeatRejectGuard';
import { PendingGateSchema, classifyGateReply, type PendingGate, type HopLoopExit } from '../session/sessionPhase';
import { renderScopeSummaryMd } from '../prompting/scopeSummaryRenderer';
import { decideGateTransition } from '../interaction/rules/gateTransitionRules';

import { filterLmTools, activeModeOf } from '../tools/toolPolicy';
import { resolveStagePrompt } from '../prompting/templateRenderer';
import { ChatResponseWriter } from '../participant/chatResponseWriter';
import { PerformanceCollector } from '../infra/diagnostics';
import { MessageEnvelope, MessageEnvelopeInvariantError, type ToolPair } from '../participant/messageEnvelope';
import { matchesTransientNetPattern } from '../infra/transientErrors';
import { LmTracer } from '../infra/lmTracer';
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
function hasToolResultParts(msg: vscode.LanguageModelChatMessage): boolean {
  return (msg.content as readonly unknown[]).some(p => p instanceof vscode.LanguageModelToolResultPart);
}

/**
 * Returns true when the message contains at least one tool-call part.
 */
function hasToolCallParts(msg: vscode.LanguageModelChatMessage): boolean {
  return (msg.content as readonly unknown[]).some(p => p instanceof vscode.LanguageModelToolCallPart);
}

/**
 * Finds the trailing assistant(tool_call) -> user(tool_result) pair in rebuilt
 * history messages.
 */
function findLastToolPairInHistory(
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
function appendBlockOnce(base: string, block: string): { text: string; skippedDuplicate: boolean } {
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
function sanitizeDescriptionForChat(description: string): string {
  return description
    .replace(/^### Objects\s+(.+)$/gm, (_m, tail: string) => {
      const cleaned = tail.replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
      return `### Objects ${cleaned}`;
    })
    .replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
function minimizeActiveToolResultPayload(payload: unknown): unknown {
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
function buildActiveMinimalToolPair(pair: ToolPair | undefined): ToolPair | undefined {
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
function buildCompletedResultSnapshot(sess: AiSession): string {
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
function minimizeCompletedToolResultPayload(payload: unknown): unknown {
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
function buildCompletedMinimalToolPair(pair: ToolPair | undefined): ToolPair | undefined {
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
function compactPresentResultReplayInput(rawInput: Record<string, unknown>): Record<string, unknown> {
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
function compactAssistantReplayParts(
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
function extractToolResultJson(result: vscode.LanguageModelToolResult | undefined): Record<string, unknown> | null {
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
function normalizeFollowupTrigger(value: string): string {
  return value.trim().toLowerCase().replace(/…/g, '...');
}

/**
 * Render the per-hop User-message directive from current engine state.
 *
 * @remarks
 * Called at every sliding-memory wipe so the trailing User msg reflects the engine's
 * advanced focus + hop number, not the gate-approval text frozen at session start.
 */
function renderHopDirective(engine: NavigationEngine | null): string {
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

/**
 * Orchestrates the interaction between VS Code Chat and the lineage engine.
 *
 * @remarks
 * This class implements the `ChatParticipant` interface, managing the full request lifecycle:
 * 1. **Discovery**: Intent analysis and initial scope mapping.
 * 2. **Active**: State machine execution for graph traversal and data collection.
 * 3. **Synthesis**: Reporting and presentation of findings.
 *
 * It utilizes a "Sliding Memory" protocol to manage large context windows and implements
 * multi-round tool execution with repeat-rejection guards.
 */
export class LineageParticipant {
  private readonly logger: Logger;

  /**
   * @param context - The extension context for subscription management.
   * @param getSession - Factory for retrieving the active AI session.
   * @param outputChannel - Channel for participant activity logs.
   * @param getActivePanel - Provider for the active webview panel instance.
   */
  constructor(
    private context: vscode.ExtensionContext,
    private getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private getActivePanel: () => vscode.WebviewPanel | undefined
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  /**
   * Registers the chat participant and its feedback listener.
   *
   * @remarks
   * Suggested follow-up actions (like exploring deferred nodes) are surfaced via
   * a `followupProvider` as standard VS Code chat pills. This maintains a clean
   * UX while inviting the user to deepen the analysis. Deterministic UI actions
   * (like "Show in Graph") remain as `stream.button` in the response stream.
   */
  public register() {
    const participant = vscode.chat.createChatParticipant(
      'dataLineageViz.lineage',
      this.handleChatRequest.bind(this)
    );

    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
      this.logger.info(`Feedback: ${kind}`);
    });

    participant.followupProvider = {
      provideFollowups: (result, context, token) => {
        const sess = this.getSession();
        const followups: vscode.ChatFollowup[] = [];

        // Always emit after completed synthesis; same trigger handles both labels.
        const completedWithResult =
          sess.phase.kind === 'completed' &&
          sess.stateMachine !== undefined &&
          sess.lastPresentResultDescription !== undefined;
        if (completedWithResult) {
          const deferredCount = sess.stateMachine!.deferredQuestions.length;
          followups.push({
            prompt: RECOMMEND_FOLLOWUPS_TRIGGER,
            label: deferredCount > 0
              ? vscode.l10n.t('Follow-up: Explore related objects…')
              : vscode.l10n.t('Ask a follow-up question')
          });
        }

        // Surface the cached AI-preview description as a one-click recall chip.
        if (sess.lastPresentResultDescription) {
          followups.push({
            prompt: SHOW_DESCRIPTION_TRIGGER,
            label: vscode.l10n.t('Show full description')
          });
        }

        // Post-discovery SM-offer pill — surfaces only after a multi-object
        // discovery walk (≥2 distinct lineage_get_object_detail calls) AND
        // only while the session is still `idle`. Once a gate is pending or
        // SM has started, enterGate() clears the captured fields so the pill
        // disappears and cannot resurface.
        if (
          sess.phase.kind === 'idle' &&
          sess.lastDiscoveryWalkCount >= 2 &&
          sess.lastDiscoveryOrigin
        ) {
          followups.push({
            prompt: START_DEEPER_ANALYSIS_TRIGGER,
            label: vscode.l10n.t('Start deeper hop-by-hop analysis')
          });
        }

        return followups;
      }
    };

    this.context.subscriptions.push(participant);
  }

  /**
   * Primary request handler for the chat participant.
   *
   * @remarks
   * Implements the core agent loop, managing model resolution, history reconstruction,
   * context eviction, and multi-round tool execution.
   *
   * @param request - The user chat request.
   * @param chatContext - The active conversation context.
   * @param stream - Response stream for markdown and tool updates.
   * @param token - Cancellation token.
   * @returns The final chat result metadata.
   */
  public async handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    const sess = this.getSession();

    // Use the model selected by the user in the Chat UI directly.
    const model = request.model;
    sess.maxInputTokens = model.maxInputTokens ?? 32768;
    sess.modelName = model.name || model.id;
    LmTracer.sessionStart(sess.id, model.id, sess.maxInputTokens);

    const writer = new ChatResponseWriter(stream, token, this.logger, sess.id);
    const collector = new PerformanceCollector(this.logger);

    const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
    const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
    setCatalogInlineTokenBudget(aiConfig.get<number>('ai.contextPayloadBudget', 10_000));
    setDiscoveryNodeCap(aiConfig.get<number>('ai.discoveryNodeCap', 10));
    setDiscoveryTokenBudget(aiConfig.get<number>('ai.discoveryTokenBudget', 10_000));
    const showToolInvocations = aiConfig.get<boolean>('ai.showToolInvocations', false);

    if (!sess.model) {
      writer.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first.');
      return {};
    }

    if (chatContext.history.length === 0) {
      const RESULT_GRAFT_WINDOW_MS = 5 * 60 * 1000;
      const preservedResult = sess.resultGraph;
      const recent = preservedResult && (Date.now() - sess.startTime) < RESULT_GRAFT_WINDOW_MS;
      sess.regenerateSessionId();
      sess.resetExploration();
      if (recent && preservedResult) {
        sess.resultGraph = preservedResult;
        this.logger.info(`[${sess.id}] New chat session — state rotated; resultGraph preserved (${preservedResult.nodeIds.length} nodes, ${preservedResult.source})`);
      } else {
        this.logger.info(`[${sess.id}] New chat session detected — state rotated`);
      }
    }

    // Reset the parallel-call guard at every turn entry.
    sess.startExplorationRoundId = null;
    sess.fromFollowupDeferredTriggerThisTurn = false;
    this.logger.info(
      `[${sess.id}] Session start — ` +
      `model=${model.vendor}/${model.family}/${model.version} (id=${model.id}, max=${model.maxInputTokens}t) ` +
      `cmd=${request.command ?? '(none)'} ` +
      `refs=${request.references.length} toolRefs=${request.toolReferences.length} ` +
      `history=${chatContext.history.length} ` +
      `prompt="${trunc(request.prompt, 200)}"`
    );

    let effectivePrompt = request.prompt;
    let duplicateBlocksRemovedThisTurn = 0;
    const toolResultCharsByTool = new Map<string, number>();
    const normalizedPrompt = normalizeFollowupTrigger(effectivePrompt);
    const isRecommendFollowupTrigger = (
      normalizedPrompt === normalizeFollowupTrigger(RECOMMEND_FOLLOWUPS_TRIGGER) ||
      normalizedPrompt === 'follow-up: explore related objects...' ||
      normalizedPrompt === 'ask a follow-up question'
    );
    const isShowDescriptionTrigger = (
      normalizedPrompt === normalizeFollowupTrigger(SHOW_DESCRIPTION_TRIGGER) ||
      normalizedPrompt === 'show full description'
    );
    const isStartDeeperTrigger = (
      normalizedPrompt === normalizeFollowupTrigger(START_DEEPER_ANALYSIS_TRIGGER)
    );

    if (isRecommendFollowupTrigger) {
      const deferred = sess.stateMachine?.deferredQuestions || [];
      if (deferred.length > 0) {
        effectivePrompt = buildDeferredQuestionsPrompt(deferred);
        sess.fromFollowupDeferredTriggerThisTurn = true;
        this.logger.info(`[Trigger] Follow-up expansion: ${deferred.length} objects`);
      } else {
        effectivePrompt = buildFollowupFallbackPrompt();
      }
    } else if (isShowDescriptionTrigger) {
      if (sess.lastPresentResultDescription) {
        writer.markdown(sanitizeDescriptionForChat(sess.lastPresentResultDescription));
      } else {
        writer.markdown('_No AI preview description is currently cached for this session._');
      }
      this.logger.info(`[Trigger] Show full description — ${sess.lastPresentResultDescription?.length ?? 0} chars`);
      return {};
    } else if (isStartDeeperTrigger) {
      if (!sess.lastDiscoveryOrigin || !sess.lastDiscoveryQuestion || !sess.lastDiscoveryAnswer) {
        writer.markdown('_The deeper-analysis link expired (no recent discovery walk). Ask the question again to enable it._');
        this.logger.warn(`[Trigger] Start deeper — discovery context missing (origin=${sess.lastDiscoveryOrigin}, q=${!!sess.lastDiscoveryQuestion}, a=${!!sess.lastDiscoveryAnswer})`);
        return {};
      }
      effectivePrompt = buildStartDeeperAnalysisTriggerPrompt(
        sess.lastDiscoveryQuestion,
        sess.lastDiscoveryAnswer,
        sess.lastDiscoveryOrigin,
      );
      this.logger.info(`[Trigger] Start deeper — origin=${sess.lastDiscoveryOrigin} q_len=${sess.lastDiscoveryQuestion.length} a_len=${sess.lastDiscoveryAnswer.length}`);
    }

    let activePhase: 'discover' | 'active' | 'synthesis' | 'completed' = 'discover';
    let lineageTools = filterLmTools(vscode.lm.tools, { kind: 'discover' });
    let isRefineRound = false;

    if ((request.command === 'trace' || request.command === 'search')
        && sess.phase.kind !== 'idle'
        && sess.phase.kind !== 'completed'
        && sess.phase.kind !== 'awaiting_gate') {
      const cmdName = request.command === 'trace' ? '/trace' : '/search';
      const phaseLabel = sess.phase.kind === 'exploring'
        ? 'an active exploration is in progress'
        : 'synthesis is in progress';
      writer.markdown(`\n\n> \`${cmdName}\` is available only when no exploration is active. Currently ${phaseLabel}. Wait for synthesis to complete, then start a fresh question.\n\n`);
      this.logger.info(`[SlashGate] ${cmdName} blocked — phase=${sess.phase.kind}`);
      return {};
    }

    if (request.command === 'trace') {
      effectivePrompt = buildTracePrompt(request.prompt);
    } else if (request.command === 'search') {
      effectivePrompt = buildSearchPrompt(request.prompt);
    }

    if (sess.phase.kind === 'awaiting_gate') {
      const gate = sess.phase.gate;
      const answer = classifyGateReply(request.prompt);
      const decision = decideGateTransition(gate, answer);
      if (decision.action === 'cancel') {
        sess.enterIdle();
        sess.resetExploration();
        writer.markdown(`\n\n> Exploration cancelled — ask a fresh question to start over.\n\n`);
        this.logger.info(`[Gate] ${gate.gate} — user cancelled`);
        return {};
      }
      // Refine path — only meaningful for the discovery-phase confirm_sm_start gate.
      // The user typed a free-text narrowing instruction (or pressed the Refine Scope
      // button which pre-fills `@lineage refine: `). Phase stays awaiting_gate; the AI
      // is forced to translate the intent into structural exclusions and re-call
      // start_exploration — the engine then re-emits the gate with the new tree.
      if (decision.action === 'refine_confirm_sm') {
        isRefineRound = true;
        const engine = sess.stateMachine as NavigationEngine | null;
        const summary = engine?.getScopeSummary();
        const treeMd = summary ? renderScopeSummaryMd(summary) : '_(scope tree unavailable)_';
        const filters = summary?.activeFilters ?? { schemas: [], types: [], nodeIds: [], passNodeIds: [] };
        // Strip the literal `refine:` prefix so the AI sees the user's actual instruction.
        const verbatim = request.prompt.replace(/^@lineage\s+/i, '').replace(/^refine\s*:?\s*/i, '').trim();
        effectivePrompt = [
          'The user is refining the pending exploration scope. Do not start a new exploration.',
          '',
          `Current candidate hops (post-filter, ${summary?.scopeCount ?? 0} nodes):`,
          treeMd,
          '',
          'Currently applied filters:',
          `- excludeTypes: ${filters.types.length ? filters.types.join(', ') : '(none)'}`,
          `- excludeSchemas: ${filters.schemas.length ? filters.schemas.join(', ') : '(none)'}`,
          `- excludeNodeIds: ${filters.nodeIds.length ? filters.nodeIds.join(', ') : '(none)'}`,
          `- passNodeIds: ${filters.passNodeIds.length ? filters.passNodeIds.join(', ') : '(none)'}`,
          '',
          `User feedback: "${verbatim}"`,
          '',
          'Translate the feedback into a full re-spec — send the complete final filter set',
          '(not a delta). Call lineage_start_exploration with the same origin / direction /',
          'depth and your updated excludeTypes / excludeSchemas / excludeNodeIds / passNodeIds /',
          'classification / targetColumns. The engine will recompute the scope and',
          're-emit the gate so the user can review or refine again.',
          '',
          'If the user\'s intent is genuinely ambiguous, ask one short clarifying question and',
          'call no tool this turn — phase stays awaiting_gate and the user can re-reply.',
        ].join('\n');
        this.logger.info(`[Gate] ${gate.gate} — user refining (${answer})`);
      } else if (decision.action === 'redirect_non_confirm') {
        // Non-confirm_sm_start gate (schema/depth expansion) — treat as a redirect and reset exploration.
        sess.resetExploration();
        this.logger.info(`[Gate] ${gate.gate} — user redirected`);
      } else {
        if (decision.action === 'approve_confirm_sm') {
          const engine = sess.stateMachine as NavigationEngine | null;
          if (engine) {
            for (const cls of gate.classes) {
              if (cls.startsWith('schema:')) engine.extendAllowedSchemas(cls.slice('schema:'.length));
            }
          }
          sess.enterExploring();
          // Wave 3 — post-approval discovery-summary composition (one-shot LM
          // call, no tools). Composes the user's semantic intent (ignore /
          // focus / be careful / must-address) into a 2–4 sentence memo that
          // rides in every hop's stable prefix as <discovery_summary>.
          // Captured discovery context survives because enterGate does not
          // clear the lastDiscovery* fields; resetExploration clears them on
          // cancel / new session. Skip when discovery context is missing
          // (e.g. SM started directly without a prior multi-object walk).
          if (engine && sess.lastDiscoveryQuestion && sess.lastDiscoveryAnswer) {
            try {
              const scope = engine.getScopeSummary();
              const filters = scope.activeFilters;
              const contractSummary = [
                `- origin: ${engine.currentFocus ?? '(unset)'}`,
                `- scope: ${scope.scopeCount} nodes`,
                `- excludeTypes: ${filters.types.length ? filters.types.join(', ') : '(none)'}`,
                `- excludeSchemas: ${filters.schemas.length ? filters.schemas.join(', ') : '(none)'}`,
                `- excludeNodeIds: ${filters.nodeIds.length ? filters.nodeIds.join(', ') : '(none)'}`,
                `- passNodeIds: ${filters.passNodeIds.length ? filters.passNodeIds.join(', ') : '(none)'}`,
                `- classification: ${sess.classification ?? 'unset'}`,
              ].join('\n');
              const composePrompt = buildDiscoverySummaryComposePrompt(
                sess.lastDiscoveryQuestion,
                sess.lastDiscoveryAnswer,
                contractSummary,
              );
              const composeStart = Date.now();
              LmTracer.request(sess.id, 0, 'compose', [vscode.LanguageModelChatMessage.User(composePrompt)], [], 'auto');
              const composeResponse = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(composePrompt)],
                {},
                token,
              );
              let composedText = '';
              for await (const part of composeResponse.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                  composedText += part.value;
                }
              }
              LmTracer.round(sess.id, 0, 'compose', Date.now() - composeStart, 0, composedText.length, 0);
              const trimmed = composedText.trim();
              if (trimmed.length > 0) {
                engine.setDiscoverySummary(trimmed);
                this.logger.info(`[Discovery] Memo composed — len=${trimmed.length} elapsed=${Date.now() - composeStart}ms`);
              } else {
                this.logger.warn(`[Discovery] Memo composition returned empty response — discoverySummary not set`);
              }
            } catch (err) {
              this.logger.debug(`[Reject] discovery_memo_composition code=internal_error reason=${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
              // _discoverySummary stays null (never set) — absence is clean.
              writer.markdown(`\n\n> ⚠ Could not compose discovery summary — analysis will proceed without it.\n\n`);
            }
          }
          const focusId = engine?.currentFocus;
          const hopNumber = engine?.hopProgress.current ?? 0;
          effectivePrompt = focusId
            ? `User approved. Current focus for hop ${hopNumber} is ${focusId}. Call submit_findings for this node.`
            : 'User approved. Begin the hop-by-hop analysis — call submit_findings for the current focus node.';
        } else {
          const engine = sess.stateMachine as NavigationEngine | null;
          if (engine) {
            for (const cls of gate.classes) {
              if (cls.startsWith('schema:')) engine.extendAllowedSchemas(cls.slice('schema:'.length));
              else if (cls.startsWith('depth:+')) engine.extendAllowedDepth(parseInt(cls.slice('depth:+'.length), 10) || 1);
            }
          }
          sess.enterExploring();
          writer.markdown(`\n\n> Expanding scope — ${gate.classes.join(', ')}. Resuming analysis.\n\n`);
          effectivePrompt = `User approved scope expansion for ${gate.classes.join(', ')}. Resume the paused exploration and route the previously blocked nodes: ${gate.nodeIds.join(', ')}.`;
        }
        this.logger.info(`[Gate] ${gate.gate} — user approved classes=[${gate.classes.join(', ')}]`);
      }
    }

    const rebuiltHistoryMessages: vscode.LanguageModelChatMessage[] = [];
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        rebuiltHistoryMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const meta = (turn.result.metadata as any)?.toolCallsMetadata as any;
        if (meta?.toolCallRounds?.length) {
          for (const round of meta.toolCallRounds) {
            const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
            if (round.response) assistantParts.push(new vscode.LanguageModelTextPart(round.response));
            for (const tc of round.toolCalls) {
              const f = extractToolCallFields(tc);
              if (meta.toolCallResults[f.callId]) assistantParts.push(new vscode.LanguageModelToolCallPart(f.callId, f.name, f.input));
            }
            if (assistantParts.length) rebuiltHistoryMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));

            const resultParts: vscode.LanguageModelToolResultPart[] = [];
            for (const tc of round.toolCalls) {
              const f = extractToolCallFields(tc);
              const r = meta.toolCallResults[f.callId];
              if (r) {
                // VS Code chat-message tool-result content is platform-internal and untyped.
                let contentStr = (r.content as any[]).map(c => typeof c.value === 'string' ? c.value : JSON.stringify(c)).join('');
                const complete = sess.stateMachine?.status === 'complete';
                const stale = compactStaleHopResult(f.name, contentStr, complete);
                const compact = stale ?? compactNoiseResult(f.name, contentStr);
                resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(compact || contentStr)]));
              }
            }
            if (resultParts.length) rebuiltHistoryMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
          }
        } else {
          const text = turn.response.filter(p => p instanceof vscode.ChatResponseMarkdownPart).map(p => (p as vscode.ChatResponseMarkdownPart).value.value).join('');
          if (text) rebuiltHistoryMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, text));
        }
      }
    }
    // ACTIVE mode is strict sliding-memory hop-by-hop: no broad chat replay.
    // Use session phase (not per-round local phase) because this runs before
    // round-loop transitions. Keep only the latest tool pair (assistant
    // tool_call + user tool_result), minimized to hop-driving fields.
    const isStrictReplay =
      sess.phase.kind === 'exploring' ||
      (sess.phase.kind === 'completed' && !!sess.stateMachine && sess.stateMachine.status === 'complete');
    const historyMessages: vscode.LanguageModelChatMessage[] =
      isStrictReplay
        ? (() => {
            const rawPair = findLastToolPairInHistory(rebuiltHistoryMessages);
            const pair = sess.phase.kind === 'exploring'
              ? buildActiveMinimalToolPair(rawPair)
              : buildCompletedMinimalToolPair(rawPair);
            return pair ? [pair.assistant, pair.result] : [];
          })()
        : rebuiltHistoryMessages;

      let cachedStablePart: { phase: 'discover' | 'active' | 'synthesis' | 'completed'; focusIsNonBodied: boolean; text: string } | null = null;
      const buildStablePart = (phase: 'discover' | 'active' | 'synthesis' | 'completed'): string => {
        const engine = sess.stateMachine;
        // Determine whether the current focus node is non-bodied (table) so structural_summary
        // only ships for those hops, not for every subsequent bodied (proc/view/function) hop.
        const focusId = (engine?.toJSON() as { currentFocusNodeId?: string | null } | undefined)?.currentFocusNodeId ?? null;
        const focusNodeType = focusId
          ? sess.model!.nodes.find(n => n.id.toLowerCase() === focusId.toLowerCase())?.type
          : null;
        const focusIsNonBodied = focusNodeType != null ? !SCRIPT_TYPES.has(focusNodeType as any) : false;
        if (cachedStablePart && cachedStablePart.phase === phase && cachedStablePart.focusIsNonBodied === focusIsNonBodied) return cachedStablePart.text;
        const dbPlatform = sess.model!.dbPlatform || 'SQL Server';
        const filterSchemas = sess.filter?.schemas || [];
        const totalSchemaCount = sess.model!.schemas.length;
        const totalNodes = sess.model!.nodes.length;
        const activeFilter = sess.filter;
        const visibleNodes = activeFilter?.schemas && activeFilter.schemas.length > 0
          ? sess.model!.nodes.filter(n => (activeFilter.schemas as string[]).includes(n.schema)).length
          : totalNodes;
        const base = buildGeneralSystemPrompt(phase, dbPlatform, filterSchemas, totalSchemaCount, visibleNodes, totalNodes);

        const phaseSpecific = buildPhasePrompt(phase);

        // Follow-up phase inherits the synthesis-stage YAML block so `present_result`
        // re-renders keep the same formatting contract.
        const templatesPhase = phase === 'completed' ? 'synthesis' : phase;
        const isCtMode = !!(engine?.columnAspect);
        const stageResolved = resolveStagePrompt(sess.outputTemplates, templatesPhase, sess.classification, sess.memory.slotCount, isCtMode, focusIsNonBodied);
        const stageBlock = stageResolved.prompt;
        const gatedSummary = stageResolved.gatedOut
          .filter(g => g.reason !== 'stage')  // stage-gated is the dominant reason; keep the line short
          .map(g => `${g.key}(${g.reason})`)
          .join(', ');
        this.logger.debug(
          `[AI] [Template] phase=${templatesPhase} classification=${sess.classification ?? 'unset'} slot_count=${sess.memory.slotCount} ` +
          `shipped_keys=[${stageResolved.shippedKeys.join(', ')}]` +
          (gatedSummary ? ` gated_out=[${gatedSummary}]` : '')
        );
        const parts: string[] = [base, phaseSpecific];

        if (phase === 'active' && engine) {
          parts.push(buildSmProtocol({ targetColumns: engine.columnAspect?.target_columns, classification: sess.classification }));
        }

        parts.push(stageBlock);

        if ((phase === 'active' || phase === 'synthesis' || phase === 'completed') && engine) {
          const missionBriefBlock = buildMissionBriefBlock(sess.memory.getMissionBrief(), sess.memory.getUserQuestion() || '');
          if (missionBriefBlock) parts.push(missionBriefBlock);
          // Wave 3 — persistent discovery memory pillar. The AI-composed memo
          // rides in every hop's stable prefix alongside <mission_brief>; the
          // engine returns null when SM started without a prior multi-object
          // discovery walk, which omits the block cleanly.
          const discoverySummary = (engine as NavigationEngine).getDiscoverySummary?.() ?? null;
          const discoverySummaryBlock = buildDiscoverySummaryBlock(discoverySummary);
          if (discoverySummaryBlock) parts.push(discoverySummaryBlock);
        }

        const text = parts.filter(Boolean).join('\n');
        cachedStablePart = { phase, focusIsNonBodied, text };
        return text;
      };

      const buildDynamicPart = (phase: 'discover' | 'active' | 'synthesis' | 'completed'): string => {
        const engine = sess.stateMachine;
        // Synthesis has no dynamic suffix — no per-hop sub-question, no working
        // memory, no protocol envelope. The closed archive is the substance; per-hop
        // state is active-phase only. Without this guard, a stale <current_task>
        // from the last hop leaks into the synthesis prompt.
        if (!engine || phase === 'discover' || phase === 'synthesis' || phase === 'completed') return '';
        const dynamic: string[] = [];
        const currentTaskBlock = buildCurrentTaskBlock(
          engine.getCurrentTask(),
          engine.columnAspect?.active_columns,
          engine.getColumnLineageQuestions(),
        );
        if (currentTaskBlock) dynamic.push(currentTaskBlock);
        if (phase === 'active') {
          // Mission state first — anchors focus_node_id before the model reads STM content.
          // (mechanically enforced via toolMode.Required + toolPolicy).
          const progress = engine.hopProgress;
          dynamic.push(buildMissionStateBlock(progress.current, progress.total, progress.open, engine.currentFocus));
          const stm = sess.memory.getShortTermMemory();
          dynamic.push(buildMemoryBlock(stm, engine.currentHop, engine.scopeSize));
        }
        return dynamic.filter(Boolean).join('\n');
      };

      const buildStageSystemPrompt = (phase: 'discover' | 'active' | 'synthesis' | 'completed'): string => {
        const stable = buildStablePart(phase);
        const dynamic = buildDynamicPart(phase);
        return dynamic ? `${stable}\n${dynamic}` : stable;
      };

      const invalidateStablePart = () => { cachedStablePart = null; };
    const resumingInActive = sess.phase.kind === 'exploring' && !!sess.stateMachine;
    const resumingInCompleted =
      sess.phase.kind === 'completed' &&
      !!sess.stateMachine &&
      sess.stateMachine.status === 'complete' &&
      chatContext.history.length > 0;
    if (resumingInActive) {
      activePhase = 'active';
      const engine = sess.stateMachine!;
      const mode = activeModeOf(engine.columnAspect !== null);
      lineageTools = filterLmTools(vscode.lm.tools, { kind: 'active', mode });
      this.logger.info(`[Phase] idle → active (gate-resume) — mode=${mode} tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
    } else if (resumingInCompleted) {
      activePhase = 'completed';
      lineageTools = filterLmTools(vscode.lm.tools, { kind: 'completed' });
      const snapshot = buildCompletedResultSnapshot(sess);
      if (snapshot) {
        const appended = appendBlockOnce(effectivePrompt, snapshot);
        effectivePrompt = appended.text;
        if (appended.skippedDuplicate) duplicateBlocksRemovedThisTurn++;
      }
      this.logger.info(`[Phase] completed → follow-up — archive slots=${sess.memory.slotCount}, tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
      this.logger.info(`[Phase] follow-up entry — mission="${trunc(sess.memory.getMissionBrief() || sess.memory.getUserQuestion(), 200)}", classification=${sess.classification ?? '(none)'}`);
    }
    let systemPrompt = buildStageSystemPrompt(activePhase);

    const serializeMessages = (msgs: vscode.LanguageModelChatMessage[]): string => {
      const parts: string[] = [];
      for (const m of msgs) {
        if (typeof m.content === 'string') { parts.push(m.content); continue; }
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content as any) {
          if (p instanceof vscode.LanguageModelTextPart) parts.push(p.value);
          else if (p instanceof vscode.LanguageModelToolCallPart) parts.push(JSON.stringify(p.input));
          else if (p instanceof vscode.LanguageModelToolResultPart) {
            for (const c of (p as any).content) if (c instanceof vscode.LanguageModelTextPart) parts.push(c.value);
          }
        }
      }
      return parts.join('\n');
    };

    const budgetTokens = Math.floor(sess.maxInputTokens * CONTEXT_PRESSURE_THRESHOLD);
    if (budgetTokens > 0 && historyMessages.length > MIN_HISTORY_MESSAGES) {
      try {
        const fullText = `${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`;
        const totalTokens = await model.countTokens(fullText);
        if (totalTokens > budgetTokens) {
          this.logger.debug(`[Performance] Context pressure: ${totalTokens}/${budgetTokens} tokens (${((totalTokens / sess.maxInputTokens) * 100).toFixed(0)}%)`);
          collector.recordEviction();
        }
      } catch (err) {
        this.logger.debug(`Context pressure check failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const envelope = new MessageEnvelope();
    envelope.seed(systemPrompt, effectivePrompt, historyMessages);
    const toolCallRounds: any[] = [];
    const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
    const toolCallCache = new Map<string, vscode.LanguageModelToolResult>();
    let roundCount = 0;
    let consecutiveErrorRounds = 0;
    let totalToolCallsMade = 0;
    let totalOutputTokens = 0;
    let peakRoundInputTokens = 0;
    let totalRoundInputTokens = 0;

    const runHopLoop = async (): Promise<HopLoopExit> => {
      // Reset per-turn presentation flag so the button gate reflects THIS turn only.
      sess.presentResultCalledThisTurn = false;
      sess.synthesisCorrectiveAttempted = false;
      sess.synthesisProgressEmitted = false;
      sess.presentResultAttemptCountThisTurn = 0;
      sess.presentResultFailureCountThisTurn = 0;
      sess.presentResultLastFailureReasonThisTurn = null;
      let actionRequiredPending = false;
      const SEARCH_TOOLS = new Set(['lineage_search_objects', 'lineage_search_ddl', 'lineage_get_context']);
      const repeatGuard = new RepeatRejectGuard();
      let lastProgressLine = '';

      const drainPendingUserNotices = () => {
        if (sess.pendingUserNotice.size === 0) return;
        for (const notice of sess.pendingUserNotice) writer.markdown(`\n\n> ${notice}\n\n`);
        sess.pendingUserNotice.clear();
      };

      while (roundCount < MAX_ROUNDS) {
        if (!writer.isOpen()) return { kind: 'cancelled' };
        roundCount++;
        sess.currentRoundId = roundCount;
        collector.startRound();
        const tRoundStart = Date.now();
        let roundInputTokens = 0;
        try {
          roundInputTokens = await model.countTokens(serializeMessages(envelope.toArray() as vscode.LanguageModelChatMessage[]));
          totalRoundInputTokens += roundInputTokens;
          if (roundInputTokens > peakRoundInputTokens) peakRoundInputTokens = roundInputTokens;
        } catch (err) {
          this.logger.debug(`Per-round countTokens failed: ${err instanceof Error ? err.message : err}`);
        }

        const requestedMode = (activePhase === 'active' || request.command === 'search' || request.command === 'trace') ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto;
        if (activePhase === 'active' && sess.stateMachine) {
          const st = sess.stateMachine.toJSON() as { status?: string; currentFocusNodeId?: string | null; hopCount?: number };
          this.logger.debug(`[Hop ${roundCount}] engine_status=${st.status} focus=${st.currentFocusNodeId ?? '(null)'}`);
        }

        // Explicit map to LanguageModelChatTool — passing raw vscode.lm.tools objects causes sendRequest to silently drop the tools array.
        // In CT mode, strip prune_neighbors from submit_findings schema: the field is BB-only and
        // its presence in the schema causes the AI to submit it even though CT mode rejects it.
        const isCtMode = activePhase === 'active' && sess.stateMachine?.columnAspect !== null;
        const tools: vscode.LanguageModelChatTool[] = lineageTools.map(t => {
          let inputSchema = t.inputSchema;
          if (isCtMode && t.name === 'lineage_submit_findings' && inputSchema) {
            const schema = structuredClone(inputSchema) as Record<string, unknown>;
            const props = schema.properties as Record<string, unknown> | undefined;
            if (props) delete props['prune_neighbors'];
            inputSchema = schema;
          }
          return {
            name: t.name,
            description: t.description || (t.tags?.includes('lineage-presentation') ? 'Presents results to user' : 'Lineage tool'),
            inputSchema,
          };
        });

        // Required is only valid with exactly one tool; fall back to Auto for multi-tool sets.
        const toolMode = (requestedMode === vscode.LanguageModelChatToolMode.Required && tools.length > 1)
          ? vscode.LanguageModelChatToolMode.Auto
          : requestedMode;

        // Pre-send invariant: orphan tool_results would otherwise surface as a remote 400.
        envelope.assertWellFormed();
        // The synthesis call to the model typically takes 30–90s; emit a progress
        // chip on the first synthesis-phase round so users do not perceive a hang.
        if (activePhase === 'synthesis' && !sess.synthesisProgressEmitted) {
          writer.progress('Synthesizing the answer…');
          sess.synthesisProgressEmitted = true;
        }
        // Bounded retry around sendRequest: a single transient network blip before any
        // tokens stream would otherwise terminate the session and discard a complete archive.
        // Wraps the request only — once the stream begins, partial markdown has been surfaced
        // to the user and replay would duplicate output, so mid-stream failures still propagate.
        const MAX_RETRIES = 1;
        const RETRY_DELAY_MS = 1500;
        let response: vscode.LanguageModelChatResponse;
        let attempt = 0;
        while (true) {
          try {
            LmTracer.request(sess.id, roundCount, activePhase, envelope.toArray() as vscode.LanguageModelChatMessage[], tools.map(t => t.name), toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto');
            response = await model.sendRequest(envelope.toArray() as vscode.LanguageModelChatMessage[], { tools, toolMode }, token);
            break;
          } catch (err) {
            if (attempt >= MAX_RETRIES || token.isCancellationRequested || !isTransientLmError(err)) {
              throw err;
            }
            attempt++;
            const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.message : String(err));
            this.logger.warn(`Transient sendRequest retry — code=${trunc(code, 200)} attempt=${attempt}/${MAX_RETRIES} delay=${RETRY_DELAY_MS}ms`);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, RETRY_DELAY_MS);
              token.onCancellationRequested(() => { clearTimeout(timer); reject(new Error('cancelled')); });
            });
          }
        }
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        // Synthesis prose-gate: suppress preamble prose ("Now I have all slots…") by only
        // surfacing prose that arrives AFTER any tool_use part. Pre-tool prose is the model's
        // planning narration; the rendered chat narrative comes after the present_result call.
        // Defensive icon-code strip for synthesis prose: the model occasionally self-renders a
        // Show-in-Graph button as literal markdown ("$(type-hierarchy-sub) Show in Graph"); the
        // platform only renders icon codes inside writer.button(...).
        const proseGate = this.synthesisProseGate(activePhase);
        for await (const part of response.stream) {
          if (!writer.isOpen()) break;
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            assistantParts.push(new vscode.LanguageModelTextPart(part.value.value));
            responseText += part.value.value;
            const surface = proseGate.surface(part.value.value);
            if (surface !== null) writer.markdown(surface);
          } else if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            responseText += part.value;
            const surface = proseGate.surface(part.value);
            if (surface !== null) writer.markdown(surface);
          }
          else if (part instanceof vscode.LanguageModelToolCallPart) {
            assistantParts.push(part);
            toolCalls.push(part);
            proseGate.observeToolCall();
            LmTracer.toolCall(sess.id, roundCount, part.name, part.callId, part.input as Record<string, unknown>);
          }
        }
        if (!writer.isOpen()) return { kind: 'cancelled' };

        let roundOutputTokens = 0;
        try {
          roundOutputTokens = await model.countTokens(responseText);
          totalOutputTokens += roundOutputTokens;
        } catch (err) {
          this.logger.debug(`Output countTokens failed: ${err instanceof Error ? err.message : err}`);
        }
        if (!toolCalls.length) {
          // toolMode.Required falls back to Auto (both ACTIVE toolsets expose ≥2 tools); corrective blocks drift.
          const engine = sess.stateMachine;
          const engineAwaiting =
            !!engine && (engine.toJSON() as { status?: string }).status === 'awaiting_findings';
          if (activePhase === 'active' && engineAwaiting) {
            this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — self-terminate blocked; injecting corrective prompt`);
            if (assistantParts.length > 0) {
              const replayParts = compactAssistantReplayParts(
                assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[],
                activePhase
              );
              envelope.pushAssistant(replayParts);
            }
            envelope.pushUserText(
              'Free-form responses are outside protocol in the SM hop loop. Call `lineage_submit_findings` for the current focus node now (or `lineage_get_neighbor_columns` first if you need a neighbor\'s columns to decide a prune).'
            );
            continue;
          }
          // Synthesis terminal: present_result is the explicit terminator.
          // - Called this turn → exit final_answer.
          // - Toolless and not yet retried → one-shot corrective via MessageEnvelope and continue.
          //   `envelope.pushAssistant + pushUserText` preserves the tool_use/tool_result pair so
          //   Bedrock User-merge cannot orphan a tool_result on the next sendRequest.
          // - Toolless after one corrective → archive fallback (deterministic markdown render).
          if (activePhase === 'synthesis') {
            if (sess.presentResultCalledThisTurn) {
              this.logger.debug(`Round ${roundCount} [SYNTHESIS] — terminated after present_result success`);
              // Stream `intro` to chat — panel overlay holds the full description.
              const intro = sess.resultGraph?.intro?.trim();
              if (intro && intro.length > 0 && responseText.indexOf(intro) === -1) {
                writer.markdown(intro + '\n\n');
              }
            } else if (!sess.synthesisCorrectiveAttempted) {
              sess.synthesisCorrectiveAttempted = true;
              this.logger.debug(`Round ${roundCount} [SYNTHESIS] — no tool call; injecting one-shot corrective and retrying`);
              if (assistantParts.length > 0) {
                const replayParts = compactAssistantReplayParts(
                  assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[],
                  activePhase
                );
                envelope.pushAssistant(replayParts);
              }
              envelope.pushUserText(
                'Call `lineage_present_result` now to assemble the structured view from the archive. The archive is closed; lift each slot\'s analysis text and assemble per the synthesis output templates.'
              );
              continue;
            } else {
              this.logger.debug(`Round ${roundCount} [SYNTHESIS] — no tool call after corrective; rendering archive fallback`);
              this.renderArchiveFallback(sess, writer);
            }
          }
          const msFinal = Date.now() - tRoundStart;
          const pctFinal = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
          this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — final answer (${msFinal}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pctFinal}%)`);
          LmTracer.finalAnswer(sess.id, roundCount, responseText);
          LmTracer.round(sess.id, roundCount, activePhase, msFinal, roundInputTokens, roundOutputTokens, 0);
          drainPendingUserNotices();
          toolCallRounds.push({ response: responseText, toolCalls: [] });
          return { kind: 'final_answer' };
        }

        if (actionRequiredPending && responseText.length > 0) actionRequiredPending = false;
        const replayParts = compactAssistantReplayParts(
          assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[],
          activePhase
        );
        envelope.pushAssistant(replayParts);
        const resultParts: vscode.LanguageModelToolResultPart[] = [];

        let roundHadCacheHit = false;
        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          if (
            activePhase === 'completed' &&
            sess.fromFollowupDeferredTriggerThisTurn &&
            f.name === 'lineage_start_exploration'
          ) {
            const inp = f.input as { origin?: unknown; supplement?: { nodeIds?: unknown[] } | null };
            const hasFreshOrigin = typeof inp.origin === 'string' && inp.origin.trim().length > 0;
            const hasSupplement = !!(inp.supplement && Array.isArray(inp.supplement.nodeIds) && inp.supplement.nodeIds.length > 0);
            if (hasFreshOrigin && !hasSupplement) {
              this.logger.warn('[FollowUpRoute] deferred-trigger turn attempted fresh start_exploration (origin without supplement).');
            }
          }
          const cacheKey = `${f.name}::${JSON.stringify(f.input)}`;
          if (toolCallCache.has(cacheKey)) {
            const cached = toolCallCache.get(cacheKey)!;
            if (extractToolErrorCode(cached) === null) {
              LmTracer.toolInvoke(sess.id, roundCount, f.name, f.callId, true);
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true }))]));
              roundHadCacheHit = true;
              continue;
            }
          }

          if (actionRequiredPending && !SEARCH_TOOLS.has(f.name)) {
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
            continue;
          }

          let progressLine = getToolInvocationLabel(f.name, f.input);
          if (f.name === 'lineage_submit_findings' && sess.stateMachine) {
            const { current, total } = sess.stateMachine.hopProgress;
            const shortName = sess.stateMachine.currentFocus?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
            progressLine = `Hop ${current} / ${total} — analyzing ${shortName}…`;
          } else if (f.name === 'lineage_get_neighbor_columns' && sess.stateMachine) {
            const { current, total } = sess.stateMachine.hopProgress;
            const remaining = Math.max(total - current, 0);
            progressLine = `Inspecting ${remaining} neighbor${remaining === 1 ? '' : 's'} for pruning…`;
          }
          if (progressLine !== lastProgressLine) {
            writer.progress(progressLine);
            lastProgressLine = progressLine;
          }
          totalToolCallsMade++;
          const tInvoke = Date.now();
          LmTracer.toolInvoke(sess.id, roundCount, f.name, f.callId, false);
          try {
            const result = await vscode.lm.invokeTool(f.name, { input: f.input, toolInvocationToken: showToolInvocations ? request.toolInvocationToken : undefined }, token);
            LmTracer.toolResult(sess.id, roundCount, f.name, f.callId, result, Date.now() - tInvoke);
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, result.content));
            accumulatedToolResults[f.callId] = result;
            toolCallCache.set(cacheKey, result);
            let toolResultChars = 0;
            try { toolResultChars = JSON.stringify(result.content).length; } catch { /* no-op */ }
            const prev = toolResultCharsByTool.get(f.name) ?? 0;
            toolResultCharsByTool.set(f.name, prev + toolResultChars);
          } catch (err) {
            const errContent = [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: String(err) }))];
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, errContent));
            accumulatedToolResults[f.callId] = new vscode.LanguageModelToolResult(errContent);
          }
        }

        envelope.pushUserToolResults(resultParts);
        drainPendingUserNotices();

        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const res = accumulatedToolResults[f.callId];
          const errorCode = extractToolErrorCode(res);
          const obs = repeatGuard.observe(f.name, f.input, errorCode !== null);
          if (obs.abort) {
            const lastErrorText = errorCode ?? 'unknown';
            const abortPayload = {
              error: 'session_aborted_repeat_reject',
              tool: f.name,
              last_error: lastErrorText,
              repeat_count: obs.count,
              hint: `The same ${f.name.replace('lineage_', '')} call with the same arguments was rejected ${obs.count} times. The parameters cannot succeed as given. Stop retrying; if you have partial findings, produce a final answer explaining what you found and what was blocked. If no findings, tell the user the request needs different input.`,
            };
            this.logger.debug(`[Bridge] Repeat-rejection abort — tool=${f.name} last_error=${lastErrorText} count=${obs.count}`);
            writer.markdown(`\n\n⚠ Session aborted: the model sent the same \`${f.name.replace('lineage_', '')}\` call ${obs.count} times and it was rejected each time (\`${lastErrorText}\`). Ask a follow-up to retry with a different approach.`);
            envelope.pushUserText(JSON.stringify(abortPayload));
            return { kind: 'aborted', reason: `repeat_reject:${f.name}:${lastErrorText}` };
          }
        }

        let consentGate: PendingGate | null = null;
        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const res = accumulatedToolResults[f.callId];
          if (!res) continue;
          for (const p of res.content) {
            if (!(p instanceof vscode.LanguageModelTextPart)) continue;
            try {
              const data = JSON.parse(p.value);
              if (data.action_required === 'analyze_and_respond') actionRequiredPending = true;
              if (data.error === 'action_required') consentGate = PendingGateSchema.parse(data);
            } catch (e) { this.logger.debug(`[Gate] tool-result not JSON or envelope failed Zod parse: ${sanitizeForLog(String(e))}`); }
          }
        }
        if (actionRequiredPending) envelope.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, buildActionRequiredGate(['analyze_and_respond'])));
        toolCallRounds.push({ response: responseText, toolCalls });
        if (consentGate) return { kind: 'gate', gate: consentGate };
        const roundMs = Date.now() - tRoundStart;
        const toolNames = toolCalls.map(tc => tc.name.replace('lineage_', ''));
        const focusNode = (toolCalls[0]?.input as any)?.focus_node_id;
        collector.recordRound(roundCount, activePhase, roundInputTokens, roundOutputTokens, toolNames, focusNode, roundHadCacheHit);
        const roundResultChars = resultParts.reduce((acc, p) => { try { return acc + JSON.stringify((p as any).content).length; } catch { return acc; } }, 0);
        const pct = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
        this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — ${toolCalls.length} tool(s): ${toolNames.join(', ')} (${roundMs}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pct}%, ${roundResultChars} result chars${roundHadCacheHit ? ', cache-hit' : ''})`);
        LmTracer.round(sess.id, roundCount, activePhase, roundMs, roundInputTokens, roundOutputTokens, toolCalls.length);

        const hasStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
        if (hasStart && activePhase === 'discover') {
          activePhase = 'active';
          const engine = sess.stateMachine!;
          const mode = activeModeOf(engine.columnAspect !== null);
          lineageTools = filterLmTools(vscode.lm.tools, { kind: 'active', mode });
          this.logger.info(`[Phase] discover → active — mode=${mode} tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
          invalidateStablePart();
          systemPrompt = buildStageSystemPrompt('active');
          envelope.setSystemPrompt(systemPrompt);
        }

        if (sess.stateMachine?.status === 'complete' && activePhase === 'active') {
          activePhase = 'synthesis';
          lineageTools = filterLmTools(vscode.lm.tools, { kind: 'synthesis' });
          this.logger.info(`[Phase] active → synthesis — SM complete, restored ${lineageTools.length} tools including presentation`);
          invalidateStablePart();
          {
            systemPrompt = buildStageSystemPrompt('synthesis');
            const archive = sess.memory.getResult();
            const deferred = sess.stateMachine.deferredQuestions;

            // Locate the trailing tool-call pair by content shape (structural — survives any
            // notice/gate insertions between the last submit and this point).
            const pair = envelope.findLastToolPair();
            let synthesisPair: ToolPair | undefined = pair;
            if (pair) {
              // Inject deferred questions into the final tool_result so synthesis AI sees them.
              const newResultParts = pair.result.content.map(p => {
                if (p instanceof vscode.LanguageModelToolResultPart) {
                  const textPart = p.content.find(cp => cp instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
                  if (textPart) {
                    try {
                      const val = JSON.parse(textPart.value);
                      val.deferred_questions = deferred;
                      return new vscode.LanguageModelToolResultPart(p.callId, [new vscode.LanguageModelTextPart(JSON.stringify(val))]);
                    } catch { /* leave non-JSON parts untouched */ }
                  }
                }
                return p;
              }) as vscode.LanguageModelToolResultPart[];
              const mutatedResult = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, newResultParts);
              synthesisPair = { assistant: pair.assistant, result: mutatedResult };
            }

            const beforeCount = envelope.length;
            LmTracer.wipe(sess.id, roundCount, 'synthesis_transition', beforeCount);
            envelope.wipeAndSeed(systemPrompt, effectivePrompt, synthesisPair);
            this.logger.info(`[Synthesis] Context cleaned: ${beforeCount} → ${envelope.length} messages; envelope preserved (${archive.detail_slots.length} slots, ${deferred.length} deferred)`);
          }
        }

        const submitParts = toolCalls.filter(tc => tc.name === 'lineage_submit_findings');
        if (submitParts.length > 0 && activePhase === 'active' && sess.stateMachine) {
          let anyError = false;
          let errorSample = '';
          for (const sp of submitParts) {
            const result = accumulatedToolResults[sp.callId];
            const resultValue = (result?.content[0] as any)?.value;
            if (!resultValue) continue;
            try {
              const parsed = JSON.parse(resultValue);
              if (parsed.error) {
                anyError = true;
                errorSample = parsed.error;
                break;
              }
            } catch (e) {
              this.logger.debug(`[Gate] submit-result not JSON — callId=${sp.callId}: ${trunc(String(e), 200)}`);
            }
          }
          if (!anyError) {
            consecutiveErrorRounds = 0;
            // Rebuild system prompt on every wipe so <current_task> and <short_term_memory> stay current.
            systemPrompt = buildStageSystemPrompt('active');
            // Refresh per-hop directive to match the engine's advanced state — avoids the User-msg slot
            // freezing on the gate-approval text ("hop 1 is X") for the rest of the session.
            effectivePrompt = renderHopDirective(sess.stateMachine as NavigationEngine | null);
            LmTracer.wipe(sess.id, roundCount, 'submit_ok', envelope.length);
            envelope.wipeAndSeed(systemPrompt, effectivePrompt, buildActiveMinimalToolPair(envelope.findLastToolPair()));
            const hopCount = sess.stateMachine?.getHopDiagnostics().hop ?? 0;
            this.logger.debug(`[Hop] Sliding memory wipe (${submitParts.length} submit${submitParts.length > 1 ? 's' : ''}, all ok)`);
            this.logger.debug(`[AI] [PromptBudget] hop=${hopCount} system=${systemPrompt.length} dynamic=${effectivePrompt.length} envelope_msgs=${envelope.length}`);
          } else {
            consecutiveErrorRounds++;
            if (consecutiveErrorRounds >= 3) {
              // Bounded error-preserve: after 3 consecutive error rounds, force a wipe
              // that keeps only the last error result so the AI still sees what broke
              // but the history does not grow unbounded within MAX_ROUNDS.
              systemPrompt = buildStageSystemPrompt('active');
              effectivePrompt = renderHopDirective(sess.stateMachine as NavigationEngine | null);
              LmTracer.wipe(sess.id, roundCount, 'forced_error_3', envelope.length);
              envelope.wipeAndSeed(systemPrompt, effectivePrompt, buildActiveMinimalToolPair(envelope.findLastToolPair()));
              this.logger.debug(`[Hop] 3 consecutive error rounds (last: ${errorSample}) — forced bounded wipe`);
              consecutiveErrorRounds = 0;
            } else {
              this.logger.debug(`[Hop] Tool error detected across ${submitParts.length} submit_findings (sample: ${errorSample}) — history preserved for AI self-correction (${consecutiveErrorRounds}/3)`);
            }
          }
        }
      }
      return { kind: 'hop_cap' };
    };

    let exit: HopLoopExit;
    try {
      exit = await runHopLoop();
    } catch (err) {
      if (!writer.isOpen() && writer.status().kind === 'cancelled') {
        exit = { kind: 'cancelled' };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const isEnvelopeReject = msg.includes('unexpected tool_use_id');
        this.logger.debug(`[Reject] chat_handler code=internal_error reason=${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
        if (isEnvelopeReject) {
          this.logger.debug(`[AI] [Envelope] at-error ${envelope.snapshot()}`);
        }
        exit = {
          kind: 'error',
          message: isEnvelopeReject
            ? 'The session message history became inconsistent. Please start a new @lineage session.'
            : msg,
        };
      }
    }

    LmTracer.sessionEnd(sess.id, totalRoundInputTokens, totalOutputTokens, peakRoundInputTokens, roundCount, totalToolCallsMade, exit.kind);
    const smStatus = sess.stateMachine ? (sess.stateMachine.columnAspect ? 'Column' : 'BB') : '—';
    const peakPct = sess.maxInputTokens > 0 ? ((peakRoundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
    this.logger.info(`Summary — model: ${sess.modelName}, SM: ${smStatus}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, cumulative in: ${totalRoundInputTokens}, out: ${totalOutputTokens}, peak-round: ${peakRoundInputTokens}/${sess.maxInputTokens} (${peakPct}%)`);
    const toolBloat = [...toolResultCharsByTool.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tool, chars]) => `${tool.replace('lineage_', '')}:${chars}`)
      .join(', ');
    this.logger.info(
      `[PromptMetrics] trigger_followup_deferred=${sess.fromFollowupDeferredTriggerThisTurn} duplicate_blocks_removed=${duplicateBlocksRemovedThisTurn} initial_prompt_chars=${effectivePrompt.length} tool_result_chars_by_tool=${toolBloat || '(none)'}`
    );

    // Post-discovery context capture: store the question + chat answer + origin so
    // the post-discovery SM-offer pill (and the eventual discovery-summary
    // composition round) can recover the context. Cleared in enterGate so a
    // stale pill never crosses into SM.
    // Trigger criteria:
    //  - ≥2 distinct lineage_get_object_detail calls (classic multi-object walk), or
    //  - lineage_get_scope_bundle with include_ddl=true and scope.nodes >= 2.
    if (activePhase === 'discover' && exit.kind === 'final_answer' && sess.phase.kind === 'idle') {
      const walkedIds = new Set<string>();
      let firstWalkedId: string | null = null;
      let ddlScopeNodeCount = 0;
      let ddlScopeOrigin: string | null = null;
      let lastResponseText = '';
      for (const round of toolCallRounds) {
        if (round.response) lastResponseText = round.response;
        for (const tc of round.toolCalls ?? []) {
          const fields = extractToolCallFields(tc);
          if (fields.name === 'lineage_get_object_detail') {
            const id = (fields.input as { id?: unknown } | null)?.id;
            if (typeof id === 'string' && id.length > 0 && !walkedIds.has(id)) {
              walkedIds.add(id);
              if (firstWalkedId === null) firstWalkedId = id;
            }
          }
          if (fields.name === 'lineage_get_scope_bundle') {
            const input = fields.input as { include_ddl?: unknown; origin?: unknown };
            if (input.include_ddl !== true) continue;
            const payload = extractToolResultJson(accumulatedToolResults[fields.callId]);
            const scope = payload?.scope as Record<string, unknown> | undefined;
            const nodes = typeof scope?.nodes === 'number' ? scope.nodes : 0;
            if (nodes >= 2 && nodes > ddlScopeNodeCount) {
              ddlScopeNodeCount = nodes;
              ddlScopeOrigin = typeof payload?.origin === 'string'
                ? payload.origin
                : (typeof input.origin === 'string' ? input.origin : null);
            }
          }
        }
      }
      const hasObjectWalk = walkedIds.size >= 2 && firstWalkedId !== null;
      const hasDdlScopeWalk = ddlScopeNodeCount >= 2 && ddlScopeOrigin !== null;
      if (hasObjectWalk || hasDdlScopeWalk) {
        const capturedCount = hasObjectWalk ? walkedIds.size : ddlScopeNodeCount;
        const capturedOrigin = hasObjectWalk ? firstWalkedId! : ddlScopeOrigin!;
        sess.lastDiscoveryWalkCount = capturedCount;
        sess.lastDiscoveryOrigin = capturedOrigin;
        sess.lastDiscoveryQuestion = request.prompt;
        sess.lastDiscoveryAnswer = lastResponseText;
        const mode = hasObjectWalk ? 'object_detail' : 'scope_bundle_ddl';
        this.logger.info(`[Discovery] Walk recorded (${mode}) — origin=${capturedOrigin} walk_count=${capturedCount} q_len=${request.prompt.length} a_len=${lastResponseText.length}`);
      }
    }

    this.dispatchExit(exit, sess, writer, request.prompt, roundCount, MAX_ROUNDS, isRefineRound);

    return {
      metadata: {
        toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults },
        lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map((tc: any) => tc.name) : [],
        performanceDiagnostics: collector.finalize(sess, peakRoundInputTokens)
      },
    };
  }

  /**
   * Builds the per-round prose gate that decides whether each LM text part
   * reaches the user via {@link ChatResponseWriter.markdown}.
   *
   * @remarks
   * Two phase-specific rules are folded in:
   * - **Active phase suppresses prose entirely** — `submit_findings` is the
   *   only legal output, so any text part is planning narration the user
   *   should never see.
   * - **Synthesis phase suppresses prose until the first `tool_use`** — the
   *   rendered chat narrative arrives as the model's commentary AFTER the
   *   `present_result` call, so pre-tool prose is the model's planning preamble.
   *   On synthesis prose, an extra defensive pass strips icon-code markup
   *   (`$(name)` literals the platform only renders inside `writer.button`)
   *   and slices off the leading planning preamble before the first `## `
   *   heading, so the chat narrative never has phrases like "Now I have all
   *   slots. Assembling the final report." welded onto its first heading.
   *
   * `surface(text)` returns the string to write, or `null` to suppress.
   * `observeToolCall()` records that the first tool_use has been seen this round.
   */
  private synthesisProseGate(phase: 'discover' | 'active' | 'synthesis' | 'completed'): {
    surface(text: string): string | null;
    observeToolCall(): void;
  } {
    const surfaceAllowed = phase !== 'active';
    const isSynthesis = phase === 'synthesis';
    let toolCallSeen = false;
    const stripSynthesisArtifacts = (s: string): string => {
      if (!isSynthesis) return s;
      let out = s.replace(/\$\([a-z][a-z0-9-]*\)\s*/gi, '');
      const hIdx = out.indexOf('## ');
      if (hIdx > 0) out = out.slice(hIdx);
      return out;
    };
    return {
      surface(text: string): string | null {
        if (!surfaceAllowed) return null;
        if (isSynthesis && !toolCallSeen) return null;
        return stripSynthesisArtifacts(text);
      },
      observeToolCall(): void {
        toolCallSeen = true;
      },
    };
  }

  /**
   * Streams the captured per-node archive directly to the chat when synthesis
   * exits without {@link AiSession.presentResultCalledThisTurn} ever flipping true.
   *
   * @remarks
   * Once the model chooses prose over a tool call, rephrasing the prompt rarely
   * recovers it — and the corrective-rebuild path was a known source of orphaned
   * `tool_result` parts after Bedrock User-merge. A deterministic fallback render
   * gives the user the analysis that was actually performed instead of an error
   * or another redundant retry.
   */
  private renderArchiveFallback(sess: AiSession, writer: ChatResponseWriter): void {
    const archive = sess.memory.getResult();
    const slots = archive.detail_slots;
    if (slots.length === 0) {
      writer.markdown('\n\n_Synthesis fallback: no analysis was captured this session._\n');
      return;
    }
    const userQuestion = sess.memory.getUserQuestion();
    const attempted = sess.presentResultAttemptCountThisTurn;
    const failed = sess.presentResultFailureCountThisTurn;
    const reason = sess.presentResultLastFailureReasonThisTurn?.trim();
    const fallbackBanner = attempted > 0
      ? `> Synthesis fallback — present_result failed validation ${failed}/${attempted} attempt(s).${reason ? ` Last reason: ${reason}` : ''} Captured analysis below.`
      : '> Synthesis fallback — the model did not invoke `present_result`. Captured analysis below.';
    const lines: string[] = [
      '',
      fallbackBanner,
      '',
    ];
    if (userQuestion) lines.push(`# ${userQuestion}`, '');
    for (const slot of slots) {
      const heading = slot.badge_label
        ? `${slot.schema}.${slot.name} — ${slot.badge_label}`
        : `${slot.schema}.${slot.name}`;
      lines.push(`## ${heading}`);
      const sectionBody = slot.sections.length > 0
        ? slot.sections.map(s => s.text).join('\n\n')
        : '';
      const body = sectionBody.length > 0 ? sectionBody : slot.summary;
      if (body) lines.push('', body);
      lines.push('');
    }
    writer.markdown(lines.join('\n'));
  }

  /**
   * Renders the unified three-button row beneath any pending consent gate.
   *
   * @remarks
   * Single emission site so every turn that lands the session in `awaiting_gate`
   * (initial gate, refine re-render, AI clarifying question) shows the same
   * affordances. Refine button only appears for the `confirm_sm_start` gate
   * (other gate sub-types are scope-expansion gates with no scope tree to refine).
   */
  private emitGateButtonRow(writer: ChatResponseWriter, gate: PendingGate): void {
    writer.button({
      command: 'dataLineageViz.aiResolveGate',
      title: '$(check) Approve & Proceed',
      arguments: ['yes'],
    });
    if (gate.gate === 'confirm_sm_start') {
      writer.button({
        command: 'dataLineageViz.aiResolveGate',
        title: '$(edit) Refine scope',
        arguments: ['refine'],
      });
    }
    writer.button({
      command: 'dataLineageViz.aiResolveGate',
      title: '$(close) Cancel',
      arguments: ['no'],
    });
  }

  /**
   * Performs post-execution cleanup based on the hop loop outcome.
   *
   * @remarks
   * Handles partial-result persistence and UI state transitions for every
   * `HopLoopExit` variant — gates, final answer, completion, hop-cap, abort,
   * cancel, error. The trailing finalizer also re-emits the gate button row
   * whenever the session lands in `awaiting_gate`, so a new exit variant cannot
   * silently swallow the affordances.
   *
   * @param exit - The terminal outcome of the hop loop.
   * @param sess - The active AI session.
   * @param writer - Interface for writing the final response components.
   * @param userPrompt - The original user input prompt.
   * @param roundCount - Total execution rounds completed.
   * @param maxRounds - The configured round budget for the session.
   */
  private dispatchExit(exit: HopLoopExit, sess: AiSession, writer: ChatResponseWriter, userPrompt: string, roundCount: number, maxRounds: number, isRefineRound: boolean): void {
    switch (exit.kind) {
      case 'gate': {
        sess.enterGate(exit.gate);
        const title = exit.gate.gate === 'confirm_sm_start' ? 'Confirm exploration' : 'Scope expansion requested';
        writer.markdown(`\n\n---\n**${title}**\n\n${exit.gate.detail}\n\n`);
        // Buttons emitted by the unified finalizer below — single source of truth.
        this.logger.info(`[Gate] ${exit.gate.gate} — classes=[${exit.gate.classes.join(', ')}] nodes=${exit.gate.nodeIds.length}`);
        break;
      }
      case 'final_answer': {
        const smComplete = sess.stateMachine?.status === 'complete';
        if (smComplete) {
          sess.enterCompleted();
          this.logger.info(`[${sess.id}] [Phase] synthesis → completed — archive slots=${sess.memory.slotCount}, deferred=${sess.stateMachine!.deferredQuestions.length}`);
          this.logger.debug(`[${sess.id}] [Phase] follow-up ready — next turn refines via present_result / supplement; no fresh exploration unless the user asks a new trace.`);
          // Surface the synthesized headline as the chat-surface answer to the user's
          // original question. The full description renders in the webview overlay; chat
          // gets the one-line digest so users see an answer without opening the panel.
          if (sess.presentResultCalledThisTurn && sess.lastPresentResultSummary) {
            writer.markdown(`\n${sess.lastPresentResultSummary}\n`);
          }
          // Only show the graph button when present_result was actually invoked this turn —
          // prevents a stale/empty button when synthesis exited via the archive fallback.
          if (this.getActivePanel() && sess.presentResultCalledThisTurn) {
            const originalQ = sess.memory.getUserQuestion() || userPrompt;
            writer.button({ command: 'dataLineageViz.aiCreateView', title: '$(type-hierarchy-sub) Show in Graph', arguments: [originalQ] });
          }
        } else if (sess.phase.kind !== 'awaiting_gate') {
          // Clarifying-question turn during refine: phase stays awaiting_gate, the finalizer
          // re-emits the button row so the user can answer / refine again / approve.
          sess.enterIdle();
        }
        break;
      }
      case 'cancelled': {
        sess.enterIdle();
        this.logger.info(`[${sess.id}] Exit cancelled — session returned to idle`);
        break;
      }
      case 'hop_cap': {
        const remaining = sess.stateMachine?.getHopDiagnostics().agendaRemaining ?? 0;
        sess.memory.reset();
        sess.enterIdle();
        this.logger.info(`Exit hop_cap: hit ${maxRounds}-round cap with ${remaining} agenda items pending — archive discarded`);
        writer.markdown([
          ``,
          `⚠ **Exploration incomplete.** Hit the ${maxRounds}-round safety cap with ${remaining} node(s) still pending.`,
          ``,
          `The scope is too broad for a single run. Narrow it and try again:`,
          `- Reduce depth: \`/trace [object] depth=1\` or \`depth=2\``,
          `- Filter schemas in the panel before re-asking`,
          `- Pick a narrower starting node (e.g. a fact table instead of a mart view)`,
          `- Or raise \`dataLineageViz.ai.maxRounds\` in settings`,
        ].join('\n'));
        break;
      }
      case 'aborted':
      case 'error': {
        sess.enterIdle();
        const msg = exit.kind === 'aborted' ? `Exploration aborted — ${exit.reason ?? 'the engine halted before completion'}.` : exit.message;
        this.logger.info(`Exit ${exit.kind}: ${msg}`);
        writer.markdown(`\n\n*Error: ${msg}*`);
        break;
      }
    }

    // Finalizer — emit the gate button row whenever the session is awaiting_gate at the
    // end of dispatch. New exit kinds can't forget the buttons.
    if (sess.phase.kind === 'awaiting_gate') {
      this.emitGateButtonRow(writer, sess.phase.gate);
    }

    // [AI] [Refine] — emit only when this turn started as a refine round. `tool_called`
    // means the AI re-called start_exploration (a new gate exit fired this turn);
    // `narration_only` means the AI replied with prose without invoking the tool.
    if (isRefineRound) {
      const newScope = sess.stateMachine?.scopeSize ?? 0;
      const agendaSize = sess.stateMachine?.getHopDiagnostics().agendaRemaining ?? 0;
      const outcome = exit.kind === 'gate' ? 'tool_called' : 'narration_only';
      this.logger.info(`[AI] [Refine] outcome=${outcome} new_scope=${newScope} agenda=${agendaSize}`);
    }
  }
}
