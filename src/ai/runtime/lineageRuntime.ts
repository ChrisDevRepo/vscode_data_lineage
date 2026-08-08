import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import type { Logger } from '../../utils/log';
import type { AgentFailureDetail } from '../host/agentRuntime';
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
import { readToolError, rejectionIssuePaths } from '../support/toolErrorEnvelope';

/** Immutable request identity, prompt, and optional history for one lineage turn. */
export interface LineageRuntimeRequest {
  readonly id: string;
  readonly prompt: string;
  readonly priorMessages?: readonly ModelMessage[];
}

/** Request-scoped dependencies required to execute one lineage turn. */
export interface LineageRuntimeRunInput {
  /** The exact native request model, already wrapped as a provider-neutral port. */
  readonly model: ModelPort;
  readonly request: LineageRuntimeRequest;
  readonly sink: TurnEventSink;
  readonly signal?: AbortSignal;
}

/** Terminal runtime outcome and provider-call accounting for one lineage turn. */
export interface LineageRuntimeResult {
  readonly outcome: TurnOutcome;
  readonly modelCalls: number;
  readonly failure?: AgentFailureDetail;
}

/** Long-lived dependencies used to construct request-scoped lineage turns. */
export interface LineageRuntimeDeps {
  readonly getSession: () => AiSession;
  /** Builds the strict direct-dispatch registry for the captured turn lease. */
  readonly createRegistry: (lease: TurnLease) => IToolRegistry<string>;
  readonly logger?: Logger;
  readonly maxRounds?: number;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly traceWriter?: AiTraceWriter;
}

/**
 * Single production facade for native lineage turns.
 *
 * The facade owns turn setup and active-request coordination. The outer
 * LangGraph owns phase/hop routing and `AgentRuntime` owns interrupt/resume and
 * the one terminal event.
 */
export class LineageRuntime {
  private readonly active = new Map<string, {
    readonly runtime: AgentRuntime;
    readonly completed: Promise<void>;
  }>();

  public constructor(private readonly deps: LineageRuntimeDeps) {}

  /**
   * Executes one request against a captured session epoch and request-selected model.
   *
   * @throws When the same session/request identifier is already active.
   */
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
    const registry = this.deps.createRegistry(lease);
    const instrumentedRegistry = this.deps.traceWriter
      ? instrumentRegistry(registry, {
          writer: this.deps.traceWriter,
          requestId: input.request.id,
          runFingerprint,
          currentPhase: () => phase,
          nextSequence: () => ++toolSequence,
        })
      : registry;
    const runtime = new AgentRuntime({
      threadId: requestKey,
      getSession: this.deps.getSession,
      model: input.model,
      registry: instrumentedRegistry,
      sink: input.sink,
      signal: input.signal,
      maxRounds: this.deps.maxRounds,
      turnEpoch,
      checkpointer: this.deps.checkpointer,
      priorMessages: input.request.priorMessages ?? session.getDiscoveryHistory(),
      logger: this.deps.logger,
    });
    let completeRun!: () => void;
    const completed = new Promise<void>((resolve) => { completeRun = resolve; });
    const activeRun = { runtime, completed };
    this.active.set(requestKey, activeRun);
    this.writeLifecycle({
      type: 'turn-start',
      requestId: input.request.id,
      runFingerprint,
      sessionFingerprint: fingerprint(session.id),
      modelFingerprint: fingerprint(input.model.identity.id),
    });

    try {
      const outcome = await runtime.run(input.request.prompt);
      // `reason`/`errorCode` come from the failure detail the runtime already exposes to callers —
      // enumerated values only, never the failure prose, so the lifecycle contract holds. Without
      // them a turn that ends on a tool rejection is untraceable: the rejection text reaches the
      // wire only as the tool result replayed into the next request, and there is no next request.
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
      // Native ChatContext history is the production participant's sole cross-turn conversation
      // owner. The session transcript remains only as a direct-runtime compatibility seam and must
      // not retain a second, stale copy after a native turn.
      if (input.request.priorMessages !== undefined) session.clearDiscoveryTranscript();
      eventObserver.dispose();
      completeRun();
      if (this.active.get(requestKey) === activeRun) this.active.delete(requestKey);
    }
  }

  /** Routes a consent decision and resolves after its owning turn reaches terminal state. */
  public async resumeGate(gateId: string, decision: GateDecision): Promise<boolean> {
    const matchingRuns: Promise<void>[] = [];
    for (const activeRun of this.active.values()) {
      if (activeRun.runtime.resumeGate(gateId, decision)) matchingRuns.push(activeRun.completed);
    }
    if (matchingRuns.length === 0) return false;
    await Promise.all(matchingRuns);
    return true;
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
    invoke: async (name, payload) => {
      const startedAt = performance.now();
      const sequence = instrumentation.nextSequence();
      const base = {
        type: 'tool' as const,
        requestId: instrumentation.requestId,
        runFingerprint: instrumentation.runFingerprint,
        seq: sequence,
        phase: instrumentation.currentPhase(),
        toolName: name,
      };
      try {
        const result = await registry.invoke(name, payload);
        const rejection = parseRejection(result);
        const issuePaths = rejection ? rejectionIssuePaths(rejection.detail) : [];
        void instrumentation.writer.write({
          ...base,
          status: rejection ? 'rejected' : 'accepted',
          ...(rejection ? { rejectionCode: rejection.code } : {}),
          ...(issuePaths.length > 0 ? { issuePaths } : {}),
          durationMs: elapsedMs(startedAt),
        }).catch(() => {});
        return result;
      } catch (error) {
        void instrumentation.writer.write({
          ...base,
          status: 'dispatch_error',
          rejectionCode: 'tool_execution_error',
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
