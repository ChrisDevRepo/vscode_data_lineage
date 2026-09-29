/**
 * Thin native-chat host adapter for the shared lineage runtime.
 *
 * LangGraph owns phase/hop routing and tool attempts. This module owns only
 * VS Code request/response projection, cancellation, and native gate buttons.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../../utils/log';
import { Logger as OutputLogger } from '../../utils/log';
import { notifyWarning } from '../../utils/notifications';
import { VscodeModelPort } from '../model/vscodeModelPort';
import type { AiTraceWriter } from '../observability/aiTraceWriter';
import { tokenToAbortSignal } from '../providers/cancellation';
import type { LineageRuntime } from '../runtime/lineageRuntime';
import {
  gateTriggerPrompt,
  RUN_TRACE_TRIGGER,
  SHOW_FULL_DESCRIPTION_TRIGGER,
  SHOW_FULL_PLAN_TRIGGER,
  SHOW_GRAPH_PREVIEW_TRIGGER,
  expandRunTracePrompt,
  expandShowGraphPreviewPrompt,
} from '../prompting/prompts';
import { TurnEventSink, type TurnEvent } from '../runtime/turnEventSink';
import type { AiSession, PendingExplorationProposal } from '../session/session';
import { nodeFiltersRemovedByOrigin, renderScopeCardMd, renderScopeSummaryMd, schemaFiltersRemovedByOrigin, GATE_CARD_HEADER, HOLD_GATE_NOTICE } from '../prompting/scopeSummaryRenderer';
import { sanitizeDescriptionForChat, sanitizeProviderError } from '../support/text';
import {
  createTurnTokenBudget,
  DEFAULT_DISCOVERY_NODE_CAP,
  DEFAULT_DISCOVERY_TOKEN_BUDGET,
  DEFAULT_MAX_TRACE_COLUMNS,
  DISCOVERY_WINDOW_SHARE,
} from '../support/tokenBudget';
import { readDeclaredNumericSetting } from '../../configCore';
import { DEFAULT_MAX_ROUNDS } from '../core/agentCore';
import {
  applyNativeChatBoundary,
  chatHistoryToModelMessages,
} from './chatHistoryAdapter';

interface PendingNativeGate {
  readonly gateId: string;
  readonly gate: string;
  /**
   * Chat request that raised this gate.
   *
   * @remarks
   * Carried so a resolution recorded from the command handler — which runs outside the turn — can
   * be grouped with that turn's other lifecycle records, whose sole grouping key is `requestId`.
   */
  readonly requestId: string;
  /** Proposal revision the card shows; its Approve and Cancel act on this revision only. */
  readonly revision: number;
  /** Exposure classes the gate carried; an approve decision echoes them back. */
  readonly classes: readonly string[];
}

/** Result metadata of the reply that printed the full plan, so it does not offer the plan again. */
const FULL_PLAN_SHOWN = 'fullPlanShown';

/** Action a native approval-card button asks the runtime to take. */
type NativeGateAction = 'approve' | 'change' | 'cancel';

/**
 * Participant mention every chat turn the approval card opens starts with: Change scope prefills
 * it unsent (`isPartialQuery`) for the user to type the change; Approve and Cancel submit it with
 * their trigger prompt. The mention is required for the turn to reach `@lineage`.
 */
const PARTICIPANT_MENTION = '@lineage ';

/** Most open leads named in the single follow-up-questions badge's prompt, taken in lead order. */
const MAX_DEFERRED_FOLLOWUPS = 2;

/** Projects the shared lineage runtime onto VS Code's native chat participant API. */
export class LineageParticipant {
  private readonly logger: Logger;
  private pendingGate: PendingNativeGate | null = null;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private readonly runtime: LineageRuntime,
    /** Session-scoped trace sink; it remains a no-op until enabled from the Command Palette. */
    private readonly traceWriter?: AiTraceWriter,
  ) {
    this.logger = OutputLogger.create(outputChannel, 'AI');
  }

  /** Registers the participant, feedback listener, follow-ups, and native gate commands. */
  public register(): void {
    const participant = vscode.chat.createChatParticipant(
      'dataLineageViz.lineage',
      this.handleChatRequest.bind(this),
    );
    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful
        ? 'helpful'
        : 'unhelpful';
      this.logger.debug(`Feedback: ${kind}`);
    });
    participant.followupProvider = {
      provideFollowups: (result) => this.followups(result),
    };

    this.context.subscriptions.push(
      participant,
      vscode.commands.registerCommand(
        'dataLineageViz.aiResumeNativeGate',
        async (
          gateId: string,
          action: NativeGateAction,
          classes: string[] = [],
        ) => {
          const pending = this.requirePendingGate(gateId, action);
          if (!pending) return;
          const outcome = await this.submitGateDecision(pending, gateId, action, classes);
          if (outcome === 'failed' || (outcome === 'resolved' && action !== 'change')) return;
          await vscode.commands.executeCommand('workbench.action.chat.open', action === 'change'
            ? { query: PARTICIPANT_MENTION, isPartialQuery: true }
            : { query: `${PARTICIPANT_MENTION}${gateTriggerPrompt(action, pending.revision)}` });
        },
      ),
    );
  }

  /**
   * Returns the current gate while the session still holds its proposal, or logs why a
   * stale/replaced native button was ignored.
   *
   * @remarks
   * The card stays live across button clicks and typed replies until the session no longer holds
   * the proposal it shows (approved, cancelled, replaced by a revised card, or a new chat), so
   * Change scope followed by Approve works. Log-only by design: a superseded card stays visible in
   * the transcript forever, and a notification for each click would be noise.
   */
  private requirePendingGate(
    gateId: string,
    action: NativeGateAction,
  ): PendingNativeGate | null {
    const pending = this.pendingGate;
    if (pending?.gateId === gateId && this.sessionHoldsGateProposal()) return pending;

    this.traceGateResolution(pending, gateId, action, 'refused',
      pending !== null && pending.gateId !== gateId ? 'gate_id_mismatch' : 'no_pending_gate');
    this.logger.debug(
      `[Gate] superseded button ignored — action=${action} requestedGateId=${gateId} `
      + `pendingGateId=${pending?.gateId ?? 'none'} pendingGate=${pending?.gate ?? 'none'}`,
    );
    return null;
  }

  /** Whether the session still holds a proposal awaiting the user's decision. */
  private sessionHoldsGateProposal(): boolean {
    const session = this.getSession();
    return session.phase.kind === 'awaiting_gate' && session.pendingExploration != null;
  }

  /**
   * Resolves the raising turn's gate with one validated action.
   *
   * @remarks
   * The raising turn holds its gate the moment the card renders, so this normally finds no owning
   * turn (`'no_turn'`); the caller then acts on the session-held proposal through a fresh
   * chat turn. The card stays live either way.
   */
  private async submitGateDecision(
    pending: PendingNativeGate,
    gateId: string,
    action: NativeGateAction,
    classes: string[],
  ): Promise<'resolved' | 'no_turn' | 'failed'> {
    const decision: Parameters<LineageRuntime['resumeGate']>[1] = action === 'approve'
      ? { kind: 'approve', classes }
      : action === 'change'
        ? { kind: 'hold' }
        : { kind: 'cancel' };
    const decidedAt = new Date().toISOString();
    try {
      const resolved = await this.runtime.resumeGate(gateId, decision);
      this.traceGateResolution(pending, gateId, action, resolved ? 'accepted' : 'no_owning_turn', undefined, decidedAt);
      return resolved ? 'resolved' : 'no_turn';
    } catch (error) {
      this.traceGateResolution(pending, gateId, action, 'failed', undefined, decidedAt);
      notifyWarning(
        this.logger,
        'Native gate action failed',
        'Data Lineage: The approval action could not be completed. The existing proposal is still pending.',
        { action, requestedGateId: gateId, error },
      );
      return 'failed';
    }
  }

  /**
   * Records the outcome of one native gate action in the diagnostic trace.
   *
   * @param pending - Gate the participant currently holds, or `null` when none is pending.
   * @param gateId - Gate id the clicked card carried.
   * @param action - Action the card requested.
   * @param outcome - How the participant answered the action.
   * @param refusedBy - Enumerated deciding condition, supplied only for a refusal.
   * @param decidedAt - ISO time the action arrived, before any turn it released was awaited.
   *
   * @remarks
   * Gate resolution happens in a VS Code command handler, outside the turn that raised the gate and
   * therefore outside its event sink — so this is the one place the trace can learn what answered a
   * gate. No-op unless the diagnostic trace is enabled: {@link AiTraceWriter.write} discards every
   * record while disabled, so the check is the writer's, not a second one here.
   */
  private traceGateResolution(
    pending: PendingNativeGate | null,
    gateId: string,
    action: NativeGateAction | 'hold',
    outcome: 'accepted' | 'refused' | 'no_owning_turn' | 'failed',
    refusedBy?: 'gate_id_mismatch' | 'no_pending_gate',
    decidedAt?: string,
  ): void {
    void this.traceWriter?.write({
      type: 'gate-resolution',
      requestId: pending?.requestId ?? 'unknown',
      gateId,
      gate: pending?.gate ?? 'none',
      action,
      outcome,
      ...(refusedBy ? { refusedBy } : {}),
      ...(decidedAt ? { decidedAt } : {}),
    }).catch(() => {});
  }

  /** Handles one native chat request with the exact model selected by VS Code. */
  public async handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const session = this.getSession();
    if (!session.model) {
      this.write(stream, token, (out) => out.markdown(
        'No lineage data loaded. Open a `.dacpac` file or connect to a database first.',
      ));
      return {};
    }

    if (applyNativeChatBoundary(
      chatContext.history,
      session,
      this.pendingGate,
      (gateId) => { void this.runtime.resumeGate(gateId, { kind: 'cancel' }); },
    )) {
      this.pendingGate = null;
      this.logger.info(
        `[${session.id}] New chat session detected — prior exploration state cleared`,
      );
    }

    if (request.prompt.trim().length === 0 && this.sessionHoldsGateProposal()) {
      this.write(stream, token, (out) => out.markdown(
        '_Use **Approve & Proceed**, **Change scope**, or **Cancel** on the proposal above, or reply in chat._',
      ));
      return {};
    }

    if (
      normalizeFollowupTrigger(request.prompt)
      === normalizeFollowupTrigger(SHOW_FULL_PLAN_TRIGGER)
    ) {
      const pending = this.pendingGate;
      const proposal = this.sessionHoldsGateProposal() ? session.pendingExploration : null;
      this.write(stream, token, (out) => {
        if (!proposal) {
          out.markdown('_No exploration plan is waiting for approval._');
          return;
        }
        out.markdown(`${this.fullPlanReplyMd(proposal)}\n\n`);
        if (pending) this.writeGateButtons(out, pending.gateId, pending.classes);
      });
      return { metadata: { [FULL_PLAN_SHOWN]: true } };
    }

    if (
      normalizeFollowupTrigger(request.prompt)
      === normalizeFollowupTrigger(SHOW_FULL_DESCRIPTION_TRIGGER)
    ) {
      this.write(stream, token, (out) => out.markdown(
        session.lastPresentResultDescription
          ? sanitizeDescriptionForChat(session.lastPresentResultDescription)
          : '_No AI preview description is currently cached for this session._',
      ));
      return {};
    }

    const config = vscode.workspace.getConfiguration('dataLineageViz');
    const modelWindow = request.model.maxInputTokens > 0
      ? request.model.maxInputTokens
      : Number.POSITIVE_INFINITY;
    const turnBudget = createTurnTokenBudget({
      modelWindowTokens: request.model.maxInputTokens,
      discoveryNodeCap: readDeclaredNumericSetting(config, 'ai.discoveryNodeCap', DEFAULT_DISCOVERY_NODE_CAP),
      discoveryTokenBudget: Math.min(
        readDeclaredNumericSetting(config, 'ai.discoveryTokenBudget', DEFAULT_DISCOVERY_TOKEN_BUDGET),
        Math.floor(modelWindow * DISCOVERY_WINDOW_SHARE),
      ),
      maxRounds: readDeclaredNumericSetting(config, 'ai.maxRounds', DEFAULT_MAX_ROUNDS),
      maxTraceColumns: readDeclaredNumericSetting(config, 'ai.maxTraceColumns', DEFAULT_MAX_TRACE_COLUMNS),
    });

    const requestId = randomUUID();
    const turnStartedAt = Date.now();
    const cancellation = tokenToAbortSignal(token);
    const traceWriter = this.traceWriter?.isEnabled() ? this.traceWriter : undefined;
    const model = new VscodeModelPort(request.model, {
      debugLog: (message) => this.logger.debug(message),
      requestId,
      wireLog: traceWriter && ((record) => {
        void traceWriter.write(record).catch(() => {});
      }),
      traceVerbose: traceWriter?.isVerbose(),
      budget: turnBudget,
    });
    const prompt = request.command
      ? `/${request.command} ${request.prompt}`.trimEnd()
      : expandRunTracePrompt(expandShowGraphPreviewPrompt(request.prompt, session), session);
    const sink = new TurnEventSink(
      (event) => this.write(stream, token, (out) => this.writeEvent(event, out, request.prompt, requestId)),
    );
    this.logger.info(
      `[${session.id}] native turn start model=${request.model.id} command=${request.command ?? 'none'} history=${chatContext.history.length}`,
    );
    const priorMessages = chatHistoryToModelMessages(chatContext.history, turnBudget, (msg) => this.logger.debug(msg));

    this.statusBarStart('working…');
    try {
      const result = await this.runtime.run({
        model,
        request: { id: requestId, prompt, priorMessages },
        sink,
        signal: cancellation.signal,
      });
      const metadata = {
        requestId,
        status: result.outcome,
        modelCalls: result.modelCalls,
      };
      if (result.outcome !== 'error') {
        this.logger.info(
          `[${session.id}] native turn terminal status=${result.outcome} modelCalls=${result.modelCalls} elapsedMs=${Date.now() - turnStartedAt}`,
        );
        return { metadata };
      }

      const message = sanitizeProviderError(result.failure?.message ?? '')
        || 'Data Lineage could not complete this request.';
      this.logger.error(
        `[${session.id}] native turn terminal status=error modelCalls=${result.modelCalls} elapsedMs=${Date.now() - turnStartedAt}`,
        message,
      );
      return { metadata, errorDetails: { message: `${message} (Retry — send the request again.)` } };
    } finally {
      this.statusBarStop();
      cancellation.dispose();
    }
  }

  /** Shared activity indicator state; the counter prevents overlapping turns from hiding it early. */
  private statusBarItem: vscode.StatusBarItem | undefined;
  private activeTurns = 0;

  private statusBarStart(label: string): void {
    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      this.statusBarItem.name = 'Lineage AI';
      this.statusBarItem.tooltip = 'Data Lineage AI is processing a request';
      this.context.subscriptions.push(this.statusBarItem);
    }
    this.activeTurns += 1;
    this.statusBarUpdate(label);
    this.statusBarItem.show();
  }

  private statusBarUpdate(label: string): void {
    if (this.statusBarItem) this.statusBarItem.text = `$(sync~spin) Lineage AI: ${label}`;
  }

  private statusBarStop(): void {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    if (this.activeTurns === 0) this.statusBarItem?.hide();
  }

  /**
   * Performs one chat-stream write, degrading to a no-op when the stream can no longer take it.
   *
   * @remarks
   * VS Code tears the `ChatResponseStream` down when the turn ends or the user presses Stop, and a
   * write that loses that race throws. These writes run inside the sink consumer, whose throw the
   * runtime re-raises out of the turn, so an unguarded one escapes `handleChatRequest`. A closed
   * stream and a cancelled token are normal end states; every other error still propagates.
   */
  private write(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    write: (stream: vscode.ChatResponseStream) => void,
  ): void {
    if (token.isCancellationRequested) return;
    try {
      write(stream);
    } catch (error) {
      if (!token.isCancellationRequested && !isStreamClosedError(error)) throw error;
      this.logger.debug('chat stream write skipped — stream closed or turn cancelled');
    }
  }

  private writeEvent(
    event: TurnEvent,
    stream: vscode.ChatResponseStream,
    originalPrompt: string,
    requestId: string,
  ): void {
    switch (event.type) {
      case 'status':
        stream.progress(event.label);
        this.statusBarUpdate(event.label);
        return;
      case 'text':
        stream.markdown(event.delta);
        return;
      case 'error':
        if (event.recoverable !== false) stream.markdown(`\n\n${event.message}`);
        return;
      case 'gate': {
        const proposal = this.getSession().pendingExploration;
        const pending: PendingNativeGate = {
          gateId: event.gateId,
          gate: event.gate,
          requestId,
          revision: proposal?.revision ?? 1,
          classes: event.classes ?? [],
        };
        this.pendingGate = pending;
        const card = proposal ? renderScopeCardMd(proposal) : event.summary;
        stream.markdown(`${GATE_CARD_HEADER}${card}${HOLD_GATE_NOTICE}\n\n`);
        this.writeGateButtons(stream, event.gateId, pending.classes);
        void this.runtime.resumeGate(event.gateId, { kind: 'hold' })
          .then((resumed) => {
            this.traceGateResolution(pending, event.gateId, 'hold', resumed ? 'accepted' : 'no_owning_turn', undefined, new Date().toISOString());
            this.logger.debug(
              `[Gate] auto-held at render — input freed for typed scope change (gateId=${event.gateId} gate=${event.gate} resumed=${resumed})`,
            );
          })
          .catch((err) => this.logger.error(`[Gate] auto-hold at render (gateId=${event.gateId})`, err));
        return;
      }
      case 'terminal': {
        const session = this.getSession();
        if (
          event.status === 'ok'
          && session.presentResultCalledThisTurn
          && !session.presentResultAutoDispatched
          && session.resultGraph
        ) {
          stream.button({
            command: 'dataLineageViz.aiCreateView',
            title: '$(type-hierarchy-sub) Show in Graph',
            arguments: [originalPrompt],
          });
        }
        const renderDegradedReason = session.consumeSynthesisRenderDegraded();
        if (renderDegradedReason) {
          notifyWarning(
            this.logger,
            'Synthesis render degraded',
            'Data Lineage: The AI preview could not be rendered. The answer text is in the chat; see the debug log for details.',
            { requestId, reason: renderDegradedReason },
          );
        }
        return;
      }
    }
  }

  /**
   * Renders the **Show full plan** reply: the discovery summary (when the proposal has one) ahead
   * of the plan, every in-scope object the stored proposal carries.
   *
   * @remarks
   * Built directly from the held proposal rather than reused from the gate's stored `detail` —
   * that string is the model-facing tool-response copy (discovery summary trailing, not leading)
   * and stays exactly as the backend built it. This is a separate, user-facing rendering of the
   * same underlying scope data.
   */
  private fullPlanReplyMd(proposal: PendingExplorationProposal): string {
    const removedSchemaFilters = schemaFiltersRemovedByOrigin(
      proposal.init.excludeSchemas ?? [],
      proposal.summary.activeFilters.schemas,
    );
    const removedNodeFilters = nodeFiltersRemovedByOrigin(
      proposal.init.excludeNodeIds ?? [],
      proposal.summary.origin,
      proposal.summary.activeFilters.nodeIds,
    );
    const plan = renderScopeSummaryMd(proposal.summary, proposal.revision, proposal.classification, removedSchemaFilters, removedNodeFilters);
    return proposal.discoverySummary ? `${proposal.discoverySummary}\n\n${plan}` : plan;
  }

  /** The approval card's three buttons, bound to the gate they resolve. */
  private writeGateButtons(stream: vscode.ChatResponseStream, gateId: string, classes: readonly string[]): void {
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(check) Approve & Proceed',
      arguments: [gateId, 'approve', [...classes]],
    });
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(edit) Change scope',
      arguments: [gateId, 'change', [...classes]],
    });
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(close) Cancel',
      arguments: [gateId, 'cancel', [...classes]],
    });
  }

  private followups(result?: vscode.ChatResult): vscode.ChatFollowup[] {
    const session = this.getSession();
    if (this.sessionHoldsGateProposal()) {
      return result?.metadata?.[FULL_PLAN_SHOWN] === true
        ? []
        : [{ prompt: SHOW_FULL_PLAN_TRIGGER, label: vscode.l10n.t('Show full plan') }];
    }
    const followups: vscode.ChatFollowup[] = [];
    if (session.phase.kind === 'completed') {
      followups.push({
        prompt: 'What related objects should I investigate next?',
        label: vscode.l10n.t('Explore related objects…'),
      });
      const reachable = (session.stateMachine?.deferredQuestions ?? []).filter(deferred => deferred.reason !== 'excluded');
      const leads = reachable.slice(0, MAX_DEFERRED_FOLLOWUPS);
      if (leads.length > 0) {
        const openLeads = leads
          .map(deferred =>
            deferred.question ? `At ${deferred.nodeId}: ${deferred.question}` : `Continue the trace at ${deferred.nodeId}.`,
          )
          .join('; ');
        followups.push({
          prompt: `Follow up the open questions: ${openLeads}`,
          label: vscode.l10n.t('Follow-up questions'),
        });
      }
    }
    if (session.lastPresentResultDescription) {
      followups.push({
        prompt: SHOW_FULL_DESCRIPTION_TRIGGER,
        label: vscode.l10n.t('Show full description'),
      });
    }
    if (session.smOfferAvailable()) {
      if (session.previewOfferAvailable()) {
        followups.push({
          prompt: SHOW_GRAPH_PREVIEW_TRIGGER,
          label: vscode.l10n.t('Show graph preview'),
        });
      }
      followups.push({
        prompt: RUN_TRACE_TRIGGER,
        label: vscode.l10n.t('Start deeper hop-by-hop analysis'),
      });
    }
    return followups;
  }
}

/** VS Code throws this when a `ChatResponseStream` is written after it has been torn down. */
function isStreamClosedError(error: unknown): boolean {
  return error instanceof Error && /stream.*closed|closed.*stream/i.test(error.message);
}

function normalizeFollowupTrigger(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
