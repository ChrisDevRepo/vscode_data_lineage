import { createHash } from 'node:crypto';
import type { Logger } from '../../utils/log';
import type { AgentFailureDetail } from '../host/agentRuntime';
import { modelUserMessage } from '../model/modelPort';
import { AgentRuntime } from '../host/agentRuntime';
import type { ModelPort } from '../model/modelPort';
import type { AiTraceWriter } from '../observability/aiTraceWriter';
import type { AiSession } from '../session/session';
import type { IToolRegistry } from '../tools/registry';
import type { TurnEventSink } from './turnEventSink';
import type { GateDecision } from '../agent/state';
import type { SyntheticRejectionTrace } from '../agent/toolAttempt';
import type { TurnOutcome } from '../core/agentCore';
import { readToolErrorText, isConsentGateRejection } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { describeTurnStop } from '../support/text';

/** Immutable request identity and input for one lineage turn. */
interface LineageRuntimeRequest {
  /** Request identifier; must be unique among this session's currently active turns. */
  readonly id: string;
  /** Prompt sent to the model for this turn. */
  readonly prompt: string;
  /** Explicit post-discovery action supplied by the host. */
  readonly executionTrigger?: 'run_trace';
}

/** Request-scoped dependencies required to execute one lineage turn. */
export interface LineageRuntimeRunInput {
  /** The exact request model, already wrapped as a provider-neutral port. */
  readonly model: ModelPort;
  readonly request: LineageRuntimeRequest;
  /** Event sink that receives this turn's events and its one terminal result. */
  readonly sink: TurnEventSink;
  /** Optional abort signal cancelling the turn. */
  readonly signal?: AbortSignal;
}

/** Terminal runtime outcome and provider-call accounting for one lineage turn. */
export type LineageRuntimeResult = {
  /** Provider calls attempted through the request's model port. */
  readonly modelCalls: number;
} & (
  | { readonly outcome: Exclude<TurnOutcome, 'error'> }
  /** An error outcome always carries its rendered stop. */
  | { readonly outcome: 'error'; readonly failure: AgentFailureDetail }
);

/** Long-lived dependencies used to construct request-scoped lineage turns. */
export interface LineageRuntimeDeps {
  /** Session accessor for the {@link AiSession} singleton. */
  readonly getSession: () => AiSession;
  /** Builds the turn's direct-dispatch registry for its model and cancel signal. */
  readonly createRegistry: (model: ModelPort, signal: AbortSignal | undefined) => IToolRegistry<string>;
  readonly logger?: Logger;
  /** Optional per-turn model-step cap forwarded to the agent runtime. */
  readonly maxRounds?: number;
  /** Optional trace writer receiving this runtime's lifecycle and tool records. */
  readonly traceWriter?: AiTraceWriter;
  readonly clearPreview?: () => void;
}

/**
 * Single production facade for lineage turns: owns turn setup and active-request
 * coordination, while the outer LangGraph owns phase/hop routing and `AgentRuntime` owns
 * interrupt/resume and the one terminal event.
 */
export class LineageRuntime {
  /** The turn in flight; the chat host runs one turn at a time. */
  private activeRun: { readonly runtime: AgentRuntime; readonly completed: Promise<void> } | undefined;

  public constructor(private readonly deps: LineageRuntimeDeps) {}

  /**
   * Generates suggestions from compact facts without tools, history replay or session mutation.
   * Writes the same `turn-start`/`turn-terminal` lifecycle pair as {@link run}, so the trace joins
   * this turn's wire records to a turn like any other request.
   */
  public async runSuggestions(input: LineageRuntimeRunInput): Promise<LineageRuntimeResult> {
    const session = this.deps.getSession();
    const runFingerprint = fingerprint(`${session.id}:${input.request.id}`);
    const startedAt = performance.now();
    void this.writeLifecycle({
      type: 'turn-start',
      requestId: input.request.id,
      runFingerprint,
      sessionFingerprint: fingerprint(session.id),
      modelFingerprint: fingerprint(input.model.identity.id),
    });
    const result = await input.model.generateToolTurn({
      messages: [modelUserMessage(input.request.prompt)], tools: [], toolChoice: 'none',
      phase: 'suggestions', signal: input.signal,
      onTextDelta: text => input.sink.stream(text),
    });
    const outcome = result.status === 'completed' ? 'ok' : result.status;
    await this.writeLifecycle({
      type: 'turn-terminal',
      requestId: input.request.id,
      runFingerprint,
      status: outcome,
      modelCalls: input.model.modelCalls,
      durationMs: elapsedMs(startedAt),
    });
    const modelCalls = input.model.modelCalls;
    if (result.status !== 'error') {
      input.sink.result(outcome);
      return { outcome: result.status === 'completed' ? 'ok' : result.status, modelCalls };
    }
    const message = describeTurnStop(result.turnStop, input.model.identity.name);
    input.sink.fail(message);
    return { outcome: 'error', modelCalls, failure: { message, turnStop: result.turnStop } };
  }

  /** Executes one request with its request-selected model. */
  public async run(input: LineageRuntimeRunInput): Promise<LineageRuntimeResult> {
    const session = this.deps.getSession();
    const requestKey = `${session.id}:${input.request.id}`;

    session.beginTurnState();
    session.modelName = input.model.identity.name;
    const startedAt = performance.now();
    const runFingerprint = fingerprint(requestKey);
    let phase = 'turn';
    let toolSequence = 0;
    const eventObserver = input.sink.addObserver((event, sequence) => {
      if (event.type === 'status') phase = event.phase;
      else if (event.type === 'gate') phase = event.gate;
      this.writeEvent(
        input.request.id,
        runFingerprint,
        sequence,
        event,
        elapsedMs(startedAt),
      );
    });
    const registry = this.deps.createRegistry(input.model, input.signal);
    const traceWriter = this.deps.traceWriter;
    const instrumentedRegistry = traceWriter
      ? instrumentRegistry(registry, {
          writer: traceWriter,
          requestId: input.request.id,
          runFingerprint,
          currentPhase: () => phase,
          nextSequence: () => ++toolSequence,
        })
      : registry;
    const traceSyntheticRejection: SyntheticRejectionTrace | undefined = traceWriter
      ? (rejection): void => {
          void traceWriter.write({
            type: 'tool',
            requestId: input.request.id,
            runFingerprint,
            seq: ++toolSequence,
            phase,
            ...(rejection.callId ? { callId: rejection.callId } : {}),
            toolName: rejection.toolName,
            status: rejection.status ?? 'rejected',
            rejectionCode: rejection.code,
            durationMs: 0,
          }).catch(() => {});
        }
      : undefined;
    const runtime = new AgentRuntime({
      threadId: requestKey,
      getSession: this.deps.getSession,
      model: input.model,
      registry: instrumentedRegistry,
      sink: input.sink,
      signal: input.signal,
      maxRounds: this.deps.maxRounds,
      priorMessages: session.getDiscoveryHistory(),
      logger: this.deps.logger,
      traceSyntheticRejection,
      clearPreview: this.deps.clearPreview,
    });
    let completeRun!: () => void;
    const completed = new Promise<void>((resolve) => { completeRun = resolve; });
    const activeRun = { runtime, completed };
    this.activeRun = activeRun;
    void this.writeLifecycle({
      type: 'turn-start',
      requestId: input.request.id,
      runFingerprint,
      sessionFingerprint: fingerprint(session.id),
      modelFingerprint: fingerprint(input.model.identity.id),
    });

    try {
      const outcome = await runtime.run(input.request.prompt, input.request.executionTrigger);
      const failure = runtime.lastFailureDetail;
      // The append chain is serial: awaiting the terminal record makes every earlier record durable
      // before the turn settles, so a host that exits right after the turn keeps the trace tail.
      await this.writeLifecycle({
        type: 'turn-terminal',
        requestId: input.request.id,
        runFingerprint,
        status: outcome,
        ...(failure?.stop ? { reason: failure.stop } : {}),
        ...(failure?.code ? { errorCode: failure.code } : {}),
        modelCalls: input.model.modelCalls,
        durationMs: elapsedMs(startedAt),
      });
      // Only an error close records a failure, and every error close records one.
      return failure ? { outcome: 'error', modelCalls: input.model.modelCalls, failure }
        : { outcome: outcome === 'cancelled' ? 'cancelled' : 'ok', modelCalls: input.model.modelCalls };
    } finally {
      eventObserver.dispose();
      completeRun();
      this.activeRun = undefined;
    }
  }

  /** Delivers a consent decision to the running turn and resolves once that turn ends. */
  public async resumeGate(gateId: string, decision: GateDecision): Promise<boolean> {
    const active = this.activeRun;
    if (!active || !active.runtime.resumeGate(gateId, decision)) return false;
    await active.completed;
    return true;
  }

  private writeLifecycle(
    record: Parameters<NonNullable<LineageRuntimeDeps['traceWriter']>['write']>[0],
  ): Promise<void> {
    return (this.deps.traceWriter?.write(record) ?? Promise.resolve()).catch(() => {});
  }

  private writeEvent(
    requestId: string,
    runFingerprint: string,
    sequence: number,
    event: Parameters<NonNullable<LineageRuntimeDeps['traceWriter']>['writeTurnEvent']>[3],
    elapsed: number,
  ): void {
    if (!this.deps.traceWriter) return;
    void this.deps.traceWriter
      .writeTurnEvent(requestId, runFingerprint, sequence, event, elapsed)
      .catch(() => {});
  }
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

interface RegistryInstrumentation {
  readonly writer: AiTraceWriter;
  readonly requestId: string;
  readonly runFingerprint: string;
  readonly currentPhase: () => string;
  readonly nextSequence: () => number;
}

function instrumentRegistry(
  registry: IToolRegistry<string>,
  instrumentation: RegistryInstrumentation,
): IToolRegistry<string> {
  return {
    register: (tool) => registry.register(tool),
    getTools: () => registry.getTools(),
    get: (name) => registry.get(name),
    has: (name) => registry.has(name),
    invoke: async (name, payload, callId, context) => {
      const startedAt = performance.now();
      const sequence = instrumentation.nextSequence();
      const base = {
        type: 'tool' as const,
        requestId: instrumentation.requestId,
        runFingerprint: instrumentation.runFingerprint,
        seq: sequence,
        phase: instrumentation.currentPhase(),
        ...(callId ? { callId } : {}),
        toolName: name,
      };
      try {
        const result = await registry.invoke(name, payload, callId, context);
        const rejection = readToolErrorText(result);
        const issuePaths = rejection?.issuePaths ?? [];
        void instrumentation.writer.write({
          ...base,
          status: rejection
            ? (isConsentGateRejection(rejection.code) ? 'gate' : 'rejected')
            : 'accepted',
          ...(rejection ? { rejectionCode: rejection.code } : {}),
          ...(issuePaths.length > 0 ? { issuePaths } : {}),
          durationMs: elapsedMs(startedAt),
        }).catch(() => {});
        return result;
      } catch (error) {
        void instrumentation.writer.write({
          ...base,
          status: 'dispatch_error',
          rejectionCode: REJECTION_CODES.toolExecutionError,
          durationMs: elapsedMs(startedAt),
        }).catch(() => {});
        throw error;
      }
    },
  };
}
