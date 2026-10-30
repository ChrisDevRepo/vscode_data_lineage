/** Thin native-chat host adapter for the shared lineage runtime. */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Logger } from '../../utils/log';
import { expandNextQuestionSuggestions } from '../prompting/followupSuggestions';
import { notifyWarning } from '../../utils/notifications';
import { VscodeModelPort } from '../model/vscodeModelPort';
import type { AiTraceWriter } from '../observability/aiTraceWriter';
import { tokenToAbortSignal } from '../providers/cancellation';
import type { LineageRuntime } from '../runtime/lineageRuntime';
import {
  RUN_TRACE_TRIGGER,
  SHOW_FULL_DESCRIPTION_TRIGGER,
  SHOW_FULL_PLAN_TRIGGER,
  SHOW_GRAPH_PREVIEW_TRIGGER,
  STALE_GATE_TRIGGER_REPLY,
  expandRunTracePrompt,
  expandShowGraphPreviewPrompt,
} from '../prompting/prompts';
import { TurnEventSink, type TurnEvent } from '../runtime/turnEventSink';
import type { AiSession } from '../session/session';
import {
  renderFullPlanMd,
  renderScopeCardMd,
  GATE_CARD_HEADER,
  HOLD_GATE_NOTICE,
} from '../prompting/scopeSummaryRenderer';
import {
  sanitizeDescriptionForChat,
  sanitizeProviderError,
} from '../support/text';
import { turnTokenBudgetFromSettings } from '../support/tokenBudget';
import {
  applyNativeChatBoundary,
  chatHistoryToModelMessages,
  continuedSlashCommand,
  GATE_SHOWN_METADATA,
} from './chatHistoryAdapter';

/** Result metadata of the reply that printed the full plan, so it does not offer the plan again. */
const FULL_PLAN_SHOWN = 'fullPlanShown';

/** Action a native approval-card button asks the runtime to take. */
type NativeGateAction = 'approve' | 'change' | 'cancel';

interface GateButtonRequest {
  /** Card the click came from; the session decides whether it is still held. */
  readonly proposalId: string;
  readonly action: 'approve' | 'cancel';
  readonly label: string;
}

/** Participant mention every chat turn the approval card opens starts with: Change scope prefills it unsent (`isPartialQuery`) for the user to type the change; Approve and Cancel submit only their visible action label. The mention is required for the turn to reach `@lineage`. */
const PARTICIPANT_MENTION = '@lineage ';

/** Natural user request submitted by the combined follow-up badge. */
const NEXT_QUESTIONS_TRIGGER = 'What could I explore next?';

/** Projects the shared lineage runtime onto VS Code's native chat participant API. */
export class LineageParticipant {
  private readonly logger: Logger;
  /** Chat request whose answer shows the current card; later answers re-attach its buttons. */
  private cardRequestId: string | null = null;
  private buttonRequest: GateButtonRequest | null = null;
  private gateCommandBusy = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private readonly runtime: LineageRuntime,
    /** Session-scoped trace sink; it remains a no-op until enabled from the Command Palette. */
    private readonly traceWriter?: AiTraceWriter,
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  /** Registers the participant, feedback listener, follow-ups, and native gate commands. */
  public register(): void {
    const participant = vscode.chat.createChatParticipant(
      'dataLineageViz.lineage',
      this.handleChatRequest.bind(this),
    );
    participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      const kind =
        feedback.kind === vscode.ChatResultFeedbackKind.Helpful
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
        async (proposalId: string, action: NativeGateAction) => {
          if (
            !['approve', 'change', 'cancel'].includes(action) ||
            this.gateCommandBusy
          )
            return;
          if (!this.requireHeldCard(proposalId, action)) return;
          const submitted: GateButtonRequest | null =
            action === 'change'
              ? null
              : {
                  proposalId,
                  action,
                  label: action === 'approve' ? 'Approve & Proceed' : 'Cancel',
                };
          this.buttonRequest = submitted;
          this.gateCommandBusy = true;
          try {
            this.traceGateResolution(proposalId, action, 'no_owning_turn');
            await vscode.commands.executeCommand(
              'workbench.action.chat.open',
              action === 'change'
                ? { query: PARTICIPANT_MENTION, isPartialQuery: true }
                : {
                    query: `${PARTICIPANT_MENTION}${submitted!.label}`,
                    blockOnResponse: true,
                  },
            );
          } finally {
            if (this.buttonRequest === submitted) this.buttonRequest = null;
            this.gateCommandBusy = false;
          }
        },
      ),
    );
  }

  /** Whether the session still holds the clicked card; logs why a stale or replaced card's button was ignored. */
  private requireHeldCard(
    proposalId: string,
    action: NativeGateAction,
  ): boolean {
    const session = this.getSession();
    if (session.holdsProposal(proposalId)) return true;
    const heldId =
      session.phase.kind === 'awaiting_gate'
        ? session.pendingExploration?.proposalId
        : undefined;
    this.traceGateResolution(
      proposalId,
      action,
      'refused',
      heldId !== undefined ? 'gate_id_mismatch' : 'no_pending_gate',
    );
    this.logger.debug(
      `[Gate] superseded button ignored — action=${action} requestedCard=${proposalId} heldCard=${heldId ?? 'none'}`,
    );
    return false;
  }

  /** Whether the session still holds a proposal awaiting the user's decision. */
  private sessionHoldsGateProposal(): boolean {
    const session = this.getSession();
    return (
      session.phase.kind === 'awaiting_gate' &&
      session.pendingExploration != null
    );
  }

  /** Records the outcome of one native gate action in the diagnostic trace. */
  private traceGateResolution(
    proposalId: string,
    action: NativeGateAction,
    outcome: 'refused' | 'no_owning_turn',
    refusedBy?: 'gate_id_mismatch' | 'no_pending_gate',
  ): void {
    void this.traceWriter
      ?.write({
        type: 'gate-resolution',
        requestId: this.cardRequestId ?? 'unknown',
        gateId: proposalId,
        gate: this.cardRequestId ? 'confirm_sm_start' : 'none',
        action,
        outcome,
        ...(refusedBy ? { refusedBy } : {}),
      })
      .catch(() => {});
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
      this.write(stream, token, (out) =>
        out.markdown(
          'No lineage data loaded. Open a `.dacpac` file or connect to a database first.',
        ),
      );
      return {};
    }

    // The badge exists only below a completed answer, so the same words in an empty chat are a
    // new-chat request and still pass the boundary reset.
    const suggestionFollowup =
      chatContext.history.length > 0 &&
      session.phase.kind === 'completed' &&
      normalizeFollowupTrigger(request.prompt) ===
        normalizeFollowupTrigger(NEXT_QUESTIONS_TRIGGER);

    if (
      !suggestionFollowup &&
      applyNativeChatBoundary(chatContext.history, session)
    ) {
      this.cardRequestId = null;
      this.logger.info(
        `[${session.id}] New chat session detected — prior exploration state cleared`,
      );
    }

    // The visible label carries no routing data. Only its request-owned button action can
    // bypass AI classification; a user typing the same words takes the normal typed-reply path.
    const submitted = this.buttonRequest;
    let gateDecision:
      | { kind: 'approve' | 'cancel'; proposalId: string }
      | undefined;
    if (submitted && request.prompt.trim() === submitted.label) {
      this.buttonRequest = null;
      if (!session.holdsProposal(submitted.proposalId)) {
        this.write(stream, token, (out) =>
          out.markdown(STALE_GATE_TRIGGER_REPLY),
        );
        return {};
      }
      gateDecision = {
        kind: submitted.action,
        proposalId: submitted.proposalId,
      };
    }

    if (request.prompt.trim().length === 0 && this.sessionHoldsGateProposal()) {
      this.write(stream, token, (out) =>
        out.markdown(
          '_Use **Approve & Proceed**, **Change scope**, or **Cancel** on the proposal above, or reply in chat._',
        ),
      );
      return {};
    }

    if (
      normalizeFollowupTrigger(request.prompt) ===
      normalizeFollowupTrigger(SHOW_FULL_PLAN_TRIGGER)
    ) {
      const proposal = this.sessionHoldsGateProposal()
        ? session.pendingExploration
        : null;
      this.write(stream, token, (out) => {
        if (!proposal) {
          out.markdown('_No exploration plan is waiting for approval._');
          return;
        }
        out.markdown(`${renderFullPlanMd(proposal)}\n\n`);
        if (proposal.proposalId !== undefined)
          this.writeGateButtons(out, proposal.proposalId);
      });
      return { metadata: { [FULL_PLAN_SHOWN]: true } };
    }

    if (
      normalizeFollowupTrigger(request.prompt) ===
      normalizeFollowupTrigger(SHOW_FULL_DESCRIPTION_TRIGGER)
    ) {
      this.write(stream, token, (out) =>
        out.markdown(
          session.lastPresentResultDescription
            ? sanitizeDescriptionForChat(session.lastPresentResultDescription)
            : '_No AI preview description is currently cached for this session._',
        ),
      );
      return {};
    }

    const turnBudget = turnTokenBudgetFromSettings(
      vscode.workspace.getConfiguration('dataLineageViz'),
      request.model.maxInputTokens,
    );

    const requestId = randomUUID();
    const turnStartedAt = Date.now();
    const cancellation = tokenToAbortSignal(token);
    const traceWriter = this.traceWriter?.isEnabled()
      ? this.traceWriter
      : undefined;
    const model = new VscodeModelPort(request.model, {
      debugLog: (message) => this.logger.debug(message),
      requestId,
      wireLog:
        traceWriter &&
        ((record) => {
          void traceWriter.write(record).catch(() => {});
        }),
      traceVerbose: traceWriter?.isVerbose(),
      budget: turnBudget,
    });
    const command =
      request.command ??
      (session.phase.kind === 'idle'
        ? continuedSlashCommand(chatContext.history)
        : undefined);
    const prompt = command
      ? `/${command} ${request.prompt}`.trimEnd()
      : gateDecision
        ? request.prompt
        : suggestionFollowup
          ? expandNextQuestionSuggestions(session)
          : expandRunTracePrompt(
              expandShowGraphPreviewPrompt(request.prompt, session),
              session,
            );
    const sink = new TurnEventSink((event) => {
      if (suggestionFollowup && event.type === 'terminal') return;
      this.write(stream, token, (out) =>
        this.writeEvent(event, out, request.prompt, requestId),
      );
    });
    this.logger.info(
      `[${session.id}] native turn start request=${requestId} model=${request.model.id} command=${command ?? 'none'} history=${chatContext.history.length}`,
    );
    const priorMessages = suggestionFollowup
      ? []
      : chatHistoryToModelMessages(chatContext.history, turnBudget, (msg) =>
          this.logger.debug(msg),
        );

    this.statusBarStart('working…');
    try {
      const run = suggestionFollowup
        ? this.runtime.runSuggestions.bind(this.runtime)
        : this.runtime.run.bind(this.runtime);
      const result = await run({
        model,
        request: {
          id: requestId,
          prompt,
          priorMessages,
          ...(gateDecision ? { gateDecision } : {}),
        },
        sink,
        signal: cancellation.signal,
      });
      const metadata = {
        requestId,
        status: result.outcome,
        modelCalls: result.modelCalls,
        ...(this.cardRequestId === requestId
          ? { [GATE_SHOWN_METADATA]: true }
          : {}),
      };
      if (result.outcome !== 'error') {
        this.logger.info(
          `[${session.id}] native turn terminal request=${requestId} status=${result.outcome} modelCalls=${result.modelCalls} elapsedMs=${Date.now() - turnStartedAt}`,
        );
        return { metadata };
      }

      const message =
        sanitizeProviderError(result.failure?.message ?? '') ||
        'Data Lineage could not complete this request.';
      // Provider text can echo prompt content, so error level carries enumerated fields only.
      this.logger.error(
        `[${session.id}] native turn terminal request=${requestId} status=error stop=${result.failure?.stop ?? 'none'}` +
          ` modelCalls=${result.modelCalls} elapsedMs=${Date.now() - turnStartedAt}`,
        `code=${result.failure?.code ?? 'none'}`,
      );
      this.logger.debug(
        `[${session.id}] native turn failure message: ${message}`,
      );
      return { metadata, errorDetails: { message } };
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
      this.statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      this.statusBarItem.name = 'Lineage AI';
      this.statusBarItem.tooltip = 'Data Lineage AI is processing a request';
      this.context.subscriptions.push(this.statusBarItem);
    }
    this.activeTurns += 1;
    this.statusBarUpdate(label);
    this.statusBarItem.show();
  }

  private statusBarUpdate(label: string): void {
    if (this.statusBarItem)
      this.statusBarItem.text = `$(sync~spin) Lineage AI: ${label}`;
  }

  private statusBarStop(): void {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    if (this.activeTurns === 0) this.statusBarItem?.hide();
  }

  /** Performs one chat-stream write, degrading to a no-op when the stream can no longer take it. */
  private write(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    write: (stream: vscode.ChatResponseStream) => void,
  ): void {
    if (token.isCancellationRequested) return;
    try {
      write(stream);
    } catch (error) {
      if (!token.isCancellationRequested && !isStreamClosedError(error))
        throw error;
      this.logger.debug(
        'chat stream write skipped — stream closed or turn cancelled',
      );
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
        if (event.recoverable !== false)
          stream.markdown(`\n\n${event.message}`);
        return;
      case 'gate': {
        const proposal = this.getSession().pendingExploration;
        if (!proposal) return;
        this.cardRequestId = requestId;
        stream.markdown(
          `${GATE_CARD_HEADER}${renderScopeCardMd(proposal)}${HOLD_GATE_NOTICE}\n\n`,
        );
        this.writeGateButtons(stream, event.proposalId);
        return;
      }
      case 'terminal': {
        const session = this.getSession();
        // Native chat may collapse older responses. Keep a held plan actionable on this answer.
        const heldId = this.sessionHoldsGateProposal()
          ? session.pendingExploration?.proposalId
          : undefined;
        if (
          event.status === 'ok' &&
          heldId !== undefined &&
          this.cardRequestId !== requestId
        ) {
          this.writeGateButtons(stream, heldId);
        }
        if (
          event.status === 'ok' &&
          session.presentResultCalledThisTurn &&
          !session.presentResultAutoDispatched &&
          session.resultGraph
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

  /** The approval card's three buttons, bound to the card they resolve. */
  private writeGateButtons(
    stream: vscode.ChatResponseStream,
    proposalId: string,
  ): void {
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(check) Approve & Proceed',
      arguments: [proposalId, 'approve'],
    });
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(edit) Change scope',
      arguments: [proposalId, 'change'],
    });
    stream.button({
      command: 'dataLineageViz.aiResumeNativeGate',
      title: '$(close) Cancel',
      arguments: [proposalId, 'cancel'],
    });
  }

  private followups(result?: vscode.ChatResult): vscode.ChatFollowup[] {
    const session = this.getSession();
    if (this.sessionHoldsGateProposal()) {
      return result?.metadata?.[FULL_PLAN_SHOWN] === true
        ? []
        : [
            {
              prompt: SHOW_FULL_PLAN_TRIGGER,
              label: vscode.l10n.t('Show full plan'),
            },
          ];
    }
    const followups: vscode.ChatFollowup[] = [];
    if (session.phase.kind === 'completed') {
      followups.push({
        prompt: NEXT_QUESTIONS_TRIGGER,
        label: vscode.l10n.t('Next questions and related objects'),
      });
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
  return (
    error instanceof Error &&
    /stream.*closed|closed.*stream/i.test(error.message)
  );
}

function normalizeFollowupTrigger(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
