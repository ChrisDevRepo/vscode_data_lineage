/** Explicit Langfuse export through OTLP/HTTP JSON; no telemetry SDK or automatic transmission. */
import { createHash } from 'node:crypto';
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
  /** Count of OTEL spans accepted (payload size minus any `partialSuccess.rejectedSpans`). */
  readonly exported: number;
  /** One human-readable line per partial-success rejection or transport failure; empty on full success. */
  readonly errors: readonly string[];
  /** OTEL trace id of each exported turn, so a run can be opened in Langfuse without recomputing it. */
  readonly traceIds: readonly string[];
}

const OTEL_TRACES_PATH = '/api/public/otel/v1/traces';
const INGESTION_VERSION = '4';
const INSTRUMENTATION_SCOPE = 'data-lineage-viz-harness';
const UUID_HEX = /^[0-9a-f]{32}$/;

interface OtelAnyValue {
  readonly stringValue?: string;
  readonly intValue?: string;
  readonly boolValue?: boolean;
}

interface OtelAttribute {
  readonly key: string;
  readonly value: OtelAnyValue;
}

interface OtelSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtelAttribute[];
  readonly status: { readonly code: number; readonly message?: string };
}

interface OtelExportPayload {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: { readonly attributes: readonly OtelAttribute[] };
    readonly scopeSpans: ReadonlyArray<{
      readonly scope: { readonly name: string };
      readonly spans: readonly OtelSpan[];
    }>;
  }>;
}

interface OtelExportResponseShape {
  readonly partialSuccess?: {
    readonly rejectedSpans?: string | number;
    readonly errorMessage?: string | null;
  };
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
 * Posts every turn and generation in `run` to Langfuse Cloud as one OTLP/HTTP JSON export.
 *
 * @param run - A trace already parsed by {@link parseTrace} (see `traceModel.ts`).
 * @param config - Connection and optional run identity; see {@link LangfuseConfig}.
 * @returns The count of spans accepted and any partial-success or transport error text, secret-scrubbed.
 */
export async function exportRunToLangfuse(
  run: ParsedRun,
  config: LangfuseConfig,
): Promise<LangfuseExportResult> {
  const spans = buildSpans(run, config.runMetadata);
  if (spans.length === 0) return { exported: 0, errors: [], traceIds: [] };
  const traceIds = [...new Set(spans.map((span) => span.traceId))];

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}${OTEL_TRACES_PATH}`;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, 'utf8').toString('base64')}`;
  const payload: OtelExportPayload = {
    resourceSpans: [{
      resource: { attributes: [stringAttr('service.name', INSTRUMENTATION_SCOPE)] },
      scopeSpans: [{ scope: { name: INSTRUMENTATION_SCOPE }, spans }],
    }],
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization,
        'x-langfuse-ingestion-version': INGESTION_VERSION,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { exported: 0, errors: [redactSecret(`Langfuse OTLP request failed: ${describeError(error)}`, config.secretKey)], traceIds };
  }

  const rawBody = await readResponseBody(response);
  const parsedBody = parseJsonBody(rawBody);

  if (!response.ok) {
    const detail = parsedBody !== undefined
      ? summarizeUnknownBody(parsedBody)
      : (rawBody.trim() ? rawBody.slice(0, 200) : describeError(new Error('empty body')));
    return {
      exported: 0,
      errors: [redactSecret(`Langfuse OTLP failed: HTTP ${response.status} ${detail}`, config.secretKey)],
      traceIds,
    };
  }

  if (parsedBody === undefined && rawBody.trim() !== '') {
    return { exported: 0, errors: [redactSecret(`Langfuse OTLP response was not JSON: ${rawBody.slice(0, 200)}`, config.secretKey)], traceIds };
  }

  const { rejected, message } = parsePartialSuccess(parsedBody);
  const exported = Math.max(0, spans.length - rejected);
  const diagnostic = message ?? (rejected > 0 ? `partialSuccess rejectedSpans=${rejected}: server rejected spans without an error message` : undefined);
  const errors = diagnostic ? [redactSecret(diagnostic, config.secretKey)] : [];
  return { exported, errors, traceIds };
}

/** Builds one complete OTEL span tree: a root per joined turn, then its generation children. */
function buildSpans(run: ParsedRun, runMetadata: LangfuseConfig['runMetadata']): OtelSpan[] {
  const spans: OtelSpan[] = [];
  for (const turn of joinTurns(run)) {
    // Wire records have no fingerprint: source position binds them to the owning turn.
    const previousTerminal = run.turns.filter(entry => entry.type === 'turn-terminal'
      && entry.requestId === turn.requestId && entry.lineIndex < (turn.terminal?.lineIndex ?? Infinity)).at(-1);
    const start = turn.start?.lineIndex ?? (previousTerminal ? previousTerminal.lineIndex + 1 : 0);
    const nextStart = run.turns.find(entry => entry.type === 'turn-start'
      && entry.requestId === turn.requestId && entry.lineIndex > start)?.lineIndex ?? Infinity;
    const end = turn.terminal?.lineIndex ?? nextStart - 1;
    const inTurn = (entry: { requestId: string; lineIndex: number }) =>
      entry.requestId === turn.requestId && entry.lineIndex >= start && entry.lineIndex <= end;
    const scopedRun: ParsedRun = { ...run, wire: run.wire.filter(inTurn) };
    const generations = run.generations.filter(inTurn);
    const identity = JSON.stringify([turn.requestId, turn.runFingerprint]);
    const traceId = otelTraceId(identity);
    const rootSpanId = otelSpanId(`${identity}:root`);
    const name = [runMetadata?.lane, runMetadata?.promptId].filter(Boolean).join('/') || turn.requestId;
    const { startIso, endIso } = turnBounds(turn, generations);
    const { input, output } = rootIo(scopedRun, generations);
    const shared = traceAttributes(turn, generations, runMetadata, name);

    spans.push({
      traceId,
      spanId: rootSpanId,
      name,
      kind: 1,
      startTimeUnixNano: toUnixNano(startIso),
      endTimeUnixNano: toUnixNano(endIso),
      attributes: [
        ...shared,
        stringAttr('langfuse.observation.type', 'span'),
        ...(input !== undefined ? [stringAttr('langfuse.observation.input', stringifyIo(input))] : []),
        ...(output !== undefined ? [stringAttr('langfuse.observation.output', stringifyIo(output))] : []),
      ],
      status: turnStatus(turn),
    });

    for (const generation of generations) {
      const { input: genInput, output: genOutput } = verboseContent(scopedRun, generation);
      const startTime = new Date(new Date(generation.at).getTime() - generation.latencyMs).toISOString();
      spans.push({
        traceId,
        spanId: otelSpanId(`${identity}:gen:${generation.generation}`),
        parentSpanId: rootSpanId,
        name: generation.phase ?? 'generation',
        kind: 1,
        startTimeUnixNano: toUnixNano(startTime),
        endTimeUnixNano: toUnixNano(generation.at),
        attributes: [
          ...shared,
          stringAttr('langfuse.observation.type', 'generation'),
          ...(generation.modelId ? [stringAttr('langfuse.observation.model.name', generation.modelId)] : []),
          ...(generation.usage
            ? [stringAttr('langfuse.observation.usage_details', JSON.stringify({
                input: generation.usage.inputTokens,
                output: generation.usage.outputTokens,
                total: generation.usage.totalTokens,
                ...(generation.usage.reasoningTokens !== undefined ? { reasoning: generation.usage.reasoningTokens } : {}),
              }))]
            : []),
          ...(generation.finishReason ? [stringAttr('langfuse.observation.metadata.finishReason', generation.finishReason)] : []),
          ...(generation.phase ? [stringAttr('langfuse.observation.metadata.phase', generation.phase)] : []),
          ...(genInput !== undefined ? [stringAttr('langfuse.observation.input', stringifyIo(genInput))] : []),
          ...(genOutput !== undefined ? [stringAttr('langfuse.observation.output', stringifyIo(genOutput))] : []),
        ],
        status: { code: 0 },
      });
    }

    for (const failure of scopedRun.wire) {
      if (failure.type !== 'wire-error' || failure.requestId !== turn.requestId) continue;
      const request = scopedRun.wire.find((entry) => entry.type === 'wire-request'
        && entry.requestId === failure.requestId && entry.generation === failure.generation);
      const failedInput = request?.type === 'wire-request' && request.system !== undefined
        ? { system: request.system, messages: request.messages }
        : undefined;
      spans.push({
        traceId,
        spanId: otelSpanId(`${identity}:error:${failure.generation}:${failure.lineIndex}`),
        parentSpanId: rootSpanId,
        name: failure.phase ?? 'generation',
        kind: 1,
        startTimeUnixNano: toUnixNano(request?.at ?? failure.at),
        endTimeUnixNano: toUnixNano(failure.at),
        attributes: [
          ...shared,
          stringAttr('langfuse.observation.type', 'generation'),
          stringAttr('langfuse.observation.level', 'ERROR'),
          ...(failure.phase ? [stringAttr('langfuse.observation.metadata.phase', failure.phase)] : []),
          ...(failedInput !== undefined ? [stringAttr('langfuse.observation.input', stringifyIo(failedInput))] : []),
        ],
        status: { code: 2, message: JSON.stringify(failure.diagnostic) },
      });
    }
  }
  return spans;
}

function traceAttributes(
  turn: JoinedTurn,
  generations: readonly GenerationEntry[],
  runMetadata: LangfuseConfig['runMetadata'],
  name: string,
): OtelAttribute[] {
  const attrs: OtelAttribute[] = [
    stringAttr('langfuse.trace.name', name),
    stringAttr('langfuse.trace.metadata.requestId', turn.requestId),
  ];
  if (runMetadata?.lane) attrs.push(stringAttr('langfuse.trace.metadata.lane', runMetadata.lane));
  if (runMetadata?.promptId) attrs.push(stringAttr('langfuse.trace.metadata.promptId', runMetadata.promptId));
  const modelId = generations[0]?.modelId;
  if (modelId) attrs.push(stringAttr('langfuse.trace.metadata.modelId', modelId));
  const outcome = turn.terminal?.status;
  if (outcome) attrs.push(stringAttr('langfuse.trace.metadata.outcome', outcome));
  if (turn.terminal?.modelCalls !== undefined) {
    attrs.push(stringAttr('langfuse.trace.metadata.modelCalls', String(turn.terminal.modelCalls)));
  }
  return attrs;
}

function rootIo(run: ParsedRun, generations: readonly GenerationEntry[]): { input?: unknown; output?: unknown } {
  let input: unknown;
  let output: unknown;
  for (const generation of generations) {
    const content = verboseContent(run, generation);
    if (content.input !== undefined && input === undefined) input = content.input;
    if (content.output !== undefined) output = content.output;
  }
  return { input, output };
}

function turnBounds(turn: JoinedTurn, generations: readonly GenerationEntry[]): { startIso: string; endIso: string } {
  const genStarts = generations.map((generation) => new Date(new Date(generation.at).getTime() - generation.latencyMs).toISOString());
  const startIso = turn.start?.at ?? genStarts[0] ?? generations[0]?.at ?? new Date().toISOString();
  const endIso = turn.terminal?.at ?? generations[generations.length - 1]?.at ?? startIso;
  return { startIso, endIso };
}

function turnStatus(turn: JoinedTurn): { readonly code: number; readonly message?: string } {
  if (turn.terminal?.status === 'error') {
    return { code: 2, message: turn.terminal.errorCode ?? turn.terminal.reason ?? 'error' };
  }
  return { code: 1 };
}

function otelTraceId(requestId: string): string {
  const compact = requestId.replace(/-/g, '').toLowerCase();
  if (UUID_HEX.test(compact)) return compact;
  return createHash('sha256').update(`langfuse-trace:${requestId}`).digest('hex').slice(0, 32);
}

function otelSpanId(seed: string): string {
  return createHash('sha256').update(`langfuse-span:${seed}`).digest('hex').slice(0, 16);
}

function toUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return `${BigInt(safe) * 1_000_000n}`;
}

function stringAttr(key: string, value: string): OtelAttribute {
  return { key, value: { stringValue: value } };
}

function stringifyIo(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJsonBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parsePartialSuccess(body: unknown): { rejected: number; message: string | undefined } {
  const shape = (body ?? {}) as OtelExportResponseShape;
  const partial = shape.partialSuccess;
  if (!partial) return { rejected: 0, message: undefined };
  const rejected = Number(partial.rejectedSpans ?? 0);
  const message = typeof partial.errorMessage === 'string' && partial.errorMessage
    ? `partialSuccess rejectedSpans=${Number.isFinite(rejected) ? rejected : 0}: ${partial.errorMessage}`
    : undefined;
  return { rejected: Number.isFinite(rejected) ? rejected : 0, message };
}

function summarizeUnknownBody(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 200);
  } catch {
    return '[unserializable response body]';
  }
}
