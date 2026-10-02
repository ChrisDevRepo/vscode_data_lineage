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
import { Logger } from '../../src/utils/log';
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

/**
 * How one gate round is answered.
 *
 * @remarks
 * `--gate` supplies an ordered, comma-separated list of these; round *N* of a turn is answered by
 * entry *N*, clamped to the last entry once the list is exhausted, so a trailing `approve` or `deny`
 * terminates any further round without needing one entry per possible gate.
 */
export type GateRoundPolicy =
  | { readonly kind: 'approve'; readonly expect?: string }
  | { readonly kind: 'deny' }
  | { readonly kind: 'refine'; readonly instruction: string };

/**
 * Evaluates one `approve:<expect>` assertion against the pending proposal.
 *
 * @param expr - `[!]<field>~<substring>` for membership, or `<field>=<number>` for a count.
 * @param session - The session carrying `pendingExploration` at gate time.
 * @returns Whether the proposal satisfies the assertion.
 * @remarks
 * The gate is where the proposal becomes binding, so an expectation is checked here rather than on
 * the finished graph: approving a proposal that contradicts the instruction and then scoring the
 * result conflates a wrong proposal with a wrongly accepted one.
 */
export function evaluateGateExpectation(expr: string, session: AiSession): boolean {
  const proposal = session.pendingExploration;
  if (!proposal) return false;
  const negated = expr.startsWith('!');
  const body = negated ? expr.slice(1) : expr;

  const countMatch = /^([A-Za-z]+)=(\d+)$/.exec(body);
  if (countMatch) {
    const counts: Record<string, number | undefined> = {
      scopeCount: proposal.summary.scopeCount,
      hopCount: proposal.summary.hopCount,
    };
    const actual = counts[countMatch[1]];
    const ok = actual !== undefined && actual === Number(countMatch[2]);
    return negated ? !ok : ok;
  }

  const hasMatch = /^([A-Za-z]+)~(.+)$/.exec(body);
  if (!hasMatch) throw new Error(`--gate expect "${expr}" is invalid. Use field~substring or field=count.`);
  const [, field, needle] = hasMatch;
  const init = proposal.init as unknown as Record<string, unknown>;
  const raw = init[field];
  const values = Array.isArray(raw) ? raw.map((v) => String(v)) : raw === undefined ? [] : [String(raw)];
  const ok = values.some((v) => v.toLowerCase().includes(needle.toLowerCase()));
  return negated ? !ok : ok;
}

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
   * How each consent gate this turn raises is answered, in round order.
   *
   * @remarks
   * A run-level policy, not a human-in-the-loop decision: the harness has no human to ask, and a
   * lane that silently varied its answer between otherwise-identical runs would make them
   * incomparable. Round *N* (1-based) is answered by `gate[N-1]`, clamped to the last entry once the
   * list is exhausted. Defaults to a single `approve` entry.
   */
  readonly gate?: readonly GateRoundPolicy[];
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

/** One consent gate and the decision the run policy applied to it. */
export interface HarnessGateDecision {
  readonly gateId: string;
  readonly gate: string;
  readonly decision: 'approve' | 'deny' | 'refine';
  /** The refine instruction sent, present only when `decision` is `'refine'`. */
  readonly instruction?: string;
  /**
   * The `approve:<expect>` assertion evaluated at this gate, and whether the proposal satisfied it.
   * A failed expectation is answered `deny`, so the run records a refusal at the gate instead of
   * measuring a graph nobody would have approved.
   */
  readonly expectation?: { readonly expr: string; readonly ok: boolean };
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
  if (options.uiState !== undefined) {
    options.session.uiState = options.uiState;
    const buffer = options.uiState as Record<string, unknown>;
    if ('renderState' in buffer) options.session.renderState = buffer.renderState;
    if ('filter' in buffer) options.session.filter = buffer.filter as AiSession['filter'];
    if (buffer.graphMode === 'full' || buffer.graphMode === 'overview') options.session.graphMode = buffer.graphMode;
    if (typeof buffer.filteredCount === 'number') options.session.filteredCount = buffer.filteredCount;
  }
  const bookmarkId = bookmarkIdFromUiState(options.uiState);
  const storedRun = options.storedRun;
  const requestId = options.requestId ?? randomUUID();
  const gatePolicy: readonly GateRoundPolicy[] =
    options.gate && options.gate.length > 0 ? options.gate : [{ kind: 'approve' }];
  const events: TurnEvent[] = [];
  const gates: HarnessGateDecision[] = [];
  let gateRound = 0;
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
        model,
        budget: model.budget,
        signal: lease.signal,
        ...(storedRun ? { getStoredRun: (id: string) => (id === bookmarkId ? storedRun : undefined) } : {}),
      },
    ),
    // Without this the graph's `deps.logger` is undefined, so every debugLog in
    // toolAttempt.ts is optional-chained away and four rejection codes
    // (invalid_tool_input, missing_required_tool_call, duplicate_read,
    // empty_generation) are counted in run.json but never written to host.log.
    // The product wires the same logger at extensionRuntime.ts; only the harness
    // omitted it, which made those rejections diagnosable solely from the NDJSON
    // trace. Observability only — no tool, score, or answer path is affected.
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
    if (event.type !== 'gate') return;
    const round = gatePolicy[Math.min(gateRound, gatePolicy.length - 1)];
    gateRound += 1;
    // A proposal that contradicts the instruction is what a user refuses at the gate, so the harness
    // refuses it too rather than approving and scoring the graph that follows.
    const expectation = round.kind === 'approve' && round.expect !== undefined
      ? { expr: round.expect, ok: evaluateGateExpectation(round.expect, options.session) }
      : undefined;
    const decision = expectation && !expectation.ok ? 'deny' : round.kind;
    gates.push({
      gateId: event.gateId,
      gate: event.gate,
      decision,
      ...(round.kind === 'refine' ? { instruction: round.instruction } : {}),
      ...(expectation ? { expectation } : {}),
    });
    if (expectation && !expectation.ok) {
      options.logger.error(
        `[harness] gate ${event.gate} expectation FAILED (${expectation.expr}) — denying instead of approving`,
      );
    }
    options.logger.info(
      `[harness] gate ${event.gate} → ${decision}${round.kind === 'refine' ? `: ${round.instruction}` : ''}`
      + (expectation ? ` [expect ${expectation.expr} ${expectation.ok ? 'ok' : 'FAILED'}]` : ''),
    );
    // FIRE-AND-FORGET, never awaited. `resumeGate` resolves only after the owning turn reaches its
    // terminal state, and this callback runs inside that turn — awaiting it here deadlocks the turn
    // that is waiting for the decision being made.
    void runtime.resumeGate(
      event.gateId,
      decision === 'approve'
        ? { kind: 'approve', classes: [] }
        : decision === 'refine'
          ? { kind: 'refine', refine: { instruction: (round as { instruction: string }).instruction } }
          : { kind: 'cancel' },
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
