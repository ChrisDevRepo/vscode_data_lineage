/**
 * Stage replay: re-sends one recorded provider request from a verbose headless trace, with exact
 * text substitutions applied to its message contents, and records what came back.
 *
 * The same substitutions also export a provider-free screening bundle for a small-model reviewer,
 * and `check` validates that reviewer's reply against the bundled tool schemas. Replay is an
 * optional, paid tier: it never runs under `npm test` or the gate; the unit tests drive it with a
 * fake fetch. See `.agents/skills/prompt-playground/SKILL.md` for the tiers.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/** Response surface the replay reads; satisfied by the global `fetch` response. */
export interface ReplayResponse {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Request transport; the default is the global `fetch`. */
export type ReplayFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<ReplayResponse>;

/** One `provider-raw` request record from an lm-trace NDJSON file. */
export interface RecordedRequest {
  readonly requestId: string;
  readonly generation: number;
  readonly phase?: string;
  readonly url: string;
  readonly body: ChatBody;
}

/** The recorded Chat Completions body; only `messages` is read structurally. */
export interface ChatBody {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

/** One exact text substitution: every occurrence of `old` in message contents becomes `new`. */
export interface Substitution {
  readonly old: string;
  readonly new: string;
}

/** Per-substitution result; `old` is a bounded preview, not the full text. */
export interface AppliedSubstitution {
  readonly old: string;
  readonly hits: number;
}

/** Thrown before any request is sent when the replay cannot be performed as specified. */
export class ReplayRefusal extends Error {}

const SubstitutionsSchema = z.array(z.object({ old: z.string().min(1), new: z.string() }).strict());
const RecordSchema = z.object({
  type: z.literal('provider-raw'),
  direction: z.literal('request'),
  requestId: z.string(),
  generation: z.number().int().min(0),
  phase: z.string().optional(),
  url: z.string(),
  body: z.object({ messages: z.array(z.object({ role: z.string() }).passthrough()) }).passthrough(),
}).passthrough();

const CHAT_COMPLETIONS = '/chat/completions';
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const PREVIEW_CHARS = 80;

/**
 * Parses an lm-trace NDJSON text into its `provider-raw` request records.
 *
 * Lines that are not JSON objects are counted in `skipped`; well-formed records of other types are
 * ignored without counting.
 */
export function readRecordedRequests(text: string): { requests: RecordedRequest[]; skipped: number } {
  const requests: RecordedRequest[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      skipped += 1;
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.type !== 'provider-raw' || record.direction !== 'request') continue;
    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const { requestId, generation, phase, url, body } = parsed.data;
    requests.push({ requestId, generation, ...(phase ? { phase } : {}), url, body: body as ChatBody });
  }
  return { requests, skipped };
}

/** Text of one message content: a string, or the `text` parts of a content-part array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text : ''))
    .join('');
}

/** The `focus_node.id` named in the last user message that carries one, when present. */
export function focusNodeOf(body: ChatBody): string | undefined {
  const pattern = /"focus_node"\s*:\s*\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"/u;
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    if (body.messages[i].role !== 'user') continue;
    const match = pattern.exec(contentText(body.messages[i].content));
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1];
      }
    }
  }
  return undefined;
}

/** One row of the generation listing. */
export interface GenerationRow {
  readonly requestId: string;
  readonly generation: number;
  readonly phase: string | null;
  readonly focusNode: string | null;
  readonly messages: number;
  readonly requestChars: number;
}

/**
 * Lists the recorded requests in trace order.
 *
 * @param needle - When given, keeps only requests whose message text contains it (case-sensitive).
 */
export function listGenerations(requests: readonly RecordedRequest[], needle?: string): GenerationRow[] {
  return requests
    .filter((request) => !needle || request.body.messages.some((message) => contentText(message.content).includes(needle)))
    .map((request) => ({
      requestId: request.requestId,
      generation: request.generation,
      phase: request.phase ?? null,
      focusNode: focusNodeOf(request.body) ?? null,
      messages: request.body.messages.length,
      requestChars: JSON.stringify(request.body).length,
    }));
}

/**
 * Selects the one request for a generation.
 *
 * Generation numbers restart in every turn, so a multi-turn trace needs `requestIdPrefix`.
 *
 * @throws {ReplayRefusal} When no request, or more than one, matches.
 */
export function selectRequest(
  requests: readonly RecordedRequest[],
  generation: number,
  requestIdPrefix?: string,
): RecordedRequest {
  const matches = requests.filter((request) => request.generation === generation
    && (!requestIdPrefix || request.requestId.startsWith(requestIdPrefix)));
  if (matches.length === 0) throw new ReplayRefusal(`No provider-raw request for generation ${generation}${requestIdPrefix ? ` in request ${requestIdPrefix}` : ''}. Record the trace with --trace-verbose.`);
  if (matches.length > 1) {
    const ids = matches.map((request) => request.requestId).join(', ');
    throw new ReplayRefusal(`Generation ${generation} occurs in ${matches.length} requests (${ids}); pass --request-id.`);
  }
  return matches[0];
}

/**
 * Validates the recorded URL for replay and collapses a doubled `/chat/completions` suffix that
 * traces record when the configured endpoint already ended in that route.
 *
 * @throws {ReplayRefusal} For a non-HTTPS URL or one with embedded credentials.
 */
export function replayUrl(recorded: string): { url: string; legacySuffixFixed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(recorded);
  } catch {
    throw new ReplayRefusal('The recorded request URL is not an absolute URL.');
  }
  if (parsed.protocol !== 'https:') throw new ReplayRefusal('The recorded request URL must use HTTPS.');
  if (parsed.username || parsed.password) throw new ReplayRefusal('The recorded request URL must not embed credentials.');
  const doubled = new RegExp(`(?:${CHAT_COMPLETIONS.replaceAll('/', '\\/')}){2,}$`, 'u');
  const legacySuffixFixed = doubled.test(parsed.pathname);
  if (legacySuffixFixed) parsed.pathname = parsed.pathname.replace(doubled, CHAT_COMPLETIONS);
  return { url: parsed.toString(), legacySuffixFixed };
}

/** Origin and path of a URL with query values removed, for a report. */
function urlSummary(url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.keys()];
  return `${parsed.origin}${parsed.pathname}${params.length ? `?${params.map((name) => `${name}=…`).join('&')}` : ''}`;
}

/** Validates a substitutions document (`[{ "old": "...", "new": "..." }]`). */
export function parseSubstitutions(json: unknown): Substitution[] {
  const parsed = SubstitutionsSchema.safeParse(json);
  if (!parsed.success) throw new ReplayRefusal('Substitutions must be a JSON array of {"old": non-empty string, "new": string}.');
  return parsed.data;
}

/**
 * Applies substitutions in order to a copy of the body's message contents (string content and the
 * `text` of content parts). Tool definitions and other fields are left unchanged.
 *
 * @throws {ReplayRefusal} When any `old` text occurs nowhere; nothing may be sent then.
 */
export function applySubstitutions(body: ChatBody, substitutions: readonly Substitution[]): {
  body: ChatBody;
  applied: AppliedSubstitution[];
} {
  const copy = structuredClone(body);
  const applied = substitutions.map(({ old, new: replacement }) => {
    let hits = 0;
    const replace = (text: string) => {
      const pieces = text.split(old);
      hits += pieces.length - 1;
      return pieces.join(replacement);
    };
    for (const message of copy.messages) {
      if (typeof message.content === 'string') message.content = replace(message.content);
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
            (part as { text: string }).text = replace((part as { text: string }).text);
          }
        }
      }
    }
    return { old: old.length > PREVIEW_CHARS ? `${old.slice(0, PREVIEW_CHARS)}…` : old, hits };
  });
  const missing = applied.filter((entry) => entry.hits === 0);
  if (missing.length) {
    throw new ReplayRefusal(`Substitution text not found; nothing sent: ${missing.map((entry) => JSON.stringify(entry.old)).join(', ')}`);
  }
  return { body: copy, applied };
}

/** The fixed last line of every screening prompt. */
export const SCREENING_REPLY_INSTRUCTION = 'Reply with exactly one JSON object {"tool": <name>, "arguments": {...}} for the tool call the conversation asks for, and nothing else.';

/** A fenced block whose fence is longer than any backtick run inside `text`. */
function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

interface ToolDefinition { name: string; description: string; parameters: unknown }

/** The function tools of a recorded body, in order. */
export function toolDefinitions(body: ChatBody): ToolDefinition[] {
  return (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) => {
    const fn = (tool as { function?: { name?: unknown; description?: unknown; parameters?: unknown } } | null)?.function;
    return fn && typeof fn.name === 'string'
      ? [{ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters ?? {} }]
      : [];
  });
}

/** Text of the body's first message when it is a system message, exactly as served; else empty. */
export function servedSystemText(body: ChatBody): string {
  const first = body.messages[0];
  return first?.role === 'system' ? contentText(first.content) : '';
}

/**
 * Renders a self-contained screening prompt from a (substituted) body: every message in order with
 * its role, assistant tool calls and tool results, then each tool's name, description and JSON
 * parameter schema, then {@link SCREENING_REPLY_INSTRUCTION}. With `afterSystem`, the leading
 * system message is left out (it is sent as the screening model's own system prompt, see
 * {@link servedSystemText}) and message numbering still follows the served order.
 */
export function renderScreeningPrompt(body: ChatBody, options: { afterSystem?: boolean } = {}): string {
  const skipFirst = options.afterSystem === true && body.messages[0]?.role === 'system';
  const lead = skipFirst
    ? 'The messages below continue the conversation after your system prompt, in order. The tools follow them.'
    : 'The messages below are one conversation, in order. The tools follow it.';
  const parts: string[] = ['# Screening prompt', '', lead, ''];
  body.messages.forEach((message, index) => {
    if (skipFirst && index === 0) return;
    const callId = typeof message.tool_call_id === 'string' ? ` (result of call ${message.tool_call_id})` : '';
    parts.push(`## Message ${index + 1}: ${message.role}${callId}`, '');
    const text = contentText(message.content);
    if (text) parts.push(fenced(text), '');
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      parts.push('Tool calls:', '', fenced(JSON.stringify(message.tool_calls, null, 1), 'json'), '');
    }
  });
  parts.push('## Tools', '');
  for (const tool of toolDefinitions(body)) {
    parts.push(`### ${tool.name}`, '', fenced(tool.description), '', 'Parameters (JSON Schema):', '', fenced(JSON.stringify(tool.parameters, null, 1), 'json'), '');
  }
  const choice = body.tool_choice as { function?: { name?: unknown } } | string | undefined;
  const named = typeof choice === 'object' && typeof choice?.function?.name === 'string' ? choice.function.name : undefined;
  parts.push('## Reply', '');
  if (named) parts.push(`The conversation requires a call to \`${named}\`.`, '');
  else if (choice === 'required') parts.push('The conversation requires a tool call.', '');
  parts.push(SCREENING_REPLY_INSTRUCTION, '');
  return parts.join('\n');
}

/** Result of checking one screening reply. */
export interface CheckResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly tool: string | null;
  readonly arguments: unknown;
}

/**
 * Checks a small-model reply against a screening bundle's tools: the reply (bare, or inside a
 * fenced `json` block) must be one JSON object `{tool, arguments}` naming a bundled tool, and
 * `arguments` must satisfy that tool's JSON parameter schema and the call must obey tool_choice.
 */
export function checkReply(reply: string, body: ChatBody): CheckResult {
  // Fence markers stand on their own lines: a ``` inside a JSON string value (an escaped SQL
  // fence in section text) is mid-line and does not close the block.
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/imu.exec(reply);
  const source = (fence ? fence[1] : reply).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { valid: false, errors: ['reply is not one JSON object'], tool: null, arguments: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['reply is not one JSON object'], tool: null, arguments: null };
  }
  const { tool, arguments: args } = parsed as { tool?: unknown; arguments?: unknown };
  const errors: string[] = [];
  const extra = Object.keys(parsed).filter((key) => key !== 'tool' && key !== 'arguments');
  if (extra.length) errors.push(`unexpected reply keys: ${extra.join(', ')}`);
  if (typeof tool !== 'string') return { valid: false, errors: [...errors, '`tool` must be a string'], tool: null, arguments: args ?? null };
  const definition = toolDefinitions(body).find((candidate) => candidate.name === tool);
  if (!definition) return { valid: false, errors: [...errors, `unknown tool ${tool}`], tool, arguments: args ?? null };
  const choice = body.tool_choice as { function?: { name?: unknown } } | string | undefined;
  const named = typeof choice === 'object' && typeof choice?.function?.name === 'string' ? choice.function.name : undefined;
  if (named && tool !== named) errors.push(`tool_choice requires ${named}`);
  if (choice === 'none') errors.push('tool_choice does not allow a tool call');
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, errors: [...errors, '`arguments` must be a JSON object'], tool, arguments: args ?? null };
  }
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(definition.parameters as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return { valid: false, errors: [...errors, `schema of ${tool} could not be loaded`], tool, arguments: args };
  }
  const result = schema.safeParse(args);
  if (!result.success) {
    for (const issue of result.error.issues) errors.push(`${issue.path.join('.') || '(arguments)'}: ${issue.message}`);
  }
  return { valid: errors.length === 0, errors, tool, arguments: args };
}

/** Removes the key literal and any `Bearer` token from a text. */
export function redact(text: string, secret: string | undefined): string {
  const withoutKey = secret ? text.split(secret).join('[redacted]') : text;
  return withoutKey.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]');
}

/** Applies {@link redact} to every string inside a JSON value. */
function redactDeep(value: unknown, secret: string | undefined): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? redact(item, secret) : item)));
}

/** How the key is presented: `Authorization: Bearer` or Azure's `api-key` header. */
export type AuthScheme = 'bearer' | 'api-key';

/** Outcome of one sample. `body` is parsed JSON when possible, else redacted text. */
export interface SendResult {
  readonly status: number | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly body: unknown;
  readonly error?: string;
}

/**
 * Posts one body, retrying 429/502/503/504 and transport failures up to `maxAttempts`, honoring a
 * `Retry-After` header in seconds (capped at 60 s).
 */
export async function sendWithRetry(options: {
  url: string;
  body: string;
  apiKey: string;
  auth: AuthScheme;
  fetchImpl: ReplayFetch;
  maxAttempts: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<SendResult> {
  const headers: Record<string, string> = options.auth === 'api-key'
    ? { 'content-type': 'application/json', 'api-key': options.apiKey }
    : { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  const started = options.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let status: number | null = null;
    let text = '';
    let retryAfterMs: number | undefined;
    let error: string | undefined;
    try {
      const response = await options.fetchImpl(options.url, {
        method: 'POST', headers, body: options.body, signal: AbortSignal.timeout(options.timeoutMs),
      });
      status = response.status;
      text = await response.text();
      const retryAfter = Number(response.headers?.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) retryAfterMs = Math.min(retryAfter * 1000, 60_000);
    } catch (thrown) {
      error = redact(thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : 'transport failure', options.apiKey);
    }
    const transient = status === null || RETRY_STATUSES.has(status);
    if (!transient || attempt >= options.maxAttempts) {
      let body: unknown = null;
      if (status !== null) {
        try {
          body = redactDeep(JSON.parse(text), options.apiKey);
        } catch {
          body = redact(text, options.apiKey);
        }
      }
      return { status, attempts: attempt, latencyMs: options.now() - started, body, ...(error ? { error } : {}) };
    }
    await options.sleep(retryAfterMs ?? 5_000 * attempt);
  }
}

/** Parsed `replay` options. */
export interface ReplayOptions {
  trace: string;
  generation: number;
  requestId?: string;
  substitutions?: string;
  samples: number;
  out?: string;
  arm: string;
  maxAttempts: number;
  timeoutMs: number;
  auth?: AuthScheme;
  dryRun: boolean;
  exportDir?: string;
}

const ReplayOptionsSchema = z.object({
  trace: z.string().min(1),
  generation: z.coerce.number().int().min(0),
  requestId: z.string().min(1).optional(),
  substitutions: z.string().min(1).optional(),
  samples: z.coerce.number().int().min(1).max(50).default(1),
  out: z.string().min(1).optional(),
  arm: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/u).default('arm'),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  timeoutMs: z.coerce.number().int().min(1_000).max(7_200_000).default(900_000),
  auth: z.enum(['bearer', 'api-key']).optional(),
  dryRun: z.boolean().default(false),
  exportDir: z.string().min(1).optional(),
}).strict().refine((value) => !(value.dryRun && value.exportDir), { path: ['dryRun'], message: '--dry-run and --export exclude each other' });

const FLAG_NAMES: Record<string, keyof ReplayOptions> = {
  '--trace': 'trace', '--generation': 'generation', '--request-id': 'requestId', '--subs': 'substitutions',
  '--samples': 'samples', '--out': 'out', '--arm': 'arm', '--max-attempts': 'maxAttempts',
  '--timeout-ms': 'timeoutMs', '--auth': 'auth', '--export': 'exportDir',
};

/** Parses `replay` flags; rejects unknown flags and invalid values before any file or network access. */
export function parseReplayArgs(args: readonly string[]): ReplayOptions {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--dry-run') {
      raw.dryRun = true;
      continue;
    }
    const name = FLAG_NAMES[flag];
    if (!name) throw new ReplayRefusal(`Unknown option ${flag}. Use --help.`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ReplayRefusal(`${flag} requires a value.`);
    raw[name] = value;
    i += 1;
  }
  const parsed = ReplayOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayRefusal(`Invalid options: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'arguments').join(', ')}. Use --help.`);
  }
  return parsed.data as ReplayOptions;
}

/**
 * Resolves the output directory. Inside the repository it must be under ignored `test-results/`.
 *
 * @throws {ReplayRefusal} For a repository path outside `test-results/`.
 */
export function resolveOutDir(repoRoot: string, out: string | undefined, runId: string): string {
  const dir = out ? resolve(repoRoot, out) : join(repoRoot, 'test-results', 'stage-replay', runId);
  const fromRoot = relative(repoRoot, dir);
  const insideRepo = fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  const underResults = insideRepo && fromRoot.split(sep)[0] === 'test-results';
  if (insideRepo && !underResults) throw new ReplayRefusal('--out inside the repository must be under test-results/ (ignored).');
  return dir;
}

/** Runtime seams for {@link runReplay} and {@link main}. */
export interface ReplayDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: ReplayFetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** Summary line values from a Chat Completions response body. */
function responseShape(body: unknown): { toolCalls: number; textChars: number; finishReason: string | null; usage: unknown } {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const choice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  return {
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    textChars: typeof message?.content === 'string' ? message.content.length : 0,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: record.usage ?? null,
  };
}

/**
 * Replays one recorded request `samples` times and writes one JSON file per sample.
 *
 * All refusals (missing record, missing substitution text, non-HTTPS URL, missing key, output
 * outside an ignored directory) happen before the first request. The key is never written or
 * logged; response and error text are redacted.
 *
 * @returns Paths written and whether every sample returned HTTP 2xx.
 */
export async function runReplay(options: ReplayOptions, deps: ReplayDeps): Promise<{ files: string[]; ok: boolean; outDir: string }> {
  const { requests } = readRecordedRequests(readFileSync(resolve(deps.repoRoot, options.trace), 'utf8'));
  const recorded = selectRequest(requests, options.generation, options.requestId);
  const substitutions = options.substitutions
    ? parseSubstitutions(JSON.parse(readFileSync(resolve(deps.repoRoot, options.substitutions), 'utf8')))
    : [];
  const { body, applied } = applySubstitutions(recorded.body, substitutions);
  if (options.exportDir) {
    const bundleDir = resolveOutDir(deps.repoRoot, options.exportDir, '');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'prompt.md'), renderScreeningPrompt(body));
    writeFileSync(join(bundleDir, 'system.md'), servedSystemText(body));
    writeFileSync(join(bundleDir, 'user.md'), renderScreeningPrompt(body, { afterSystem: true }));
    writeFileSync(join(bundleDir, 'request.json'), `${JSON.stringify(body, null, 1)}\n`);
    const manifest = {
      tool: 'stage-replay', bundle: 'screening', arm: options.arm, trace: basename(options.trace),
      requestId: recorded.requestId, generation: recorded.generation, phase: recorded.phase ?? null,
      focusNode: focusNodeOf(recorded.body) ?? null, model: typeof body.model === 'string' ? body.model : null,
      reasoningEffort: (typeof body.reasoning_effort === 'string' ? body.reasoning_effort : deps.env.AI_TEST_REASONING_EFFORT?.trim()) || null,
      substitutions: applied,
    };
    writeFileSync(join(bundleDir, 'bundle.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    deps.log(`${options.arm} export substitutions=${JSON.stringify(applied.map((entry) => entry.hits))} written: ${bundleDir}`);
    return { files: ['prompt.md', 'system.md', 'user.md', 'request.json', 'bundle.json'].map((name) => join(bundleDir, name)), ok: true, outDir: bundleDir };
  }
  const { url, legacySuffixFixed } = replayUrl(recorded.url);
  const effort = deps.env.AI_TEST_REASONING_EFFORT?.trim();
  const reasoningEffortAdded = body.reasoning_effort === undefined && Boolean(effort);
  if (reasoningEffortAdded) body.reasoning_effort = effort;
  const apiKey = deps.env.AI_TEST_API_KEY?.trim() ?? '';
  if (!options.dryRun && !apiKey) throw new ReplayRefusal('Set AI_TEST_API_KEY (or a provider profile) to send; use --dry-run to check substitutions only.');
  const auth: AuthScheme = options.auth ?? (deps.env.AI_TEST_PROVIDER?.trim().toLowerCase() === 'azure' ? 'api-key' : 'bearer');
  const outDir = resolveOutDir(deps.repoRoot, options.out, `${new Date(deps.now()).toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(outDir, { recursive: true });

  const payload = JSON.stringify(body);
  const request = {
    trace: basename(options.trace),
    requestId: recorded.requestId,
    generation: recorded.generation,
    phase: recorded.phase ?? null,
    focusNode: focusNodeOf(recorded.body) ?? null,
    model: body.model ?? null,
    url: urlSummary(url),
    legacySuffixFixed,
    auth,
    messages: body.messages.length,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    toolChoice: body.tool_choice ?? null,
    reasoningEffort: body.reasoning_effort ?? null,
    reasoningEffortAdded,
    requestChars: payload.length,
    bodySha256: createHash('sha256').update(payload).digest('hex'),
  };
  const files: string[] = [];
  let ok = true;
  for (let sample = 1; sample <= (options.dryRun ? 1 : options.samples); sample += 1) {
    const result: SendResult | null = options.dryRun ? null : await sendWithRetry({
      url, body: payload, apiKey, auth, fetchImpl: deps.fetchImpl, maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs, sleep: deps.sleep, now: deps.now,
    });
    const shape = result ? responseShape(result.body) : null;
    const record = {
      tool: 'stage-replay',
      arm: options.arm,
      sample,
      dryRun: options.dryRun,
      request,
      substitutions: applied,
      ...(result ? {
        status: result.status, attempts: result.attempts, latencyMs: result.latencyMs,
        finishReason: shape!.finishReason, toolCalls: shape!.toolCalls, textChars: shape!.textChars, usage: shape!.usage,
        ...(result.error ? { error: result.error } : {}), response: result.body,
      } : {}),
    };
    const file = join(outDir, `${options.arm}-sample-${String(sample).padStart(2, '0')}${options.dryRun ? '-dry-run' : ''}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
    files.push(file);
    if (result) {
      const success = result.status !== null && result.status >= 200 && result.status < 300;
      ok &&= success;
      deps.log(`${options.arm} sample=${sample} status=${result.status ?? 'error'} attempts=${result.attempts} latencyMs=${result.latencyMs}`
        + ` finish=${shape!.finishReason ?? '-'} toolCalls=${shape!.toolCalls} textChars=${shape!.textChars} usage=${JSON.stringify(shape!.usage)}`);
    } else {
      deps.log(`${options.arm} dry-run substitutions=${JSON.stringify(applied.map((entry) => entry.hits))} requestChars=${payload.length}`);
    }
  }
  deps.log(`written: ${outDir}`);
  return { files, ok, outDir };
}

const HELP = `Stage replay and screening export (optional; replay calls a real provider and may incur cost):
  node tests/tools/stage-replay.mjs find --trace FILE [--needle TEXT] [--json]
  node tests/tools/stage-replay.mjs replay --trace FILE --generation N [--request-id ID]
      [--subs FILE] [--samples N] [--arm LABEL] [--out DIR] [--max-attempts N]
      [--timeout-ms N] [--auth bearer|api-key] [--dry-run | --export DIR]
  node tests/tools/stage-replay.mjs check BUNDLE_DIR REPLY_FILE [--out FILE]
FILE is an lm-trace NDJSON from npm run test:ai:headless -- --trace-verbose.
--subs is a JSON array of exact {"old","new"} message-text substitutions; if any old
text is absent nothing is sent or exported. The key comes from AI_TEST_API_KEY (or the
selected AI_TEST_PROVIDER profile) and is never printed or written. Replay writes one
JSON per sample under ignored test-results/stage-replay/ unless --out names a directory
outside the repository. --export writes a screening bundle (prompt.md, system.md, user.md,
request.json, bundle.json) without calling a provider; check validates a saved reply against that
bundle's tool schemas and writes BUNDLE_DIR/check.json (or --out).
Exit codes: 0 success or valid reply, 2 a sample failed or reply invalid, 4 refused.`;

/**
 * Checks a saved reply file against a screening bundle and writes the {@link CheckResult}.
 *
 * @returns The result and the path written.
 */
export function runCheck(bundle: string, replyFile: string, out: string | undefined, repoRoot: string): { result: CheckResult; file: string } {
  const bundleDir = resolve(repoRoot, bundle);
  const body = JSON.parse(readFileSync(join(bundleDir, 'request.json'), 'utf8')) as ChatBody;
  if (!body || !Array.isArray(body.tools)) throw new ReplayRefusal('The bundle request.json has no tools array.');
  const result = checkReply(readFileSync(resolve(repoRoot, replyFile), 'utf8'), body);
  const file = out ? resolve(repoRoot, out) : join(bundleDir, 'check.json');
  resolveOutDir(repoRoot, dirname(file), '');
  writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
  return { result, file };
}

/** Parses `check` arguments: two positionals and an optional `--out FILE`. */
function parseCheckArgs(args: readonly string[]): { bundle: string; reply: string; out?: string } {
  const positionals: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') {
      out = args[i + 1];
      if (!out || out.startsWith('--')) throw new ReplayRefusal('--out requires a value.');
      i += 1;
    } else if (args[i].startsWith('--')) throw new ReplayRefusal(`Unknown option ${args[i]}. Use --help.`);
    else positionals.push(args[i]);
  }
  if (positionals.length !== 2) throw new ReplayRefusal('check takes BUNDLE_DIR and REPLY_FILE.');
  return { bundle: positionals[0], reply: positionals[1], ...(out ? { out } : {}) };
}

/** Parses `find` flags. */
function parseFindArgs(args: readonly string[]): { trace: string; needle?: string; json: boolean } {
  let trace: string | undefined;
  let needle: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') { json = true; continue; }
    if (flag !== '--trace' && flag !== '--needle') throw new ReplayRefusal(`Unknown option ${flag}. Use --help.`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new ReplayRefusal(`${flag} requires a value.`);
    if (flag === '--trace') trace = value;
    else needle = value;
    i += 1;
  }
  if (!trace) throw new ReplayRefusal('--trace is required.');
  return { trace, ...(needle ? { needle } : {}), json };
}

/**
 * CLI entry: `find` lists generations, `replay` sends samples or exports a screening bundle,
 * `check` validates a screening reply.
 *
 * @returns Process exit code: 0 success, 2 a sample failed or could not complete, 4 refused.
 */
export async function main(argv: readonly string[], deps: ReplayDeps): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || args.includes('--help')) {
    deps.log(HELP);
    return command ? 0 : 4;
  }
  try {
    if (command === 'find') {
      const options = parseFindArgs(args);
      const { requests, skipped } = readRecordedRequests(readFileSync(resolve(deps.repoRoot, options.trace), 'utf8'));
      const rows = listGenerations(requests, options.needle);
      if (options.json) deps.log(JSON.stringify({ rows, skippedLines: skipped }));
      else {
        deps.log('requestId generation phase focusNode messages requestChars');
        for (const row of rows) {
          deps.log(`${row.requestId.slice(0, 8)} ${row.generation} ${row.phase ?? '-'} ${row.focusNode ?? '-'} ${row.messages} ${row.requestChars}`);
        }
        deps.log(`${rows.length} of ${requests.length} requests${skipped ? `; ${skipped} malformed lines skipped` : ''}`);
      }
      return 0;
    }
    if (command === 'replay') {
      const { ok } = await runReplay(parseReplayArgs(args), deps);
      return ok ? 0 : 2;
    }
    if (command === 'check') {
      const options = parseCheckArgs(args);
      const { result, file } = runCheck(options.bundle, options.reply, options.out, deps.repoRoot);
      deps.log(`check valid=${result.valid} tool=${result.tool ?? '-'} errors=${result.errors.length} written: ${file}`);
      return result.valid ? 0 : 2;
    }
    throw new ReplayRefusal(`Unknown command ${command}. Use find, replay or check.`);
  } catch (error) {
    if (error instanceof ReplayRefusal) {
      deps.log(`REFUSED: ${error.message}`);
      return 4;
    }
    if (error instanceof SyntaxError) {
      deps.log('REFUSED: a JSON input file is not valid JSON.');
      return 4;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    deps.log(`FAIL: ${code === 'ENOENT' ? 'input file not found' : redact(error instanceof Error ? error.message : 'unexpected failure', deps.env.AI_TEST_API_KEY?.trim())}`);
    return code === 'ENOENT' ? 4 : 2;
  }
}
