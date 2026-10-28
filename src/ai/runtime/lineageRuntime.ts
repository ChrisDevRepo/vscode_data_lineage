import { createHash } from 'node:crypto';
import type { Logger } from '../../utils/log';
import type { AgentFailureDetail } from '../host/agentRuntime';
import { modelUserMessage } from '../model/modelPort';
import { AgentRuntime } from '../host/agentRuntime';
import type {
  ModelMessage,
  ModelPort,
} from '../model/modelPort';
import type { AiTraceWriter } from '../observability/aiTraceWriter';
import type { AiSession } from '../session/session';
import type { TurnLease } from '../session/turnLease';
import type { IToolRegistry } from '../tools/registry';
import type { TurnEventSink } from './turnEventSink';
import type { GateDecision } from '../agent/state';
import type { TurnOutcome } from '../core/agentCore';
import type { ToolRejection } from '../support/toolErrorEnvelope';
import { CLARIFICATION_WINDOW_MS, readToolError, isAdmissionRefusal, isConsentGateRejection } from '../support/toolErrorEnvelope';
import type { SyntheticRejectionTrace } from '../agent/toolAttempt';
import { REJECTION_CODES } from '../support/rejectionCodes';

/** Immutable request identity, prompt, and optional history for one lineage turn. */
interface LineageRuntimeRequest {
  /** Request identifier; must be unique among this session's currently active turns. */
  readonly id: string;
  /** Verbatim user prompt for this turn. */
  readonly prompt: string;
  /** Optional prior-turn conversation, oldest first; when present the session transcript is cleared after the turn. */
  readonly priorMessages?: readonly ModelMessage[];
  /** The approval-card click this turn answers, when it was started by one. */
  readonly gateDecision?: GateDecision;
}

/** Request-scoped dependencies required to execute one lineage turn. */
interface LineageRuntimeRunInput {
  /** The exact native request model, already wrapped as a provider-neutral port. */
  readonly model: ModelPort;
  /** Request identity, prompt, and optional history for this turn. */
  readonly request: LineageRuntimeRequest;
  /** Native event sink that receives this turn's events and its one terminal result. */
  readonly sink: TurnEventSink;
  /** Optional abort signal cancelling the turn; rides the captured turn lease. */
  readonly signal?: AbortSignal;
}

/** Terminal runtime outcome and provider-call accounting for one lineage turn. */
interface LineageRuntimeResult {
  /** Terminal status of the turn. */
  readonly outcome: TurnOutcome;
  /** Provider calls attempted through the request's model port. */
  readonly modelCalls: number;
  /** Diagnostic detail when the turn ended other than `ok`. */
  readonly failure?: AgentFailureDetail;
}

/** Long-lived dependencies used to construct request-scoped lineage turns. */
interface LineageRuntimeDeps {
  /** Session accessor for the {@link AiSession} singleton. */
  readonly getSession: () => AiSession;
  /** Builds the strict direct-dispatch registry for the captured turn lease and request model. */
  readonly createRegistry: (lease: TurnLease, model: ModelPort) => IToolRegistry<string>;
  /** Optional logger forwarded to the agent runtime. */
  readonly logger?: Logger;
  /** Optional per-turn model-step cap forwarded to the agent runtime. */
  readonly maxRounds?: number;
  /** Optional trace writer receiving this runtime's lifecycle and tool records. */
  readonly traceWriter?: AiTraceWriter;
}

/** Single production facade for native lineage turns. */
export class LineageRuntime {
  private readonly active = new Set<string>();

  public constructor(private readonly deps: LineageRuntimeDeps) {}

  /** Generates suggestions from compact facts without tools, history replay or session mutation. */
  public async runSuggestions(input: LineageRuntimeRunInput): Promise<LineageRuntimeResult> {
    const session = this.deps.getSession();
    const runFingerprint = fingerprint(`${session.id}:${input.request.id}`);
    const startedAt = performance.now();
    this.writeLifecycle({
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
    this.writeLifecycle({
      type: 'turn-terminal',
      requestId: input.request.id,
      runFingerprint,
      status: outcome,
      modelCalls: input.model.modelCalls,
      durationMs: elapsedMs(startedAt),
    });
    input.sink.result(outcome);
    return { outcome, modelCalls: input.model.modelCalls, ...(result.status === 'error'
      ? { failure: { message: result.error } } : {}) };
  }

  /** Executes one request against a captured session epoch and request-selected model. */
  public async run(input: LineageRuntimeRunInput): Promise<LineageRuntimeResult> {
    const session = this.deps.getSession();
    const requestKey = `${session.id}:${input.request.id}`;
    if (this.active.has(requestKey)) {
      throw new Error(`LineageRuntime: request ${input.request.id} is already active.`);
    }

    const turnEpoch = session.beginTurn();
    session.beginTurnState();
    session.modelName = input.model.identity.name;
    const lease: TurnLease = Object.freeze({
      sessionId: session.id,
      epoch: turnEpoch,
      signal: input.signal ?? new AbortController().signal,
    });
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
    const registry = this.deps.createRegistry(lease, input.model);
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
    const traceSyntheticRejection = traceWriter
      ? (rejection: Parameters<SyntheticRejectionTrace>[0]): void => {
          void traceWriter.write({
            type: 'tool',
            requestId: input.request.id,
            runFingerprint,
            seq: ++toolSequence,
            phase,
            ...(rejection.callId ? { callId: rejection.callId } : {}),
            toolName: rejection.toolName,
            status: rejection.status,
            rejectionCode: rejection.code,
            clarificationWindowMs: CLARIFICATION_WINDOW_MS,
            ...(rejection.issuePaths?.length ? { issuePaths: rejection.issuePaths } : {}),
            durationMs: 0,
          }).catch(() => {});
        }
      : undefined;
    const runtime = new AgentRuntime({
      threadId: requestKey,
      requestId: input.request.id,
      getSession: this.deps.getSession,
      model: input.model,
      registry: instrumentedRegistry,
      sink: input.sink,
      signal: input.signal,
      maxRounds: this.deps.maxRounds,
      turnEpoch,
      priorMessages: input.request.priorMessages ?? session.getDiscoveryHistory(),
      logger: this.deps.logger,
      traceSyntheticRejection,
    });
    this.active.add(requestKey);
    this.writeLifecycle({
      type: 'turn-start',
      requestId: input.request.id,
      runFingerprint,
      sessionFingerprint: fingerprint(session.id),
      modelFingerprint: fingerprint(input.model.identity.id),
    });

    try {
      const outcome = await runtime.run(input.request.prompt, input.request.gateDecision);
      const failure = runtime.lastFailureDetail;
      this.writeLifecycle({
        type: 'turn-terminal',
        requestId: input.request.id,
        runFingerprint,
        status: outcome,
        ...(failure?.stop ? { reason: failure.stop } : {}),
        ...(failure?.code ? { errorCode: failure.code } : {}),
        modelCalls: input.model.modelCalls,
        durationMs: elapsedMs(startedAt),
      });
      return {
        outcome,
        modelCalls: input.model.modelCalls,
        ...(runtime.lastFailureDetail
          ? { failure: runtime.lastFailureDetail }
          : {}),
      };
    } finally {
      if (input.request.priorMessages !== undefined) session.clearDiscoveryTranscript();
      eventObserver.dispose();
      this.active.delete(requestKey);
    }
  }

  private writeLifecycle(
    record: Parameters<NonNullable<LineageRuntimeDeps['traceWriter']>['write']>[0],
  ): void {
    if (!this.deps.traceWriter) return;
    void this.deps.traceWriter.write(record).catch(() => {});
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
    invoke: async (name, payload, callId) => {
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
        const result = await registry.invoke(name, payload, callId);
        const rejection = parseRejection(result);
        const issuePaths = rejection?.issuePaths ?? [];
        void instrumentation.writer.write({
          ...base,
          status: !rejection
            ? 'accepted'
            : isConsentGateRejection(rejection.code) ? 'gate'
              : isAdmissionRefusal(rejection.code) ? 'refused' : 'rejected',
          ...(rejection && !isConsentGateRejection(rejection.code) ? { rejectionCode: rejection.code, clarificationWindowMs: CLARIFICATION_WINDOW_MS } : {}),
          ...(issuePaths.length > 0 ? { issuePaths } : {}),
          ...(rejection?.missingParts?.length ? { missingParts: rejection.missingParts, feedbackAt: rejection.feedbackAt } : {}),
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

function parseRejection(result: string): ToolRejection | null {
  try {
    const parsed: unknown = JSON.parse(result);
    return readToolError(parsed);
  } catch {
    return null;
  }
}
