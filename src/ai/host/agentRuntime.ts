/**
 * Host wrapper for the production native LangGraph runtime. LangGraph owns workflow state,
 * conditional routing and consent interrupts. Its checkpointing is in-process only
 * (`buildAgentGraph` compiles against a fresh in-memory saver per graph): enough to pause at a
 * consent interrupt and resume through `Command({ resume })` **within a single turn**, nothing
 * more; no state survives a host restart or outlives the turn. Cross-turn state is `AiSession` by
 * design.
 *
 * This wrapper owns only platform-facing turn lifecycle: `thread_id`, native gate event emission,
 * user resume delivery, cancellation, and the single terminal result the {@link TurnEventSink}
 * claims exactly once (`sink.result` / `sink.fail`).
 */

import { randomUUID } from 'node:crypto';
import { Command, GraphRecursionError, INTERRUPT, isInterrupted } from '@langchain/langgraph';
import {
  modelUserMessage,
  isPortCancellation,
  ModelPortError,
  classifyTurnStop,
  type ModelMessage,
  type ModelPort,
} from '../model/modelPort';
import { isCancellationOutcome } from '../support/cancellation';
import { describeTurnStop, sanitizeProviderErrorDiagnostic, type TurnStop } from '../support/text';
import { trackInFlightDispatch, type IToolRegistry } from '../tools/registry';
import type { Logger } from '../../utils/log';
import type { TurnEventSink } from '../runtime/turnEventSink';
import type { TurnOutcome } from '../core/agentCore';
import type { AiSession } from '../session/session';
import { PendingGateSchema, type PendingGate } from '../session/sessionPhase';
import { buildAgentGraph, turnRecursionLimit } from '../agent/graph';
import type { SyntheticRejectionTrace } from '../agent/toolAttempt';
import { PREVIEW_REQUEST_MARKER, TRACE_REQUEST_MARKER } from '../prompting/prompts';
import type { AgentStateUpdate, AgentErrorCode, GateDecision } from '../agent/state';

export { type GateDecision } from '../agent/state';

/** Diagnostic detail behind a non-`ok` {@link TurnOutcome}. */
export interface AgentFailureDetail {
  /** Chat text of the stop, rendered once by {@link describeTurnStop}. */
  readonly message: string;
  /** Source, code and phase of the stop; the content-free fields the error log line carries. */
  readonly turnStop: TurnStop;
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
  readonly sink: TurnEventSink;
  /** Abort signal cancelling this turn; re-checked before every graph invoke. */
  readonly signal?: AbortSignal;
  /** Hop limit for the turn; defaults to the turn budget's `ai.maxRounds` value. */
  readonly maxRounds?: number;
  /**
   * Turn-ownership epoch captured for this turn (from {@link AiSession.beginTurn}), threaded to the
   * graph and {@link AgentRuntime.close}'s `enterIdle` so a superseded "zombie" turn cannot
   * force-idle the session a newer turn owns.
   */
  readonly turnEpoch: number;
  /**
   * Prior-turn discovery conversation, oldest first, for cross-turn chat memory. Seeded ahead of
   * the current prompt and carried in `messages` (after the cached `system` prefix) so prompt
   * caching holds. Empty/omitted on the first turn.
   */
  readonly priorMessages?: readonly ModelMessage[];
  /** Optional logger for graph-attempt diagnostics; forwarded to the graph. Off when undefined. */
  readonly logger?: Logger;
  /**
   * Optional trace sink for rejections raised without a tool dispatch, forwarded to the graph;
   * undefined unless the host enabled the diagnostic trace.
   */
  readonly traceSyntheticRejection?: SyntheticRejectionTrace;
  readonly clearPreview?: () => void;
}

/**
 * Environment flags that make LangChain construct a LangSmith tracer. `@lineage` has no external
 * telemetry integration, so failing closed keeps that boundary explicit without declaring LangSmith
 * as a dependency or mutating process-wide environment variables shared with the extension host.
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
  /** Effective per-turn hop limit: `deps.maxRounds`, else the budget's `ai.maxRounds`. */
  public readonly maxRounds: number;
  /** Diagnostic detail behind the most recent non-`ok` {@link close}. */
  public lastFailureDetail: AgentFailureDetail | undefined;
  private readonly priorMessages: readonly ModelMessage[];
  /** This turn's ownership epoch, carried into guarded session writes so a zombie turn no-ops. */
  private readonly turnEpoch: number;
  private readonly logger: Logger | undefined;
  /** The turn's model; its display name labels a quoted provider message. */
  private readonly model: ModelPort;
  private readonly graph: ReturnType<typeof buildAgentGraph>;
  private readonly pendingGates = new Map<string, (d: GateDecision) => void>();
  /**
   * Settle-await for every tool dispatch in flight through this turn's registry. Awaited before
   * {@link close} on every cancellation path, so a mutating tool's effect (session write, engine
   * publish, panel render) finishes before the turn releases the lease, even when LangGraph's abort
   * race already rejected `graph.invoke` while the dispatching node still ran. See
   * {@link trackInFlightDispatch}.
   */
  private readonly dispatchSettled: () => Promise<void>;

  constructor(deps: AgentRuntimeDeps) {
    this.threadId = deps.threadId;
    this.getSession = deps.getSession;
    this.sink = deps.sink;
    this.signal = deps.signal;
    this.maxRounds = deps.maxRounds ?? deps.model.budget.exploration.maxRounds;
    this.priorMessages = deps.priorMessages ?? [];
    this.turnEpoch = deps.turnEpoch;
    this.logger = deps.logger;
    this.model = deps.model;
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
      traceSyntheticRejection: deps.traceSyntheticRejection,
      clearPreview: deps.clearPreview,
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
        signal: this.signal,
      };

      for (;;) {
        assertExternalTracingDisabled();
        // An approval turn builds the pending proposal's engine inside the graph; size by its scope.
        const recursionLimit = turnRecursionLimit(
          this.maxRounds,
          session.pendingExploration?.summary.scopeCount ?? session.stateMachine?.scopeSize ?? 0,
        );
        const result = await this.graph.invoke(input as never, { ...config, recursionLimit });
        const interruptPayload = extractInterruptPayload(result);
        if (interruptPayload !== null) {
          const gate = PendingGateSchema.parse(interruptPayload);
          const decision = await this.waitForGateDecision(gate);
          input = new Command({ resume: decision });
          continue;
        }
        if (this.signal?.aborted) {
          await this.dispatchSettled();
          return this.close('cancelled');
        }

        const state = result as {
          outcome?: TurnOutcome | null;
          error?: TurnStop | null;
          errorCode?: AgentErrorCode | null;
          activeStop?: string | null;
        };
        if (state.error) return this.close('error', state.error, { code: state.errorCode ?? undefined, stop: state.activeStop ?? undefined });
        // `fail` writes `outcome: 'error'` together with its `TurnStop`; one without is a graph
        // bug.
        if (state.outcome === 'error') throw new Error('Graph ended in error without a TurnStop.');
        return this.close(state.outcome ?? 'ok');
      }
    } catch (err) {
      if (isCancellationOutcome(err, this.signal) || isPortCancellation(err)) {
        this.logger?.debug('[AI] turn aborted — closed as cancelled');
        await this.dispatchSettled();
        return this.close('cancelled');
      }
      // The error line is the participant's; a thrown text or stack can echo content: debug only.
      if (!(err instanceof ModelPortError)) this.logger?.debug(`[AI] LangGraph turn failed — ${err instanceof Error ? err.stack : String(err)}`);
      const stop = classifyTurnStop(err, sanitizeProviderErrorDiagnostic(err, 'turn'));
      return this.close('error', err instanceof GraphRecursionError ? { ...stop, code: 'recursion_limit' } : stop);
    }
  }

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

  /**
   * Claims the turn's terminal; an error close always carries its `TurnStop`, rendered once
   * here.
   */
  private close(
    ...[status, error, detail]: [status: 'ok' | 'cancelled'] | [status: 'error', error: TurnStop, detail?: { readonly code?: AgentErrorCode; readonly stop?: string }]
  ): TurnOutcome {
    let claimed: boolean;
    let sinkFailure: { readonly cause: unknown } | undefined;
    const message = error && describeTurnStop(error, this.model.identity.name);
    try {
      claimed = message ? this.sink.fail(message) : this.sink.result(status);
    } catch (cause) {
      claimed = true;
      sinkFailure = { cause };
    }
    if (!claimed) return this.sink.terminalStatus ?? status;

    this.lastFailureDetail = error && message
      ? { message, turnStop: error, code: detail?.code, stop: detail?.stop }
      : undefined;
    if (status === 'cancelled' || status === 'error') {
      const sess = this.getSession();
      if (sess.phase.kind === 'exploring') {
        const outcome = sess.cancelPendingExploration(this.turnEpoch);
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
