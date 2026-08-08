/**
 * Assembles `run.json`: one machine-readable row per headless real-model run.
 *
 * @remarks
 * The file the analysis reads. Everything in it is *observed* — a provider `finish_reason` is the
 * provider's own string, a rejection count is counted off the trace's `tool` records, and the
 * state-machine numbers are read back out of the `sm-state.json` the run wrote. Nothing here
 * re-derives a value the pipeline already produced, and nothing here is a judgement: the summary
 * says what happened, never whether it was good. `suspectedToolCallAsText` in particular is a
 * heuristic FLAG carried through from the port (DD-5) and never a status.
 *
 * Two properties are load-bearing:
 *
 * - **No credential surface.** The lane's base URL and API key are not fields of this file. A lane
 *   is identified by its id and its (public) model id; a summary must be safe to paste into a bug
 *   report exactly like the trace it accompanies (DD-7).
 * - **Absent means "did not happen".** `sm` is `null` when no exploration ran, `usage` fields are
 *   omitted when the provider reported none. A zero would claim a measurement that was never made.
 *
 * Pure: no filesystem, no network, no `vscode`. The CLI owns I/O.
 */
import type { AgentFailureDetail } from '../../src/ai/host/agentRuntime';
import type { TokenUsage } from '../../src/ai/observability/wireLog';
import type { ResultGraph } from '../../src/ai/session/types';
import type { SmState } from '../../src/ai/sm/smTypes';
import type { OpenAiGenerationSummary } from './openAiCompatiblePort';
import type { PromptSource } from './prompts';
import type { HarnessGateDecision } from './runTurn';
import type { ParsedRun } from './traceModel';

/** Bumped when a consumer of `run.json` must branch on the shape below. */
export const RUN_SUMMARY_SCHEMA_VERSION = 1;

/** One notification production code raised during the run, as the shim recorded it. */
export interface SummaryNotification {
  readonly severity: 'error' | 'warning' | 'information';
  readonly message: string;
}

/** Outcome of the optional Langfuse export for this run. */
export interface SummaryLangfuse {
  readonly attempted: boolean;
  /** Why no export happened, when `attempted` is false (e.g. `missing-env`). */
  readonly skipped?: string;
  readonly exported: number;
  readonly errors: readonly string[];
}

/** Outcome of the optional LangSmith export for this run. */
export interface SummaryLangsmith {
  readonly attempted: boolean;
  /** Why no export happened, when `attempted` is false (e.g. `missing-env`). */
  readonly skipped?: string;
  readonly exported: number;
  readonly errors: readonly string[];
}

/** Everything {@link buildRunSummary} needs; the CLI gathers it, this module only shapes it. */
export interface RunSummaryInput {
  /** 1-based index of this run within the `--runs N` batch. */
  readonly runIndex: number;
  readonly runCount: number;
  readonly runDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lane: {
    readonly id: string;
    readonly model: string;
    readonly contextWindow: number;
  };
  readonly prompt: {
    readonly id: string;
    readonly source: PromptSource;
    readonly text: string;
  };
  readonly gatePolicy: 'approve' | 'deny';
  readonly traceVerbose: boolean;
  /** Terminal outcome as the runtime reported it. */
  readonly outcome: 'ok' | 'error' | 'cancelled' | string;
  /** Terminal status claimed by the event sink, or `null` when no terminal event was emitted. */
  readonly terminalStatus: string | null;
  readonly modelCalls: number;
  readonly failure?: AgentFailureDetail;
  readonly exitCode: number;
  readonly generations: readonly OpenAiGenerationSummary[];
  readonly gates: readonly HarnessGateDecision[];
  /** The run's parsed NDJSON trace, or `null` when it could not be read back. */
  readonly trace: ParsedRun | null;
  readonly tracePath?: string;
  /** Parsed `sm-state.json`, or `null` when the exploration phase never ran. */
  readonly smState?: SmState | null;
  /** `session.resultGraph` — the nodes the answer actually kept. */
  readonly resultGraph?: ResultGraph | null;
  readonly notifications: readonly SummaryNotification[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly answerChars: number;
  readonly langfuse?: SummaryLangfuse;
  readonly langsmith?: SummaryLangsmith;
}

/** Per-generation measurement axes, carried through from the port verbatim. */
export interface SummaryGeneration {
  readonly generation: number;
  readonly phase?: string;
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly usage?: TokenUsage;
  readonly suspectedToolCallAsText: boolean;
  readonly toolCalls: number;
  readonly textChars: number;
}

/** Summed provider-reported usage; a field is absent when no generation reported it. */
export interface SummaryUsageTotals {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
  /** How many generations reported any usage at all — the denominator for the totals above. */
  readonly reportedBy: number;
}

/** Tool-dispatch accounting read off the trace's `tool` records. */
export interface SummaryTools {
  readonly calls: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly dispatchError: number;
  /** Rejection counts keyed by the rejection code the dispatcher reported. */
  readonly rejectionsByCode: Readonly<Record<string, number>>;
}

/** What the exploration engine ended up with; `null` when no exploration ran. */
export interface SummaryStateMachine {
  readonly status: string;
  readonly hopCount: number;
  /** Nodes the engine had in scope (`SmState.scopeNodeIds`). */
  readonly scope: readonly string[];
  /** Nodes the ANSWER kept (`session.resultGraph.nodeIds`) — a subset of `scope` after pruning. */
  readonly kept: readonly string[];
  /** Nodes the engine removed (`SmState.removedSet`). */
  readonly pruned: readonly string[];
  /** Validated column-lineage edges accumulated by a column trace; `0` for a blueprint run. */
  readonly columnEdges: number;
  readonly visited: number;
}

/** Integrity of the NDJSON trace this run wrote. */
export interface SummaryTrace {
  readonly path?: string;
  readonly lines: number;
  /** Lines that could not be read back as records — must be `0` for a run to be trustworthy. */
  readonly malformed: number;
  readonly generationRecords: number;
  readonly wireRecords: number;
  /** Records whose `type` this trace-model version does not know; a schema-drift signal. */
  readonly unknownRecords: number;
}

/** One run, as `run.json` holds it. */
export interface RunSummary {
  readonly schemaVersion: typeof RUN_SUMMARY_SCHEMA_VERSION;
  readonly run: {
    readonly index: number;
    readonly of: number;
    readonly dir: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
  };
  readonly lane: RunSummaryInput['lane'];
  readonly prompt: RunSummaryInput['prompt'];
  readonly outcome: {
    readonly status: string;
    readonly terminalStatus: string | null;
    readonly exitCode: number;
    readonly modelCalls: number;
    readonly failure?: AgentFailureDetail;
    readonly answerChars: number;
  };
  readonly settings: {
    readonly gate: 'approve' | 'deny';
    readonly traceVerbose: boolean;
  };
  readonly generations: readonly SummaryGeneration[];
  readonly usage: SummaryUsageTotals;
  readonly failureClasses: {
    /** Generations whose completed text looks like a tool call the provider failed to emit (DD-5). */
    readonly suspectedToolCallAsText: number;
    /** `invalid_tool_input` rejections — the other half of the DeepSeek argument failure class. */
    readonly invalidToolInput: number;
    /** Generations the provider stopped for a non-ordinary reason (`length`, `content_filter`, …). */
    readonly abnormalFinishReasons: readonly string[];
  };
  readonly tools: SummaryTools;
  readonly gates: readonly HarnessGateDecision[];
  readonly sm: SummaryStateMachine | null;
  readonly trace: SummaryTrace;
  readonly notifications: readonly SummaryNotification[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly langfuse: SummaryLangfuse | null;
  readonly langsmith: SummaryLangsmith | null;
}

/** Finish reasons that mean the generation ended the ordinary way; anything else is reported. */
const ORDINARY_FINISH_REASONS = new Set(['stop', 'tool_calls', 'tool-calls', 'function_call', '']);

/**
 * Shapes one run's observations into the `run.json` record.
 *
 * @param input - Everything the CLI observed about the run.
 * @returns The summary; the caller serializes it.
 */
export function buildRunSummary(input: RunSummaryInput): RunSummary {
  const generations: SummaryGeneration[] = input.generations.map((entry) => ({
    generation: entry.generation,
    ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    finishReason: entry.finishReason,
    latencyMs: entry.latencyMs,
    ...(entry.usage ? { usage: entry.usage } : {}),
    suspectedToolCallAsText: entry.suspectedToolCallAsText,
    toolCalls: entry.toolCalls,
    textChars: entry.textChars,
  }));

  const tools = summarizeTools(input.trace);
  return {
    schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
    run: {
      index: input.runIndex,
      of: input.runCount,
      dir: input.runDir,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    },
    lane: input.lane,
    prompt: input.prompt,
    outcome: {
      status: input.outcome,
      terminalStatus: input.terminalStatus,
      exitCode: input.exitCode,
      modelCalls: input.modelCalls,
      ...(input.failure ? { failure: input.failure } : {}),
      answerChars: input.answerChars,
    },
    settings: { gate: input.gatePolicy, traceVerbose: input.traceVerbose },
    generations,
    usage: sumUsage(input.generations),
    failureClasses: {
      suspectedToolCallAsText: input.generations.filter((entry) => entry.suspectedToolCallAsText).length,
      invalidToolInput: tools.rejectionsByCode.invalid_tool_input ?? 0,
      abnormalFinishReasons: [
        ...new Set(
          input.generations
            .map((entry) => entry.finishReason)
            .filter((reason) => !ORDINARY_FINISH_REASONS.has(reason)),
        ),
      ],
    },
    tools,
    gates: input.gates,
    sm: summarizeStateMachine(input.smState ?? null, input.resultGraph ?? null),
    trace: summarizeTrace(input.trace, input.tracePath),
    notifications: input.notifications,
    artifacts: input.artifacts,
    langfuse: input.langfuse ?? null,
    langsmith: input.langsmith ?? null,
  };
}

/**
 * Sums provider-reported usage across generations.
 *
 * @remarks
 * A field stays absent unless at least one generation reported it, because `0` and "the provider
 * does not report this" are different facts and the whole point of the axis is to tell them apart.
 */
function sumUsage(generations: readonly OpenAiGenerationSummary[]): SummaryUsageTotals {
  let reportedBy = 0;
  const totals: Record<keyof TokenUsage, number | undefined> = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    reasoningTokens: undefined,
  };
  for (const generation of generations) {
    if (!generation.usage) continue;
    reportedBy += 1;
    for (const key of Object.keys(totals) as Array<keyof TokenUsage>) {
      const value = generation.usage[key];
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return {
    ...(totals.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
    ...(totals.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
    ...(totals.totalTokens !== undefined ? { totalTokens: totals.totalTokens } : {}),
    ...(totals.reasoningTokens !== undefined ? { reasoningTokens: totals.reasoningTokens } : {}),
    reportedBy,
  };
}

/** Counts tool dispatch outcomes off the trace's `tool` lifecycle records. */
function summarizeTools(trace: ParsedRun | null): SummaryTools {
  const rejectionsByCode: Record<string, number> = {};
  let accepted = 0;
  let rejected = 0;
  let dispatchError = 0;
  for (const entry of trace?.tools ?? []) {
    if (entry.status === 'accepted') accepted += 1;
    else if (entry.status === 'rejected') {
      rejected += 1;
      const code = entry.rejectionCode ?? 'unspecified';
      rejectionsByCode[code] = (rejectionsByCode[code] ?? 0) + 1;
    } else dispatchError += 1;
  }
  return { calls: accepted + rejected + dispatchError, accepted, rejected, dispatchError, rejectionsByCode };
}

/** Projects the engine dump and the answer's result graph into the four analysis numbers. */
function summarizeStateMachine(
  smState: SmState | null,
  resultGraph: ResultGraph | null,
): SummaryStateMachine | null {
  if (!smState) return null;
  return {
    status: smState.status,
    hopCount: smState.hopCount,
    scope: smState.scopeNodeIds ?? [],
    kept: resultGraph?.nodeIds ?? [],
    pruned: smState.removedSet ?? [],
    columnEdges: smState.columnAspect?.edges?.length ?? 0,
    visited: smState.visited?.length ?? 0,
  };
}

function summarizeTrace(trace: ParsedRun | null, path?: string): SummaryTrace {
  if (!trace) {
    return { ...(path ? { path } : {}), lines: 0, malformed: 0, generationRecords: 0, wireRecords: 0, unknownRecords: 0 };
  }
  const lines = trace.turns.length + trace.generations.length + trace.tools.length
    + trace.gates.length + trace.phases.length + trace.wire.length + trace.raw.length
    + trace.malformed.length;
  return {
    ...(path ? { path } : {}),
    lines,
    malformed: trace.malformed.length,
    generationRecords: trace.generations.length,
    wireRecords: trace.wire.length,
    unknownRecords: trace.raw.length,
  };
}
