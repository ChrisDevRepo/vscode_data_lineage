/** Pure string helpers shared across the VS Code-free AI core, the provider adapters, and the host runners. */

import { stripFocusNodeLinks } from '../../engine/shared/bridgeContract';

/** Max characters retained from a provider error before truncation (avoid dumping a body). */
const PROVIDER_ERROR_MAX = 300;
const PROVIDER_ERROR_CAUSE_DEPTH = 3;

/** Sanitized allowlisted fields retained from one provider exception or nested cause. */
interface ProviderErrorCauseDiagnostic {
  /** A provider reply part arrived before failure, even if the phase buffered it. */
  readonly replyReceived?: true;
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

/** Escapes text for a dynamic prompt slot so it cannot open or close a prompt delimiter. */
export function escapePromptText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape untrusted catalog text (object/schema names, hop labels) for inline Markdown display. */
export function escapeMarkdownText(value: string): string {
  return escapePromptText(value).replace(/[\\`*_#[\]$]/g, '\\$&');
}

/** Truncates `text` to `max` characters, the trailing `…` included. */
function truncWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Shorten a visible status preview at its last sentence or clause boundary, then a word boundary. */
export function truncAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return '.'.repeat(Math.max(0, max));
  let cut = text.slice(0, max - 3);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const clause = cut.match(/^.*[.!?;,:](?=\s|$)/s)?.[0];
  const word = cut.match(/^.*\s/s)?.[0];
  const folded = (clause ?? word ?? '')
    .replace(/[.!?;,:\s]+$/, '')
    .replace(/(?:^|\s)(?:and|but|or)$/i, '')
    .trimEnd();
  return `${folded}...`;
}

/** Serialize `value` to JSON with every angle bracket replaced by its unicode escape. */
export function escapeDelimitedJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

/** Redact likely secrets from a provider error before it reaches a log, the webview, or telemetry. */
export function sanitizeProviderError(message: string): string {
  return truncWithEllipsis(redactProviderSecrets(message), PROVIDER_ERROR_MAX);
}

/** Redacts credentials, long opaque tokens and URLs from provider error text and collapses whitespace, without the length cap {@link sanitizeProviderError} applies. */
export function redactProviderSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ‹redacted›')
    .replace(/\b(?:sk|key|api)[-_][A-Za-z0-9]{8,}\b/gi, '‹redacted-key›')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '‹redacted›')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '‹redacted-url›')
    .replace(
      /\b(endpoint|uri|url|base[_-]?url)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=‹redacted›',
    )
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Retains only bounded, diagnostic provider-error fields and sanitizes them before any sink sees them. */
export function sanitizeProviderErrorDiagnostic(
  error: unknown,
  phase: string,
): ProviderErrorDiagnostic {
  const seen = new Set<unknown>();
  const visit = (
    value: unknown,
    depth: number,
  ): ProviderErrorCauseDiagnostic => {
    seen.add(value);
    const record =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : undefined;
    const rawName =
      value instanceof Error
        ? value.name
        : typeof record?.name === 'string'
          ? record.name
          : 'Error';
    const rawMessage =
      value instanceof Error
        ? value.message
        : typeof record?.message === 'string'
          ? record.message
          : String(value);
    const stringCode =
      typeof record?.code === 'string' && record.code.trim() !== ''
        ? record.code
        : undefined;
    const rawCode =
      stringCode ??
      chromiumNetworkCode(rawMessage) ??
      (typeof record?.code === 'number' ? record.code : undefined);
    const diagnostic: ProviderErrorCauseDiagnostic & {
      code?: string;
      cause?: ProviderErrorCauseDiagnostic;
    } = {
      name: safeDiagnosticToken(rawName, 'Error'),
      message: sanitizeProviderError(rawMessage),
      ...(record?.replyReceived === true
        ? { replyReceived: true as const }
        : {}),
    };
    if (typeof rawCode === 'string' || typeof rawCode === 'number') {
      diagnostic.code = safeDiagnosticToken(String(rawCode), 'unknown');
    }
    if (
      record &&
      record.cause !== undefined &&
      depth < PROVIDER_ERROR_CAUSE_DEPTH &&
      !seen.has(record.cause)
    ) {
      diagnostic.cause = visit(record.cause, depth + 1);
    }
    return diagnostic;
  };
  return { phase: safeDiagnosticToken(phase, 'unknown'), ...visit(error, 0) };
}

/** Formats a sanitized provider diagnostic for a single-line debug callback. */
export function formatProviderErrorDiagnostic(
  diagnostic: ProviderErrorDiagnostic,
): string {
  return `phase=${diagnostic.phase} detail=${JSON.stringify(diagnostic)}`;
}

/** Connection-level Node/undici codes that identify a transport interruption rather than a provider verdict. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Chromium network-stack failures that are transport interruptions, not provider verdicts. */
const CHROMIUM_TRANSPORT_ERRORS = new Set([
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_TIMED_OUT',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_QUIC_PROTOCOL_ERROR',
  'net::ERR_SOCKET_NOT_CONNECTED',
  'net::ERR_ADDRESS_UNREACHABLE',
]);

/** Recovers a Chromium transport token from an error message that carries no `code`. */
function chromiumNetworkCode(message: string): string | undefined {
  for (const match of message.matchAll(/\bnet::ERR_[A-Z0-9_]+/g)) {
    if (CHROMIUM_TRANSPORT_ERRORS.has(match[0])) return match[0];
  }
  return undefined;
}

/** True when any sanitized cause carries a known connection-level code — a network interruption, not a provider verdict. */
export function isTransportProviderError(
  diagnostic: ProviderErrorCauseDiagnostic,
): boolean {
  for (
    let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic;
    cursor;
    cursor = cursor.cause
  ) {
    if (
      cursor.code &&
      (TRANSPORT_ERROR_CODES.has(cursor.code) ||
        CHROMIUM_TRANSPORT_ERRORS.has(cursor.code))
    )
      return true;
  }
  return false;
}

/** Ordered codes carried by a diagnostic and its causes, used only for the user-facing detail string. */
function providerErrorCodeChain(
  diagnostic: ProviderErrorCauseDiagnostic,
): string[] {
  const codes: string[] = [];
  for (
    let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic;
    cursor;
    cursor = cursor.cause
  ) {
    if (cursor.code) codes.push(cursor.code);
  }
  return codes;
}

/** Plain-words explanation for each `vscode.LanguageModelError` code, keyed by the error's `code`. The provider's own text for these carries no remedy the user can act on. */
const LANGUAGE_MODEL_ERROR_TEXT: Readonly<Record<string, string>> = {
  NoPermissions:
    'The extension is not allowed to use the selected language model. Grant it access in the model picker or the chat provider settings, then try again.',
  Blocked:
    'The AI provider blocked the request. Try again later or choose another model.',
  NotFound:
    'The selected language model is no longer available. Choose another model and try again.',
};

/** Renders a sanitized provider diagnostic as the single user-facing chat error line. */
export function describeProviderErrorForUser(
  diagnostic: ProviderErrorDiagnostic,
): string {
  const codes = providerErrorCodeChain(diagnostic);
  if (isTransportProviderError(diagnostic)) {
    return (
      `The AI provider connection was interrupted (${codes.join(' → ') || diagnostic.name}).` +
      ' This is usually a temporary network or service issue — please try again.'
    );
  }
  const plain = codes
    .map((code) => LANGUAGE_MODEL_ERROR_TEXT[code])
    .find((text): text is string => text !== undefined);
  if (plain !== undefined) return plain;
  const detail = `${diagnostic.name}${codes.length ? ` [${codes.join(' → ')}]` : ''}: ${diagnostic.message}`;
  return `The AI provider reported an error (${detail}).`;
}

function safeDiagnosticToken(value: string, fallback: string): string {
  return (
    sanitizeProviderError(value)
      .replace(/[^A-Za-z0-9_.:-]/g, '')
      .slice(0, 100) || fallback
  );
}

/** Strips overlay-only `#focus-node:` anchors from a cached AI-preview description before it is replayed into a chat surface as plain text. */
export function sanitizeDescriptionForChat(description: string): string {
  return stripFocusNodeLinks(description).replace(
    /^### Objects\s+(.+)$/gm,
    (_m, tail: string) => `*Objects: ${tail}*`,
  );
}

/** Reads a `cursor` input as the zero-based offset of the next page. */
export function cursorOffset(cursor: string | undefined): number {
  return cursor === undefined ? 0 : Number.parseInt(cursor, 10);
}

/** Builds the `next_cursor` value for a list that continues at `offset`. */
export function nextCursor(offset: number, total: number): string | undefined {
  return offset < total ? String(offset) : undefined;
}

/** Regular-suffix pluralizer — the single home for the mechanical `+s` rule so user-facing counts phrase consistently across chat messages and prompt renderings. */
export function pluralize(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}
