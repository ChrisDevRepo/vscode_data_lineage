/**
 * Pure string helpers shared across the VS Code-free AI core, the provider adapters, and the
 * host runners.
 *
 * @remarks
 * VS Code-free on purpose so the core framework and the `vscode.lm` runner share **one** copy.
 * Secret redaction lives here too so every provider-error path can sanitize before logging/emitting.
 */

import { stripFocusNodeLinks } from '../../engine/shared/bridgeContract';

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
 * Escapes text for a dynamic prompt slot so it cannot open or close a prompt delimiter.
 *
 * @remarks
 * Every value that reaches a system prompt from outside the prompt builder — the user question,
 * mission brief, screen phrase — passes through here before interpolation.
 *
 * @param value - Untrusted text.
 * @returns The text with `&`, `<` and `>` entity-escaped.
 */
export function escapePromptText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Truncate `text` to `max` characters with a trailing ellipsis.
 *
 * @param text - The string to shorten (status labels, log previews).
 * @param max - Inclusive character budget; defaults to 60.
 * @returns `text` unchanged when within budget, else its first `max - 1` chars + `…`.
 */
export function trunc(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Truncate `text` to at most `max` characters, folding at the nearest earlier whitespace boundary
 * instead of {@link trunc}'s mid-word hard cut, with a trailing ellipsis.
 *
 * @remarks
 * `trunc` is correct for a single-line log preview, where a mid-word cut is unobjectionable. A
 * multi-line surface (a chat status label) reads as broken prose when the cut lands inside a word,
 * so this folds back to the last space before the budget. Falls back to `trunc`'s hard cut when no
 * whitespace exists before `max` (one long unbroken token), so the result is never empty and never
 * exceeds `max`.
 *
 * @param text - The string to shorten.
 * @param max - Inclusive character budget, the trailing `…` included.
 * @returns `text` unchanged when within budget, else the text folded at the nearest earlier word
 * boundary plus `…`.
 */
export function truncAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  const folded = boundary > 0 ? cut.slice(0, boundary).trimEnd() : cut.trimEnd();
  return `${folded}…`;
}

/**
 * Serialize `value` to JSON with every angle bracket replaced by its unicode escape.
 *
 * @remarks
 * The result is embedded between XML-style delimiters in a model message; DDL, comments, and
 * identifiers inside the payload must not be able to close the delimiter and smuggle markup into
 * the instruction stream. JSON readers decode the escapes back to the original characters, so the
 * payload the model parses is unchanged. Every delimited JSON block goes through here — a second
 * escaping site is a drift risk on a security-relevant rule.
 *
 * @param value - The payload to serialize.
 * @param space - Optional `JSON.stringify` indentation.
 * @returns Escaped JSON safe to place inside an XML-style delimiter block.
 */
export function escapeDelimitedJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * Redact likely secrets from a provider error before it reaches a log, the webview, or telemetry.
 *
 * @remarks
 * A provider `401`/`403` body can echo the `Authorization` header or the API key. We strip
 * `Bearer <token>` headers, `sk-`/`key-`/`api-`-prefixed tokens, and any long opaque run, then
 * cap the length. Over-redaction is acceptable here — an error message never needs a 32+ char
 * literal verbatim.
 *
 * @param message - The raw `Error.message` from the provider/SDK.
 * @returns A length-capped message safe to log and surface inline.
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
 * Retains only bounded, diagnostic provider-error fields and sanitizes them before any sink sees them.
 *
 * @param error - Raw SDK/provider exception.
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

/** Connection-level Node/undici codes that identify a transport interruption rather than a provider verdict. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Chromium network-stack failures that are transport interruptions, not provider verdicts.
 *
 * @remarks
 * Inside the extension host the request travels over Electron's network stack, which reports
 * `net::ERR_*` and attaches **no** `code` property — the token exists only inside the message.
 * Listed explicitly rather than matched by prefix so a Chromium error meaning "the provider
 * answered and the answer was refused" is never silently retried.
 */
const CHROMIUM_TRANSPORT_ERRORS = new Set([
  'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_ABORTED', 'net::ERR_CONNECTION_FAILED', 'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED',
  'net::ERR_TIMED_OUT', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_QUIC_PROTOCOL_ERROR', 'net::ERR_SOCKET_NOT_CONNECTED', 'net::ERR_ADDRESS_UNREACHABLE',
]);

/**
 * Recovers a Chromium transport token from an error message that carries no `code`.
 *
 * @param message - Raw provider error message.
 * @returns The first allowlisted `net::ERR_*` token in the message (later tokens are checked when
 *   an earlier one is a generic wrapper such as `net::ERR_FAILED`), or `undefined` when none match.
 *
 * @remarks
 * The one place a code is derived from prose, applied at the boundary where the raw error is still
 * available. Everything downstream — {@link isTransportProviderError} above all — keeps classifying
 * on `code` alone, so the "never match on message text" rule still holds where the decision is made.
 */
function chromiumNetworkCode(message: string): string | undefined {
  for (const match of message.matchAll(/\bnet::ERR_[A-Z0-9_]+/g)) {
    if (CHROMIUM_TRANSPORT_ERRORS.has(match[0])) return match[0];
  }
  return undefined;
}

/** True when any sanitized cause carries a known connection-level code — a network interruption, not a provider verdict. */
export function isTransportProviderError(diagnostic: ProviderErrorCauseDiagnostic): boolean {
  for (let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic; cursor; cursor = cursor.cause) {
    if (cursor.code && (TRANSPORT_ERROR_CODES.has(cursor.code) || CHROMIUM_TRANSPORT_ERRORS.has(cursor.code))) return true;
  }
  return false;
}

/** Ordered codes carried by a diagnostic and its causes, used only for the user-facing detail string. */
function providerErrorCodeChain(diagnostic: ProviderErrorCauseDiagnostic): string[] {
  const codes: string[] = [];
  for (let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic; cursor; cursor = cursor.cause) {
    if (cursor.code) codes.push(cursor.code);
  }
  return codes;
}

/**
 * Plain-words explanation for each `vscode.LanguageModelError` code, keyed by the error's `code`.
 * The provider's own text for these carries no remedy the user can act on.
 */
const LANGUAGE_MODEL_ERROR_TEXT: Readonly<Record<string, string>> = {
  NoPermissions: 'The extension is not allowed to use the selected language model. Grant it access in the model picker or the chat provider settings, then try again.',
  Blocked: 'The AI provider blocked the request. Try again later or choose another model.',
  NotFound: 'The selected language model is no longer available. Choose another model and try again.',
};

/**
 * Renders a sanitized provider diagnostic as the single user-facing chat error line.
 *
 * @remarks
 * Classification is code-based only (never message-prose matching), via
 * {@link isTransportProviderError}: a known connection-level code names the failure a temporary
 * network/service interruption; a `vscode.LanguageModelError` code is named in plain words;
 * anything else stays a plain provider error. The transport branch
 * reports the code chain, not the provider's own message — that prose is boilerplate shared across
 * every network-class failure and can offer a contradictory remedy. The full message stays in the
 * debug log and trace diagnostic. A provider *verdict* keeps its message, since there the prose is
 * the answer itself.
 */
export function describeProviderErrorForUser(diagnostic: ProviderErrorDiagnostic): string {
  const codes = providerErrorCodeChain(diagnostic);
  if (isTransportProviderError(diagnostic)) {
    return `The AI provider connection was interrupted (${codes.join(' → ') || diagnostic.name}).`
      + ' This is usually a temporary network or service issue — please try again.';
  }
  const plain = codes.map(code => LANGUAGE_MODEL_ERROR_TEXT[code]).find((text): text is string => text !== undefined);
  if (plain !== undefined) return plain;
  const detail = `${diagnostic.name}${codes.length ? ` [${codes.join(' → ')}]` : ''}: ${diagnostic.message}`;
  return `The AI provider reported an error (${detail}).`;
}

function safeDiagnosticToken(value: string, fallback: string): string {
  return sanitizeProviderError(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || fallback;
}

/**
 * Strips overlay-only `#focus-node:` anchors from a cached AI-preview description before it is
 * replayed into a chat surface as plain text.
 *
 * @remarks
 * `#focus-node:` links only resolve inside the graph webview's own React tree; a chat surface has
 * no such target, so the markup would render as dead links. The `### Objects` transport line is
 * demoted to small italic text so chat never renders a heading-scale object list.
 *
 * @param description - The full assembled markdown from `AiSession.lastPresentResultDescription`.
 * @returns The same markdown with every `[label](#focus-node:...)` reduced to plain `label` and
 *   the Objects footnote rendered as `*Objects: …*`.
 */
export function sanitizeDescriptionForChat(description: string): string {
  return stripFocusNodeLinks(description)
    .replace(/^### Objects\s+(.+)$/gm, (_m, tail: string) => `*Objects: ${tail}*`);
}

/**
 * Renders ids as a backticked, comma-separated list for a rejection message — the single home for
 * the offender-list quoting rule.
 *
 * @param ids - Offending ids to display.
 * @returns The backtick-quoted list. Quoting keeps an invisible defect (zero-width or padding
 *   characters) from rendering an offending id identical to a valid one, which would make the
 *   model re-send the same value and spend a repair round learning nothing.
 */
export function quoteIds(ids: readonly string[]): string {
  return ids.map(id => `\`${id}\``).join(', ');
}

/**
 * Reads a `cursor` input as the zero-based offset of the next page.
 *
 * @param cursor - The `next_cursor` value a previous result carried; absent for the first page.
 * @returns The offset, `0` when no cursor was sent.
 */
export function cursorOffset(cursor: string | undefined): number {
  return cursor === undefined ? 0 : Number.parseInt(cursor, 10);
}

/**
 * Builds the `next_cursor` value for a list that continues at `offset`.
 *
 * @param offset - Zero-based index of the first item the next page serves.
 * @param total - Length of the full list; no cursor is returned once `offset` reaches it.
 * @returns The opaque cursor string, or `undefined` when the list is exhausted.
 */
export function nextCursor(offset: number, total: number): string | undefined {
  return offset < total ? String(offset) : undefined;
}

/**
 * Regular-suffix pluralizer — the single home for the mechanical `+s` rule so user-facing
 * counts phrase consistently across chat messages and prompt renderings.
 *
 * @param n - The count deciding the form.
 * @param noun - The singular noun (regular pluralization only).
 * @returns The noun, suffixed with `s` unless `n` is exactly 1.
 */
export function pluralize(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}
