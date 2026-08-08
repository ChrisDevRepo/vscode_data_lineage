/**
 * Pure string helpers shared across the VS Code-free AI core, the provider adapters, and the
 * host runners.
 *
 * @remarks
 * VS Code-free on purpose so the core framework and the `vscode.lm` runner share **one** copy.
 * Secret
 * redaction lives here too so every provider-error path can sanitize before logging/emitting.
 */

/** Max characters retained from a provider error before truncation (avoid dumping a body). */
const PROVIDER_ERROR_MAX = 300;
const PROVIDER_ERROR_CAUSE_DEPTH = 3;

/** Sanitized allowlisted fields retained from one provider exception or nested cause. */
export interface ProviderErrorCauseDiagnostic {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: ProviderErrorCauseDiagnostic;
}

/** Sanitized provider exception evidence bound to the model-call phase that failed. */
export interface ProviderErrorDiagnostic extends ProviderErrorCauseDiagnostic {
  readonly phase: string;
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
    const rawCode = record?.code;
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

/** True when any sanitized cause carries a known connection-level code — a network interruption, not a provider verdict. */
export function isTransportProviderError(diagnostic: ProviderErrorCauseDiagnostic): boolean {
  for (let cursor: ProviderErrorCauseDiagnostic | undefined = diagnostic; cursor; cursor = cursor.cause) {
    if (cursor.code && TRANSPORT_ERROR_CODES.has(cursor.code)) return true;
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
 * Renders a sanitized provider diagnostic as the single user-facing chat error line.
 *
 * @remarks
 * Classification is code-based only (never message-prose matching) and is delegated to
 * {@link isTransportProviderError}: a known connection-level code anywhere in the cause chain
 * names the failure a temporary network/service interruption so the user knows a retry is
 * reasonable; anything else stays a plain provider error.
 */
export function describeProviderErrorForUser(diagnostic: ProviderErrorDiagnostic): string {
  const codes = providerErrorCodeChain(diagnostic);
  const detail = trunc(`${diagnostic.name}${codes.length ? ` [${codes.join(' → ')}]` : ''}: ${diagnostic.message}`, 200);
  return isTransportProviderError(diagnostic)
    ? `The AI provider connection was interrupted (${detail}). This is usually a temporary network or service issue — please try again.`
    : `The AI provider reported an error (${detail}).`;
}

function safeDiagnosticToken(value: string, fallback: string): string {
  return sanitizeProviderError(value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || fallback;
}

/**
 * Strips overlay-only `#focus-node:` anchors from a cached AI-preview description before it is
 * replayed into a chat surface as plain text.
 *
 * @remarks
 * `#focus-node:` links only resolve inside the graph webview's own React tree (they zoom/focus a
 * node on the canvas); a chat surface — the native Copilot panel — has no such target, so the link
 * markup would render as dead or broken-looking links.
 *
 * @param description - The full assembled markdown from `AiSession.lastPresentResultDescription`.
 * @returns The same markdown with every `[label](#focus-node:...)` reduced to plain `label`.
 */
export function sanitizeDescriptionForChat(description: string): string {
  return description
    .replace(/^### Objects\s+(.+)$/gm, (_m, tail: string) => {
      const cleaned = tail.replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
      return `### Objects ${cleaned}`;
    })
    .replace(/\[([^\]]+)\]\(#focus-node:[^)]+\)/g, '$1');
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
