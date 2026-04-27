import * as vscode from 'vscode';
import { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { setInlineTokenBudget, setSmInlineNodeCap } from './tools';
import {
  buildGeneralSystemPrompt, buildDiscoveryPrompt, buildActivePhasePrompt, buildSynthesisPrompt, buildFollowUpPrompt,
  buildTracePrompt, buildSearchPrompt, buildActionRequiredGate,
  buildToolUsageBlock, buildMissionBriefBlock, buildCurrentTaskBlock, buildMemoryBlock, buildMissionStateBlock,
  buildDeferredQuestionsPrompt, RECOMMEND_FOLLOWUPS_TRIGGER, SHOW_DESCRIPTION_TRIGGER,
  ACTION_REQUIRED_PENDING_HINT
} from './prompts';
import { getToolInvocationLabel } from './toolLabels';
import { buildModeBlock } from './smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './tokenBudget';
import { NavigationEngine } from './smBase';
import { RepeatRejectGuard } from './repeatRejectGuard';
import { PendingGateSchema, classifyGateReply, type PendingGate, type HopLoopExit } from './sessionPhase';
import { renderScopeSummaryMd } from './scopeSummaryRenderer';
import { CLASSIFICATION_BANNER } from './classification';
import { filterLmTools, activeModeOf, getAllowedLmToolNames } from './toolPolicy';
import { resolveStagePrompt } from './templateRenderer';
import { ChatResponseWriter } from './chatResponseWriter';
import { PerformanceCollector } from './diagnostics';
import { MessageEnvelope, MessageEnvelopeInvariantError, type ToolPair } from './messageEnvelope';
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
export function extractToolCallFields(tc: vscode.LanguageModelToolCallPart): { callId: string; name: string; input: Record<string, unknown> } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input as Record<string, unknown>,
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

        const hasDeferred = sess.phase.kind === 'completed' && sess.stateMachine && sess.stateMachine.deferredQuestions.length > 0;
        if (hasDeferred) {
          followups.push({
            prompt: RECOMMEND_FOLLOWUPS_TRIGGER,
            label: vscode.l10n.t('Follow-up: Explore related objects…')
          });
        }

        // Surface the cached AI-preview description as a one-click recall chip.
        if (sess.lastPresentResultDescription) {
          followups.push({
            prompt: SHOW_DESCRIPTION_TRIGGER,
            label: vscode.l10n.t('Show full description')
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
    this.logger.info(
      `[${sess.id}] Session start — ` +
      `model=${model.vendor}/${model.family}/${model.version} (id=${model.id}, max=${model.maxInputTokens}t) ` +
      `cmd=${request.command ?? '(none)'} ` +
      `refs=${request.references.length} toolRefs=${request.toolReferences.length} ` +
      `history=${chatContext.history.length} ` +
      `prompt="${trunc(request.prompt, 200)}"`
    );

    let effectivePrompt = request.prompt;
    if (effectivePrompt === RECOMMEND_FOLLOWUPS_TRIGGER) {
      const deferred = sess.stateMachine?.deferredQuestions || [];
      effectivePrompt = buildDeferredQuestionsPrompt(deferred);
      this.logger.info(`[Trigger] Follow-up expansion: ${deferred.length} objects`);
    } else if (effectivePrompt === SHOW_DESCRIPTION_TRIGGER) {
      // Short-circuit: emit the cached AI-preview description 1:1 (no LM round-trip).
      if (sess.lastPresentResultDescription) {
        writer.markdown(sess.lastPresentResultDescription);
      } else {
        writer.markdown('_No AI preview description is currently cached for this session._');
      }
      this.logger.info(`[Trigger] Show full description — ${sess.lastPresentResultDescription?.length ?? 0} chars`);
      return {};
    }

    let activePhase: 'discover' | 'active' | 'synthesis' | 'completed' = 'discover';
    let lineageTools = filterLmTools(vscode.lm.tools, { kind: 'discover' });

    // /trace and /search inject discovery-phase prompts that conflict with
    // active/synthesis system prompts. Valid only in idle / completed; the
    // awaiting_gate branch below has its own routing.
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
      if (answer === 'no') {
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
      const isConfirmSm = gate.gate === 'confirm_sm_start';
      const userIsRefining = isConfirmSm && (answer === 'refine' || answer === 'redirect');
      if (userIsRefining) {
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
          'forceMode / classification / targetColumns. The engine will recompute the scope and',
          're-emit the gate so the user can review or refine again.',
          '',
          'If the user\'s intent is genuinely ambiguous, ask one short clarifying question and',
          'call no tool this turn — phase stays awaiting_gate and the user can re-reply.',
        ].join('\n');
        this.logger.info(`[Gate] ${gate.gate} — user refining (${answer})`);
      } else if (answer === 'redirect') {
        // Non-confirm_sm_start gate (schema/depth expansion) — treat as a redirect and reset exploration.
        sess.resetExploration();
        this.logger.info(`[Gate] ${gate.gate} — user redirected`);
      } else {
        if (gate.gate === 'confirm_sm_start') {
          const engine = sess.stateMachine as NavigationEngine | null;
          if (engine) {
            for (const cls of gate.classes) {
              if (cls.startsWith('schema:')) engine.extendAllowedSchemas(cls.slice('schema:'.length));
            }
          }
          sess.enterExploring();
          const focusId = engine?.currentFocus;
          effectivePrompt = focusId
            ? `User approved. Current focus for hop 1 is ${focusId}. Call submit_findings for this node.`
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

      let cachedStablePart: { phase: 'discover' | 'active' | 'synthesis' | 'completed'; text: string } | null = null;
      const buildStablePart = (phase: 'discover' | 'active' | 'synthesis' | 'completed'): string => {
        const engine = sess.stateMachine;
        if (cachedStablePart && cachedStablePart.phase === phase) return cachedStablePart.text;
        const dbPlatform = sess.model!.dbPlatform || 'SQL Server';
        const filterSchemas = sess.filter?.schemas || [];
        const totalSchemaCount = sess.model!.schemas.length;
        const totalNodes = sess.model!.nodes.length;
        const activeFilter = sess.filter;
        const visibleNodes = activeFilter?.schemas && activeFilter.schemas.length > 0
          ? sess.model!.nodes.filter(n => (activeFilter.schemas as string[]).includes(n.schema)).length
          : totalNodes;
        const base = buildGeneralSystemPrompt(phase, dbPlatform, filterSchemas, totalSchemaCount, visibleNodes, totalNodes);

        let phaseSpecific = '';
        if (phase === 'discover') phaseSpecific = buildDiscoveryPrompt();
        else if (phase === 'active') {
          const isInline = engine?.inlineMode ?? false;
          phaseSpecific = buildActivePhasePrompt(isInline);
        }
        else if (phase === 'synthesis') phaseSpecific = buildSynthesisPrompt();
        else if (phase === 'completed') phaseSpecific = buildFollowUpPrompt();

        // Follow-up phase inherits the synthesis-stage YAML block so `present_result`
        // re-renders keep the same formatting contract.
        const templatesPhase = phase === 'completed' ? 'synthesis' : phase;
        const stageBlock = resolveStagePrompt(sess.outputTemplates, templatesPhase, sess.classification, sess.memory.slotCount);
        const parts: string[] = [base, phaseSpecific];

        if (phase === 'active' && engine) {
          parts.push(buildToolUsageBlock());
          parts.push(buildModeBlock(engine.inlineMode, engine.columnAspect?.target_columns));
        }

        parts.push(stageBlock);

        if ((phase === 'active' || phase === 'synthesis' || phase === 'completed') && engine) {
          const missionBriefBlock = buildMissionBriefBlock(sess.memory.getMissionBrief(), sess.memory.getUserQuestion() || '');
          if (missionBriefBlock) parts.push(missionBriefBlock);
        }

        const text = parts.filter(Boolean).join('\n');
        cachedStablePart = { phase, text };
        return text;
      };

      const buildDynamicPart = (phase: 'discover' | 'active' | 'synthesis' | 'completed'): string => {
        const engine = sess.stateMachine;
        // Synthesis has no dynamic suffix — no per-hop sub-question, no working
        // memory, no protocol envelope. The closed archive is the substance; per-hop
        // state is active-phase only. Without this guard, a stale <current_task>
        // from the last hop leaks into the synthesis prompt.
        if (!engine || phase === 'discover' || phase === 'synthesis') return '';
        const dynamic: string[] = [];
        const currentTaskBlock = buildCurrentTaskBlock(engine.getCurrentTask());
        if (currentTaskBlock) dynamic.push(currentTaskBlock);
        if (phase === 'active' && !engine.inlineMode) {
          const stm = sess.memory.getShortTermMemory();
          const tally = sess.memory.getVerdictCounts();
          dynamic.push(buildMemoryBlock(stm, tally, engine.currentHop, engine.scopeSize));
          // Protocol envelope (ACK/WAIT contract) — ships on every SM active hop so the AI
          // sees the legal-reply shape and session-termination rule in structured form.
          const mode = activeModeOf(false, engine.columnAspect !== null);
          const legalTools = [...getAllowedLmToolNames({ kind: 'active', mode })]
            .map(n => n.replace(/^lineage_/, ''));
          const agendaRemaining = Math.max(0, engine.scopeSize - engine.currentHop);
          dynamic.push(buildMissionStateBlock(engine.currentHop, engine.scopeSize, agendaRemaining, legalTools, engine.currentFocus));
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
      const mode = activeModeOf(engine.inlineMode === true, engine.columnAspect !== null);
      lineageTools = filterLmTools(vscode.lm.tools, { kind: 'active', mode });
      this.logger.info(`[Phase] idle → active (gate-resume) — mode=${mode} tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
    } else if (resumingInCompleted) {
      activePhase = 'completed';
      lineageTools = filterLmTools(vscode.lm.tools, { kind: 'completed' });
      this.logger.info(`[Phase] completed → follow-up — archive slots=${sess.memory.slotCount}, tools: ${lineageTools.map(t => t.name.replace('lineage_', '')).join(', ')}`);
      this.logger.debug(`[Phase] follow-up entry — mission="${trunc(sess.memory.getMissionBrief() || sess.memory.getUserQuestion(), 200)}", classification=${sess.classification ?? '(none)'}`);
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
        const tools: vscode.LanguageModelChatTool[] = lineageTools.map(t => ({
          name: t.name,
          description: t.description || (t.tags?.includes('lineage-presentation') ? 'Presents results to user' : 'Lineage tool'),
          inputSchema: t.inputSchema
        }));

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
        const response = await model.sendRequest(envelope.toArray() as vscode.LanguageModelChatMessage[], { tools, toolMode }, token);
        const assistantParts: any[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        // Synthesis prose-gate: suppress preamble prose ("Now I have all slots…") by only
        // surfacing prose that arrives AFTER any tool_use part. Pre-tool prose is the model's
        // planning narration; the rendered chat narrative comes after the present_result call.
        // Defensive icon-code strip for synthesis prose: the model occasionally self-renders a
        // Show-in-Graph button as literal markdown ("$(type-hierarchy-sub) Show in Graph"); the
        // platform only renders icon codes inside writer.button(...).
        const surfaceProse = activePhase !== 'active';
        const gateProse = activePhase === 'synthesis';
        // Drop everything before the first '## ' heading so planning preambles
        // ("Now I have all slots. Assembling the final report.") never weld
        // onto the synthesised chat output.
        const stripSynthesisArtifacts = (s: string): string => {
          if (!gateProse) return s;
          let out = s.replace(/\$\([a-z][a-z0-9-]*\)\s*/gi, '');
          const hIdx = out.indexOf('## ');
          if (hIdx > 0) out = out.slice(hIdx);
          return out;
        };
        let toolCallSeenInTurn = false;
        for await (const part of response.stream) {
          if (!writer.isOpen()) break;
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            assistantParts.push(new vscode.LanguageModelTextPart(part.value.value));
            responseText += part.value.value;
            if (surfaceProse && (!gateProse || toolCallSeenInTurn)) writer.markdown(stripSynthesisArtifacts(part.value.value));
          } else if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            responseText += part.value;
            if (surfaceProse && (!gateProse || toolCallSeenInTurn)) writer.markdown(stripSynthesisArtifacts(part.value));
          }
          else if (part instanceof vscode.LanguageModelToolCallPart) {
            assistantParts.push(part);
            toolCalls.push(part);
            toolCallSeenInTurn = true;
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
          // SM-ACK/WAIT protocol guard: in SM active mode while the engine is still awaiting
          // findings, a toolless response violates the session contract (`toolMode.Required`
          // can fall back to Auto when tools.length > 1, so the API cannot enforce this on
          // its own). Inject a corrective user message and continue the loop; the existing
          // MAX_ROUNDS cap is the safety net for repeated drift.
          const engine = sess.stateMachine;
          const engineAwaiting =
            !!engine && !engine.inlineMode && (engine.toJSON() as { status?: string }).status === 'awaiting_findings';
          if (activePhase === 'active' && engineAwaiting) {
            this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — SM self-terminate blocked; injecting corrective prompt`);
            if (assistantParts.length > 0) {
              envelope.pushAssistant(assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]);
            }
            envelope.pushUserText(
              'Free-form responses are outside protocol in SLIDING MEMORY mode. Call `lineage_submit_findings` for the current focus node now (or `lineage_get_neighbor_columns` first if you need a neighbor\'s columns to decide a prune).'
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
            } else if (!sess.synthesisCorrectiveAttempted) {
              sess.synthesisCorrectiveAttempted = true;
              this.logger.warn(`Round ${roundCount} [SYNTHESIS] — no tool call; injecting one-shot corrective and retrying`);
              if (assistantParts.length > 0) {
                envelope.pushAssistant(assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]);
              }
              envelope.pushUserText(
                'Call `lineage_present_result` now to assemble the structured view from the archive. The archive is closed; lift each slot\'s analysis text and assemble per the synthesis output templates.'
              );
              continue;
            } else {
              this.logger.warn(`Round ${roundCount} [SYNTHESIS] — no tool call after corrective; rendering archive fallback`);
              this.renderArchiveFallback(sess, writer);
            }
          }
          const msFinal = Date.now() - tRoundStart;
          const pctFinal = roundInputTokens > 0 ? ((roundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
          this.logger.debug(`Round ${roundCount} [${activePhase.toUpperCase()}] — final answer (${msFinal}ms, ${roundInputTokens} in / ${roundOutputTokens} out tokens, ${pctFinal}%)`);
          drainPendingUserNotices();
          toolCallRounds.push({ response: responseText, toolCalls: [] });
          return { kind: 'final_answer' };
        }

        if (actionRequiredPending && responseText.length > 0) actionRequiredPending = false;
        envelope.pushAssistant(assistantParts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]);
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

          let progressLine = getToolInvocationLabel(f.name, f.input);
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
            this.logger.warn(`[Bridge] Repeat-rejection abort — tool=${f.name} last_error=${lastErrorText} count=${obs.count}`);
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
          const engine = sess.stateMachine!;
          const mode = activeModeOf(engine.inlineMode === true, engine.columnAspect !== null);
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
          if (sess.stateMachine.inlineMode && sess.classification) {
            writer.markdown(`\n\n${CLASSIFICATION_BANNER[sess.classification]}\n\n`);
          }
          invalidateStablePart();
          systemPrompt = buildStageSystemPrompt('synthesis');
          if (!sess.stateMachine.inlineMode) {
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
            envelope.wipeAndSeed(systemPrompt, effectivePrompt, synthesisPair);
            this.logger.info(`[Synthesis] Context cleaned: ${beforeCount} → ${envelope.length} messages; envelope preserved (${archive.detail_slots.length} slots, ${deferred.length} deferred)`);
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
            consecutiveErrorRounds = 0;
            // Rebuild system prompt on every wipe so <current_task> and <short_term_memory> stay current.
            systemPrompt = buildStageSystemPrompt('active');
            envelope.wipeAndSeed(systemPrompt, effectivePrompt);
            this.logger.debug(`[Hop] Sliding memory wipe (${submitParts.length} submit${submitParts.length > 1 ? 's' : ''}, all ok)`);
          } else {
            consecutiveErrorRounds++;
            if (consecutiveErrorRounds >= 3) {
              // Bounded error-preserve: after 3 consecutive error rounds, force a wipe
              // that keeps only the last error result so the AI still sees what broke
              // but the history does not grow unbounded within MAX_ROUNDS.
              systemPrompt = buildStageSystemPrompt('active');
              envelope.wipeAndSeed(systemPrompt, effectivePrompt);
              this.logger.warn(`[Hop] 3 consecutive error rounds (last: ${errorSample}) — forced bounded wipe`);
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
        this.logger.error('Chat handler', err);
        exit = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    const smStatus = sess.stateMachine ? (sess.stateMachine.columnAspect ? 'Column' : 'BB') : '—';
    const peakPct = sess.maxInputTokens > 0 ? ((peakRoundInputTokens / sess.maxInputTokens) * 100).toFixed(0) : '?';
    this.logger.info(`Summary — model: ${sess.modelName}, SM: ${smStatus}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, cumulative in: ${totalRoundInputTokens}, out: ${totalOutputTokens}, peak-round: ${peakRoundInputTokens}/${sess.maxInputTokens} (${peakPct}%)`);
    this.dispatchExit(exit, sess, writer, request.prompt, roundCount, MAX_ROUNDS);

    return {
      metadata: {
        toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults },
        lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map((tc: any) => tc.name) : [],
        performanceDiagnostics: collector.finalize(sess, peakRoundInputTokens)
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
    const lines: string[] = [
      '',
      '> Synthesis fallback — the model did not invoke `present_result`. Captured analysis below.',
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
  private dispatchExit(exit: HopLoopExit, sess: AiSession, writer: ChatResponseWriter, userPrompt: string, roundCount: number, maxRounds: number): void {
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
        this.logger.warn(`Exit hop_cap: hit ${maxRounds}-round cap with ${remaining} agenda items pending — archive discarded`);
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
        this.logger.warn(`Exit ${exit.kind}: ${msg}`);
        writer.markdown(`\n\n*Error: ${msg}*`);
        break;
      }
    }

    // Finalizer — emit the gate button row whenever the session is awaiting_gate at the
    // end of dispatch. New exit kinds can't forget the buttons.
    if (sess.phase.kind === 'awaiting_gate') {
      this.emitGateButtonRow(writer, sess.phase.gate);
    }
  }
}
