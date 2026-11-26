/**
 * Pure string helpers shared by the VS Code-free AI core, the provider adapters and the host
 * runners. Secret redaction lives here so every
 * provider-error path sanitizes before logging or emitting.
 */

import { stripFocusNodeLinks } from '../../engine/shared/bridgeContract';
import { OUTPUT_CHANNEL_NAME } from '../../utils/log';

/** Max characters retained from a provider error before truncation (avoid dumping a body). */
const PROVIDER_ERROR_MAX = 300;
const PROVIDER_ERROR_CAUSE_DEPTH = 3;

/** Sanitized allowlisted fields retained from one provider exception or nested cause. */
export interface ProviderErrorCauseDiagnostic {
  /** Sanitized exception name, reduced to diagnostic-safe characters. */
  readonly name: string;
  /** Redacted, length-capped error message. */
  readonly message: string;
  /** Connection-level or provider code when one survives sanitization (e.g. `ECONNRESET`). */
  readonly code?: string;
  /** Nested sanitized cause, at most three levels deep. */
  readonly cause?: ProviderErrorCauseDiagnostic;
}

/** Sanitized provider exception evidence bound to the model-call phase that failed. */
export interface ProviderErrorDiagnostic extends ProviderErrorCauseDiagnostic {
  /** Model-call phase in which the exception surfaced. */
  readonly phase: string;
}

/**
 * Escapes text for a dynamic prompt slot (`&`, `<`, `>` entity-escaped) so it cannot open or close
 * a prompt delimiter. Every value reaching a system prompt from outside the prompt builder
 * (question, mission brief, screen phrase) passes through here.
 */
export function escapePromptText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes untrusted catalog text (object/schema names, hop labels) for inline Markdown: `&`, `<`,
 * `>` entity-escaped and Markdown control characters backslash-escaped, so it renders literally and
 * opens no emphasis, link, code span, math or HTML.
 */
export function escapeMarkdownText(value: string): string {
  return escapePromptText(value).replace(/[\\`*_#[\]$]/g, '\\$&');
}

/** Truncates `text` to `max` characters (default 60, inclusive) with a trailing `…`. */
function trunc(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Shortens a visible status preview at its last sentence or clause boundary, then a word boundary;
 * `max` includes the trailing `...`, added only when the text exceeds it. An unbroken token that
 * cannot fit is omitted rather than split. Stored findings and model history are untouched.
 */
export function truncAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return '.'.repeat(Math.max(0, max));
  let cut = text.slice(0, max - 3);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const clause = cut.match(/^.*[.!?;,:](?=\s|$)/s)?.[0];
  const word = cut.match(/^.*\s/s)?.[0];
  const folded = (clause ?? word ?? '').replace(/[.!?;,:\s]+$/, '')
    .replace(/(?:^|\s)(?:and|but|or)$/i, '').trimEnd();
  return `${folded}...`;
}

/**
 * Serializes `value` to JSON with every angle bracket replaced by its unicode escape. The result
 * sits between XML-style delimiters in a model message, so DDL, comments and identifiers cannot
 * close the delimiter and smuggle markup; JSON readers decode the escapes unchanged. Every
 * delimited JSON block goes through here; a second escaping site is drift on a security-relevant
 * rule.
 */
export function escapeDelimitedJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * Redacts likely secrets from a provider error before it reaches a log, the webview or telemetry. A
 * `401`/`403` body can echo the `Authorization` header or API key, so it strips `Bearer <token>`,
 * `sk-`/`key-`/`api-` tokens and any long opaque run, then caps the length. Over-redaction is
 * acceptable: an error message never needs a 32+ char literal.
 */
export function sanitizeProviderError(message: string): string {
  const redacted = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ‹redacted›')
    .replace(/\b(?:sk|key|api)[-_][A-Za-z0-9]{8,}\b/gi, '‹redacted-key›')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '‹redacted›')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '‹redacted-url›')
    .replace(/\b(endpoint|uri|url|base[_-]?url)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=‹redacted›')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return trunc(redacted, PROVIDER_ERROR_MAX);
}

/**
 * Retains only bounded diagnostic provider-error fields, sanitized before any sink sees them.
 *
 * @param phase - Runtime model-call phase in which the exception surfaced.
 * @returns A no-secret, JSON-safe diagnostic with at most three nested causes.
 */
export function sanitizeProviderErrorDiagnostic(error: unknown, phase: string): ProviderErrorDiagnostic {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): ProviderErrorCauseDiagnostic => {
    seen.add(value);
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    const rawName = value instanceof Error ? value.name : typeof record?.name === 'string' ? record.name : 'Error';
    const rawMessage = value instanceof Error ? value.message : typeof record?.message === 'string' ? record.message : String(value);
    const stringCode = typeof record?.code === 'string' && record.code.trim() !== '' ? record.code : undefined;
    const rawCode = stringCode
      ?? chromiumNetworkCode(rawMessage)
      ?? (typeof record?.code === 'number' ? record.code : undefined);
    const diagnostic: { name: string; message: string; code?: string; cause?: ProviderErrorCauseDiagnostic } = {
      name: safeDiagnosticToken(rawName, 'Error'),
      message: sanitizeProviderError(rawMessage),
    };
    if (typeof rawCode === 'string' || typeof rawCode === 'number') {
      diagnostic.code = safeDiagnosticToken(String(rawCode), 'unknown');
    }
    if (record && record.cause !== undefined && depth < PROVIDER_ERROR_CAUSE_DEPTH && !seen.has(record.cause)) {
      diagnostic.cause = visit(record.cause, depth + 1);
    }
    return diagnostic;
  };
  return { phase: safeDiagnosticToken(phase, 'unknown'), ...visit(error, 0) };
}

/** Formats a sanitized provider diagnostic for a single-line debug callback. */
export function formatProviderErrorDiagnostic(diagnostic: ProviderErrorDiagnostic): string {
  return `phase=${diagnostic.phase} detail=${JSON.stringify(diagnostic)}`;
}

/** Connection-level Node/undici codes marking a transport interruption, not a provider verdict. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Chromium network-stack failures that are transport interruptions, not provider verdicts. In the
 * extension host requests use Electron's network stack, which reports `net::ERR_*` with **no**
 * `code` property (the token exists only in the message). Listed explicitly, not matched by prefix,
 * so an error meaning "the provider answered and refused" is never silently retried.
 */
const CHROMIUM_TRANSPORT_ERRORS = new Set([
  'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_ABORTED', 'net::ERR_CONNECTION_FAILED', 'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED',
  'net::ERR_TIMED_OUT', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_QUIC_PROTOCOL_ERROR', 'net::ERR_SOCKET_NOT_CONNECTED', 'net::ERR_ADDRESS_UNREACHABLE',
]);

/**
 * Recovers a Chromium transport token from an error message that carries no `code`. Returns the
 * first allowlisted `net::ERR_*` token (later ones are checked when an earlier one is a generic
 * wrapper such as `net::ERR_FAILED`), or `undefined`.
 *
 * The one place a code is derived from prose, at the boundary where the raw error is still
 * available; everything downstream, {@link isTransportProviderError} above all, classifies on
 * `code` alone, so "never match on message text" holds where the decision is made.
 */
function chromiumNetworkCode(message: string): string | undefined {
  for (const match of message.matchAll(/\bnet::ERR_[A-Z0-9_]+/g)) {
    if (CHROMIUM_TRANSPORT_ERRORS.has(match[0])) return match[0];
  }
  return undefined;
}

/** True when any sanitized cause carries a known connection-level code (a network interruption). */
export function isTransportProviderError(diagnostic: ProviderErrorCauseDiagnostic): boolean {
  for (let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic; cursor; cursor = cursor.cause) {
    if (cursor.code && (TRANSPORT_ERROR_CODES.has(cursor.code) || CHROMIUM_TRANSPORT_ERRORS.has(cursor.code))) return true;
  }
  return false;
}

/** Ordered codes carried by a diagnostic and its causes. */
function providerErrorCodeChain(diagnostic: ProviderErrorCauseDiagnostic): string[] {
  const codes: string[] = [];
  for (let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic; cursor; cursor = cursor.cause) {
    if (cursor.code) codes.push(cursor.code);
  }
  return codes;
}

/** Where the error that ended a chat turn came from; decides its chat label and log `source=`. */
type StopSource = 'provider' | 'network' | 'model_replies' | 'internal';

/**
 * One turn-ending failure in content-free fields, plus the sanitized error chain behind it.
 * Built once where the stop is decided and rendered once by {@link describeTurnStop}.
 */
export interface TurnStop {
  readonly source: StopSource;
  /** Content-free code: model-port, transport or rejection code, or the app's stop reason. */
  readonly code: string;
  /** Model-call or attempt phase in which the turn stopped, when known. */
  readonly phase?: string;
  /**
   * Data Lineage's own reason (stop reason, last rejection, catalog name); plain text, escaped when
   * rendered.
   */
  readonly detail?: string;
  /** Sanitized error chain; its message is quoted verbatim for an external source. */
  readonly diagnostic?: ProviderErrorDiagnostic;
}

/** Codes carried by an error's causes: the provider's or transport's own, not the port's. */
export function causeCodes(diagnostic: ProviderErrorDiagnostic): string[] {
  return diagnostic.cause ? providerErrorCodeChain(diagnostic.cause) : [];
}

/** Per source: the verb after `Request` and the plain-words source label. */
const STOP_LINE: Readonly<Record<StopSource, { readonly verb: 'failed' | 'stopped'; readonly label: string }>> = {
  provider: { verb: 'failed', label: 'model provider error' },
  network: { verb: 'failed', label: 'network error' },
  internal: { verb: 'failed', label: 'Data Lineage internal error' },
  model_replies: { verb: 'stopped', label: 'model replies rejected' },
};

/** Closing sentence of every {@link describeTurnStop} line. */
const TURN_STOP_LINE_END = `Details: Output › ${OUTPUT_CHANNEL_NAME}.`;

/**
 * The chat block of one committed hop: a bold `Hop n/m` header and the finding summary in italics
 * (`summary` already Markdown-escaped). UI progress, not a model reply.
 */
export function hopProgressBlock(current: number, total: number, label: string, summary: string): string {
  return `\n\n**Hop ${current}/${total} — ${label}**\n\n_${summary}_\n\n`;
}

/**
 * The diagnostic of a provider or network stop: the only stops whose message is the provider's own.
 * Already redacted and length-capped by {@link sanitizeProviderErrorDiagnostic}.
 */
function externalDiagnostic(stop: TurnStop): ProviderErrorDiagnostic | undefined {
  return stop.source === 'provider' || stop.source === 'network' ? stop.diagnostic : undefined;
}

/** The external message as the chat line quotes it: Markdown-escaped, in double quotes. */
function quotedExternalMessage(stop: TurnStop): string | undefined {
  const external = externalDiagnostic(stop);
  return external && `"${escapeMarkdownText(external.message)}"`;
}

/**
 * The fields of a turn stop for its log line: the host's error line of a failed turn, or the warn
 * line of a stop the turn survives. Source, the class of the exception behind it when its code is
 * not already that class name, the code, the codes of its cause chain, and the external message
 * quoted for a provider or network stop. The sanitized diagnostic itself stays for a debug line.
 */
export function turnStopLogFields(stop: TurnStop): string {
  const external = externalDiagnostic(stop);
  const causes = stop.diagnostic ? causeCodes(stop.diagnostic) : [];
  const name = stop.diagnostic?.name;
  const cls = stop.source === 'internal' && name !== undefined && name !== stop.code ? ` class=${name}` : '';
  return `source=${stop.source}${cls} code=${stop.code}`
    + `${causes.length ? ` cause=${causes.join(',')}` : ''}${external ? ` message="${external.message}"` : ''}`;
}

/**
 * Builds the one chat line of a turn-ending error (Markdown): what happened, the source with its
 * model or code, then the external message quoted verbatim (sanitized by
 * {@link sanitizeProviderErrorDiagnostic}, Markdown-escaped) or Data Lineage's own reason, then
 * where the details are. Follows the `DbConnectionError`/`describeConnectionError` split: the
 * error stays untouched and the presentation is added here only.
 *
 * @param modelName - Display name of the request's model, naming a provider error's sender.
 */
export function describeTurnStop(stop: TurnStop, modelName: string): string {
  const { verb, label } = STOP_LINE[stop.source];
  const quoted = quotedExternalMessage(stop);
  const codes = quoted && stop.diagnostic ? causeCodes(stop.diagnostic) : [stop.code];
  // Codes are diagnostic-safe tokens; the model name, quote and detail (catalog names) are escaped.
  const sender = stop.source === 'provider' ? [escapeMarkdownText(modelName), ...codes] : stop.source === 'model_replies' ? [] : codes;
  const text = quoted ?? (stop.detail && escapeMarkdownText(stop.detail));
  const body = `**Request ${verb}:** ${label}${sender.length ? ` (${sender.join(', ')})` : ''}`
    + (text ? `${sender.length ? ': ' : ' '}${text}` : '');
  return `${/[.!?]"?$/.test(body) ? body : `${body}.`} ${TURN_STOP_LINE_END}`;
}

function safeDiagnosticToken(value: string, fallback: string): string {
  return sanitizeProviderError(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || fallback;
}

/**
 * Strips overlay-only `#focus-node:` anchors from a cached AI-preview description before it is
 * replayed into a chat transcript, which has no target for them and would render dead links. Every
 * `[label](#focus-node:...)` becomes plain `label`, and the `### Objects` transport line is demoted
 * to `*Objects: …*` so chat never renders a heading-scale object list.
 */
export function sanitizeDescriptionForChat(description: string): string {
  return stripFocusNodeLinks(description)
    .replace(/^### Objects\s+(.+)$/gm, (_m, tail: string) => `*Objects: ${tail}*`);
}

/**
 * Renders ids as a double-quoted, comma-separated list for a rejection message (the single home for
 * the quoting rule). Quoting keeps an invisible defect (zero-width or padding characters) from
 * making an offending id look identical to a valid one, which would make the model re-send it and
 * waste a repair round.
 */
export function quoteIds(ids: readonly string[]): string {
  return ids.map(id => JSON.stringify(id)).join(', ');
}

/** Reads a `cursor` (a prior `next_cursor`) as the next page's zero-based offset; 0 if none. */
export function cursorOffset(cursor: string | undefined): number {
  return cursor === undefined ? 0 : Number.parseInt(cursor, 10);
}

/**
 * Builds the `next_cursor` for a list continuing at `offset`; `undefined` once `offset` reaches
 * `total`.
 */
export function nextCursor(offset: number, total: number): string | undefined {
  return offset < total ? String(offset) : undefined;
}

/**
 * Regular-suffix pluralizer (`+s` unless `n` is exactly 1), the single home for the rule so counts
 * phrase consistently across chat messages and prompts.
 */
export function pluralize(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}
