/**
 * Host side of the own chat panel. The controller handles the validated frames of the docked chat
 * view, runs each user turn through `LineageRuntime` on the `ai.models` entry the user picked, and
 * posts the turn's events to the view. It holds no model state beyond the selection; cross-turn
 * memory is the session's own transcript.
 */
import { randomUUID } from 'node:crypto';
import { NO_MODEL_MESSAGE, type ChatToExtensionMsg, type ChatToWebviewMsg, type TurnEvent } from '../engine/shared/chatContract';
import { ModelPortError, type ModelPort } from '../ai/model/modelPort';
import { isClearCommand } from '../ai/agent/slashCommands';
import { expandNextQuestionSuggestions } from '../ai/prompting/followupSuggestions';
import { NEXT_QUESTIONS_TRIGGER, RUN_TRACE_TRIGGER, SHOW_FULL_DESCRIPTION_TRIGGER, expandRunTracePrompt } from '../ai/prompting/prompts';
import type { ProviderModelPortOptions } from '../ai/model/providerModelPort';
import type { AiTraceWriter } from '../ai/observability/aiTraceWriter';
import { parseModelEntries, type ModelEntry } from '../ai/providers/modelEntries';
import { createConfiguredModelPort, type ModelPortSources } from '../ai/providers/modelPortFactory';
import type { LineageRuntime } from '../ai/runtime/lineageRuntime';
import { TurnEventSink } from '../ai/runtime/turnEventSink';
import type { AiSession } from '../ai/session/session';
import { sanitizeDescriptionForChat } from '../ai/support/text';
import { calibrateTurnBudget } from '../ai/support/tokenBudget';
import { Logger, OUTPUT_POINTER } from '../utils/log';
import { notifyError, notifyWarningOnce } from '../utils/notifications';

/** Window in which streamed text deltas are merged into one frame. */
const TEXT_BATCH_MS = 75;

/** A trigger as the user may type it: case and spacing do not matter. */
const normalizeTrigger = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

/** The chat surface: the docked pane of the graph webview. */
export interface ChatView {
  /** Sends a frame to the view's webview. */
  post(msg: ChatToWebviewMsg): void;
}

/** What the controller needs from the host. */
export interface ChatHostDeps {
  readonly runtime: Pick<LineageRuntime, 'run' | 'runSuggestions' | 'resumeGate'>;
  readonly getSession: () => AiSession;
  /** Current `ai.models`, `ai.defaultModel` and SecretStorage; read afresh per use. */
  readonly modelSources: () => ModelPortSources;
  /** The `ai.*` numeric settings that size a turn. */
  readonly turnSettings: () => {
    readonly discoveryNodeCap: number;
    readonly discoveryTokenBudget: number;
    readonly maxRounds: number;
    readonly maxTraceColumns: number;
  };
  /** Runs the host's guided model command the view asked for: Add AI Model, or the Manage AI Models menu. */
  readonly runModelCommand: (command: Extract<ChatToExtensionMsg, { type: 'chat.modelCommand' }>['command']) => PromiseLike<unknown>;
  readonly logger: Logger;
  readonly showErrorMessage: (message: string) => unknown;
  readonly showWarningMessage: (message: string) => unknown;
  readonly traceWriter?: AiTraceWriter;
  /**
   * The port factory; replaced only by tests.
   * @internal
   */
  readonly createPort?: (
    sources: ModelPortSources,
    options: ProviderModelPortOptions & { readonly entryId?: string; readonly effort?: string },
  ) => Promise<ModelPort>;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly abort: AbortController;
  pendingGate?: { readonly gateId: string; readonly classes: readonly string[] };
  pendingText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  finish(): void;
  readonly done: Promise<void>;
}

/** Runs chat turns for the attached view. */
export class ChatController {
  private view: ChatView | undefined;
  /** Whether the view has sent `chat.ready`; a prompt from a view that has not is rejected. */
  private ready = false;
  private selectedModelId: string | undefined;
  private selectedEffort: string | undefined;
  private turn: ActiveTurn | undefined;

  public constructor(private readonly deps: ChatHostDeps) {}

  /**
   * Attaches the view; disposing the handle detaches it and ends the chat it showed: the turn is
   * aborted and the session reset, so a held approval proposal never outlives its card.
   */
  public attachView(view: ChatView): { dispose(): void } {
    this.view = view;
    this.ready = false;
    return {
      dispose: () => {
        if (this.view !== view) return;
        this.view = undefined;
        this.ready = false;
        this.deps.logger.debug(`[Chat] view closed — ending the chat${this.turn ? ` (aborting turn ${this.turn.turnId})` : ''}`);
        this.resetSession().catch((error: unknown) => this.deps.logger.error('Chat reset on view close', error));
      },
    };
  }

  /** Aborts a running turn; wired to extension shutdown. */
  public dispose(): void {
    this.turn?.abort.abort();
  }

  /** Re-sends the composer state after `ai.models` or `ai.defaultModel` changed. */
  public refresh(): void {
    this.post(this.stateMsg());
  }

  /** Handles one validated frame from the view. */
  public async receive(msg: ChatToExtensionMsg): Promise<void> {
    const { logger } = this.deps;
    switch (msg.type) {
      case 'chat.ready':
        this.ready = true;
        this.post(this.stateMsg());
        this.post({ type: 'chat.history', messages: this.deps.getSession().getDiscoveryTranscript() });
        return;
      case 'chat.send':
        if (!this.ready) {
          logger.debug('[Chat] send rejected — the view has not sent ready');
        } else if (isClearCommand(msg.text)) {
          // A host command, not a prompt: the same path as the New chat button, even mid-turn.
          await this.newChat();
        } else if (this.turn) {
          logger.debug('[Chat] send rejected — a turn is already running');
        } else {
          void this.runTurn(msg.text);
        }
        return;
      case 'chat.cancel':
        if (this.turn?.turnId !== msg.turnId) {
          logger.debug(`[Chat] cancel rejected — no running turn ${msg.turnId}`);
          return;
        }
        this.turn.abort.abort();
        return;
      case 'chat.gate':
        this.decideGate(msg);
        return;
      case 'chat.newChat':
        await this.newChat();
        return;
      case 'chat.modelCommand':
        Promise.resolve(this.deps.runModelCommand(msg.command)).catch((error: unknown) => logger.error('Chat model command', error));
        return;
      case 'chat.selectModel':
        if (!this.entries().entries.some((candidate) => candidate.id === msg.modelId)) {
          logger.debug(`[Chat] model selection rejected — unknown entry ${msg.modelId}`);
          return;
        }
        this.selectedModelId = msg.modelId;
        this.selectedEffort = undefined;
        this.post(this.stateMsg());
        return;
      case 'chat.selectEffort':
        if (!this.selectedEntry()?.supportsReasoningEffort?.includes(msg.effort)) {
          logger.debug(`[Chat] effort selection rejected — ${msg.effort} not offered by the selected entry`);
          return;
        }
        this.selectedEffort = msg.effort;
        this.post(this.stateMsg());
        return;
    }
  }

  private decideGate(msg: Extract<ChatToExtensionMsg, { type: 'chat.gate' }>): void {
    const turn = this.turn;
    const pending = turn?.pendingGate;
    if (turn?.turnId !== msg.turnId || pending?.gateId !== msg.gateId) {
      this.deps.logger.debug(`[Chat] gate decision rejected — turn=${msg.turnId} gate=${msg.gateId} is not pending`);
      return;
    }
    turn.pendingGate = undefined;
    const decision = msg.decision === 'approve'
      ? { kind: 'approve' as const, classes: [...pending.classes] }
      : msg.decision === 'refine'
        ? { kind: 'refine' as const, refine: { instruction: msg.text } }
        : { kind: 'cancel' as const };
    // Resolves when the turn ends, so it is not awaited here.
    this.deps.runtime.resumeGate(msg.gateId, decision)
      .then((resumed) => {
        if (!resumed) this.deps.logger.debug(`[Chat] gate ${msg.gateId} had no owning run`);
      })
      .catch((error: unknown) => this.deps.logger.error('Chat gate decision', error));
  }

  /** Aborts a running turn, waits for it to end, then starts a fresh session (memory, state machine, gate, results, transcript). */
  private async resetSession(): Promise<void> {
    if (this.turn) {
      this.turn.abort.abort();
      await this.turn.done;
    }
    this.deps.getSession().beginNativeChatSession();
  }

  private async newChat(): Promise<void> {
    await this.resetSession();
    this.post({ type: 'chat.history', messages: [] });
    this.post(this.stateMsg());
  }

  private async runTurn(prompt: string): Promise<void> {
    const { logger, getSession } = this.deps;
    const requestId = randomUUID();
    let finish!: () => void;
    const turn: ActiveTurn = {
      turnId: `${getSession().id}:${requestId}`,
      abort: new AbortController(),
      pendingText: '',
      finish: () => finish(),
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    this.turn = turn;
    this.post(this.stateMsg());
    const sink = new TurnEventSink((event) => this.onEvent(turn, event));
    const entry = this.selectedEntry();
    const session = getSession();
    const trigger = normalizeTrigger(prompt);
    let failure: unknown;
    try {
      if (trigger === normalizeTrigger(SHOW_FULL_DESCRIPTION_TRIGGER)) {
        sink.stream(session.lastPresentResultDescription
          ? sanitizeDescriptionForChat(session.lastPresentResultDescription)
          : '_No AI preview description is currently cached for this session._');
        sink.result('ok');
        return;
      }
      if (!entry) throw new ModelPortError('invalid_request', NO_MODEL_MESSAGE);
      const trace = this.deps.traceWriter?.isEnabled() ? this.deps.traceWriter : undefined;
      const port = await (this.deps.createPort ?? createConfiguredModelPort)(this.deps.modelSources(), {
        entryId: entry.id,
        effort: this.explicitEffort(entry),
        requestId,
        debugLog: (message) => logger.debug(message),
        wireLog: trace && ((record) => { void trace.write(record).catch(() => {}); }),
        traceVerbose: trace?.isVerbose(),
        budget: calibrateTurnBudget(entry.maxInputTokens, this.deps.turnSettings()),
      });
      // Next questions read compact facts on the tool-free suggestion path; the Run-trace sentinel
      // becomes the seeded envelope the graph routes to the hop-by-hop analysis.
      const suggestions = trigger === normalizeTrigger(NEXT_QUESTIONS_TRIGGER) && session.phase.kind === 'completed';
      const result = await (suggestions ? this.deps.runtime.runSuggestions : this.deps.runtime.run).call(this.deps.runtime, {
        model: port,
        request: { id: requestId, prompt: suggestions ? expandNextQuestionSuggestions(session) : expandRunTracePrompt(prompt, session) },
        sink,
        signal: turn.abort.signal,
      });
      logger.info(`[${getSession().id}] chat turn terminal status=${result.outcome} modelCalls=${result.modelCalls}`);
    } catch (error) {
      failure = error;
      sink.fail(error instanceof ModelPortError ? error.message : 'The assistant could not complete the request.');
    } finally {
      this.flushText(turn);
      if (sink.terminalStatus === 'error') {
        notifyError(
          logger,
          'Chat turn failed',
          `Data Lineage: the assistant could not finish — ${OUTPUT_POINTER}.`,
          failure,
          undefined,
          this.deps.showErrorMessage,
        );
      }
      this.turn = undefined;
      this.post(this.stateMsg());
      turn.finish();
    }
  }

  private onEvent(turn: ActiveTurn, event: TurnEvent): void {
    if (event.type === 'text') {
      turn.pendingText += event.delta;
      turn.flushTimer ??= setTimeout(() => this.flushText(turn), TEXT_BATCH_MS);
      return;
    }
    this.flushText(turn);
    if (event.type === 'gate') {
      turn.pendingGate = { gateId: event.gateId, classes: event.classes ?? [] };
      // A finished analysis is replaced when the user approves a new one.
      const replacesAnalysis = this.deps.getSession().resultGraph != null;
      this.post({ type: 'chat.event', turnId: turn.turnId, event, ...(replacesAnalysis ? { replacesAnalysis } : {}) });
      return;
    }
    if (event.type === 'terminal') turn.pendingGate = undefined;
    this.post({ type: 'chat.event', turnId: turn.turnId, event });
  }

  private flushText(turn: ActiveTurn): void {
    clearTimeout(turn.flushTimer);
    turn.flushTimer = undefined;
    if (turn.pendingText === '') return;
    const delta = turn.pendingText;
    turn.pendingText = '';
    this.post({ type: 'chat.event', turnId: turn.turnId, event: { type: 'text', delta } });
  }

  private post(msg: ChatToWebviewMsg): void {
    this.view?.post(msg);
  }

  private entries(): ReturnType<typeof parseModelEntries> {
    const read = parseModelEntries(this.deps.modelSources().models);
    if (read.invalid.length > 0) {
      notifyWarningOnce(
        this.deps.logger,
        'Chat model entries',
        `Data Lineage: ai.models entry ${read.invalid.map((entry) => `"${entry.name}"`).join(', ')} is invalid and not offered.`,
        undefined,
        this.deps.showWarningMessage,
      );
    }
    return read;
  }

  /** The entry the next turn runs on: the user's pick, else `ai.defaultModel`, else the first. */
  private selectedEntry(entries: readonly ModelEntry[] = this.entries().entries): ModelEntry | undefined {
    const byId = (id: string | undefined) => entries.find((entry) => entry.id === id);
    return byId(this.selectedModelId) ?? byId(this.deps.modelSources().defaultModel) ?? entries[0];
  }

  /** The user's effort pick while the selected entry still offers it. */
  private explicitEffort(entry: ModelEntry | undefined): string | undefined {
    return entry?.supportsReasoningEffort?.includes(this.selectedEffort ?? '') ? this.selectedEffort : undefined;
  }

  /** The follow-up buttons for the session as it stands; none while a turn runs or a gate is pending. */
  private followups(): { label: string; prompt: string }[] {
    const session = this.deps.getSession();
    if (this.turn || session.phase.kind === 'awaiting_gate') return [];
    return [
      ...(session.phase.kind === 'completed' ? [{ label: 'Next questions and related objects', prompt: NEXT_QUESTIONS_TRIGGER }] : []),
      ...(session.lastPresentResultDescription ? [{ label: 'Show full description', prompt: SHOW_FULL_DESCRIPTION_TRIGGER }] : []),
      ...(session.smOfferAvailable() ? [{ label: 'Start deeper hop-by-hop analysis', prompt: RUN_TRACE_TRIGGER }] : []),
    ];
  }

  private stateMsg(): ChatToWebviewMsg {
    const { entries } = this.entries();
    const selected = this.selectedEntry(entries);
    return {
      type: 'chat.state',
      models: entries.map(({ id, name, supportsReasoningEffort, reasoningEffort }) => (
        { id, name, supportsReasoningEffort, reasoningEffort }
      )),
      selectedModelId: selected?.id ?? '',
      effort: this.explicitEffort(selected) ?? selected?.reasoningEffort,
      busy: this.turn !== undefined,
      turnId: this.turn?.turnId,
      followups: this.followups(),
    };
  }
}
