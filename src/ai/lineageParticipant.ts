import * as vscode from 'vscode';
import { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { setInlineTokenBudget, setSmInlineNodeCap } from './tools';
import {
  buildPlatformContext, buildSchemaContext, buildSystemPromptBase,
  buildTracePrompt, buildSearchPrompt, buildActionRequiredGate,
  ACTION_REQUIRED_PENDING_HINT
} from './prompts';
import { buildNavigationPrompt } from './smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './tokenBudget';
import { NavigationEngine } from './smBase';
import { RepeatRejectGuard } from './repeatRejectGuard';
import { PendingGateSchema, classifyGateReply, type PendingGate, type HopLoopExit } from './sessionPhase';
import { CLASSIFICATION_BANNER } from './classification';
import { resolveStagePrompt } from './templateRenderer';
import { ChatResponseWriter } from './chatResponseWriter';
export { classifyGateReply } from './sessionPhase';

/**
 * Extracts key fields from a VS Code language model tool call part.
 *
 * @remarks
 * This helper utility normalizes the extraction of `callId`, `name`, and `input` from various
 * versions or shapes of the tool call part, providing a stable interface for the participant loop.
 *
 * @param tc - The tool call part received from the language model response.
 * @returns An object containing the call identifier, tool name, and input arguments.
 */
export function extractToolCallFields(tc: vscode.LanguageModelToolCallPart): { callId: string; name: string; input: any } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input,
  };
}

/**
 * Extract the `error` code from a tool result's JSON envelope, or `null` if the result
 * is not an error.
 *
 * @remarks
 * Our tools return `{ error: '<code>', … }` on rejection and anything else on success.
 * Non-JSON text parts or envelopes without an `error` field are treated as success.
 * Shared by the dedup bypass, the repeat-reject detector, and the abort-payload builder.
 *
 * @param result - The tool result to inspect, or `undefined` if the call produced none.
 * @returns The error code string, or `null` if the result is absent or successful.
 */
export function extractToolErrorCode(result: vscode.LanguageModelToolResult | undefined): string | null {
  if (!result) return null;
  for (const p of result.content) {
    if (!(p instanceof vscode.LanguageModelTextPart)) continue;
    try {
      const data = JSON.parse(p.value);
      if (data && typeof data.error !== 'undefined') return String(data.error);
    } catch { /* non-JSON: not an error envelope, continue scanning */ }
  }
  return null;
}

/**
 * The primary chat participant for the Data Lineage Viz extension.
 *
 * @remarks
 * This class orchestrates the interaction between the VS Code Copilot Chat interface and the
 * underlying lineage engine. It manages the chat request lifecycle, handles tool invocation rounds,
 * performs context eviction to fit token budgets, and implements the "Sliding Memory" protocol
 * for deep lineage exploration.
 *
 * The participant operates in three distinct phases:
 * 1. **Discovery**: Identifying user intent and mapping the initial scope.
 * 2. **Active**: Executing a state machine (Blackboard or Column Trace) to traverse the graph.
 * 3. **Done**: Synthesizing findings into a final technical report for the user.
 */
export class LineageParticipant {
  private readonly logger: Logger;

  /**
   * Initializes a new instance of the LineageParticipant.
   *
   * @param context - The extension context for managing subscriptions and state.
   * @param getSession - A factory function to retrieve the current active AI session.
   * @param outputChannel - The log output channel for tracing participant activity.
   * @param getActivePanel - A function to retrieve the currently active webview panel, if any.
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
   * Registers the participant and its associated providers with VS Code.
   *
   * @remarks
   * This method sets up the chat participant, its feedback handler, and its followup provider
   * which suggests context-sensitive actions (like "Show in Graph") based on tool activity.
   */
  public register() {
    const participant = vscode.chat.createChatParticipant(
      'dataLineageViz.lineage',
      this.handleChatRequest.bind(this)
    );

    participant.followupProvider = {
      provideFollowups(result) {
        const meta = (result.metadata as any) ?? {};
        const lastTools: string[] = meta.lastTools ?? [];
        const deferredCount: number = typeof meta.deferredQuestionCount === 'number' ? meta.deferredQuestionCount : 0;
        const followups: vscode.ChatFollowup[] = [];
        // "Detailed explanation" chip — gated on two conditions:
        // (a) enrich_view ran this turn (we have a view to extend, not just chat prose);
        // (b) the engine has at least one deferred question (there IS something new to analyze).
        // Click fires `/followup` → handler extends the live SM with the deferred-question
        // nodes via NavigationEngine.extendScope, reusing the existing detail archive.
        //
        // The "Show in Graph" / "Create AI view" affordances are rendered as an INLINE
        // stream.button inside the response body (see dispatchExit 'final_answer' case),
        // not as chips here — the button is context-aware (reveal existing view vs. create
        // new one) via the dataLineageViz.aiCreateView command.
        const hasEnrichView = lastTools.some((t: string) => t.includes('enrich_view'));
        if (hasEnrichView && deferredCount > 0) {
          followups.push({
            prompt: 'Explain the lineage in more detail',
            label: `Detailed explanation (${deferredCount})`,
            command: 'followup',
          });
        }
        if (hasEnrichView) {
          followups.push({
            prompt: 'Show the full description',
            label: 'Show full description',
            command: 'followup',
          });
        }
        return followups;
      }
    };

    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
      this.logger.info(`Feedback: ${kind}`);
    });

    this.context.subscriptions.push(participant);
  }

  /**
   * Main entry point for handling chat requests from the user.
   *
   * @remarks
   * This method implements the core agent loop, which includes:
   * - Session rotation on new chat starts.
   * - History reconstruction and context eviction.
   * - Multi-round tool execution (Agentic Loop).
   * - Phase transitions based on tool output and state machine status.
   * - Final synthesis of technical evidence into a user-facing response.
   *
   * @param request - The user's chat request containing the prompt and model selection.
   * @param chatContext - The conversation history provided by VS Code.
   * @param stream - The response stream for delivering markdown and progress updates.
   * @param token - A cancellation token to stop processing if the user cancels.
   * @returns A promise that resolves to the chat result metadata.
   */
  /**
   * Routes the "Detailed explanation" chip click into the engine's extend path.
   *
   * @remarks
   * Called only from the `/followup` slash command branch. Looks up the engine's deferred
   * questions (nodes the AI wanted to investigate but were outside the approved scope)
   * and adds them to the agenda via {@link NavigationEngine.extendScope}. The existing
   * hop loop then processes them and synthesis patches the view via `enrich_view.is_update`.
   *
   * @param sess - The active session; must have `stateMachine.status === 'complete'`.
   * @param writer - Lifecycle-aware chat writer for a short user-visible progress line.
   * @returns `true` when at least one node was added to the agenda; `false` otherwise.
   */
  private tryExtendWithDeferredQuestions(sess: AiSession, writer: ChatResponseWriter): boolean {
    const engine = sess.stateMachine as NavigationEngine | null;
    if (!engine || engine.status !== 'complete' || sess.isStale()) return false;
    const deferred = engine.deferredQuestions ?? [];
    if (deferred.length === 0) return false;
    // Dedup by nodeId — the engine ring-buffers but a node can be deferred more than once.
    const byNode = new Map<string, string>();
    for (const d of deferred) {
      if (!byNode.has(d.nodeId)) byNode.set(d.nodeId, d.question ?? 'User-requested follow-up');
    }
    const nodeIds = Array.from(byNode.keys());
    const question = `Extended scope: ${byNode.size} deferred question(s) requested by user`;
    const result = engine.extendScope(nodeIds, question);
    if (result.added === 0) return false;
    writer.markdown(`\n\n> Extending analysis — ${result.added} new node(s), reusing ${sess.memory.slotCount} existing finding(s).\n\n`);
    return true;
  }

  public async handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    const sess = this.getSession();
    sess.maxInputTokens = request.model.maxInputTokens;
    sess.modelName = request.model.name || request.model.id;
    // Stream lifecycle is owned by the writer — every stream.* call in this handler routes
    // through it so cancellation (Stop button / new prompt / panel close) is observed once
    // and subsequent writes become silent no-ops. Replaces direct `stream.*` access.
    const writer = new ChatResponseWriter(stream, token, this.logger, sess.id);

    const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
    const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
    setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
    setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));
    // Off by default so the built-in chat copy button captures only AI prose, not expanded tool JSON.
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

    // Any user-driven turn (new prompt, gate reply, follow-up chip) is activity — refresh
    // the stale timer so a long-pending confirm_sm_start gate can be resumed without
    // resetIfStale() wiping the primed engine on the next start_exploration call.
    sess.touch();

    this.logger.info(`[${sess.id}] Session start — model=${request.model.id}, prompt="${trunc(request.prompt, 200)}"`);

    let activePhase: 'discover' | 'active' | 'done' = 'discover';
    let lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage'));

    let effectivePrompt = request.prompt;
    if (request.command === 'trace') {
      effectivePrompt = buildTracePrompt(request.prompt);
    } else if (request.command === 'search') {
      effectivePrompt = buildSearchPrompt(request.prompt);
    } else if (request.command === 'followup') {
      // "Show full description" chip — short-circuit: stream the stored enrich_view description
      // 1:1 into chat. No SM extension, no new LM call. Detected by prompt sentinel.
      if (request.prompt === 'Show the full description' && sess.lastEnrichViewDescription) {
        writer.markdown(sess.lastEnrichViewDescription);
        return {};
      }
      // Fired by the "Detailed explanation" chip (ChatFollowup with `command: 'followup'`).
      // Route the existing live SM session into its extend path: add deferred-question nodes
      // to the agenda and resume the hop loop. Preserves the detail archive so this is fast.
      const extended = this.tryExtendWithDeferredQuestions(sess, writer);
      if (extended) {
        sess.enterExploring();
        effectivePrompt = 'Continue the hop-by-hop analysis — call submit_findings for the newly-added focus node. Merge findings into the existing archive and update the view via is_update:true.';
      } else {
        // Fallback: no live SM or no deferred questions. Treat as a generic drill-in.
        effectivePrompt = 'Explain the lineage in more detail — drill into the most load-bearing nodes of the last exploration.';
      }
    }

    // FSM turn-entry dispatch: if the previous turn paused on a gate, resolve the user's reply
    // before anything else runs. Yes → transition to `exploring` and continue; No → idle; Redirect
    // → idle + let the new prompt flow through normal discovery.
    if (sess.phase.kind === 'awaiting_gate') {
      const gate = sess.phase.gate;
      const answer = classifyGateReply(request.prompt);
      if (answer === 'no') {
        sess.enterIdle();
        writer.markdown(
          `\n\n> Exploration paused — scope held to the declared filter. ` +
          `Ask a refined question to restart with a different scope.\n\n`
        );
        this.logger.info(`[Gate] ${gate.gate} — user declined`);
        return {};
      }
      if (answer === 'redirect') {
        // User typed a new question instead of yes/no — treat as a fresh turn.
        sess.resetExploration();
        this.logger.info(`[Gate] ${gate.gate} — user redirected`);
        // Fall through — handler continues with request.prompt as the new question.
      } else {
        // answer === 'yes'
        if (gate.gate === 'confirm_sm_start') {
          // Engine is already initialized; just enter exploring. Pre-active-phase block below
          // sees `phase.kind === 'exploring'` and jumps into the hop loop directly.
          sess.enterExploring();
          effectivePrompt = 'User approved. Begin the hop-by-hop analysis — call submit_findings for the current focus node.';
        } else {
          // Inline-only expansion path. SM never reaches here — SM scope is locked at confirm_sm_start;
          // mid-session out-of-scope routes are deferred and surfaced at synthesis (never a mid-session gate).
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

    const historyMessages: vscode.LanguageModelChatMessage[] = [];
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        historyMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
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
            if (assistantParts.length) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));

            const resultParts: vscode.LanguageModelToolResultPart[] = [];
            for (const tc of round.toolCalls) {
              const f = extractToolCallFields(tc);
              const r = meta.toolCallResults[f.callId];
              if (r) {
                let contentStr = (r.content as any[]).map(c => typeof c.value === 'string' ? c.value : JSON.stringify(c)).join('');
                const complete = sess.stateMachine?.status === 'complete';
                const bbComplete = complete && sess.stateMachine?.mode === 'blackboard';
                const ctComplete = complete && sess.stateMachine?.mode === 'column_trace';
                const stale = compactStaleHopResult(f.name, contentStr, bbComplete, ctComplete);
                const compact = stale ?? compactNoiseResult(f.name, contentStr);
                resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(compact || contentStr)]));
              }
            }
            if (resultParts.length) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
          }
        } else {
          const text = turn.response.filter(p => p instanceof vscode.ChatResponseMarkdownPart).map(p => (p as vscode.ChatResponseMarkdownPart).value.value).join('');
          if (text) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, text));
        }
      }
    }

    // Stage-scoped system prompt: templates inject per phase via resolveStagePrompt,
    // driven by `STAGE_BY_KEY` in templateRenderer.ts. Active phase now injects the
    // dual-stage subsections (business_subsection, technical_subsection) so capture
    // rules live in the YAML the user edits — end-to-end effect.
    const buildStageSystemPrompt = (phase: 'discover' | 'active' | 'synthesis'): string => {
      const base = buildPlatformContext(sess.model!.dbPlatform || 'SQL Server') +
        (sess.filter?.schemas?.length ? buildSchemaContext(sess.filter.schemas) : '') +
        buildSystemPromptBase(MAX_ROUNDS);
      const stageBlock = resolveStagePrompt(sess.outputTemplates, phase, sess.classification);
      return stageBlock ? `${base}\n${stageBlock}` : base;
    };
    let systemPrompt = buildStageSystemPrompt('discover');
    // Built on active-phase entry and re-injected after every sliding-memory wipe.
    let navPrompt = '';

    // FSM post-gate pre-activation: when `phase.kind === 'exploring'` at turn entry, the prior
    // turn approved a gate (confirm_sm_start or schema/depth) — the engine is live and the AI
    // must jump straight to ACTIVE without re-calling start_exploration.
    if (sess.phase.kind === 'exploring' && sess.stateMachine) {
      activePhase = 'active';
      lineageTools = vscode.lm.tools.filter(t => t.name === 'lineage_submit_findings');
      systemPrompt = buildStageSystemPrompt('active');
      navPrompt = buildNavigationPrompt(sess.stateMachine.mode);
      this.logger.info(`[Phase] idle → active (gate-resume) — tools: submit_findings`);
    }

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
    if (historyMessages.length > MIN_HISTORY_MESSAGES) {
      try {
        const fullText = `${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`;
        let totalTokens = await request.model.countTokens(fullText);
        if (totalTokens > budgetTokens) {
          let evicted = 0;
          while (historyMessages.length > MIN_HISTORY_MESSAGES && totalTokens > budgetTokens) {
            historyMessages.shift(); evicted++;
            totalTokens = await request.model.countTokens(`${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`);
          }
          historyMessages.unshift(vscode.LanguageModelChatMessage.User(buildEvictionStub(evicted)));
        }
      } catch (err) {
        this.logger.warn(`Context eviction countTokens failed — proceeding without pressure check, may overflow budget: ${err instanceof Error ? err.message : err}`);
      }
    }

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      ...historyMessages,
    ];
    if (navPrompt) messages.push(vscode.LanguageModelChatMessage.User(navPrompt));
    messages.push(vscode.LanguageModelChatMessage.User(effectivePrompt));
    const toolCallRounds: any[] = [];
    const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
    const toolCallCache = new Map<string, vscode.LanguageModelToolResult>();
    let roundCount = 0;
    let totalToolCallsMade = 0;
    let totalOutputTokens = 0;
    let peakRoundInputTokens = 0;
    let totalRoundInputTokens = 0;

    const runHopLoop = async (): Promise<HopLoopExit> => {
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
        // Cooperative cancellation at hop boundary — VS Code has already torn the stream down,
        // so any further sendRequest / stream write would crash. Exit cleanly.
        if (!writer.isOpen()) return { kind: 'cancelled' };
        roundCount++;
        // Bump the session round counter so tools can detect parallel calls within one LM round.
        // Used by the start_exploration parallel-call guard in toolProvider.ts.
        sess.currentRoundId = roundCount;
        const tRoundStart = Date.now();
        let roundInputTokens = 0;
        try {
          roundInputTokens = await request.model.countTokens(serializeMessages(messages));
          totalRoundInputTokens += roundInputTokens;
          if (roundInputTokens > peakRoundInputTokens) peakRoundInputTokens = roundInputTokens;
        } catch (err) {
          this.logger.debug(`Per-round countTokens failed: ${err instanceof Error ? err.message : err}`);
        }

        // Map-&-Router enforcement: in ACTIVE the AI is a callback that must call submit_findings.
        // Required mode makes free-form text impossible so there's no silent-bail escape hatch. The
        // AI retains full speed control via verdicts (irrelevant cascade-prunes → fast drain).
        // DISCOVER and SYNTHESIS stay Auto so the AI can produce trivial chat answers or final prose.
        const toolMode = activePhase === 'active'
          ? vscode.LanguageModelChatToolMode.Required
          : vscode.LanguageModelChatToolMode.Auto;

        // Round-entry diagnostic for ACTIVE phase — makes state-machine progress visible per hop.
        if (activePhase === 'active' && sess.stateMachine) {
          const st = sess.stateMachine.toJSON() as { status?: string; currentFocusNodeId?: string | null; hopCount?: number };
          this.logger.debug(`[Round ${roundCount}] engine_status=${st.status} focus=${st.currentFocusNodeId ?? '(null)'} hop=${st.hopCount ?? 0}`);
        }

        const response = await request.model.sendRequest(messages, { tools: lineageTools, toolMode }, token);
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        // Suppress active-phase prose so hop narratives don't surface as duplicate chat output.
        const surfaceProse = activePhase !== 'active';
        for await (const part of response.stream) {
          // Stop draining LM output if the user cancelled — pushing to a closed stream throws.
          if (!writer.isOpen()) break;
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            assistantParts.push(new vscode.LanguageModelTextPart(part.value.value));
            responseText += part.value.value;
            if (surfaceProse) writer.markdown(part.value.value);
          } else if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            responseText += part.value;
            if (surfaceProse) writer.markdown(part.value);
          }
          else if (part instanceof vscode.LanguageModelToolCallPart) { assistantParts.push(part); toolCalls.push(part); }
        }
        if (!writer.isOpen()) return { kind: 'cancelled' };

        let roundOutputTokens = 0;
        try {
          roundOutputTokens = await request.model.countTokens(responseText);
          totalOutputTokens += roundOutputTokens;
        } catch (err) {
          this.logger.debug(`Output countTokens failed: ${err instanceof Error ? err.message : err}`);
        }
        if (!toolCalls.length) {
          const msFinal = Date.now() - tRoundStart;
          const pctFinal = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
          this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — final answer (${msFinal}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pctFinal}%)`);
          drainPendingUserNotices();
          return { kind: 'final_answer' };
        }

        if (actionRequiredPending && responseText.length > 0) actionRequiredPending = false;
        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));
        const resultParts: vscode.LanguageModelToolResultPart[] = [];

        let roundHadCacheHit = false;
        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const cacheKey = `${f.name}::${JSON.stringify(f.input)}`;
          if (toolCallCache.has(cacheKey)) {
            // Bypass the dedup short-circuit when the cached result is an error envelope — let
            // the AI see the real error on retries (so it can adapt) and let RepeatRejectGuard
            // observe the same error 3x to trigger the 3-strike abort.
            const cached = toolCallCache.get(cacheKey)!;
            if (extractToolErrorCode(cached) === null) {
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true }))]));
              roundHadCacheHit = true;
              continue;
            }
            // cached error → fall through and re-invoke
          }

          if (actionRequiredPending && !SEARCH_TOOLS.has(f.name)) {
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
            continue;
          }

          // Per-tool progress line; submit_findings shows hop count + focus-node short name,
          // non-hop tools show generic "Invoking <tool>…".
          let progressLine = `Invoking ${f.name.replace('lineage_', '')}…`;
          if (f.name === 'lineage_submit_findings' && sess.stateMachine) {
            const st = sess.stateMachine.toJSON() as { hopCount?: number; scopeSize?: number; currentFocusNodeId?: string | null };
            const shortName = st.currentFocusNodeId?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
            const denom = st.scopeSize ?? '?';
            progressLine = `Hop ${st.hopCount ?? 1} / ${denom} — analyzing ${shortName}…`;
          }
          if (progressLine !== lastProgressLine) {
            writer.progress(progressLine);
            lastProgressLine = progressLine;
          }
          totalToolCallsMade++;
          try {
            const result = await vscode.lm.invokeTool(
              f.name,
              {
                input: f.input,
                toolInvocationToken: showToolInvocations ? request.toolInvocationToken : undefined,
              },
              token
            );
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, result.content));
            accumulatedToolResults[f.callId] = result;
            toolCallCache.set(cacheKey, result);
          } catch (err) {
            const errContent = [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: String(err) }))];
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, errContent));
            accumulatedToolResults[f.callId] = new vscode.LanguageModelToolResult(errContent);
          }
        }

        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));

        drainPendingUserNotices();

        // Abort on 3 consecutive identical failures to avoid wasting the round budget on loops.
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
            this.logger.warn(`[Bridge] Repeat-rejection abort — tool=${f.name} last_error=${lastErrorText} count=${obs.count}`);
            writer.markdown(`\n\n⚠ Session aborted: the model sent the same \`${f.name.replace('lineage_', '')}\` call ${obs.count} times and it was rejected each time (\`${lastErrorText}\`). Ask a follow-up to retry with a different approach.`);
            messages.push(vscode.LanguageModelChatMessage.User(JSON.stringify(abortPayload)));
            return { kind: 'aborted', reason: `repeat_reject:${f.name}:${lastErrorText}` };
          }
        }

        // Scan tool results for reasoning-gate signals (`analyze_and_respond`) and engine-emitted
        // consent gates (`action_required` envelopes). Consent gates are Zod-validated at the
        // boundary before flowing into the HopLoopExit — malformed envelopes throw and surface
        // as parse errors, not silent corruption.
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
        if (actionRequiredPending) messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, buildActionRequiredGate(['analyze_and_respond'])));
        if (consentGate) return { kind: 'gate', gate: consentGate };

        toolCallRounds.push({ response: responseText, toolCalls });

        const roundMs = Date.now() - tRoundStart;
        const toolNames = toolCalls.map(tc => tc.name.replace('lineage_', ''));
        const roundResultChars = resultParts.reduce((acc, p) => {
          try { return acc + JSON.stringify((p as any).content).length; } catch { return acc; }
        }, 0);
        const pct = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
        this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — ${toolCalls.length} tool(s): ${toolNames.join(', ')} (${roundMs}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pct}%, ${roundResultChars} result chars${roundHadCacheHit ? ', cache-hit' : ''})`);

        // Phase transitions
        const hasStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
        if (hasStart && activePhase === 'discover') {
          activePhase = 'active';
          // ACTIVE-phase tool set is submit_findings only — Required mode forces a tool call, and
          // some models only support a single tool under Required. The start_exploration tool is
          // dropped here; the parallel-call guard remains as defense-in-depth in case a model
          // somehow calls it, but the schema itself no longer lists it.
          lineageTools = vscode.lm.tools.filter(t => t.name === 'lineage_submit_findings');
          this.logger.info(`[Phase] discover → active — tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);

          // Stage-scope the system prompt: drop output templates for ACTIVE hops.
          systemPrompt = buildStageSystemPrompt('active');

          const engine = sess.stateMachine;
          if (engine) {
            navPrompt = buildNavigationPrompt(engine.mode);
            messages.push(vscode.LanguageModelChatMessage.User(navPrompt));
          }
        }

        if (sess.stateMachine?.status === 'complete' && activePhase === 'active') {
          activePhase = 'done';
          lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage') && t.name !== 'lineage_submit_findings');
          this.logger.info(`[Phase] active → done — SM complete, restored ${lineageTools.length} classic tools`);

          // Classification gate (inline path): infer from mission brief + user question,
          // store on session, stream a one-line banner to chat. SM path classifies earlier
          // inside toolProvider's submit_findings drain — that path does not render a banner
          // (SM's confirm-sm-start message already set the user's expectation).
          if (sess.stateMachine.inlineMode && !sess.classification) {
            sess.setClassification('business');
            writer.markdown(`\n\n${CLASSIFICATION_BANNER[sess.classification!]}\n\n`);
            this.logger.info(`[${sess.id}] [Classification] fired=business (inline mode, fallback)`);
          }

          // Stage-scope the system prompt: restore full output templates for SYNTHESIS.
          systemPrompt = buildStageSystemPrompt('synthesis');

          // Clean hop history, preserve the completion envelope verbatim. The last
          // Assistant(tool_call submit_findings) + User(tool_result) pair carries detail_slots,
          // suggested_sections, suggested_labels, fullNodes, edges, and synthesis_reminder
          // (appended as the last JSON key in toolProvider). Main's proven pattern — keeps the
          // reminder at the end-of-context attention peak and preserves the structural skeleton
          // the AI uses to produce labeled, grouped, detailed sections.
          if (!sess.stateMachine.inlineMode) {
            const lastAssistant = messages[messages.length - 2];
            const lastResult    = messages[messages.length - 1];
            const beforeCount   = messages.length;
            messages.length = 0;
            messages.push(
              vscode.LanguageModelChatMessage.User(systemPrompt),
              vscode.LanguageModelChatMessage.User(effectivePrompt),
              lastAssistant,
              lastResult,
            );
            const archive = sess.memory.getResult();
            const deferred = sess.stateMachine.deferredQuestions;
            this.logger.info(`[Synthesis] Context cleaned: ${beforeCount} → ${messages.length} messages; envelope preserved (${archive.detail_slots.length} slots, ${deferred.length} deferred)`);
          }
        }

        // Wipe history only when every submit in this round succeeded; preserve on error so the AI can self-correct.
        const submitParts = toolCalls.filter(tc => tc.name === 'lineage_submit_findings');
        if (submitParts.length > 0 && activePhase === 'active' && sess.stateMachine && !sess.stateMachine.inlineMode) {
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
            } catch {
              // non-JSON result — treat as success (rare, but safe default)
            }
          }

          if (!anyError) {
            const lastAssistant = messages[messages.length - 2];
            const lastResult = messages[messages.length - 1];
            messages.length = 0;
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt), vscode.LanguageModelChatMessage.User(effectivePrompt));
            // Nav prompt must survive the wipe so mode guidance persists past hop 1.
            if (navPrompt) messages.push(vscode.LanguageModelChatMessage.User(navPrompt));
            messages.push(lastAssistant, lastResult);
            this.logger.debug(`[Hop] Sliding memory wipe (${submitParts.length} submit${submitParts.length > 1 ? 's' : ''}, all ok; navPrompt preserved)`);
          } else {
            this.logger.debug(`[Hop] Tool error detected across ${submitParts.length} submit_findings (sample: ${errorSample}) — history preserved for AI self-correction`);
          }
        }
      }
      return { kind: 'hop_cap' };
    };

    let exit: HopLoopExit;
    try {
      exit = await runHopLoop();
    } catch (err) {
      // Cancellation during an in-flight sendRequest / invokeTool surfaces as a thrown error,
      // but it is a user action — not a bug. Only treat it as `error` when the writer is still
      // open (i.e. the throw came from a real code path, not a cancelled turn).
      if (!writer.isOpen() && writer.status().kind === 'cancelled') {
        exit = { kind: 'cancelled' };
      } else {
        this.logger.error('Chat handler', err);
        exit = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    const smMode = sess.stateMachine?.mode ?? '—';
    const peakPct = sess.maxInputTokens > 0 ? ((peakRoundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
    this.logger.info(`Summary — model: ${sess.modelName}, mode: ${smMode}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, cumulative in: ${totalRoundInputTokens}, out: ${totalOutputTokens}, peak-round: ${peakRoundInputTokens}/${sess.maxInputTokens} (${peakPct}%)`);

    this.dispatchExit(exit, sess, writer, request.prompt, roundCount, MAX_ROUNDS);

    // Count distinct deferred-question nodes so the followup provider knows whether to render
    // the "Detailed explanation" chip. Chip is gated on (a) the turn included an enrich_view
    // call AND (b) the engine has unanswered out-of-scope routes to investigate.
    const deferredQuestionCount = (sess.stateMachine?.status === 'complete'
      ? new Set(sess.stateMachine.deferredQuestions.map(d => d.nodeId)).size
      : 0);
    return {
      metadata: {
        toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults },
        lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map((tc: any) => tc.name) : [],
        deferredQuestionCount,
      },
    };
  }

  /**
   * Single source of truth for post-hop-loop cleanup. Each `HopLoopExit` variant owns its own
   * branch — partial-result storage lives ONLY in `hop_cap` / `aborted` cases, making the
   * "paused gate rendered as incomplete" bug structurally impossible.
   *
   * @param exit - The typed outcome of `runHopLoop`.
   * @param sess - The active session (mutated via `enterGate` / `enterIdle`).
   * @param writer - Lifecycle-aware chat writer; writes become no-ops if the stream closed.
   * @param userPrompt - Verbatim user prompt, used by the "Show in Graph" button.
   * @param roundCount - Number of rounds actually executed.
   * @param maxRounds - The configured round budget (for the "cap hit" message).
   */
  private dispatchExit(
    exit: HopLoopExit,
    sess: AiSession,
    writer: ChatResponseWriter,
    userPrompt: string,
    roundCount: number,
    maxRounds: number
  ): void {
    switch (exit.kind) {
      case 'gate': {
        sess.enterGate(exit.gate);
        const title =
          exit.gate.gate === 'confirm_sm_start' ? 'Confirm exploration' :
          exit.gate.gate === 'confirm_scope_extension' ? 'Scope extension available' :
          'Scope expansion requested';
        writer.markdown(
          `\n\n---\n**${title}**\n\n${exit.gate.detail}\n\n` +
          `Reply \`yes\` to proceed, \`no\` to pause, or ask a different question to redirect.\n\n---\n`
        );
        this.logger.info(`[Gate] ${exit.gate.gate} — classes=[${exit.gate.classes.join(', ')}] nodes=${exit.gate.nodeIds.length}`);
        return;
      }
      case 'final_answer': {
        const smComplete = sess.stateMachine?.status === 'complete';
        sess.enterIdle();
        if (this.getActivePanel() && smComplete) {
          // Prefer the original user question (captured at SM start) over the current turn's prompt,
          // which may be a gate confirmation like "yes" that would leak into enrich_view.name.
          const originalQ = sess.memory.getUserQuestion() || userPrompt;
          this.logger.debug(`[CreateView] button arg=${sess.memory.getUserQuestion() ? 'userQuestion' : 'userPrompt'} (${originalQ.length} chars): ${originalQ.slice(0, 100)}`);
          writer.button({ command: 'dataLineageViz.aiCreateView', title: '$(type-hierarchy-sub) Show in Graph', arguments: [originalQ] });
        }
        return;
      }
      case 'cancelled': {
        // User cancelled — stream is already torn down; VS Code renders its own "Cancelled" UI.
        // Only session bookkeeping here; no stream write would land anyway.
        sess.enterIdle();
        this.logger.info(`[${sess.id}] Exit cancelled — session returned to idle`);
        return;
      }
      case 'hop_cap':
      case 'aborted':
      case 'error': {
        sess.enterIdle();
        const msg = exit.kind === 'hop_cap'
          ? `Exploration stopped — hit the ${maxRounds}-round safety cap before the agenda drained. Rerun with a narrower scope or raise 'dataLineageViz.ai.maxRounds'.`
          : exit.kind === 'aborted'
            ? `Exploration aborted — ${exit.reason ?? 'the engine halted before completion'}.`
            : exit.message;
        this.logger.warn(`Exit ${exit.kind}: ${msg}`);
        writer.markdown(`\n\n*Error: ${msg}*`);
        return;
      }
    }
  }
}
