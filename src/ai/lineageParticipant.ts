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
import { compactNoiseResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './tokenBudget';
import { NavigationEngine } from './smBase';

/** Helper to extract callId, name, and input from various tool call part types */
export function extractToolCallFields(tc: vscode.LanguageModelToolCallPart): { callId: string; name: string; input: any } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input,
  };
}

export class LineageParticipant {
  private readonly logger: Logger;

  constructor(
    private context: vscode.ExtensionContext,
    private getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private getActivePanel: () => vscode.WebviewPanel | undefined
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

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
        if (lastTools.some((t: string) => t.includes('submit_findings'))) followups.push({ prompt: 'Show the trace result in the graph', label: 'Show in Graph' });
        return followups;
      }
    };

    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
      this.logger.info(`Feedback: ${kind}`);
    });

    this.context.subscriptions.push(participant);
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
    
    const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
    const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
    setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
    setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));

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
                const compact = compactNoiseResult(f.name, contentStr);
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

    const systemPrompt = buildPlatformContext(sess.model.dbPlatform || 'SQL Server') + 
      (sess.filter?.schemas?.length ? buildSchemaContext(sess.filter.schemas) : '') + 
      buildSystemPromptBase(MAX_ROUNDS) +
      `### AI OUTPUT TEMPLATES\n` +
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
    let lastInputTokenEstimate = 0;
    let totalOutputTokens = 0;
    let totalToolResultChars = 0;
    let lastRoundInputTokens = 0;

    const runWithTools = async () => {
      let actionRequiredPending = false;
      const SEARCH_TOOLS = new Set(['lineage_search_objects', 'lineage_search_ddl', 'lineage_get_context']);

      while (roundCount < MAX_ROUNDS) {
        roundCount++;
        try { 
          const currentInputTokens = await request.model.countTokens(serializeMessages(messages)); 
          const pct = ((currentInputTokens / sess.maxInputTokens) * 100).toFixed(1);
          const delta = lastRoundInputTokens > 0 ? ` (+${currentInputTokens - lastRoundInputTokens})` : '';
          const phaseLabel = activePhase.toUpperCase();
          this.logger.info(`Round ${roundCount} [${phaseLabel}] — context: ${currentInputTokens}${delta} tokens (${pct}% of ${sess.maxInputTokens})`);
          lastInputTokenEstimate = currentInputTokens;
          lastRoundInputTokens = currentInputTokens;
        } catch (err) {
          this.logger.debug(`Per-round countTokens failed: ${err instanceof Error ? err.message : err}`);
        }
        
        const response = await request.model.sendRequest(messages, { tools: lineageTools }, token);
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        for await (const part of response.stream) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            assistantParts.push(new vscode.LanguageModelTextPart(part.value.value));
            responseText += part.value.value;
            stream.markdown(part.value.value);
          } else if (part instanceof vscode.LanguageModelTextPart) { 
            assistantParts.push(part); 
            responseText += part.value; 
            stream.markdown(part.value); 
          }
          else if (part instanceof vscode.LanguageModelToolCallPart) { assistantParts.push(part); toolCalls.push(part); }
        }

        try {
          totalOutputTokens += await request.model.countTokens(responseText);
        } catch (err) {
          this.logger.debug(`Output countTokens failed: ${err instanceof Error ? err.message : err}`);
        }
        if (!toolCalls.length) return;

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

          stream.progress(`Invoking ${f.name.replace('lineage_', '')}...`);
          totalToolCallsMade++;
          try {
            const result = await vscode.lm.invokeTool(f.name, { input: f.input, toolInvocationToken: request.toolInvocationToken }, token);
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, result.content));
            accumulatedToolResults[f.callId] = result;
            toolCallCache.set(cacheKey, result);
            totalToolResultChars += JSON.stringify(result.content).length;
          } catch (err) {
            const errContent = [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: String(err) }))];
            resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, errContent));
            accumulatedToolResults[f.callId] = new vscode.LanguageModelToolResult(errContent);
          }
        }

        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
        
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

        // Phase transitions
        const hasStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
        if (hasStart && activePhase === 'discover') {
          activePhase = 'active';
          lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-engine'));
          
          const engine = sess.stateMachine;
          if (engine) {
            const modePromptMsg = vscode.LanguageModelChatMessage.User(buildNavigationPrompt(engine.mode));
            messages.push(modePromptMsg);
          }
        }

        if (sess.stateMachine?.status === 'complete' && activePhase === 'active') {
          activePhase = 'done';
          lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage') && t.name !== 'lineage_submit_findings');

          if (!sess.stateMachine.inlineMode) {
            // Deliver the Detail Archive evidence for Phase 3
            const archive = sess.memory.getResult();
            const evidenceHeader = '### DETAIL ARCHIVE (TECHNICAL EVIDENCE)\n' +
              'The following evidence was captured during the investigation. Assembly this into your final report.\n\n';
            
            const evidenceItems = archive.detail_slots.map(s => 
              `#### ${s.nodeId}\n- **Summary**: ${s.summary}\n- **Technical Analysis**:\n${s.analysis}\n`
            ).join('\n---\n');

            messages.length = 0;
            messages.push(
              vscode.LanguageModelChatMessage.User(systemPrompt),
              vscode.LanguageModelChatMessage.User(effectivePrompt),
              vscode.LanguageModelChatMessage.User(buildSynthesisPrompt()),
              vscode.LanguageModelChatMessage.User(evidenceHeader + evidenceItems)
            );
            this.logger.debug(`[Synthesis] Wiping history and injecting ${archive.detail_slots.length} archive slots`);
          }
        }

        // Sliding memory: wipe history only when EVERY submit_findings in this round succeeded.
        // If any of N parallel submissions errored (focus_mismatch, invalid_status, orphan_rejection,
        // cascade_too_wide, route_validation_failed), history must be preserved so the AI sees the
        // error and can self-correct. Wiping on partial success destroys error feedback and the AI
        // commonly gives up after the next round (empirically observed).
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
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt), vscode.LanguageModelChatMessage.User(effectivePrompt), lastAssistant, lastResult);
            this.logger.debug(`[Hop] Sliding memory wipe (${submitParts.length} submit${submitParts.length > 1 ? 's' : ''}, all ok)`);
          } else {
            this.logger.warn(`[Hop] Tool error detected across ${submitParts.length} submit_findings (sample: ${errorSample}) — history preserved for AI self-correction`);
          }
        }
      }
    };

    try {
      await runWithTools();
      const totalTokenEst = lastInputTokenEstimate + totalOutputTokens + Math.round(totalToolResultChars / 4);
      this.logger.info(`Summary — rounds: ${roundCount}, tools: ${totalToolCallsMade}, tokens: ~${totalTokenEst}`);
      
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
