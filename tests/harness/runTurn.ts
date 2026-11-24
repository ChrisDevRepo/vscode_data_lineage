/** Runs the production runtime with a simulated gate policy and writes ignored diagnostic artifacts. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPort } from '../../src/ai/model/modelPort';
import type { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import { LineageRuntime } from '../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../src/ai/runtime/turnEventSink';
import type { AiSession } from '../../src/ai/session/session';
import type { StoredAiRun } from '../../src/ai/session/runStore';
import type { NavigationEngine } from '../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../src/ai/tools/toolProvider';
import { DEFAULT_CONFIG } from '../../src/engine/types';
import { Logger } from '../../src/utils/log';
import { answerExpectation, gateRound, type GateExpectationReceipt, type GateRoundPolicy } from './gatePolicy';
import type { HeadlessLogChannel } from './headlessLogger';

/**
 * Reads `uiState.screenState.bookmark.id` out of a parsed `--ui-state` buffer.
 *
 * @remarks
 * The buffer is an opaque passthrough by contract (see `AiSession.uiState`), so every step is
 * defensive rather than typed — a foreign or malformed shape resolves to `undefined` instead of
 * throwing, matching how the production presenter itself treats the same buffer.
 */
function bookmarkIdFromUiState(uiState: unknown): string | undefined {
  if (typeof uiState !== 'object' || uiState === null) return undefined;
  const screenState = (uiState as Record<string, unknown>).screenState;
  if (typeof screenState !== 'object' || screenState === null) return undefined;
  const bookmark = (screenState as Record<string, unknown>).bookmark;
  if (typeof bookmark !== 'object' || bookmark === null) return undefined;
  const id = (bookmark as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** The answer of a run with no `--gate` list: every card is approved. */
const APPROVE: GateRoundPolicy = { kind: 'approve' };

type GateEvent = Extract<TurnEvent, { type: 'gate' }>;

/** Everything one headless turn needs; nothing here is VS Code specific. */
export interface HarnessTurnOptions {
  readonly session: AiSession;
  /** The lane's model port, supplied by its scripted or HTTP transport. */
  readonly model: ModelPort;
  readonly prompt: string;
  /** Directory the post-run artifacts are written to; created if absent. */
  readonly runDir: string;
  readonly logger: HeadlessLogChannel;
  readonly requestId?: string;
  readonly maxRounds?: number;
  /**
   * The run's gate rounds: card *N* is answered by `gate[N]`; a card past the list is held
   * unanswered.
   *
   * @remarks
   * A run-level policy, not a human-in-the-loop decision: the harness has no human to ask, and a
   * lane that silently varied its answer between otherwise-identical runs would make them
   * incomparable. Absent, every card is approved.
   */
  readonly gate?: readonly GateRoundPolicy[];
  /**
   * Cards the run's earlier turns answered: this turn's first card reads `gate[gateOffset]`, so
   * the list continues across follow-ups.
   */
  readonly gateOffset?: number;
  readonly signal?: AbortSignal;
  /** Session trace sink; when present the runtime writes lifecycle and tool records to it. */
  readonly traceWriter?: AiTraceWriter;
  /**
   * Parsed `--ui-state` buffer, assigned to `session.uiState` verbatim before the turn.
   *
   * @remarks
   * A top-level `renderState` key is additionally lifted onto `session.renderState`, and a
   * top-level `filter` key onto `session.filter` — mirroring the two extra webview messages a real
   * screen posts alongside `filter-changed`.
   */
  readonly uiState?: unknown;
  /**
   * Parsed `--stored-run` buffer. Resolved by `lineage_get_screen_state` only for the bookmark id
   * found at `uiState.screenState.bookmark.id`, matching how a real save keys one run per bookmark.
   */
  readonly storedRun?: StoredAiRun;
}

/** One gate round and the decision applied to its card (revised card when `mismatch` is set). */
interface HarnessGateDecision extends Pick<GateExpectationReceipt, 'expectation' | 'mismatch'> {
  readonly gateId: string;
  readonly gate: string;
  /** Index of the round in the gate list. */
  readonly policyIndex: number;
  readonly decision: GateRoundPolicy['kind'];
  /** The refine instruction sent, present only when `decision` is `'refine'`. */
  readonly instruction?: string;
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
  /** A card with no declared round was held open; the caller judges it. */
  readonly unansweredCard: boolean;
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
 * Executes one turn and dumps `sm-state.json`, `answer.md`, `present-result.json`, `final-snapshot.json`, `hop-log.json`.
 *
 * @param options - Session, model port, prompt, run directory, and gate policy.
 * @returns The terminal outcome plus the observed events, answer text, and artifact paths.
 */
export async function runHarnessTurn(options: HarnessTurnOptions): Promise<HarnessTurnResult> {
  mkdirSync(options.runDir, { recursive: true });
  if (options.uiState !== undefined) {
    options.session.uiState = options.uiState;
    const buffer = options.uiState as Record<string, unknown>;
    if ('renderState' in buffer) options.session.renderState = buffer.renderState;
    if ('filter' in buffer) options.session.filter = buffer.filter as AiSession['filter'];
    if (buffer.graphMode === 'full' || buffer.graphMode === 'overview') options.session.graphMode = buffer.graphMode;
  }
  const bookmarkId = bookmarkIdFromUiState(options.uiState);
  const storedRun = options.storedRun;
  const requestId = options.requestId ?? randomUUID();
  const events: TurnEvent[] = [];
  const gates: HarnessGateDecision[] = [];
  const answering: Promise<void>[] = [];
  /** Waits for the card an onMismatch Change revises: the next gate event, or `null` at turn end. */
  let revisedCard: ((gate: GateEvent | null) => void) | null = null;
  let unansweredCard = false;
  let text = '';
  let engine: NavigationEngine | null = null;

  const runtime = new LineageRuntime({
    getSession: () => options.session,
    createRegistry: (lease, model) => buildAiToolRegistry(
      () => options.session,
      options.logger as unknown as import('vscode').LogOutputChannel,
      () => undefined,
      lease,
      {
        analysisSettings: () => DEFAULT_CONFIG.analysis,
        model,
        budget: model.budget,
        signal: lease.signal,
        ...(storedRun ? { getStoredRun: (id: string) => (id === bookmarkId ? storedRun : undefined) } : {}),
      },
    ),
    // Without a logger the graph's `deps.logger` is undefined, so toolAttempt.ts debugLog calls
    // are optional-chained away and rejection codes are counted in run.json but never written to
    // host.log.
    logger: Logger.create(options.logger as unknown as import('vscode').LogOutputChannel, 'AI'),
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    ...(options.traceWriter ? { traceWriter: options.traceWriter } : {}),
  });

  const sink = new TurnEventSink((event) => {
    events.push(event);
    if (event.type === 'text') text += event.delta;
    if (!engine && options.session.stateMachine) {
      engine = options.session.stateMachine as NavigationEngine;
    }
    if (event.type === 'terminal') revisedCard?.(null);
    if (event.type !== 'gate') return;
    if (revisedCard) {
      revisedCard(event);
      return;
    }
    answering.push(answerCard(event));
  });

  /** Resolves a gate without awaiting it: `resumeGate` settles only after the owning turn reaches its terminal state, and
   * this runs inside that turn, so awaiting would deadlock the turn that is waiting for the decision being made. */
  const resume = (gateId: string, decision: Parameters<LineageRuntime['resumeGate']>[1]): void => {
    void runtime.resumeGate(gateId, decision).catch((error: unknown) => {
      options.logger.error(`[harness] gate resume failed: ${String(error)}`);
    });
  };

  /** Answers one card with the next declared round: a missed `expect` is recorded, never refused. */
  async function answerCard(event: GateEvent): Promise<void> {
    const policyIndex = (options.gateOffset ?? 0) + gates.length;
    const round = options.gate === undefined ? APPROVE : gateRound(options.gate, policyIndex);
    if (!round) {
      // `hold` ends the turn with the card open, as a user who leaves it: the caller sees `unansweredCard`.
      unansweredCard = true;
      options.logger.info(`[harness] gate ${event.gate} has no declared round ${policyIndex + 1} — held unanswered`);
      resume(event.gateId, { kind: 'hold' });
      return;
    }
    let gateId = event.gateId;
    const answered = await answerExpectation(round, () => options.session, async (instruction) => {
      const revised = new Promise<GateEvent | null>((resolve) => { revisedCard = resolve; });
      options.logger.info(`[harness] gate ${event.gate} expectation missed — sending the onMismatch Change: ${instruction}`);
      resume(gateId, { kind: 'refine', refine: { instruction } });
      const card = await revised;
      revisedCard = null;
      if (card) gateId = card.gateId;
    });
    const decision = answered.decision ?? round.kind;
    const instruction = answered.answer ?? (round.kind === 'refine' ? round.instruction : undefined);
    gates.push({
      gateId,
      gate: event.gate,
      policyIndex,
      decision,
      ...(instruction !== undefined ? { instruction } : {}),
      ...(answered.expectation ? { expectation: answered.expectation } : {}),
      ...(answered.mismatch ? { mismatch: answered.mismatch } : {}),
    });
    options.logger.info(
      `[harness] gate ${event.gate} round ${policyIndex + 1} → ${decision}${instruction !== undefined ? `: ${instruction}` : ''}`
      + (answered.expectation ? ` [expect ${answered.expectation.expr} ${answered.expectation.ok ? 'ok' : 'FAILED'}]` : ''),
    );
    // A Change that left no card was the round's last answer: nothing is left to resume.
    if (answered.decision) return;
    resume(gateId, round.kind === 'approve'
      ? { kind: 'approve', classes: [] }
      : round.kind === 'refine' ? { kind: 'refine', refine: { instruction: round.instruction } } : { kind: 'cancel' });
  }

  options.logger.info(`[harness] turn start request=${requestId} model=${options.model.identity.id}`);
  const outcome = await runtime.run({
    model: options.model,
    request: { id: requestId, prompt: options.prompt },
    sink,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await Promise.all(answering);
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

  // No result graph means no final graph, not an empty one: the file is absent.
  if (options.session.resultGraph) {
    writeArtifact(
      options.runDir,
      artifacts,
      'final-snapshot.json',
      JSON.stringify({
        nodes: options.session.resultGraph.nodeIds,
        columnEdges: options.session.stateMachine?.columnAspect?.edges ?? null,
      }, null, 2),
    );
  }

  const terminal = events.filter((event) => event.type === 'terminal');
  return {
    outcome,
    events,
    text,
    terminalStatus: terminal.length === 1 && terminal[0].type === 'terminal' ? terminal[0].status : null,
    gates,
    unansweredCard,
    artifacts,
  };
}
