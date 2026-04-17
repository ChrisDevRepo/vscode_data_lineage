import * as vscode from 'vscode';
import { AiSession } from './session';
import { Logger, trunc } from '../utils/log';
import { setInlineTokenBudget, setSmInlineNodeCap } from './tools';
import { 
  buildPlatformContext, buildSchemaContext, buildSystemPromptBase, 
  buildTracePrompt, buildSearchPrompt, buildActionRequiredGate,
  ACTION_REQUIRED_PENDING_HINT
} from './prompts';
import { buildNavigationPrompt, buildSynthesisPrompt } from './smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './tokenBudget';
import { NavigationEngine } from './smBase';
import { RepeatRejectGuard } from './repeatRejectGuard';

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
        const lastTools = (result.metadata as any)?.lastTools ?? [];
        const followups: vscode.ChatFollowup[] = [];
        if (lastTools.some((t: string) => t.includes('bfs_trace'))) followups.push({ prompt: 'Create a view from this trace', label: 'Create AI view' });
        if (lastTools.some((t: string) => t.includes('enrich_view'))) {
          followups.push({ prompt: 'Explain the lineage in more detail', label: 'Detailed explanation' });
        }
        if (lastTools.some((t: string) => t.includes('submit_findings'))) {
          followups.push({ prompt: 'Show the trace result in the graph', label: 'Show in Graph' });
          followups.push({ prompt: 'Explain the full lineage path in detail', label: 'Detailed explanation' });
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
  public async handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    const sess = this.getSession();
    sess.maxInputTokens = request.model.maxInputTokens;
    sess.modelName = request.model.name || request.model.id;
    
    const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
    const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
    setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
    setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));
    // Copy-friendliness: when false, we skip passing toolInvocationToken to vscode.lm.invokeTool().
    // Without the token VS Code does not render each tool call as a chat part (which would otherwise
    // include the expanded input JSON), so the built-in chat copy button captures only AI prose.
    // Full tool I/O is still logged to the output channel; flip the setting on for developer debug.
    const showToolInvocations = aiConfig.get<boolean>('ai.showToolInvocations', false);

    if (!sess.model) {
      stream.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first.');
      return {};
    }

    if (chatContext.history.length === 0) {
      sess.regenerateSessionId();
      sess.resetExploration();
      this.logger.info(`[${sess.id}] New chat session detected — state rotated`);
    }

    this.logger.info(`[${sess.id}] Session start — model=${request.model.id}, prompt="${trunc(request.prompt, 200)}"`);

    let activePhase: 'discover' | 'active' | 'done' = 'discover';
    let lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage'));

    let effectivePrompt = request.prompt;
    if (request.command === 'trace') {
      effectivePrompt = buildTracePrompt(request.prompt);
    } else if (request.command === 'search') {
      effectivePrompt = buildSearchPrompt(request.prompt);
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

    // System prompt structure follows LangChain best-practice for agents:
    // Role + Context + Instructions + Output Format — all stable, all phase-agnostic.
    // Output templates stay here (not extracted to a separate message) because
    // they are part of the agent's stable identity: "I produce X-shaped output."
    // This also enables Anthropic prompt caching of the system message.
    // Source: https://docs.langchain.com/oss/javascript/langchain/agents
    const systemPrompt = buildPlatformContext(sess.model.dbPlatform || 'SQL Server') +
      (sess.filter?.schemas?.length ? buildSchemaContext(sess.filter.schemas) : '') +
      buildSystemPromptBase(MAX_ROUNDS) +
      `### AI OUTPUT TEMPLATES (user-editable via assets/aiOutputTemplates.yaml)\n` +
      `- summary: ${sess.outputTemplates.summary}\n` +
      `- sections: ${sess.outputTemplates.sections}\n` +
      `- notes: ${sess.outputTemplates.notes}\n` +
      `- highlights: ${sess.outputTemplates.highlights}\n` +
      `- description (fallback): ${sess.outputTemplates.description}`;

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
        this.logger.debug(`Context eviction countTokens failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const messages = [vscode.LanguageModelChatMessage.User(systemPrompt), ...historyMessages, vscode.LanguageModelChatMessage.User(effectivePrompt)];
    const toolCallRounds: any[] = [];
    const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
    const toolCallCache = new Map<string, vscode.LanguageModelToolResult>();
    let roundCount = 0;
    let totalToolCallsMade = 0;
    let totalOutputTokens = 0;
    let peakRoundInputTokens = 0;
    let totalRoundInputTokens = 0;
    // Nav prompt is built once on active-phase entry and preserved across sliding
    // memory wipes — without this, mode-specific guidance (memory protocol, routing
    // rules, classification) vanished after the first hop.
    let navPrompt = '';

    const runWithTools = async () => {
      let actionRequiredPending = false;
      const SEARCH_TOOLS = new Set(['lineage_search_objects', 'lineage_search_ddl', 'lineage_get_context']);
      const repeatGuard = new RepeatRejectGuard();

      while (roundCount < MAX_ROUNDS) {
        roundCount++;
        const tRoundStart = Date.now();
        let roundInputTokens = 0;
        try {
          roundInputTokens = await request.model.countTokens(serializeMessages(messages));
          totalRoundInputTokens += roundInputTokens;
          if (roundInputTokens > peakRoundInputTokens) peakRoundInputTokens = roundInputTokens;
        } catch (err) {
          this.logger.debug(`Per-round countTokens failed: ${err instanceof Error ? err.message : err}`);
        }

        const response = await request.model.sendRequest(messages, { tools: lineageTools }, token);
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        // During active exploration the AI often emits running narrative prose alongside its
        // tool calls (its blackboard/reasoning). Streaming that to the chat produces a noisy
        // "chatty" experience — users see duplicate, partial narratives hop after hop. Only
        // surface prose in discover + done phases, where the AI's text IS the user-facing answer.
        const surfaceProse = activePhase !== 'active';
        for await (const part of response.stream) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            assistantParts.push(new vscode.LanguageModelTextPart(part.value.value));
            responseText += part.value.value;
            if (surfaceProse) stream.markdown(part.value.value);
          } else if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            responseText += part.value;
            if (surfaceProse) stream.markdown(part.value);
          }
          else if (part instanceof vscode.LanguageModelToolCallPart) { assistantParts.push(part); toolCalls.push(part); }
        }

        let roundOutputTokens = 0;
        try {
          roundOutputTokens = await request.model.countTokens(responseText);
          totalOutputTokens += roundOutputTokens;
        } catch (err) {
          this.logger.debug(`Output countTokens failed: ${err instanceof Error ? err.message : err}`);
        }
        if (!toolCalls.length) {
          // Premature-termination guard: the engine is waiting for more findings but the AI
          // emitted prose (or nothing) instead of calling lineage_submit_findings. Inject a
          // corrective message and let the loop re-prompt; MAX_ROUNDS caps any retry.
          // Symmetric counterpart to the `action_required: 'analyze_and_respond'` gate.
          if (activePhase === 'active' && sess.stateMachine?.status === 'awaiting_findings') {
            const smDump = sess.stateMachine.toJSON() as { agendaSize?: number; currentFocusNodeId?: string | null };
            const agendaRemaining = smDump.agendaSize ?? 0;
            if (agendaRemaining > 0) {
              const focus = smDump.currentFocusNodeId ?? '(unknown)';
              this.logger.warn(`Round ${roundCount} [ACTIVE] — premature final answer rejected; ${agendaRemaining} agenda items remain, re-prompting`);
              messages.push(vscode.LanguageModelChatMessage.User(
                `STOP. You emitted a final answer but the exploration is NOT complete. ` +
                `Engine status: awaiting_findings. Agenda: ${agendaRemaining} items remain. ` +
                `Current focus: ${focus}. ` +
                `Your ONLY valid next action is lineage_submit_findings for the current focus node. ` +
                `Every agenda item must receive a verdict (relevant, pass, or irrelevant) — the engine auto-completes when the last one is dispatched. Do NOT emit prose while in active phase.`
              ));
              continue;
            }
          }

          const msFinal = Date.now() - tRoundStart;
          const pctFinal = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
          this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — final answer (${msFinal}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pctFinal}%)`);
          return;
        }

        if (actionRequiredPending && responseText.length > 0) actionRequiredPending = false;
        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));
        const resultParts: vscode.LanguageModelToolResultPart[] = [];

        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const cacheKey = `${f.name}::${JSON.stringify(f.input)}`;
          if (toolCallCache.has(cacheKey)) {
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true }))]));
            continue;
          }

          if (actionRequiredPending && !SEARCH_TOOLS.has(f.name)) {
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
            continue;
          }

          // Concise per-tool progress line. For submit_findings, show the current hop number +
          // scope size + node short name so users see "Hop 7 / 24 — analyzing spCadenceRule_Alloc1b…"
          // rather than a generic "Invoking submit_findings…" repeated 24 times.
          let progressLine = `Invoking ${f.name.replace('lineage_', '')}…`;
          if (f.name === 'lineage_submit_findings' && sess.stateMachine) {
            const st = sess.stateMachine.toJSON() as { hopCount?: number; scopeSize?: number; currentFocusNodeId?: string | null };
            const shortName = st.currentFocusNodeId?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
            const denom = st.scopeSize ?? '?';
            progressLine = `Hop ${st.hopCount ?? 1} / ${denom} — analyzing ${shortName}…`;
          }
          stream.progress(progressLine);
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

        // Repeat-rejection belt: if the AI just sent the same tool call for the third
        // consecutive time and it failed every time, terminate the session cleanly.
        // Observing every tool call keeps the counter tight; any successful call resets it.
        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const res = accumulatedToolResults[f.callId];
          let isError = false;
          if (res) {
            for (const p of res.content) {
              if (p instanceof vscode.LanguageModelTextPart) {
                try { if (JSON.parse(p.value).error) { isError = true; break; } } catch { /* non-JSON result: treat as success */ }
              }
            }
          }
          const obs = repeatGuard.observe(f.name, f.input, isError);
          if (obs.abort) {
            const lastErrorText = (() => {
              const p = res?.content.find(c => c instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
              try { return p ? (JSON.parse(p.value).error ?? 'unknown') : 'unknown'; } catch { return 'unknown'; }
            })();
            const abortPayload = { error: 'session_aborted_repeat_reject', tool: f.name, last_error: lastErrorText, repeat_count: obs.count };
            this.logger.warn(`[Bridge] Repeat-rejection abort — tool=${f.name} last_error=${lastErrorText} count=${obs.count}`);
            stream.markdown(`\n\n⚠ Session aborted: the model sent the same \`${f.name.replace('lineage_', '')}\` call ${obs.count} times and it was rejected each time (\`${lastErrorText}\`). Ask a follow-up to retry with a different approach.`);
            messages.push(vscode.LanguageModelChatMessage.User(JSON.stringify(abortPayload)));
            return;
          }
        }

        // Reasoning Gate (Action Required)
        for (const call of toolCalls) {
          const f = extractToolCallFields(call);
          const res = accumulatedToolResults[f.callId];
          if (res) {
            for (const p of res.content) {
              if (p instanceof vscode.LanguageModelTextPart) {
                try { 
                  const data = JSON.parse(p.value);
                  if (data.action_required === 'analyze_and_respond') actionRequiredPending = true; 
                } catch {}
              }
            }
          }
        }
        if (actionRequiredPending) messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, buildActionRequiredGate(['analyze_and_respond'])));

        toolCallRounds.push({ response: responseText, toolCalls });

        const roundMs = Date.now() - tRoundStart;
        const toolNames = toolCalls.map(tc => tc.name.replace('lineage_', ''));
        const roundResultChars = resultParts.reduce((acc, p) => {
          try { return acc + JSON.stringify((p as any).content).length; } catch { return acc; }
        }, 0);
        const pct = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
        this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — ${toolCalls.length} tool(s): ${toolNames.join(', ')} (${roundMs}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pct}%, ${roundResultChars} result chars)`);

        // Phase transitions
        const hasStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
        if (hasStart && activePhase === 'discover') {
          activePhase = 'active';
          lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-engine'));
          this.logger.info(`[Phase] discover → active — tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);

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

          if (!sess.stateMachine.inlineMode) {
            // Deliver the Detail Archive evidence for Phase 3
            const archive = sess.memory.getResult();
            const evidenceHeader = '### DETAIL ARCHIVE (TECHNICAL EVIDENCE)\n' +
              'The following evidence was captured during the investigation. Assembly this into your final report.\n\n';
            
            const evidenceItems = archive.detail_slots.map(s => {
              const badge = s.badge_label ? `- **Badge**: ${s.badge_label}\n` : '';
              const note = s.note_caption ? `- **Note caption**: ${s.note_caption}\n` : '';
              return `#### ${s.nodeId}\n${badge}${note}- **Summary**: ${s.summary}\n- **Technical Analysis**:\n${s.analysis}\n`;
            }).join('\n---\n');

            messages.length = 0;
            messages.push(
              vscode.LanguageModelChatMessage.User(systemPrompt),
              vscode.LanguageModelChatMessage.User(effectivePrompt),
              vscode.LanguageModelChatMessage.User(buildSynthesisPrompt()),
              vscode.LanguageModelChatMessage.User(evidenceHeader + evidenceItems)
            );
            const archiveChars = evidenceItems.length;
            const archiveTokensEst = Math.round(archiveChars / 4);
            this.logger.info(`[Synthesis] Detail archive: ${archive.detail_slots.length} slot(s), ${archiveChars} chars, ~${archiveTokensEst} tokens — injected as evidence for final synthesis`);
          }
        }

        // Sliding memory: wipe history only when EVERY submit_findings in this round succeeded.
        // If any of N parallel submissions errored (focus_mismatch, invalid_status, prune_would_orphan_noted,
        // prune_cascade_too_wide, route_validation_failed, validation_error), history must be preserved
        // so the AI sees the error and can self-correct. Wiping on partial success destroys error
        // feedback and the AI commonly gives up after the next round (empirically observed).
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
            // Preserve the navigation prompt across wipes — without this, the AI
            // loses its mode guidance (memory protocol, routing rules, classification)
            // after the very first hop and flies blind on subsequent hops.
            if (navPrompt) messages.push(vscode.LanguageModelChatMessage.User(navPrompt));
            messages.push(lastAssistant, lastResult);
            this.logger.debug(`[Hop] Sliding memory wipe (${submitParts.length} submit${submitParts.length > 1 ? 's' : ''}, all ok; navPrompt preserved)`);
          } else {
            this.logger.warn(`[Hop] Tool error detected across ${submitParts.length} submit_findings (sample: ${errorSample}) — history preserved for AI self-correction`);
          }
        }
      }
    };

    try {
      await runWithTools();
      const smMode = sess.stateMachine?.mode ?? '—';
      const peakPct = sess.maxInputTokens > 0 ? ((peakRoundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
      this.logger.info(`Summary — model: ${sess.modelName}, mode: ${smMode}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, cumulative in: ${totalRoundInputTokens}, out: ${totalOutputTokens}, peak-round: ${peakRoundInputTokens}/${sess.maxInputTokens} (${peakPct}%)`);
      
      const smComplete = sess.stateMachine?.status === 'complete';
      if (this.getActivePanel() && smComplete) {
        stream.button({ command: 'dataLineageViz.aiCreateView', title: '$(type-hierarchy-sub) Show in Graph', arguments: [request.prompt] });
      }
    } catch (err) {
      this.logger.error('Chat handler', err);
      stream.markdown(`\n\n*Error: ${err instanceof Error ? err.message : String(err)}*`);
    }

    return { metadata: { toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults }, lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map((tc: any) => tc.name) : [] } };
  }
}
