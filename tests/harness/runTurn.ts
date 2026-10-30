/** Runs the production runtime with a simulated gate policy and writes ignored diagnostic artifacts. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelPort, ModelMessage } from '../../src/ai/model/modelPort';
import type { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import { LineageRuntime } from '../../src/ai/runtime/lineageRuntime';
import type { GateDecision } from '../../src/ai/agent/state';
import {
  TurnEventSink,
  type TurnEvent,
} from '../../src/ai/runtime/turnEventSink';
import type {
  AiSession,
  PendingExplorationProposal,
} from '../../src/ai/session/session';
import { isDeepStrictEqual } from 'node:util';
import {
  AiGateRefineSchema,
  type AiGateRefine,
} from '../../src/engine/shared/bridgeContract';
import { resolveDepthBorder } from '../../src/engine/shared/explorationDepthContract';
import type { StoredAiRun } from '../../src/ai/session/runStore';
import type { NavigationEngine } from '../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../src/ai/tools/toolProvider';
import { Logger } from '../../src/utils/log';
import type { HeadlessLogChannel } from './headlessLogger';

/** Removes the leading native participant mention; leaves command text and SQL unchanged. */
export function nativeHarnessPrompt(prompt: string): string {
  return prompt.replace(/^@lineage(?=\s|$)[ \t]?/u, '');
}

/** Reads `uiState.screenState.bookmark.id` out of a parsed `--ui-state` buffer. */
function bookmarkIdFromUiState(uiState: unknown): string | undefined {
  if (typeof uiState !== 'object' || uiState === null) return undefined;
  const screenState = (uiState as Record<string, unknown>).screenState;
  if (typeof screenState !== 'object' || screenState === null) return undefined;
  const bookmark = (screenState as Record<string, unknown>).bookmark;
  if (typeof bookmark !== 'object' || bookmark === null) return undefined;
  const id = (bookmark as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** How one gate round is answered. Exposed to the CLI via import types.
 * @public
 */
export type GateRoundPolicy =
  | {
      readonly kind: 'approve';
      readonly expect?: string;
      readonly onMismatch?: AiGateRefine;
    }
  | { readonly kind: 'deny' }
  | { readonly kind: 'refine'; readonly instruction: string };

/** Evaluates one `approve:<expect>` assertion against the pending proposal.
 * @public
 */
export function evaluateGateExpectation(
  expr: string,
  session: AiSession,
): boolean {
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
  if (!hasMatch)
    throw new Error(
      `--gate expect "${expr}" is invalid. Use field~substring or field=count.`,
    );
  const [, field, needle] = hasMatch;
  const init = proposal.init as unknown as Record<string, unknown>;
  const raw =
    field === 'classification' ? proposal.classification : init[field];
  const values = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : raw === undefined
      ? []
      : [String(raw)];
  const ok = values.some((v) => v.toLowerCase().includes(needle.toLowerCase()));
  return negated ? !ok : ok;
}

/** Approved workload dimensions; prose is deliberately excluded from cost matching. */
export function approvalWorkload(
  proposal: Pick<PendingExplorationProposal, 'classification' | 'init'>,
) {
  const init = proposal.init;
  const sorted = (values: readonly string[] | undefined) =>
    [...new Set(values ?? [])].sort();
  return {
    classification: proposal.classification,
    origin: init.origin,
    analysisMode:
      init.analysisMode ?? (init.targetColumns?.length ? 'ct' : 'bb'),
    targetColumns: sorted(init.targetColumns),
    direction: init.direction ?? 'bidirectional',
    depthIntent: structuredClone(init.depthIntent),
    excludeTypes: sorted(init.excludeTypes),
    excludeSchemas: sorted(init.excludeSchemas),
    excludeNodeIds: sorted(init.excludeNodeIds),
    passNodeIds: sorted(init.passNodeIds),
  };
}
export type ApprovalWorkload = ReturnType<typeof approvalWorkload>;

/** Reports the binding dimensions that differ, without changing either proposal. */
export function approvalWorkloadDifferences(
  expected: Partial<ApprovalWorkload>,
  actual: ApprovalWorkload,
): string[] {
  return (Object.keys(expected) as Array<keyof ApprovalWorkload>).filter(
    (key) =>
      key === 'depthIntent'
        ? !isDeepStrictEqual(
            resolveDepthBorder(expected.depthIntent!),
            resolveDepthBorder(actual.depthIntent),
          )
        : !isDeepStrictEqual(expected[key], actual[key]),
  );
}

/** Native Change fields for a declared case expectation; equivalent depth labels are not edits. */
export function requiredApprovalRefinement(
  expected: Partial<ApprovalWorkload>,
  actual: ApprovalWorkload,
): AiGateRefine | undefined {
  const differences = approvalWorkloadDifferences(expected, actual);
  if (!differences.length) return undefined;
  const edits: Record<string, unknown> = {};
  for (const field of differences)
    edits[field === 'depthIntent' ? 'depth' : field] =
      expected[field as keyof ApprovalWorkload];
  return AiGateRefineSchema.parse({
    ...edits,
    instruction: `Apply these case-requested approval edits: ${JSON.stringify(edits)}. Preserve other scope fields.`,
  });
}

/** Everything one headless turn needs; nothing here is VS Code specific. */
export interface HarnessTurnOptions {
  readonly session: AiSession;
  /** The lane's model port, supplied by its scripted or HTTP transport. */
  readonly model: ModelPort;
  readonly prompt: string;
  /** Prior visible question-and-answer text, oldest first, matching native chat history. */
  readonly priorMessages?: readonly ModelMessage[];
  /** Directory the post-run artifacts are written to; created if absent. */
  readonly runDir: string;
  readonly logger: HeadlessLogChannel;
  readonly requestId?: string;
  readonly maxRounds?: number;
  /** Ordered consent policies; a conditional Change reuses its approval row for the revised gate. */
  readonly gate?: readonly GateRoundPolicy[];
  /** Selected baseline's approved workload; checked before simulated approval. */
  readonly expectedApproval?: ApprovalWorkload;
  /** Declared test-case lens/border; a reference is diagnostic only. */
  readonly requiredApproval?: Partial<ApprovalWorkload>;
  readonly signal?: AbortSignal;
  /** Session trace sink; when present the runtime writes lifecycle and tool records to it. */
  readonly traceWriter?: AiTraceWriter;
  /** Parsed `--ui-state` buffer, assigned to `session.uiState` verbatim before the turn. */
  readonly uiState?: unknown;
  /** Parsed `--stored-run` buffer. Resolved by `lineage_get_screen_state` only for the bookmark id found at `uiState.screenState.bookmark.id`, matching how a real save keys one run per bookmark. */
  readonly storedRun?: StoredAiRun;
}

/** One consent gate and the decision the run policy applied to it.
 * @public Gate decision API exposed to CLI result import types.
 */
export interface HarnessGateDecision {
  readonly gateId: string;
  readonly gate: string;
  readonly policyIndex?: number;
  readonly proposalRevision?: number;
  readonly refine?: AiGateRefine;
  readonly decision: 'approve' | 'deny' | 'refine';
  /** The refine instruction sent, present only when `decision` is `'refine'`. */
  readonly instruction?: string;
  /** Case expectation evaluated on this proposal. A configured mismatch requests Change once; a remaining mismatch stays recorded when approval continues. */
  readonly expectation?: { readonly expr: string; readonly ok: boolean };
  readonly requiredApproval?: {
    readonly expected: Partial<ApprovalWorkload>;
    readonly actual: ApprovalWorkload;
    readonly differences: readonly string[];
  };
  readonly approval?: {
    readonly actual: ApprovalWorkload;
    readonly expected?: ApprovalWorkload;
    readonly differences: readonly string[];
    readonly equivalentDeclaredDifferences: readonly string[];
  };
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

/** Executes one turn and dumps `sm-state.json`, `answer.md`, `present-result.json`, `hop-log.json`. */
export async function runHarnessTurn(
  options: HarnessTurnOptions,
): Promise<HarnessTurnResult> {
  mkdirSync(options.runDir, { recursive: true });
  if (options.uiState !== undefined) {
    options.session.uiState = options.uiState;
    const buffer = options.uiState as Record<string, unknown>;
    if ('renderState' in buffer)
      options.session.renderState = buffer.renderState;
    if ('filter' in buffer)
      options.session.filter = buffer.filter as AiSession['filter'];
    if (buffer.graphMode === 'full' || buffer.graphMode === 'overview')
      options.session.graphMode = buffer.graphMode;
    if (typeof buffer.filteredCount === 'number')
      options.session.filteredCount = buffer.filteredCount;
  }
  const bookmarkId = bookmarkIdFromUiState(options.uiState);
  const storedRun = options.storedRun;
  const requestId = options.requestId ?? randomUUID();
  const gatePolicy: readonly GateRoundPolicy[] = (
    options.gate && options.gate.length > 0
      ? options.gate
      : [{ kind: 'approve' } as const]
  ).map((policy) =>
    policy.kind === 'approve' && policy.onMismatch
      ? { ...policy, onMismatch: AiGateRefineSchema.parse(policy.onMismatch) }
      : policy,
  );
  const events: TurnEvent[] = [];
  const gates: HarnessGateDecision[] = [];
  let gateRound = 0;
  let requiredChangeRequested = false;
  let text = '';
  let engine: NavigationEngine | null = null;

  const runtime = new LineageRuntime({
    getSession: () => options.session,
    createRegistry: (lease, model) =>
      buildAiToolRegistry(
        () => options.session,
        options.logger as unknown as import('vscode').LogOutputChannel,
        () => undefined,
        lease,
        {
          model,
          budget: model.budget,
          signal: lease.signal,
          ...(storedRun
            ? {
                getStoredRun: (id: string) =>
                  id === bookmarkId ? storedRun : undefined,
              }
            : {}),
        },
      ),
    // Without this the graph's `deps.logger` is undefined, so every debugLog in
    // toolAttempt.ts is optional-chained away and synthesized rejections
    // (bad arguments, a missing required call, a duplicate read, an empty
    // reply) are counted in run.json but never written to host.log.
    // The product wires the same logger at extensionRuntime.ts; only the harness
    // omitted it, which made those rejections diagnosable solely from the NDJSON
    // trace. Observability only — no tool, score, or answer path is affected.
    logger: Logger.create(
      options.logger as unknown as import('vscode').LogOutputChannel,
      'AI',
    ),
    ...(options.maxRounds !== undefined
      ? { maxRounds: options.maxRounds }
      : {}),
    ...(options.traceWriter ? { traceWriter: options.traceWriter } : {}),
  });

  // The card ends its turn; the policy's answer is the user's next turn, as in native chat.
  let answer:
    | { readonly prompt: string; readonly gateDecision: GateDecision }
    | undefined;
  let terminalStatus: string | null = null;
  const onEvent = (event: TurnEvent): void => {
    events.push(event);
    if (event.type === 'text') text += event.delta;
    if (!engine && options.session.stateMachine) {
      engine = options.session.stateMachine as NavigationEngine;
    }
    if (event.type !== 'gate') return;
    const policyIndex = Math.min(gateRound, gatePolicy.length - 1);
    const round = gatePolicy[policyIndex];
    // A case may request one Change for a mismatched proposal; baseline differences are diagnostic.
    const expectation =
      round.kind === 'approve' && round.expect !== undefined
        ? {
            expr: round.expect,
            ok: evaluateGateExpectation(round.expect, options.session),
          }
        : undefined;
    const actual = options.session.pendingExploration
      ? approvalWorkload(options.session.pendingExploration)
      : undefined;
    const differences =
      options.expectedApproval && round.kind === 'approve'
        ? actual
          ? approvalWorkloadDifferences(options.expectedApproval, actual)
          : ['pendingExploration']
        : [];
    const equivalentDeclaredDifferences =
      options.expectedApproval &&
      actual &&
      !isDeepStrictEqual(
        options.expectedApproval.depthIntent,
        actual.depthIntent,
      ) &&
      !approvalWorkloadDifferences(options.expectedApproval, actual).includes(
        'depthIntent',
      )
        ? ['depthIntent']
        : [];
    const requiredCorrection =
      round.kind === 'approve' && options.requiredApproval && actual
        ? requiredApprovalRefinement(options.requiredApproval, actual)
        : undefined;
    const requiredStillWrong = Boolean(
      requiredCorrection && requiredChangeRequested,
    );
    const caseChange =
      requiredCorrection && !requiredChangeRequested
        ? requiredCorrection
        : undefined;
    if (caseChange) requiredChangeRequested = true;
    const correction =
      caseChange ??
      (round.kind === 'approve' &&
      expectation &&
      !expectation.ok &&
      round.onMismatch &&
      !gates.some(
        (gate) =>
          gate.policyIndex === policyIndex && gate.decision === 'refine',
      )
        ? round.onMismatch
        : undefined);
    const refinement = requiredStillWrong
      ? undefined
      : (correction ??
        (round.kind === 'refine'
          ? { instruction: round.instruction }
          : undefined));
    const decision = requiredStillWrong
      ? 'deny'
      : refinement
        ? 'refine'
        : round.kind;
    if (!correction) gateRound += 1;
    gates.push({
      gateId: event.proposalId,
      gate: event.gate,
      policyIndex,
      proposalRevision: options.session.pendingExploration?.revision,
      decision,
      ...(refinement
        ? {
            refine: refinement,
            ...(refinement.instruction !== undefined
              ? { instruction: refinement.instruction }
              : {}),
          }
        : {}),
      ...(expectation ? { expectation } : {}),
      ...(options.requiredApproval && actual
        ? {
            requiredApproval: {
              expected: options.requiredApproval,
              actual,
              differences: approvalWorkloadDifferences(
                options.requiredApproval,
                actual,
              ),
            },
          }
        : {}),
      ...(actual
        ? {
            approval: {
              actual,
              ...(options.expectedApproval
                ? { expected: options.expectedApproval }
                : {}),
              differences,
              equivalentDeclaredDifferences,
            },
          }
        : {}),
    });
    if (equivalentDeclaredDifferences.length)
      options.logger.info(
        '[harness] declared depth differs; execution border is equivalent — preserving both declarations in the approval receipt',
      );
    if (differences.length)
      options.logger.info(
        `[harness] baseline workload differs: ${differences.join(', ')} — comparison is informational`,
      );
    if (expectation && !expectation.ok) {
      options.logger.info(
        `[harness] gate ${event.gate} expectation mismatch (${expectation.expr}) — ${correction ? 'requesting the case-defined Change once' : 'recording the remaining mismatch'}`,
      );
    }
    options.logger.info(
      `[harness] gate ${event.gate} → ${decision}${refinement?.instruction ? `: ${refinement.instruction}` : ''}` +
        (expectation
          ? ` [expect ${expectation.expr} ${expectation.ok ? 'ok' : 'FAILED'}]`
          : ''),
    );
    answer = refinement
      ? {
          prompt: refinement.instruction ?? 'Change scope',
          gateDecision: {
            kind: 'refine',
            proposalId: event.proposalId,
            refine: refinement,
          },
        }
      : decision === 'approve'
        ? {
            prompt: 'Approve & Proceed',
            gateDecision: { kind: 'approve', proposalId: event.proposalId },
          }
        : {
            prompt: 'Cancel',
            gateDecision: { kind: 'cancel', proposalId: event.proposalId },
          };
  };

  options.logger.info(
    `[harness] turn start request=${requestId} model=${options.model.identity.id}`,
  );
  const runOne = async (prompt: string, gateDecision?: GateDecision) => {
    const sink = new TurnEventSink(onEvent);
    const result = await runtime.run({
      model: options.model,
      request: {
        id: requestId,
        prompt,
        ...(options.priorMessages !== undefined
          ? { priorMessages: options.priorMessages }
          : {}),
        ...(gateDecision ? { gateDecision } : {}),
      },
      sink,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    terminalStatus = sink.terminalStatus ?? null;
    return result;
  };
  let outcome = await runOne(nativeHarnessPrompt(options.prompt));
  while (answer && outcome.outcome === 'ok') {
    const next: {
      readonly prompt: string;
      readonly gateDecision: GateDecision;
    } = answer;
    answer = undefined;
    outcome = await runOne(next.prompt, next.gateDecision);
  }
  // A post-run read catches an engine published by a node that emitted no further event.
  if (!engine && options.session.stateMachine) {
    engine = options.session.stateMachine as NavigationEngine;
  }
  options.logger.info(
    `[harness] turn terminal outcome=${outcome.outcome} modelCalls=${outcome.modelCalls}`,
  );

  const artifacts: Record<string, string> = {};
  writeArtifact(options.runDir, artifacts, 'answer.md', text);
  writeArtifact(
    options.runDir,
    artifacts,
    'hop-log.json',
    JSON.stringify(options.session.hopLog, null, 2),
  );
  // Every turn stores a state dump. A turn that never opened an exploration records that fact
  // instead of omitting the file.
  writeArtifact(
    options.runDir,
    artifacts,
    'sm-state.json',
    JSON.stringify(
      engine ? engine.toJSON() : { explorationOpened: false },
      null,
      2,
    ),
  );
  if (options.session.presentationArtifact) {
    writeArtifact(
      options.runDir,
      artifacts,
      'present-result.json',
      JSON.stringify(options.session.presentationArtifact, null, 2),
    );
  }

  return {
    outcome,
    events,
    text,
    terminalStatus,
    gates,
    artifacts,
  };
}
