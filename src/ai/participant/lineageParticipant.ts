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
  RUN_TRACE_TRIGGER,
  SHOW_FULL_DESCRIPTION_TRIGGER,
  SHOW_GRAPH_PREVIEW_TRIGGER,
  expandRunTracePrompt,
  expandShowGraphPreviewPrompt,
} from '../prompting/prompts';
import { TurnEventSink, type TurnEvent } from '../runtime/turnEventSink';
import type { AiSession } from '../session/session';
import { sanitizeDescriptionForChat, sanitizeProviderError } from '../support/text';
import {
  DEFAULT_DISCOVERY_NODE_CAP,
  DEFAULT_DISCOVERY_TOKEN_BUDGET,
  DEFAULT_EXPLORATION_NODE_CAP,
  DEFAULT_EXPLORATION_TOKEN_BUDGET,
  DISCOVERY_WINDOW_SHARE,
  EXPLORATION_WINDOW_SHARE,
  setExplorationNodeCap,
  setExplorationTokenBudget,
} from '../support/tokenBudget';
import {
  setDiscoveryNodeCap,
  setDiscoveryTokenBudget,
} from '../tools/tools';
import {
  applyNativeChatBoundary,
  chatHistoryToModelMessages,
} from './chatHistoryAdapter';

interface PendingNativeGate {
  readonly gateId: string;
  readonly gate: string;
  resolving: boolean;
}

const STALE_GATE_ACTION_MESSAGE =
  'Data Lineage: This scope approval action is no longer active. Use the latest approval card.';

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
      provideFollowups: () => this.followups(),
    };

    this.context.subscriptions.push(
      participant,
      vscode.commands.registerCommand(
        'dataLineageViz.aiResumeNativeGate',
        (
          gateId: string,
          decision: 'approve' | 'cancel',
          classes: string[] = [],
        ) => {
          const pending = this.requirePendingGate(gateId, decision);
          if (!pending) return;
          this.submitGateDecision(
            pending,
            gateId,
            decision === 'approve'
              ? { kind: 'approve', classes }
              : { kind: 'cancel' },
            decision,
          );
        },
      ),
      vscode.commands.registerCommand(
        'dataLineageViz.aiChangeOrCancelNativeGate',
        async (gateId: string) => {
          const pending = this.requirePendingGate(gateId, 'change', 'confirm_sm_start');
          if (!pending) return;
          pending.resolving = true;

          const choice = await vscode.window.showInformationMessage(
            'Data Lineage: Change the pending scope or cancel the exploration?',
            'Change scope',
            'Cancel',
          );
          if (choice === undefined) {
            if (this.pendingGate === pending) pending.resolving = false;
            return;
          }

          if (choice === 'Cancel') {
            if (this.pendingGate !== pending) return;
            this.submitGateDecision(pending, gateId, { kind: 'cancel' }, 'cancel');
            return;
          }

          const instruction = await vscode.window.showInputBox({
            prompt: 'Change the pending exploration scope',
            placeHolder: 'Remove DimCalendar, exclude staging objects, focus on dbo, ...',
            ignoreFocusOut: true,
          });
          const normalized = instruction?.trim();
          if (!normalized) {
            if (this.pendingGate === pending) pending.resolving = false;
            return;
          }

          if (this.pendingGate !== pending) return;
          this.submitGateDecision(pending, gateId, {
            kind: 'refine',
            refine: { instruction: normalized },
          }, 'change');
        },
      ),
    );
  }

  /** Returns the current gate or reports why a stale/replaced native button was ignored. */
  private requirePendingGate(
    gateId: string,
    action: 'approve' | 'cancel' | 'change',
    requiredGate?: string,
  ): PendingNativeGate | null {
    const pending = this.pendingGate;
    if (
      pending?.gateId === gateId
      && !pending.resolving
      && (requiredGate === undefined || pending.gate === requiredGate)
    ) return pending;

    notifyWarning(
      this.logger,
      'Native gate action ignored',
      STALE_GATE_ACTION_MESSAGE,
      {
        action,
        requestedGateId: gateId,
        requiredGate,
        pendingGateId: pending?.gateId ?? 'none',
        pendingGate: pending?.gate ?? 'none',
      },
    );
    return null;
  }

  /** Submits one validated gate action and restores the card if the owning runtime disappeared. */
  private submitGateDecision(
    pending: PendingNativeGate,
    gateId: string,
    decision: Parameters<LineageRuntime['resumeGate']>[1],
    action: 'approve' | 'cancel' | 'change',
  ): void {
    pending.resolving = true;
    this.pendingGate = null;
    void this.runtime.resumeGate(gateId, decision).then((resolved) => {
      if (resolved || this.pendingGate !== null) return;
      pending.resolving = false;
      this.pendingGate = pending;
      notifyWarning(
        this.logger,
        'Native gate action ignored',
        STALE_GATE_ACTION_MESSAGE,
        { action, requestedGateId: gateId },
      );
    }).catch((error) => {
      if (this.pendingGate === null) {
        pending.resolving = false;
        this.pendingGate = pending;
      }
      notifyWarning(
        this.logger,
        'Native gate action failed',
        'Data Lineage: The approval action could not be completed. The existing proposal is still pending.',
        { action, requestedGateId: gateId, error },
      );
    });
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

    if (this.pendingGate && session.phase.kind === 'awaiting_gate') {
      // While a native choice/input is open, every duplicate gate action is rejected.
      const waitMessage = this.pendingGate.resolving
        ? '_The pending approval action is already being resolved._'
        : '_This analysis is waiting for the pending native gate action. Use one of its native buttons._';
      this.write(stream, token, (out) => out.markdown(waitMessage));
      return {};
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
    // Token budgets recalibrate per turn to the selected model: the setting is a ceiling and the
    // model's input window bounds the share — a small BYOK window shrinks both budgets with it.
    const modelWindow = request.model.maxInputTokens > 0
      ? request.model.maxInputTokens
      : Number.POSITIVE_INFINITY;
    setDiscoveryNodeCap(
      config.get<number>('ai.discoveryNodeCap', DEFAULT_DISCOVERY_NODE_CAP),
    );
    setDiscoveryTokenBudget(Math.min(
      config.get<number>('ai.discoveryTokenBudget', DEFAULT_DISCOVERY_TOKEN_BUDGET),
      Math.floor(modelWindow * DISCOVERY_WINDOW_SHARE),
    ));
    setExplorationNodeCap(
      config.get<number>('ai.explorationNodeCap', DEFAULT_EXPLORATION_NODE_CAP),
    );
    setExplorationTokenBudget(Math.min(
      config.get<number>('ai.explorationTokenBudget', DEFAULT_EXPLORATION_TOKEN_BUDGET),
      Math.floor(modelWindow * EXPLORATION_WINDOW_SHARE),
    ));

    const requestId = randomUUID();
    const cancellation = tokenToAbortSignal(token);
    const traceWriter = this.traceWriter?.isEnabled() ? this.traceWriter : undefined;
    const model = new VscodeModelPort(request.model, {
      debugLog: (message) => this.logger.debug(message),
      requestId,
      // Fire-and-forget: a debug capture must never delay or fail the turn, so only the failure
      // kind reaches the channel — never the record, which carries model content.
      wireLog: traceWriter && ((record) => {
        void traceWriter.write(record).catch(() => {});
      }),
      // Read once per turn: the capture level is fixed when the session command enables the trace.
      traceVerbose: traceWriter?.isVerbose(),
    });
    // The pill carries a short sentinel so chat can label it; expansion seeds the deterministic
    // marker the graph routes on, so the re-entry costs no entry-detector call.
    const prompt = request.command
      ? `/${request.command} ${request.prompt}`.trimEnd()
      : expandRunTracePrompt(expandShowGraphPreviewPrompt(request.prompt, session), session);
    const sink = new TurnEventSink(
      (event) => this.write(stream, token, (out) => this.writeEvent(event, out, request.prompt)),
    );
    this.logger.info(
      `[${session.id}] native turn start model=${request.model.id} command=${request.command ?? 'none'} history=${chatContext.history.length}`,
    );
    const priorMessages = chatHistoryToModelMessages(chatContext.history, (msg) => this.logger.debug(msg));

    this.statusBarStart('working…');
    try {
      const result = await this.runtime.run({
        model,
        request: { id: requestId, prompt, priorMessages },
        sink,
        signal: cancellation.signal,
      });
      this.logger.info(
        `[${session.id}] native turn terminal status=${result.outcome} modelCalls=${result.modelCalls}`,
      );
      const metadata = {
        requestId,
        status: result.outcome,
        modelCalls: result.modelCalls,
      };
      if (result.outcome !== 'error') return { metadata };

      const message = sanitizeProviderError(result.failure?.message ?? '')
        || 'Data Lineage could not complete this request.';
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
        // Terminal failures are returned through ChatResult.errorDetails so VS Code owns the
        // error presentation and Retry affordance. Recoverable guidance remains inline.
        if (event.recoverable !== false) stream.markdown(`\n\n${event.message}`);
        return;
      case 'gate':
        {
          this.pendingGate = {
            gateId: event.gateId,
            gate: event.gate,
            resolving: false,
          };
          const title = event.gate === 'confirm_sm_start'
            ? 'Confirm exploration'
            : 'Scope expansion requested';
          stream.markdown(`\n\n---\n**${title}**\n\n${event.summary}\n\n`);
        }
        stream.button({
          command: 'dataLineageViz.aiResumeNativeGate',
          title: '$(check) Approve & Proceed',
          arguments: [event.gateId, 'approve', event.classes ?? []],
        });
        if (event.gate === 'confirm_sm_start') {
          stream.button({
            command: 'dataLineageViz.aiChangeOrCancelNativeGate',
            title: '$(edit) Change scope / Cancel',
            arguments: [event.gateId],
          });
        } else {
          stream.button({
            command: 'dataLineageViz.aiResumeNativeGate',
            title: '$(close) Cancel',
            arguments: [event.gateId, 'cancel', event.classes ?? []],
          });
        }
        return;
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
        return;
      }
    }
  }

  private followups(): vscode.ChatFollowup[] {
    const session = this.getSession();
    const followups: vscode.ChatFollowup[] = [];
    if (session.phase.kind === 'completed') {
      followups.push({
        prompt: 'What related objects should I investigate next?',
        label: vscode.l10n.t('Explore related objects…'),
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
  return error instanceof Error && /stream.*closed|closed.*stream/i.test(error.message);
}

function normalizeFollowupTrigger(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
