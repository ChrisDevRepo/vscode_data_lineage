/**
 * @module Redact
 * Removes credential-shaped text from strings bound for logs and user-visible messages. It has no
 * imports, so every layer that writes output can use it.
 */

/** Credential key names, with any `word_` prefix such as `client_secret`, `access_token` or `SharedAccessKey`. */
const SECRET_KEY = String.raw`\w*(?:password|passphrase|pwd|token|secret|account[_-]?key|access[_-]?key|api[_-]?key|private[_-]?key|subscription[_-]?key)`;
/** A value an earlier pass already replaced; a later pass leaves it alone instead of marking it again. */
const NOT_REDACTED_YET = String.raw`(?!\[(?:token )?removed\])`;
/** A bare `key: value` value made only of closing brackets or sentence marks, as in `Unexpected token: }`, is prose. */
const NOT_CLOSING_PUNCTUATION = String.raw`(?![)\]}>.!?]+(?![^\s;,]))`;
/**
 * Longest braced value scanned for its closing brace. A brace has no second opener to stop the
 * scan, so an unbounded search repeats to the end of the text for every unclosed `key={`.
 */
const MAX_BRACED_VALUE_LENGTH = 1024;
/**
 * A connection-string value: quoted (doubled quote escapes), braced, or bare up to `;` or whitespace.
 * An opening quote or brace without its closer takes the rest of the line up to `;`.
 */
const SECRET_VALUE = String.raw`(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\{(?:[^}]|\}\}){0,${MAX_BRACED_VALUE_LENGTH}}\}|["'{][^;\r\n]*|[^;\s]+)`;
/** Compiled once: {@link redactSecrets} runs on every bridge log line. */
const KEY_EQUALS_VALUE = new RegExp(String.raw`\b(${SECRET_KEY})\s*=\s*${NOT_REDACTED_YET}${SECRET_VALUE}`, 'gi');
const QUOTED_KEY_VALUE = new RegExp(String.raw`(["'])(${SECRET_KEY})\1(\s*:\s*)(["'])(?:(?!\4)[^\\]|\\.)*\4`, 'gi');
const KEY_COLON_VALUE = new RegExp(String.raw`\b(${SECRET_KEY})\s*:\s*${NOT_REDACTED_YET}(?:"[^"\r\n]*"|'[^'\r\n]*'|${NOT_CLOSING_PUNCTUATION}[^;,\s]+)`, 'gi');

/**
 * Removes credential-shaped text from a driver message.
 *
 * @remarks
 * Driver messages do not normally contain secrets; this guards the rare one that echoes a
 * connection string (including quoted, braced or unterminated values), a JSON-like credential
 * field in single or double quotes, a key/value or `key: value` secret, a SAS `sig` query value,
 * URL userinfo, an `Authorization: Basic` or bearer token, or a JWT.
 *
 * A bare `key: value` value cannot be told apart from prose by its content, so a word after
 * `token:` is removed even when it is ordinary text (`token: expired`); only a value made solely of
 * closing brackets or `.!?` is kept (`Unexpected token: }`).
 *
 * An unterminated quoted or braced value cannot be told apart from the text that follows it, so
 * the rest of that line up to the next `;` is removed with it, including any error text there.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(?<![\w-])(?=[\w-]*eyJ[\w-]{8})[\w-]+\.[\w-]{8,}\.[\w-]*/g, '[token removed]')
    .replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [token removed]')
    .replace(/(\bAuthorization\s*:\s*Basic\s+)[\w+/=-]{8,}/gi, '$1[token removed]')
    .replace(/(:\/\/)[^/?#\s@]+@/g, '$1[removed]@')
    .replace(KEY_EQUALS_VALUE, '$1=[removed]')
    .replace(/(\bsig=)[^&#;\s]+/gi, '$1[removed]')
    .replace(QUOTED_KEY_VALUE, '$1$2$1$3$4[removed]$4')
    .replace(KEY_COLON_VALUE, '$1: [removed]');
}
