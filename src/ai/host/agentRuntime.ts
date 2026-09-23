/**
 * Host wrapper for the production native LangGraph runtime.
 *
 * @remarks
 * LangGraph owns workflow state, conditional routing, and consent interrupts. Its checkpointing is
 * in-process only: `buildAgentGraph` compiles against a fresh in-memory saver per graph. That is
 * enough to pause at a consent interrupt and resume through `Command({ resume })` **within a single
 * turn**, and nothing more — the saver dies with the runtime, so no state survives a host restart or
 * even outlives the turn that created it. Cross-turn state is `AiSession`, by design:
 * `docs/ARCHITECTURE.md` §Memory and state ownership.
 *
 * This host wrapper owns only platform-facing turn lifecycle: `thread_id`, native gate event
 * emission, user resume delivery, cancellation, and the single terminal result the
 * {@link TurnEventSink} claims exactly once (`sink.result` / `sink.fail`).
 */

import { randomUUID } from 'node:crypto';
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';
import {
  modelUserMessage,
  isPortCancellation,
  type ModelMessage,
  type ModelPort,
} from '../model/modelPort';
import { isCancellationOutcome } from '../support/cancellation';
import type { IToolRegistry } from '../tools/registry';
import type { Logger } from '../../utils/log';
import type { TurnEventSink } from '../runtime/turnEventSink';
import type { TurnOutcome } from '../core/agentCore';
import type { AiSession } from '../session/session';
import { PendingGateSchema, type PendingGate } from '../session/sessionPhase';
import { buildAgentGraph, turnRecursionLimit } from '../agent/graph';
import type { SyntheticRejectionTrace } from '../agent/toolAttempt';
import { PREVIEW_REQUEST_MARKER, TRACE_REQUEST_MARKER } from '../prompting/prompts';
import type { AgentStateUpdate, AgentErrorCode, GateDecision } from '../agent/state';
import { DEFAULT_MAX_ROUNDS } from '../core/agentCore';

export { type GateDecision } from '../agent/state';

/** Diagnostic detail behind a non-`ok` {@link TurnOutcome}. */
export interface AgentFailureDetail {
  /** Error prose behind the non-`ok` outcome — graph-state error or the caught exception message. */
  readonly message: string;
  /** Enumerated {@link AgentErrorCode} when the failure carries one. */
  readonly code?: AgentErrorCode;
  /** Engine stop reason when the turn ended on a stop rather than a hard failure. */
  readonly stop?: string;
}

/** Construction dependencies for {@link AgentRuntime}. */
export interface AgentRuntimeDeps {
  /** LangGraph thread id for this request; a fresh value per turn, never reused across turns. */
  readonly threadId: string;
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
  /** Per-phase max LM step count; defaults to 50. */
  readonly maxRounds?: number;
  /**
   * Turn-ownership epoch captured for this turn (from {@link AiSession.beginTurn}).
   *
   * @remarks
   * Threaded to the graph and into {@link AgentRuntime.close}'s `enterIdle` so a superseded "zombie"
   * turn cannot force-idle the session a newer turn now owns.
   */
  readonly turnEpoch: number;
  /**
   * Prior-turn discovery conversation, oldest first, for cross-turn chat memory.
   *
   * @remarks
   * Seeded ahead of the current prompt so discovery answers can reference earlier turns.
   * Rides in `messages` (after the cached `system` prefix) so prompt caching is preserved.
   * Empty/omitted on the first turn.
   */
  readonly priorMessages?: readonly ModelMessage[];
  /** Optional logger for graph-attempt diagnostics; forwarded to the graph. Off when undefined. */
  readonly logger?: Logger;
  /**
   * Optional trace sink for rejections raised without a tool dispatch; forwarded to the graph.
   *
   * @remarks
   * Undefined unless the host enabled the diagnostic trace.
   */
  readonly traceSyntheticRejection?: SyntheticRejectionTrace;
}

/**
 * Environment flags that make LangChain construct a LangSmith tracer.
 *
 * @remarks
 * `@lineage` has no external telemetry integration. Failing closed keeps that
 * boundary explicit without importing or declaring LangSmith as an application
 * dependency, and without mutating process-wide environment variables shared
 * with the extension host.
 */
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
  private readonly threadId: string;
  private readonly getSession: () => AiSession;
  private readonly sink: TurnEventSink;
  private readonly signal: AbortSignal | undefined;
  /** Effective per-turn hop limit — `deps.maxRounds` or {@link DEFAULT_MAX_ROUNDS} when omitted. */
  public readonly maxRounds: number;
  /** Diagnostic detail behind the most recent non-`ok` {@link close}. */
  public lastFailureDetail: AgentFailureDetail | undefined;
  private readonly priorMessages: readonly ModelMessage[];
  /** This turn's ownership epoch — carried into guarded session writes so a zombie turn is a no-op. */
  private readonly turnEpoch: number;
  private readonly logger: Logger | undefined;
  private readonly graph: ReturnType<typeof buildAgentGraph>;
  private readonly pendingGates = new Map<string, (d: GateDecision) => void>();

  constructor(deps: AgentRuntimeDeps) {
    this.threadId = deps.threadId;
    this.getSession = deps.getSession;
    this.sink = deps.sink;
    this.signal = deps.signal;
    this.maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.priorMessages = deps.priorMessages ?? [];
    this.turnEpoch = deps.turnEpoch;
    this.logger = deps.logger;
    this.graph = buildAgentGraph({
      getSession: deps.getSession,
      model: deps.model,
      registry: deps.registry,
      sink: deps.sink,
      signal: deps.signal,
      maxRounds: this.maxRounds,
      turnEpoch: deps.turnEpoch,
      logger: deps.logger,
      traceSyntheticRejection: deps.traceSyntheticRejection,
    });
  }

  /** Runs one user prompt through the graph, handling each LangGraph consent interrupt. */
  public async run(prompt: string): Promise<TurnOutcome> {
    const session = this.getSession();
    session.currentRoundId += 1;
    session.currentTurnPrompt = prompt.startsWith(PREVIEW_REQUEST_MARKER) || prompt.startsWith(TRACE_REQUEST_MARKER)
      ? null
      : prompt;
    try {
      let input: AgentStateUpdate | Command = this.priorMessages.length > 0
        ? { prompt, messages: [...this.priorMessages, modelUserMessage(prompt)] }
        : { prompt };
      const config = {
        configurable: { thread_id: this.threadId },
        callbacks: [],
        recursionLimit: turnRecursionLimit(this.maxRounds),
      };

      for (;;) {
        if (this.signal?.aborted) return this.close('cancelled');
        assertExternalTracingDisabled();
        const result = await this.graph.invoke(input as never, config);
        const interruptPayload = extractInterruptPayload(result);
        if (interruptPayload !== null) {
          const gate = PendingGateSchema.parse(interruptPayload);
          const decision = await this.waitForGateDecision(gate);
          input = new Command({ resume: decision });
          continue;
        }
        if (this.signal?.aborted) return this.close('cancelled');

        const state = result as {
          outcome?: TurnOutcome | null;
          error?: string | null;
          errorCode?: AgentErrorCode | null;
          activeStop?: string | null;
        };
        const outcome: TurnOutcome = state.outcome ?? (state.error ? 'error' : 'ok');
        return this.close(outcome, state.error ?? undefined, { code: state.errorCode ?? undefined, stop: state.activeStop ?? undefined });
      }
    } catch (err) {
      if (isCancellationOutcome(err, this.signal) || isPortCancellation(err)) {
        this.logger?.debug('[AI] turn aborted — closed as cancelled');
        return this.close('cancelled');
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error('[AI] LangGraph turn', err);
      return this.close('error', msg);
    }
  }

  /** Resolves a pending consent gate with the user's decision. */
  public resumeGate(gateId: string, decision: GateDecision): boolean {
    const resume = this.pendingGates.get(gateId);
    if (!resume) return false;
    resume(decision);
    return true;
  }

  private async waitForGateDecision(gate: PendingGate): Promise<GateDecision> {
    const gateId = randomUUID();
    return await new Promise<GateDecision>((resolve) => {
      const finish = (decision: GateDecision) => {
        this.pendingGates.delete(gateId);
        this.signal?.removeEventListener('abort', abort);
        resolve(decision);
      };
      const abort = () => finish({ kind: 'cancel' });
      this.pendingGates.set(gateId, finish);
      if (this.signal?.aborted) {
        abort();
        return;
      }
      this.signal?.addEventListener('abort', abort, { once: true });
      this.sink.gate({
        gateId,
        gate: gate.gate,
        summary: gate.detail,
        classes: gate.classes,
      });
    });
  }

  private close(status: TurnOutcome, error?: string, detail?: { readonly code?: AgentErrorCode; readonly stop?: string }): TurnOutcome {
    let claimed: boolean;
    let sinkFailure: { readonly cause: unknown } | undefined;
    try {
      claimed = status === 'error' && error
        ? this.sink.fail(error)
        : this.sink.result(status, error);
    } catch (cause) {
      claimed = true;
      sinkFailure = { cause };
    }
    if (!claimed) return this.sink.terminalStatus ?? status;

    this.lastFailureDetail = status !== 'ok' && error ? { message: error, code: detail?.code, stop: detail?.stop } : undefined;
    if (status === 'cancelled' || status === 'error') {
      const sess = this.getSession();
      if (sess.phase.kind === 'exploring' || sess.phase.kind === 'awaiting_gate') {
        const outcome = sess.enterIdle(this.turnEpoch);
        if (outcome.kind === 'dropped_stale_turn') {
          this.logger?.debug(`[AI] stale-turn write dropped — op=${outcome.op} captured=${outcome.captured} current=${outcome.current}`);
        }
      }
    }
    if (sinkFailure) throw sinkFailure.cause;
    return status;
  }
}

/** Reads the gate payload from a compiled-graph interrupt using the official LangGraph helpers. */
function extractInterruptPayload(output: unknown): unknown | null {
  if (!isInterrupted(output)) return null;
  const interrupts = output[INTERRUPT];
  return interrupts.length > 0 ? (interrupts[0].value ?? null) : null;
}
