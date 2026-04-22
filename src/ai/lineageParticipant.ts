import * as vscode from 'vscode';
import { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { setInlineTokenBudget, setSmInlineNodeCap } from './tools';
import {
  buildGeneralSystemPrompt, buildDiscoveryPrompt, buildActivePhasePrompt, buildSynthesisPrompt,
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
import { PerformanceCollector } from './diagnostics';
export { classifyGateReply } from './sessionPhase';

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
export function extractToolCallFields(tc: vscode.LanguageModelToolCallPart): { callId: string; name: string; input: any } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input,
  };
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
   * Registers the chat participant and its associated providers.
   *
   * @remarks
   * Configures the participant ID, the main request handler, and the followup provider
   * for context-aware suggested actions.
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

        const hasPresentResult = lastTools.some((t: string) => t.includes('present_result'));
        if (hasPresentResult && deferredCount > 0) {
          followups.push({
            prompt: 'Explain the lineage in more detail',
            label: `Detailed explanation (${deferredCount})`,
            command: 'followup',
          });
        }
        if (hasPresentResult) {
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
   * Appends deferred analysis questions to the active exploration agenda.
   *
   * @remarks
   * Used by the `/followup` command to include nodes that were previously
   * excluded by scope filters into the next analysis round.
   *
   * @param sess - The active AI session.
   * @param writer - Interface for writing progress updates to the chat response.
   * @returns `true` if nodes were added to the agenda, `false` otherwise.
   */
  private tryExtendWithDeferredQuestions(sess: AiSession, writer: ChatResponseWriter): boolean {
    const engine = sess.stateMachine as NavigationEngine | null;
    if (!engine || engine.status !== 'complete' || sess.isStale()) return false;
    const deferred = engine.deferredQuestions ?? [];
    if (deferred.length === 0) return false;

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

    const writer = new ChatResponseWriter(stream, token, this.logger, sess.id);
    const collector = new PerformanceCollector(this.logger);

    const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
    const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
    setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
    setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));
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

    sess.touch();
    this.logger.info(`[${sess.id}] Session start — model=${model.id}, prompt="${trunc(request.prompt, 200)}"`);

    let effectivePrompt = request.prompt;
    let activePhase: 'discover' | 'active' | 'synthesis' = 'discover';
    let lineageTools = vscode.lm.tools.filter(t => {
      if (t.name === 'lineage_submit_findings') return false;
      if (t.tags?.includes('lineage-presentation')) return activePhase === 'synthesis';
      return t.tags?.includes('lineage');
    });
    if (request.command === 'trace') {
      effectivePrompt = buildTracePrompt(request.prompt);
    } else if (request.command === 'search') {
      effectivePrompt = buildSearchPrompt(request.prompt);
    }

    if (sess.phase.kind === 'awaiting_gate') {
      const gate = sess.phase.gate;
      const answer = classifyGateReply(request.prompt);
      if (answer === 'no') {
        sess.enterIdle();
        writer.markdown(`\n\n> Exploration paused — scope held to the declared filter. Ask a refined question to restart with a different scope.\n\n`);
        this.logger.info(`[Gate] ${gate.gate} — user declined`);
        return {};
      }
      if (answer === 'redirect') {
        sess.resetExploration();
        this.logger.info(`[Gate] ${gate.gate} — user redirected`);
      } else {
        if (gate.gate === 'confirm_sm_start') {
          sess.enterExploring();
          effectivePrompt = 'User approved. Begin the hop-by-hop analysis — call submit_findings for the current focus node.';
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
                const isColumnAspectActive = !!sess.stateMachine?.columnAspect;
                const stale = compactStaleHopResult(f.name, contentStr, complete && !isColumnAspectActive, complete && isColumnAspectActive);
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

      const buildStageSystemPrompt = (phase: 'discover' | 'active' | 'synthesis'): string => {
        const dbPlatform = sess.model!.dbPlatform || 'SQL Server';
        const schemas = sess.filter?.schemas || [];
        const base = buildGeneralSystemPrompt(dbPlatform, schemas);

        let phaseSpecific = '';
        if (phase === 'discover') phaseSpecific = buildDiscoveryPrompt();
        else if (phase === 'active') {
          const isInline = sess.stateMachine?.inlineMode ?? false;
          phaseSpecific = buildActivePhasePrompt(isInline);
        }
        else if (phase === 'synthesis') phaseSpecific = buildSynthesisPrompt();

        const stageBlock = resolveStagePrompt(sess.outputTemplates, phase, sess.classification);
        return [base, phaseSpecific, stageBlock].filter(Boolean).join('\n');
      };
    let systemPrompt = buildStageSystemPrompt('discover');
    let navPrompt = '';

    if (sess.phase.kind === 'exploring' && sess.stateMachine) {
      activePhase = 'active';
      lineageTools = vscode.lm.tools.filter(t => t.name === 'lineage_submit_findings' || t.name === 'lineage_get_ddl_batch');
      systemPrompt = buildStageSystemPrompt('active');
      navPrompt = buildNavigationPrompt(sess.stateMachine.inlineMode, sess.stateMachine.columnAspect?.target_columns);
      this.logger.info(`[Phase] idle → active (gate-resume) — tools: submit_findings, get_ddl_batch`);
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
        if (!writer.isOpen()) return { kind: 'cancelled' };
        roundCount++;
        sess.currentRoundId = roundCount;
        collector.startRound();
        const tRoundStart = Date.now();
        let roundInputTokens = 0;
        try {
          roundInputTokens = await model.countTokens(serializeMessages(messages));
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

        /**
         * VS Code API Compliance:
         * We explicitly map LanguageModelToolInformation to LanguageModelChatTool instances.
         * Using the raw tool information objects from vscode.lm.tools would cause sendRequest to silently 
         * drop the tools array. 
         * 
         * Memory Strategy (Pro/Con):
         * We use a custom "Sliding Memory" implementation rather than generic utilities like @vscode/chat-extension-utils.
         * Pro: Authoritative history wipes (messages.length = 0) keep the context window focused and token-efficient.
         * Pro: Domain-specific JSON compaction (via historyManager.ts) preserves gate payloads while stripping noise.
         * Con: Requires manual tool-loop orchestration (MAX_ROUNDS).
         */
        const tools: vscode.LanguageModelChatTool[] = lineageTools.map(t => ({
          name: t.name, 
          description: t.description || (t.tags?.includes('lineage-presentation') ? 'Presents results to user' : 'Lineage tool'), 
          inputSchema: t.inputSchema
        }));

        // FIX: VS Code API only supports 'Required' mode when exactly one tool is provided.
        // For multiple tools, we must fallback to 'Auto' and rely on the model's capabilities and system prompt.
        const toolMode = (requestedMode === vscode.LanguageModelChatToolMode.Required && tools.length > 1) 
          ? vscode.LanguageModelChatToolMode.Auto 
          : requestedMode;

        const response = await model.sendRequest(messages, { tools, toolMode }, token);
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        const surfaceProse = activePhase !== 'active';
        for await (const part of response.stream) {
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
          roundOutputTokens = await model.countTokens(responseText);
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
            const cached = toolCallCache.get(cacheKey)!;
            if (extractToolErrorCode(cached) === null) {
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true }))]));
              roundHadCacheHit = true;
              continue;
            }
          }

          if (actionRequiredPending && !SEARCH_TOOLS.has(f.name)) {
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
            continue;
          }

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
            const result = await vscode.lm.invokeTool(f.name, { input: f.input, toolInvocationToken: showToolInvocations ? request.toolInvocationToken : undefined }, token);
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
        const focusNode = (toolCalls[0]?.input as any)?.focus_node_id;
        collector.recordRound(roundCount, activePhase, roundInputTokens, roundOutputTokens, toolNames, focusNode, roundHadCacheHit);
        const roundResultChars = resultParts.reduce((acc, p) => { try { return acc + JSON.stringify((p as any).content).length; } catch { return acc; } }, 0);
        const pct = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
        this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — ${toolCalls.length} tool(s): ${toolNames.join(', ')} (${roundMs}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pct}%, ${roundResultChars} result chars${roundHadCacheHit ? ', cache-hit' : ''})`);

        const hasStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
        if (hasStart && activePhase === 'discover') {
          activePhase = 'active';
          lineageTools = vscode.lm.tools.filter(t => t.name === 'lineage_submit_findings' || t.name === 'lineage_get_ddl_batch');
          this.logger.info(`[Phase] discover → active — tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
          systemPrompt = buildStageSystemPrompt('active');
          const engine = sess.stateMachine;
          if (engine) {
            navPrompt = buildNavigationPrompt(engine.inlineMode, engine.columnAspect?.target_columns);
            messages.push(
              vscode.LanguageModelChatMessage.User(
                `# Navigation State\n${navPrompt}`
              )
            );
          }
        }

        if (sess.stateMachine?.status === 'complete' && activePhase === 'active') {
          activePhase = 'synthesis';
          lineageTools = vscode.lm.tools.filter(t => {
            if (t.name === 'lineage_submit_findings') return false;
            if (t.tags?.includes('lineage-presentation')) return true; // Enabled in synthesis
            return t.tags?.includes('lineage');
          });
          this.logger.info(`[Phase] active → synthesis — SM complete, restored ${lineageTools.length} tools including presentation`);
          if (sess.stateMachine.inlineMode && !sess.classification) {
            sess.setClassification('business');
            writer.markdown(`\n\n${CLASSIFICATION_BANNER[sess.classification!]}\n\n`);
          }
          systemPrompt = buildStageSystemPrompt('synthesis');
          if (!sess.stateMachine.inlineMode) {
            const lastAssistant = messages[messages.length - 2];
            const lastResult    = messages[messages.length - 1];
            const beforeCount   = messages.length;
            messages.length = 0;
            messages.push(
              vscode.LanguageModelChatMessage.User(systemPrompt),
              vscode.LanguageModelChatMessage.User(effectivePrompt),
              lastAssistant,
              lastResult
            );
            const archive = sess.memory.getResult();
            const deferred = sess.stateMachine.deferredQuestions;
            this.logger.info(`[Synthesis] Context cleaned: ${beforeCount} → ${messages.length} messages; envelope preserved (${archive.detail_slots.length} slots, ${deferred.length} deferred)`);
          }
        }

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
            } catch {}
          }
          if (!anyError) {
            const lastAssistant = messages[messages.length - 2];
            const lastResult = messages[messages.length - 1];
            messages.length = 0;
            messages.push(
              vscode.LanguageModelChatMessage.User(systemPrompt),
              vscode.LanguageModelChatMessage.User(effectivePrompt)
            );
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
      if (!writer.isOpen() && writer.status().kind === 'cancelled') {
        exit = { kind: 'cancelled' };
      } else {
        this.logger.error('Chat handler', err);
        exit = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    const smStatus = sess.stateMachine ? (sess.stateMachine.columnAspect ? 'Column' : 'BB') : '—';
    const peakPct = sess.maxInputTokens > 0 ? ((peakRoundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
    this.logger.info(`Summary — model: ${sess.modelName}, SM: ${smStatus}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, cumulative in: ${totalRoundInputTokens}, out: ${totalOutputTokens}, peak-round: ${peakRoundInputTokens}/${sess.maxInputTokens} (${peakPct}%)`);
    this.dispatchExit(exit, sess, writer, request.prompt, roundCount, MAX_ROUNDS);

    const deferredQuestionCount = (sess.stateMachine?.status === 'complete' ? new Set(sess.stateMachine.deferredQuestions.map(d => d.nodeId)).size : 0);
    return {
      metadata: {
        toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults },
        lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map((tc: any) => tc.name) : [],
        deferredQuestionCount,
        performanceDiagnostics: collector.finalize(sess, peakRoundInputTokens)
      },
    };
  }

  /**
   * Performs post-execution cleanup based on the hop loop outcome.
   *
   * @remarks
   * Handles the persistence of partial results and UI state transitions for all
   * `HopLoopExit` variants, including gates, completion, and failure modes.
   *
   * @param exit - The terminal outcome of the hop loop.
   * @param sess - The active AI session.
   * @param writer - Interface for writing the final response components.
   * @param userPrompt - The original user input prompt.
   * @param roundCount - Total execution rounds completed.
   * @param maxRounds - The configured round budget for the session.
   */
  private dispatchExit(exit: HopLoopExit, sess: AiSession, writer: ChatResponseWriter, userPrompt: string, roundCount: number, maxRounds: number): void {
    switch (exit.kind) {
      case 'gate': {
        sess.enterGate(exit.gate);
        const title = exit.gate.gate === 'confirm_sm_start' ? 'Confirm exploration' : exit.gate.gate === 'confirm_scope_extension' ? 'Scope extension available' : 'Scope expansion requested';
        writer.markdown(`\n\n---\n**${title}**\n\n${exit.gate.detail}\n\n`);
        
        writer.button({
          command: 'dataLineageViz.aiResolveGate',
          title: '$(check) Approve & Proceed',
          arguments: ['yes']
        });
        
        writer.button({
          command: 'dataLineageViz.aiResolveGate',
          title: '$(close) Decline',
          arguments: ['no']
        });

        this.logger.info(`[Gate] ${exit.gate.gate} — classes=[${exit.gate.classes.join(', ')}] nodes=${exit.gate.nodeIds.length}`);
        return;
      }
      case 'final_answer': {
        const smComplete = sess.stateMachine?.status === 'complete';
        sess.enterIdle();
        if (this.getActivePanel() && smComplete) {
          const originalQ = sess.memory.getUserQuestion() || userPrompt;
          writer.button({ command: 'dataLineageViz.aiCreateView', title: '$(type-hierarchy-sub) Show in Graph', arguments: [originalQ] });
        }
        return;
      }
      case 'cancelled': {
        sess.enterIdle();
        this.logger.info(`[${sess.id}] Exit cancelled — session returned to idle`);
        return;
      }
      case 'hop_cap':
      case 'aborted':
      case 'error': {
        sess.enterIdle();
        const msg = exit.kind === 'hop_cap' ? `Exploration stopped — hit the ${maxRounds}-round safety cap before the agenda drained. Rerun with a narrower scope or raise 'dataLineageViz.ai.maxRounds'.` : exit.kind === 'aborted' ? `Exploration aborted — ${exit.reason ?? 'the engine halted before completion'}.` : exit.message;
        this.logger.warn(`Exit ${exit.kind}: ${msg}`);
        writer.markdown(`\n\n*Error: ${msg}*`);
        return;
      }
    }
  }
}
