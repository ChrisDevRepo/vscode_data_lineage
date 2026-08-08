/**
 * Runs one complete production turn headlessly and writes everything an analysis may read.
 *
 * @remarks
 * The whole `LineageRuntime.run` path — entry routing, phase nodes, the LangGraph consent interrupt,
 * the terminal event — because that path is the thing under measurement. Only two seams are used and
 * production uses both: `createRegistry` builds the canonical registry against the turn lease, and
 * the consent gate is resolved through `runtime.resumeGate`, the exact call
 * `LineageParticipant.submitGateDecision` makes for the native Approve button.
 *
 * `session.activatePendingExploration` is deliberately NOT called: doing so would skip
 * `approveGateNode`, the sole publisher of the navigation engine, and quietly bypass the invariant
 * the approve-gate design exists to hold.
 *
 * The model arrives as a {@link ModelPort} parameter rather than being constructed here. That is the
 * seam the later real-provider port plugs into unchanged — this module never learns which lane it is
 * driving.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPort } from '../../src/ai/model/modelPort';
import type { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import { LineageRuntime } from '../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../src/ai/runtime/turnEventSink';
import type { AiSession } from '../../src/ai/session/session';
import type { NavigationEngine } from '../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../src/ai/tools/toolProvider';
import type { HeadlessLogChannel } from './headlessLogger';

/** Everything one headless turn needs; nothing here is VS Code specific. */
export interface HarnessTurnOptions {
  readonly session: AiSession;
  /** The lane's model port — scripted today, an HTTP port later. */
  readonly model: ModelPort;
  readonly prompt: string;
  /** Directory the post-run artifacts are written to; created if absent. */
  readonly runDir: string;
  readonly logger: HeadlessLogChannel;
  readonly requestId?: string;
  readonly maxRounds?: number;
  /**
   * How every consent gate this turn raises is answered.
   *
   * @remarks
   * A run-level policy, not a per-gate decision: the harness has no human to ask, and a lane that
   * silently varied its answer between gates would make two runs incomparable.
   */
  readonly gate?: 'approve' | 'deny';
  readonly signal?: AbortSignal;
  /** Session trace sink; when present the runtime writes lifecycle and tool records to it. */
  readonly traceWriter?: AiTraceWriter;
}

/** One consent gate and the decision the run policy applied to it. */
export interface HarnessGateDecision {
  readonly gateId: string;
  readonly gate: string;
  readonly decision: 'approve' | 'deny';
}

/** Terminal outcome plus everything observable about the turn that produced it. */
export interface HarnessTurnResult {
  readonly outcome: Awaited<ReturnType<LineageRuntime['run']>>;
  readonly events: readonly TurnEvent[];
  /** Concatenated streamed deltas — the user-visible answer. */
  readonly text: string;
  /** Terminal status claimed by the sink, or `null` when no terminal event was emitted. */
  readonly terminalStatus: string | null;
  readonly gates: readonly HarnessGateDecision[];
  /** Absolute paths of the artifacts written, keyed by artifact name. */
  readonly artifacts: Readonly<Record<string, string>>;
}

function writeArtifact(
  runDir: string,
  artifacts: Record<string, string>,
  name: string,
  content: string,
): void {
  const path = join(runDir, name);
  writeFileSync(path, content, 'utf8');
  artifacts[name] = path;
}

/**
 * Executes one turn and dumps `sm-state.json`, `answer.md`, `present-result.json`, `hop-log.json`.
 *
 * @param options - Session, model port, prompt, run directory, and gate policy.
 * @returns The terminal outcome plus the observed events, answer text, and artifact paths.
 */
export async function runHarnessTurn(options: HarnessTurnOptions): Promise<HarnessTurnResult> {
  mkdirSync(options.runDir, { recursive: true });
  const requestId = options.requestId ?? randomUUID();
  const gatePolicy = options.gate ?? 'approve';
  const events: TurnEvent[] = [];
  const gates: HarnessGateDecision[] = [];
  let text = '';
  let engine: NavigationEngine | null = null;

  const runtime = new LineageRuntime({
    getSession: () => options.session,
    createRegistry: (lease) => buildAiToolRegistry(
      () => options.session,
      options.logger as unknown as import('vscode').LogOutputChannel,
      () => undefined,
      lease,
    ),
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    ...(options.traceWriter ? { traceWriter: options.traceWriter } : {}),
  });

  const sink = new TurnEventSink((event) => {
    events.push(event);
    if (event.type === 'text') text += event.delta;
    if (!engine && options.session.stateMachine) {
      engine = options.session.stateMachine as NavigationEngine;
    }
    if (event.type !== 'gate') return;
    gates.push({ gateId: event.gateId, gate: event.gate, decision: gatePolicy });
    options.logger.info(`[harness] gate ${event.gate} → ${gatePolicy}`);
    // FIRE-AND-FORGET, never awaited. `resumeGate` resolves only after the owning turn reaches its
    // terminal state, and this callback runs inside that turn — awaiting it here deadlocks the turn
    // that is waiting for the decision being made.
    void runtime.resumeGate(
      event.gateId,
      gatePolicy === 'approve' ? { kind: 'approve', classes: [] } : { kind: 'cancel' },
    ).catch((error: unknown) => {
      options.logger.error(`[harness] gate resume failed: ${String(error)}`);
    });
  });

  options.logger.info(`[harness] turn start request=${requestId} model=${options.model.identity.id}`);
  const outcome = await runtime.run({
    model: options.model,
    request: { id: requestId, prompt: options.prompt },
    sink,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // A post-run read catches an engine published by a node that emitted no further event.
  if (!engine && options.session.stateMachine) {
    engine = options.session.stateMachine as NavigationEngine;
  }
  options.logger.info(
    `[harness] turn terminal outcome=${outcome.outcome} modelCalls=${outcome.modelCalls}`,
  );

  const artifacts: Record<string, string> = {};
  writeArtifact(options.runDir, artifacts, 'answer.md', text);
  writeArtifact(options.runDir, artifacts, 'hop-log.json', JSON.stringify(options.session.hopLog, null, 2));
  // Absent rather than empty when the phase never ran: `sm-state.json` missing means "no exploration
  // happened", which a `{}` placeholder would hide behind a file that looks like a failed one.
  if (engine) {
    writeArtifact(options.runDir, artifacts, 'sm-state.json', JSON.stringify(engine.toJSON(), null, 2));
  }
  if (options.session.presentationArtifact) {
    writeArtifact(
      options.runDir,
      artifacts,
      'present-result.json',
      JSON.stringify(options.session.presentationArtifact, null, 2),
    );
  }

  const terminal = events.filter((event) => event.type === 'terminal');
  return {
    outcome,
    events,
    text,
    terminalStatus: terminal.length === 1 && terminal[0].type === 'terminal' ? terminal[0].status : null,
    gates,
    artifacts,
  };
}
