/** Host wrapper for the production native LangGraph runtime. */

import { GraphRecursionError } from '@langchain/langgraph';
import {
  modelUserMessage,
  isPortCancellation,
  type ModelMessage,
  type ModelPort,
} from '../model/modelPort';
import { isCancellationOutcome } from '../support/cancellation';
import {
  INTERNAL_INVARIANT_STOP_TEXT,
  InternalInvariantError,
} from '../support/internalInvariant';
import { trackInFlightDispatch, type IToolRegistry } from '../tools/registry';
import type { Logger } from '../../utils/log';
import type { TurnEventSink } from '../runtime/turnEventSink';
import type { TurnOutcome } from '../core/agentCore';
import type { AiSession } from '../session/session';
import { buildAgentGraph, turnRecursionLimit } from '../agent/graph';
import type { SyntheticRejectionTrace } from '../agent/toolAttempt';
import {
  PREVIEW_REQUEST_MARKER,
  TRACE_REQUEST_MARKER,
} from '../prompting/prompts';
import type {
  AgentStateUpdate,
  AgentErrorCode,
  GateDecision,
} from '../agent/state';
import { errorMessage } from '../../utils/errorMessage';

/** Diagnostic detail behind a non-`ok` {@link TurnOutcome}. */
export interface AgentFailureDetail {
  /** Error prose behind the non-`ok` outcome — graph-state error or the caught exception message. */
  readonly message: string;
  /** Enumerated {@link AgentErrorCode} when the failure carries one. */
  readonly code?: AgentErrorCode;
  /** Stop reason of the run: an engine stop, or `provider_error` when a model request failed. */
  readonly stop?: string;
}

/** Construction dependencies for {@link AgentRuntime}. */
interface AgentRuntimeDeps {
  /** Identity of this turn's graph run; the fallback request id of its debug logs. */
  readonly threadId: string;
  /** Host request id for correlated debug logs; falls back to this turn's thread id. */
  readonly requestId?: string;
  /** Session accessor — same singleton the toolProvider reads. */
  readonly getSession: () => AiSession;
  /** Provider-neutral model port for structured output, streaming, and tool calls. */
  readonly model: ModelPort;
  /** Text-adapted full registry; graph nodes filter it by phase. */
  readonly registry: IToolRegistry<string>;
  /** Native turn event sink. */
  readonly sink: TurnEventSink;
  /** Abort signal cancelling this turn; re-checked before every graph invoke and forwarded to the graph. */
  readonly signal?: AbortSignal;
  /** Hop limit for the turn; defaults to the turn budget's `ai.maxRounds` value. */
  readonly maxRounds?: number;
  /** Turn-ownership epoch captured for this turn (from {@link AiSession.beginTurn}). */
  readonly turnEpoch: number;
  /** Prior-turn discovery conversation, oldest first, for cross-turn chat memory. */
  readonly priorMessages?: readonly ModelMessage[];
  /** Optional logger for graph-attempt diagnostics; forwarded to the graph. Off when undefined. */
  readonly logger?: Logger;
  /** See the graph's `transportRetryDelayMs`; tests shorten it. */
  readonly transportRetryDelayMs?: number;
  /** Optional trace sink for rejections raised without a tool dispatch; forwarded to the graph. */
  readonly traceSyntheticRejection?: SyntheticRejectionTrace;
}

/** Environment flags that make LangChain construct a LangSmith tracer. */
const EXTERNAL_TRACING_FLAGS = [
  'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING',
  'LANGCHAIN_TRACING_V2',
] as const;

function assertExternalTracingDisabled(): void {
  const enabled = EXTERNAL_TRACING_FLAGS.filter((name) => {
    const value = process.env[name];
    if (value === undefined) return false;
    return name === 'LANGCHAIN_TRACING' || value.toLowerCase() === 'true';
  });
  if (enabled.length > 0) {
    throw new Error(
      `External LangChain tracing is not supported by @lineage; unset ${enabled.join(', ')}.`,
    );
  }
}

/** Production LangGraph runtime facade used by the native host path. */
export class AgentRuntime {
  private readonly getSession: () => AiSession;
  private readonly sink: TurnEventSink;
  private readonly signal: AbortSignal | undefined;
  /** Effective per-turn hop limit — `deps.maxRounds` or the turn budget's `ai.maxRounds` value when omitted. */
  public readonly maxRounds: number;
  /** Diagnostic detail behind the most recent non-`ok` {@link close}. */
  public lastFailureDetail: AgentFailureDetail | undefined;
  private readonly priorMessages: readonly ModelMessage[];
  /** This turn's ownership epoch — carried into guarded session writes so a zombie turn is a no-op. */
  private readonly turnEpoch: number;
  private readonly logger: Logger | undefined;
  private readonly graph: ReturnType<typeof buildAgentGraph>;
  /** Settle-await for every tool dispatch in flight through this turn's registry. */
  private readonly dispatchSettled: () => Promise<void>;

  constructor(deps: AgentRuntimeDeps) {
    this.getSession = deps.getSession;
    this.sink = deps.sink;
    this.signal = deps.signal;
    this.maxRounds = deps.maxRounds ?? deps.model.budget.exploration.maxRounds;
    this.priorMessages = deps.priorMessages ?? [];
    this.turnEpoch = deps.turnEpoch;
    this.logger = deps.logger;
    const tracked = trackInFlightDispatch(deps.registry);
    this.dispatchSettled = tracked.settled;
    this.graph = buildAgentGraph({
      getSession: deps.getSession,
      model: deps.model,
      registry: tracked.registry,
      sink: deps.sink,
      signal: deps.signal,
      turnEpoch: deps.turnEpoch,
      logger: deps.logger,
      requestId: deps.requestId ?? deps.threadId,
      traceSyntheticRejection: deps.traceSyntheticRejection,
      transportRetryDelayMs: deps.transportRetryDelayMs,
    });
  }

  /** Runs one user prompt through the graph; `gateDecision` is the card click this turn answers. */
  public async run(
    prompt: string,
    gateDecision?: GateDecision,
  ): Promise<TurnOutcome> {
    const session = this.getSession();
    session.currentRoundId += 1;
    session.currentTurnPrompt =
      prompt.startsWith(PREVIEW_REQUEST_MARKER) ||
      prompt.startsWith(TRACE_REQUEST_MARKER)
        ? null
        : prompt;
    try {
      const input: AgentStateUpdate = {
        prompt,
        ...(this.priorMessages.length > 0
          ? { messages: [...this.priorMessages, modelUserMessage(prompt)] }
          : {}),
        ...(gateDecision ? { gateDecision } : {}),
      };
      assertExternalTracingDisabled();
      const recursionLimit = turnRecursionLimit(
        this.maxRounds,
        session.stateMachine?.scopeSize ?? 0,
      );
      const result = await this.graph.invoke(input as never, {
        callbacks: [],
        signal: this.signal,
        recursionLimit,
      });
      if (this.signal?.aborted) {
        await this.dispatchSettled();
        return this.close('cancelled');
      }

      const state = result as {
        outcome?: TurnOutcome | null;
        error?: string | null;
        errorCode?: AgentErrorCode | null;
        activeStop?: string | null;
      };
      const outcome: TurnOutcome =
        state.outcome ?? (state.error ? 'error' : 'ok');
      return this.close(outcome, state.error ?? undefined, {
        code: state.errorCode ?? undefined,
        stop: state.activeStop ?? undefined,
      });
    } catch (err) {
      if (isCancellationOutcome(err, this.signal) || isPortCancellation(err)) {
        this.logger?.debug('[AI] turn aborted — closed as cancelled');
        await this.dispatchSettled();
        return this.close('cancelled');
      }
      this.logger?.error('[AI] LangGraph turn', err);
      if (err instanceof GraphRecursionError) {
        return this.close(
          'error',
          'Analysis stopped: internal step limit reached. The run is incomplete, so no result is shown and the graph was not changed. This is a defect — please report it.',
        );
      }
      // The message of a broken runtime invariant is written for the log, which already has it.
      if (err instanceof InternalInvariantError)
        return this.close('error', INTERNAL_INVARIANT_STOP_TEXT);
      const msg = errorMessage(err);
      return this.close('error', msg);
    }
  }

  private close(
    status: TurnOutcome,
    error?: string,
    detail?: { readonly code?: AgentErrorCode; readonly stop?: string },
  ): TurnOutcome {
    let claimed: boolean;
    let sinkFailure: { readonly cause: unknown } | undefined;
    try {
      claimed =
        status === 'error' && error
          ? this.sink.fail(error)
          : this.sink.result(status, error);
    } catch (cause) {
      claimed = true;
      sinkFailure = { cause };
    }
    if (!claimed) return this.sink.terminalStatus ?? status;

    this.lastFailureDetail =
      status !== 'ok' && error
        ? { message: error, code: detail?.code, stop: detail?.stop }
        : undefined;
    if (status === 'cancelled' || status === 'error') {
      const sess = this.getSession();
      // A proposal no card shows (a stopped scope change already replaced the plan) is not left for anyone to approve.
      const unshownProposal =
        sess.phase.kind === 'awaiting_gate' &&
        sess.pendingExploration?.proposalId === undefined;
      if (sess.phase.kind === 'exploring' || unshownProposal) {
        const outcome = sess.cancelPendingExploration(this.turnEpoch);
        if (outcome.kind === 'dropped_stale_turn') {
          this.logger?.debug(
            `[AI] stale-turn write dropped — op=${outcome.op} captured=${outcome.captured} current=${outcome.current}`,
          );
        }
      }
    }
    if (sinkFailure) throw sinkFailure.cause;
    return status;
  }
}
