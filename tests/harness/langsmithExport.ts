/**
 * Zero-dependency exporter that posts a parsed harness trace to LangSmith's REST run-ingestion API
 * (`POST /runs/batch`), so a real-model run recorded by the headless harness shows up as a trace in
 * LangSmith without pulling in the `langsmith` npm package — which this repository keeps inert by
 * design (see `stubs/langsmith/`, the `overrides` entry, `src/ai/host/agentRuntime.ts`'s fail-closed
 * tracing guard, and `tests/tools/assert-no-langsmith.mjs`). This module never imports `langsmith`,
 * never sets `LANGSMITH_TRACING`/`LANGCHAIN_TRACING*`, and never touches any of those four layers —
 * it is pure `fetch` from test tooling, posting already-captured trace data over the documented
 * ingestion contract, exactly as {@link ../../src/ai/host/agentRuntime.ts} forbids the product code
 * from doing implicitly.
 *
 * @remarks
 * Shapes here were read on 2026-08-07 from LangSmith's own documentation — the OpenAPI document at
 * `https://api.smith.langchain.com/docs` names `POST /runs/batch` (`{post: Run[], patch: Run[]}`)
 * and `POST /runs`; `https://docs.langchain.com/langsmith/trace-with-api` documents the `x-api-key`
 * auth header and the core run fields (`id`, `trace_id`, `name`, `run_type`, `start_time`,
 * `end_time`, `inputs`, `outputs`, `parent_run_id`, `dotted_order`, `session_name`); a construction
 * example surfaced via `langchain-ai/langsmith-sdk` issue #751 pins the `dotted_order` format as
 * `{compact-timestamp}Z{run-id}` for a root run and `{parent-dotted-order}.{compact-timestamp}Z
 * {run-id}` for a child, where a root run's dotted_order carries exactly one such segment; and
 * `https://docs.langchain.com/langsmith/cost-tracking` documents `extra.metadata.ls_model_name` /
 * `ls_provider` as the REST-API-safe way to attach a model identity to a run (the alternative, a
 * top-level `model` field, is not part of the documented `Run` schema). `/runs/multipart` is the
 * throughput-optimized alternative LangSmith recommends for production tracing, but it requires
 * hand-rolling `multipart/form-data` encoding; `/runs/batch`'s plain-JSON body is the documented,
 * dependency-free surface that matches this harness's one-shot, post-hoc export (mirrors the choice
 * `langfuseExport.ts` makes against Langfuse's own legacy-but-documented JSON ingestion endpoint).
 *
 * One HTTP call per joined turn (root `chain` run plus its child `llm` runs together), not one call
 * for the whole batch — `/runs/batch` is not documented to return itemized per-run success like
 * Langfuse's `IngestionResponse`, so per-turn calls are the only honest way to let one turn's
 * ingestion failure surface without hiding another turn's success, and it is what
 * {@link exportRunToLangSmith}'s partial-failure behavior is built on.
 *
 * No request header — including `x-api-key` — is ever placed in an error string this module
 * returns; {@link redactSecret} additionally scrubs the literal API key from every error text on the
 * chance a provider or network error happens to echo the request back.
 */
import { randomUUID } from 'node:crypto';
import { joinTurns, type GenerationEntry, type JoinedTurn, type ParsedRun } from './traceModel';
import { describeError, redactSecret, verboseContent } from './exportShared';

/** Resolved connection for one export call. */
export interface LangSmithConfig {
  /** LangSmith API host, e.g. `https://api.smith.langchain.com` (no trailing path). */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Maps to `session_name` on every posted run; omitted (server default project) when unset. */
  readonly project?: string;
  /** Injectable for tests; defaults to the global `fetch` Node ≥22 provides. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Run-level identity the trace itself does not carry — only the CLI that launched this run
   * knows which lane and which scenario prompt produced it.
   */
  readonly runMetadata?: {
    readonly lane?: string;
    readonly promptId?: string;
  };
}

/** Outcome of one export call. */
export interface LangSmithExportResult {
  /** Count of run objects LangSmith accepted (summed across every per-turn call that succeeded). */
  readonly exported: number;
  /** One human-readable line per turn LangSmith rejected, or per transport failure; empty on full success. */
  readonly errors: readonly string[];
}

const BATCH_PATH = '/runs/batch';
const DEFAULT_BASE_URL = 'https://api.smith.langchain.com';

/** One run object as `POST /runs/batch`'s documented `Run` schema shapes it. */
interface RunPayload {
  readonly id: string;
  readonly trace_id: string;
  readonly name: string;
  readonly run_type: 'chain' | 'llm';
  readonly start_time: string;
  readonly end_time: string;
  readonly dotted_order: string;
  readonly parent_run_id?: string;
  readonly session_name?: string;
  readonly inputs?: Record<string, unknown>;
  readonly outputs?: Record<string, unknown>;
  readonly extra: { readonly metadata: Record<string, unknown> };
}

/**
 * Reads LangSmith connection settings from an env-shaped object.
 *
 * @param env - Caller-supplied key/value map — deliberately not `process.env` so this stays
 *   testable and the exporter never reaches into ambient process state on its own.
 * @returns `null` when `LANGSMITH_API_KEY` is missing or empty, so the caller can self-skip
 *   (`--langsmith` without a configured `.env` is a no-op, not an error). `LANGSMITH_PROJECT` is
 *   optional; `LANGSMITH_BASE_URL` defaults to LangSmith's public API host.
 */
export function resolveLangSmithConfig(
  env: Readonly<Record<string, string | undefined>>,
): Pick<LangSmithConfig, 'baseUrl' | 'apiKey' | 'project'> | null {
  const apiKey = env.LANGSMITH_API_KEY;
  if (!apiKey) return null;
  const baseUrl = env.LANGSMITH_BASE_URL || DEFAULT_BASE_URL;
  const project = env.LANGSMITH_PROJECT;
  return { baseUrl, apiKey, ...(project ? { project } : {}) };
}

/**
 * Posts every turn and generation in `run` to LangSmith as one `/runs/batch` call per joined turn.
 *
 * @param run - A trace already parsed by {@link parseTrace} (see `traceModel.ts`).
 * @param config - Connection and optional run identity; see {@link LangSmithConfig}.
 * @returns The count LangSmith accepted and any per-turn or transport error text, secret-scrubbed.
 */
export async function exportRunToLangSmith(
  run: ParsedRun,
  config: LangSmithConfig,
): Promise<LangSmithExportResult> {
  const turns = joinTurns(run);
  if (turns.length === 0) return { exported: 0, errors: [] };

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}${BATCH_PATH}`;

  let exported = 0;
  const errors: string[] = [];
  for (const turn of turns) {
    const generations = run.generations.filter((entry) => entry.requestId === turn.requestId);
    const posts = buildTurnRuns(run, turn, generations, config);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify({ post: posts, patch: [] }),
      });
    } catch (error) {
      errors.push(redactSecret(`LangSmith ingestion request failed for turn ${turn.requestId}: ${describeError(error)}`, config.apiKey));
      continue;
    }

    if (!response.ok) {
      const bodyText = await safeText(response);
      errors.push(redactSecret(
        `LangSmith ingestion failed for turn ${turn.requestId}: HTTP ${response.status}${bodyText ? ` ${bodyText.slice(0, 200)}` : ''}`,
        config.apiKey,
      ));
      continue;
    }

    exported += posts.length;
  }

  return { exported, errors };
}

/** Builds the root `chain` run plus its child `llm` runs for one joined turn. */
function buildTurnRuns(
  run: ParsedRun,
  turn: JoinedTurn,
  generations: readonly GenerationEntry[],
  config: LangSmithConfig,
): RunPayload[] {
  const rootId = randomUUID();
  const startTime = turn.start?.at ?? generations[0]?.at ?? new Date().toISOString();
  const endTime = turn.terminal?.at ?? generations[generations.length - 1]?.at ?? startTime;
  const rootDottedOrder = dottedOrderSegment(rootId, startTime);
  const name = [config.runMetadata?.lane, config.runMetadata?.promptId].filter(Boolean).join('/') || turn.requestId;

  const root: RunPayload = {
    id: rootId,
    trace_id: rootId,
    name,
    run_type: 'chain',
    start_time: startTime,
    end_time: endTime,
    dotted_order: rootDottedOrder,
    ...(config.project ? { session_name: config.project } : {}),
    extra: {
      metadata: {
        lane: config.runMetadata?.lane,
        modelId: generations[0]?.modelId,
        outcome: turn.terminal?.status,
        modelCalls: turn.terminal?.modelCalls,
      },
    },
  };

  const children = generations.map((generation) => buildGenerationRun(run, rootId, rootDottedOrder, generation, config));
  return [root, ...children];
}

function buildGenerationRun(
  run: ParsedRun,
  rootId: string,
  rootDottedOrder: string,
  generation: GenerationEntry,
  config: LangSmithConfig,
): RunPayload {
  const childId = randomUUID();
  const startTime = new Date(new Date(generation.at).getTime() - generation.latencyMs).toISOString();
  const { input, output } = verboseContent(run, generation);
  const usage = generation.usage
    ? {
        usage_metadata: {
          input_tokens: generation.usage.inputTokens,
          output_tokens: generation.usage.outputTokens,
          total_tokens: generation.usage.totalTokens,
        },
      }
    : {};

  return {
    id: childId,
    trace_id: rootId,
    parent_run_id: rootId,
    name: generation.phase ?? 'generation',
    run_type: 'llm',
    start_time: startTime,
    end_time: generation.at,
    dotted_order: `${rootDottedOrder}.${dottedOrderSegment(childId, generation.at)}`,
    ...(config.project ? { session_name: config.project } : {}),
    ...(input ? { inputs: input as Record<string, unknown> } : {}),
    ...(output || Object.keys(usage).length > 0 ? { outputs: { ...usage, ...(output as Record<string, unknown> | undefined) } } : {}),
    extra: {
      metadata: {
        finishReason: generation.finishReason,
        phase: generation.phase,
        ls_model_name: generation.modelId,
      },
    },
  };
}

/**
 * Formats the `{compact-timestamp}Z{run-id}` segment `dotted_order` is built from.
 *
 * @remarks
 * The documented construction (surfaced via `langchain-ai/langsmith-sdk` issue #751) uses
 * microsecond precision (`YYYYMMDDTHHMMSSffffffZ`); `Date` only carries milliseconds, so the
 * millisecond triplet is zero-padded to six digits. Only relative ordering within a trace is
 * observable from this field, and zero-padding preserves it.
 */
function dottedOrderSegment(id: string, at: string): string {
  const compact = new Date(at).toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '')
    .replace(/(\d{3})Z$/, '$1000Z');
  return `${compact}${id}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

