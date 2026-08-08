/**
 * Zero-dependency exporter that posts a parsed harness trace to Langfuse Cloud's public batch
 * ingestion API (`POST /api/public/ingestion`), so a real-model run recorded by the headless
 * harness shows up as a trace in Langfuse without pulling in `@langfuse/*`.
 *
 * @remarks
 * Shapes here were read out of Langfuse's own OpenAPI document
 * (`https://cloud.langfuse.com/generated/api/openapi.yml`, schemas `IngestionEvent`,
 * `TraceEvent`/`TraceBody`, `CreateGenerationEvent`/`CreateGenerationBody`, `IngestionResponse`)
 * on 2026-08-07, cross-checked against `https://api.reference.langfuse.com`. The endpoint is
 * marked legacy there in favor of an OpenTelemetry ingester, but it is still the one documented,
 * stable, dependency-free surface a hand-rolled `fetch` client can drive — the OTel endpoint
 * expects protobuf-encoded OTLP, which is not a "zero-dependency" proposition. Two events per
 * model call: one `trace-create` per harness turn (`(requestId, runFingerprint)`), one
 * `generation-create` per {@link GenerationEntry}, correlated by `traceId`. Message content
 * (`input`/`output`) is attached to a generation only when the matching `wire-request` entry
 * carries a `system` field — the harness only captures verbatim prompt text in verbose mode, so a
 * non-verbose trace has nothing to attach without inventing it.
 *
 * No request header — including `Authorization` — is ever placed in an error string this module
 * returns; {@link redactSecret} additionally scrubs the literal secret key from every error text
 * on the chance a provider or network error happens to echo the request back.
 */
import { randomUUID } from 'node:crypto';
import { joinTurns, type GenerationEntry, type JoinedTurn, type ParsedRun } from './traceModel';
import { describeError, redactSecret, verboseContent } from './exportShared';

/** Resolved connection for one export call. */
export interface LangfuseConfig {
  /** Langfuse Cloud region host, e.g. `https://cloud.langfuse.com` (no trailing path). */
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
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
export interface LangfuseExportResult {
  /** Count of batch events Langfuse reported as ingested (`IngestionResponse.successes.length`). */
  readonly exported: number;
  /** One human-readable line per event Langfuse rejected, or per transport failure; empty on full success. */
  readonly errors: readonly string[];
}

const INGESTION_PATH = '/api/public/ingestion';

/** One `{id, timestamp, type, body}` envelope, matching Langfuse's `IngestionEvent` union. */
interface IngestionEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly type: 'trace-create' | 'generation-create';
  readonly body: Record<string, unknown>;
}

interface IngestionResponseShape {
  readonly successes?: ReadonlyArray<{ readonly id: string; readonly status: number }>;
  readonly errors?: ReadonlyArray<{
    readonly id: string;
    readonly status: number;
    readonly message?: string | null;
    readonly error?: unknown;
  }>;
}

/**
 * Reads Langfuse connection settings from an env-shaped object.
 *
 * @param env - Caller-supplied key/value map — deliberately not `process.env` so this stays
 *   testable and the exporter never reaches into ambient process state on its own.
 * @returns `null` when any of the three required variables is missing or empty, so the caller can
 *   self-skip (`--langfuse` without a configured `.env` is a no-op, not an error).
 */
export function resolveLangfuseConfig(
  env: Readonly<Record<string, string | undefined>>,
): Pick<LangfuseConfig, 'baseUrl' | 'publicKey' | 'secretKey'> | null {
  const baseUrl = env.LANGFUSE_BASE_URL;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!baseUrl || !publicKey || !secretKey) return null;
  return { baseUrl, publicKey, secretKey };
}

/**
 * Posts every turn and generation in `run` to Langfuse Cloud as one ingestion batch.
 *
 * @param run - A trace already parsed by {@link parseTrace} (see `traceModel.ts`).
 * @param config - Connection and optional run identity; see {@link LangfuseConfig}.
 * @returns The count Langfuse ingested and any per-event or transport error text, secret-scrubbed.
 */
export async function exportRunToLangfuse(
  run: ParsedRun,
  config: LangfuseConfig,
): Promise<LangfuseExportResult> {
  const batch = buildBatch(run, config.runMetadata);
  if (batch.length === 0) return { exported: 0, errors: [] };

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}${INGESTION_PATH}`;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, 'utf8').toString('base64')}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ batch }),
    });
  } catch (error) {
    return { exported: 0, errors: [redactSecret(`Langfuse ingestion request failed: ${describeError(error)}`, config.secretKey)] };
  }

  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch (error) {
    if (response.ok) {
      return { exported: 0, errors: [redactSecret(`Langfuse ingestion response was not JSON: ${describeError(error)}`, config.secretKey)] };
    }
    return { exported: 0, errors: [redactSecret(`Langfuse ingestion failed: HTTP ${response.status}`, config.secretKey)] };
  }

  // 207 is the documented success shape (partial failure inside an otherwise-accepted batch); any
  // other non-2xx status means the whole batch was refused before per-event processing ran.
  if (!response.ok && response.status !== 207) {
    return {
      exported: 0,
      errors: [redactSecret(`Langfuse ingestion failed: HTTP ${response.status} ${summarizeUnknownBody(parsedBody)}`, config.secretKey)],
    };
  }

  const { successes, errors } = parseIngestionResponse(parsedBody);
  return { exported: successes, errors: errors.map((message) => redactSecret(message, config.secretKey)) };
}

/** Builds the full ingestion batch: one `trace-create` per joined turn, then its generations. */
function buildBatch(run: ParsedRun, runMetadata: LangfuseConfig['runMetadata']): IngestionEvent[] {
  const events: IngestionEvent[] = [];
  for (const turn of joinTurns(run)) {
    const generations = run.generations.filter((entry) => entry.requestId === turn.requestId);
    events.push(buildTraceEvent(turn, generations, runMetadata));
    for (const generation of generations) {
      events.push(buildGenerationEvent(run, turn.requestId, generation));
    }
  }
  return events;
}

function buildTraceEvent(
  turn: JoinedTurn,
  generations: readonly GenerationEntry[],
  runMetadata: LangfuseConfig['runMetadata'],
): IngestionEvent {
  const name = [runMetadata?.lane, runMetadata?.promptId].filter(Boolean).join('/') || turn.requestId;
  return {
    id: randomUUID(),
    timestamp: turn.start?.at ?? generations[0]?.at ?? new Date().toISOString(),
    type: 'trace-create',
    body: {
      id: turn.requestId,
      timestamp: turn.start?.at,
      name,
      metadata: {
        lane: runMetadata?.lane,
        modelId: generations[0]?.modelId,
        outcome: turn.terminal?.status,
        modelCalls: turn.terminal?.modelCalls,
      },
    },
  };
}

function buildGenerationEvent(run: ParsedRun, traceId: string, generation: GenerationEntry): IngestionEvent {
  const startTime = new Date(new Date(generation.at).getTime() - generation.latencyMs).toISOString();
  const { input, output } = verboseContent(run, generation);
  return {
    id: randomUUID(),
    timestamp: generation.at,
    type: 'generation-create',
    body: {
      id: `${generation.requestId}-gen-${generation.generation}`,
      traceId,
      name: generation.phase ?? 'generation',
      startTime,
      endTime: generation.at,
      model: generation.modelId,
      usage: generation.usage
        ? {
            input: generation.usage.inputTokens,
            output: generation.usage.outputTokens,
            total: generation.usage.totalTokens,
            unit: 'TOKENS',
          }
        : undefined,
      metadata: { finishReason: generation.finishReason, phase: generation.phase },
      input,
      output,
    },
  };
}

function parseIngestionResponse(body: unknown): { successes: number; errors: string[] } {
  const shape = (body ?? {}) as IngestionResponseShape;
  const successes = Array.isArray(shape.successes) ? shape.successes.length : 0;
  const errors = Array.isArray(shape.errors)
    ? shape.errors.map((entry) => `id=${entry.id} status=${entry.status}${entry.message ? `: ${entry.message}` : ''}`)
    : [];
  return { successes, errors };
}

function summarizeUnknownBody(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 200);
  } catch {
    return '[unserializable response body]';
  }
}

