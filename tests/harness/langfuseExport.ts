/** Explicit Langfuse export through OTLP/HTTP JSON; no telemetry SDK or automatic transmission. */
import { createHash } from 'node:crypto';
import { joinTurns, type GenerationEntry, type JoinedTurn, type ParsedRun, type ToolEntry } from './traceModel';
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
    /** Groups every run of one evaluation into one Langfuse session. */
    readonly sessionId?: string;
    /** Filterable trace tags, e.g. the commit and the baseline/candidate arm. */
    readonly tags?: readonly string[];
  };
  /** Optional evidence files; each upload failure is reported in {@link LangfuseExportResult.errors} and never blocks the span export. */
  readonly attachments?: LangfuseAttachments;
}

/** A local file attached to a Langfuse trace through the media API. */
export interface LangfuseAttachment {
  /** Key under the trace's `attachments` metadata, e.g. `debug-log`. */
  readonly name: string;
  /** Types the media API accepts for plain text, JSON and Markdown evidence. */
  readonly contentType: 'text/plain' | 'application/json' | 'text/markdown';
  readonly content: string;
}

/** Evidence files to upload with the export; explicit opt-in because they can hold prompts and database metadata. */
export interface LangfuseAttachments {
  /** Attached to every exported trace (e.g. the event trace and the debug log). */
  readonly run?: readonly LangfuseAttachment[];
  /** Attached to the trace of the turn at the same index (e.g. that turn's answer and hop log). */
  readonly turns?: ReadonlyArray<readonly LangfuseAttachment[]>;
  /** Literal secrets removed from every attachment before it is hashed and uploaded. */
  readonly redact?: readonly string[];
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
const MEDIA_PATH = '/api/public/media';
/** Larger evidence files are skipped, not truncated: a partial trace would mislead. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const INGESTION_VERSION = '4';
const INSTRUMENTATION_SCOPE = 'data-lineage-viz-harness';
const UUID_HEX = /^[0-9a-f]{32}$/;

interface OtelAnyValue {
  readonly arrayValue?: { readonly values: readonly OtelAnyValue[] };
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
  const fetchImpl = config.fetchImpl ?? fetch;
  const attachmentErrors: string[] = [];
  const attachmentTokens = new Map<string, Record<string, string>>();
  if (config.attachments) {
    const turnTraceIds = joinTurns(run).map(turnTraceId);
    for (const [index, traceId] of turnTraceIds.entries()) {
      const files = [...(config.attachments.run ?? []), ...(config.attachments.turns?.[index] ?? [])];
      const { tokens, errors } = await uploadAttachments(config, fetchImpl, traceId, files);
      if (Object.keys(tokens).length) attachmentTokens.set(traceId, tokens);
      attachmentErrors.push(...errors);
    }
  }
  const spans = buildSpans(run, config.runMetadata, attachmentTokens);
  if (spans.length === 0) return { exported: 0, errors: attachmentErrors, traceIds: [] };
  const traceIds = [...new Set(spans.map((span) => span.traceId))];

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
    return { exported: 0, errors: [...attachmentErrors, redactSecret(`Langfuse OTLP request failed: ${describeError(error)}`, config.secretKey)], traceIds };
  }

  const rawBody = await readResponseBody(response);
  const parsedBody = parseJsonBody(rawBody);

  if (!response.ok) {
    const detail = parsedBody !== undefined
      ? summarizeUnknownBody(parsedBody)
      : (rawBody.trim() ? rawBody.slice(0, 200) : describeError(new Error('empty body')));
    return {
      exported: 0,
      errors: [...attachmentErrors, redactSecret(`Langfuse OTLP failed: HTTP ${response.status} ${detail}`, config.secretKey)],
      traceIds,
    };
  }

  if (parsedBody === undefined && rawBody.trim() !== '') {
    return { exported: 0, errors: [...attachmentErrors, redactSecret(`Langfuse OTLP response was not JSON: ${rawBody.slice(0, 200)}`, config.secretKey)], traceIds };
  }

  const { rejected, message } = parsePartialSuccess(parsedBody);
  const exported = Math.max(0, spans.length - rejected);
  const diagnostic = message ?? (rejected > 0 ? `partialSuccess rejectedSpans=${rejected}: server rejected spans without an error message` : undefined);
  const errors = [...attachmentErrors, ...(diagnostic ? [redactSecret(diagnostic, config.secretKey)] : [])];
  return { exported, errors, traceIds };
}

/** Builds one complete OTEL span tree: a root per joined turn, then its generation children. */
function buildSpans(
  run: ParsedRun,
  runMetadata: LangfuseConfig['runMetadata'],
  attachmentTokens: ReadonlyMap<string, Record<string, string>>,
): OtelSpan[] {
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
    const tools = run.tools.filter(inTurn);
    const identity = turnIdentity(turn);
    const traceId = otelTraceId(identity);
    const rootSpanId = otelSpanId(`${identity}:root`);
    const name = [runMetadata?.lane, runMetadata?.promptId].filter(Boolean).join('/') || turn.requestId;
    const { startIso, endIso } = turnBounds(turn, generations);
    const { input, output } = rootIo(scopedRun, generations);
    const shared = traceAttributes(turn, generations, tools, runMetadata, name, attachmentTokens.get(traceId));

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

    for (const tool of tools) {
      spans.push(toolSpan(tool, traceId, rootSpanId, identity, shared));
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

/**
 * One tool dispatch as a Langfuse `tool` observation.
 *
 * @remarks
 * A rejection is a `WARNING` and a thrown handler an `ERROR`, so rejections are countable in the
 * backend. A consent `gate` stays at the default level: it is a control outcome, not a fault. Only
 * bounded identifiers are exported (status, code, field paths); tool arguments and results are not.
 */
function toolSpan(
  tool: ToolEntry,
  traceId: string,
  rootSpanId: string,
  identity: string,
  shared: readonly OtelAttribute[],
): OtelSpan {
  const level = tool.status === 'rejected' ? 'WARNING' : tool.status === 'dispatch_error' ? 'ERROR' : 'DEFAULT';
  const startTime = new Date(new Date(tool.at).getTime() - tool.durationMs).toISOString();
  return {
    traceId,
    spanId: otelSpanId(`${identity}:tool:${tool.seq}:${tool.lineIndex}`),
    parentSpanId: rootSpanId,
    name: `tool:${tool.toolName}`,
    kind: 1,
    startTimeUnixNano: toUnixNano(startTime),
    endTimeUnixNano: toUnixNano(tool.at),
    attributes: [
      ...shared,
      stringAttr('langfuse.observation.type', 'tool'),
      stringAttr('langfuse.observation.level', level),
      stringAttr('langfuse.observation.metadata.status', tool.status),
      stringAttr('langfuse.observation.metadata.phase', tool.phase),
      stringAttr('langfuse.observation.metadata.seq', String(tool.seq)),
      ...(tool.rejectionCode ? [stringAttr('langfuse.observation.metadata.rejectionCode', tool.rejectionCode)] : []),
      ...(tool.issuePaths?.length ? [stringAttr('langfuse.observation.metadata.issuePaths', tool.issuePaths.join(','))] : []),
    ],
    status: tool.status === 'dispatch_error' ? { code: 2, message: 'dispatch_error' } : { code: 1 },
  };
}

function traceAttributes(
  turn: JoinedTurn,
  generations: readonly GenerationEntry[],
  tools: readonly ToolEntry[],
  runMetadata: LangfuseConfig['runMetadata'],
  name: string,
  attachments?: Record<string, string>,
): OtelAttribute[] {
  const attrs: OtelAttribute[] = [
    stringAttr('langfuse.trace.name', name),
    stringAttr('langfuse.trace.metadata.requestId', turn.requestId),
  ];
  if (runMetadata?.sessionId) attrs.push(stringAttr('langfuse.session.id', runMetadata.sessionId));
  if (runMetadata?.tags?.length) {
    attrs.push({ key: 'langfuse.trace.tags', value: { arrayValue: { values: runMetadata.tags.map(tag => ({ stringValue: tag })) } } });
  }
  // Top-level scalar keys only: Langfuse filters on top-level metadata keys.
  const byStatus = (status: ToolEntry['status']) => tools.filter(tool => tool.status === status).length;
  const codes = new Map<string, number>();
  for (const tool of tools) if (tool.rejectionCode && tool.status === 'rejected') codes.set(tool.rejectionCode, (codes.get(tool.rejectionCode) ?? 0) + 1);
  attrs.push(
    stringAttr('langfuse.trace.metadata.toolCalls', String(tools.length)),
    stringAttr('langfuse.trace.metadata.rejections', String(byStatus('rejected'))),
    stringAttr('langfuse.trace.metadata.gates', String(byStatus('gate'))),
    stringAttr('langfuse.trace.metadata.refusals', String(byStatus('refused'))),
    stringAttr('langfuse.trace.metadata.notEvaluated', String(byStatus('not_evaluated'))),
    stringAttr('langfuse.trace.metadata.dispatchErrors', String(byStatus('dispatch_error'))),
  );
  if (attachments) attrs.push(stringAttr('langfuse.trace.metadata.attachments', JSON.stringify(attachments)));
  if (codes.size) attrs.push(stringAttr('langfuse.trace.metadata.rejectionCodes', JSON.stringify(Object.fromEntries(codes))));
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

/**
 * The root span's input and output: the first captured request and the last response. A turn whose
 * generations all failed has no response, so its input comes from the first captured request and
 * its output is the last provider failure.
 */
function rootIo(run: ParsedRun, generations: readonly GenerationEntry[]): { input?: unknown; output?: unknown } {
  let input: unknown;
  let output: unknown;
  for (const generation of generations) {
    const content = verboseContent(run, generation);
    if (content.input !== undefined && input === undefined) input = content.input;
    if (content.output !== undefined) output = content.output;
  }
  if (input === undefined) {
    const request = run.wire.find(entry => entry.type === 'wire-request' && entry.system !== undefined);
    if (request?.type === 'wire-request') input = { system: request.system, messages: request.messages };
  }
  if (output === undefined) {
    const failure = run.wire.filter(entry => entry.type === 'wire-error').at(-1);
    if (failure?.type === 'wire-error') output = { error: failure.diagnostic };
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

function turnIdentity(turn: JoinedTurn): string {
  return JSON.stringify([turn.requestId, turn.runFingerprint]);
}

function turnTraceId(turn: JoinedTurn): string {
  return otelTraceId(turnIdentity(turn));
}

/**
 * Uploads evidence files through the media API and returns the reference token for each.
 *
 * @remarks
 * Per file: request an upload URL for the trace, `PUT` the bytes with their SHA-256, then confirm the
 * upload. Literal secrets are removed before hashing. A file that fails or exceeds the size limit is
 * reported and skipped; it never blocks the span export. A file already stored under the same hash
 * comes back without an upload URL and is referenced as is.
 */
async function uploadAttachments(
  config: LangfuseConfig,
  fetchImpl: typeof fetch,
  traceId: string,
  files: readonly LangfuseAttachment[],
): Promise<{ tokens: Record<string, string>; errors: string[] }> {
  const tokens: Record<string, string> = {};
  const errors: string[] = [];
  const base = config.baseUrl.replace(/\/+$/, '');
  const secrets = [config.secretKey, ...(config.attachments?.redact ?? [])].filter(Boolean);
  const headers = {
    'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, 'utf8').toString('base64')}`,
  };
  for (const file of files) {
    try {
      const bytes = Buffer.from(secrets.reduce((text, secret) => redactSecret(text, secret), file.content), 'utf8');
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        errors.push(`Attachment ${file.name} skipped: ${bytes.length} bytes exceeds ${MAX_ATTACHMENT_BYTES}.`);
        continue;
      }
      const sha256 = createHash('sha256').update(bytes).digest('base64');
      const created = await fetchImpl(`${base}${MEDIA_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ traceId, field: 'metadata', contentType: file.contentType, contentLength: bytes.length, sha256Hash: sha256 }),
      });
      if (!created.ok) {
        errors.push(`Attachment ${file.name} not stored: media request HTTP ${created.status}.`);
        continue;
      }
      const { mediaId, uploadUrl } = await created.json() as { mediaId?: string; uploadUrl?: string | null };
      if (!mediaId) {
        errors.push(`Attachment ${file.name} not stored: media response had no id.`);
        continue;
      }
      if (uploadUrl) {
        const started = Date.now();
        const uploaded = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': file.contentType, 'x-amz-checksum-sha256': sha256 },
          body: bytes,
        });
        await fetchImpl(`${base}${MEDIA_PATH}/${mediaId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ uploadedAt: new Date().toISOString(), uploadHttpStatus: uploaded.status, uploadTimeMs: Date.now() - started }),
        });
        if (!uploaded.ok) {
          errors.push(`Attachment ${file.name} not stored: upload HTTP ${uploaded.status}.`);
          continue;
        }
      }
      tokens[file.name] = `@@@langfuseMedia:type=${file.contentType}|id=${mediaId}|source=bytes@@@`;
    } catch (error) {
      errors.push(redactSecret(`Attachment ${file.name} failed: ${describeError(error)}`, config.secretKey));
    }
  }
  return { tokens, errors };
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
