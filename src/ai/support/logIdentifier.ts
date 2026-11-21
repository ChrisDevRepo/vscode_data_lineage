/**
 * Shared bounding for provider-controlled identifiers (tool names, call ids, phase labels, field
 * paths) embedded in single-line debug logs and trace attributes. Distinct from the `utils/log.ts`
 * truncation helpers (`trunc`, `LOG_TRUNC_*`), which preview prose and mark the cut with an
 * omission suffix that would embed a space into what must stay one greppable token. This helper
 * sanitizes the character set (so the value cannot break a single-line log format) and hard-bounds
 * the length with a silent cut, matching the call sites it consolidates (the tool-call id and
 * tool-name bounds in `agent/toolAttempt.ts`).
 */

/** Behavior for a character outside the allowed set. */
export interface SafeIdentifierOptions {
  /** Extra characters allowed beyond `[A-Za-z0-9_]`; each is escaped before entering the class. */
  readonly extraChars: string;
  /** Substitution text for a disallowed character — pass `''` to strip it instead. */
  readonly replacement: string;
  /** Characters kept from the start of the sanitized value. */
  readonly maxLength: number;
  /** Value returned when sanitizing yields an empty string. */
  readonly fallback: string;
}

/**
 * Bounds a provider-controlled identifier for a single-line log or trace attribute: replaces (or
 * strips) disallowed characters, then hard-slices to `maxLength`.
 *
 * `extraChars` is escaped per character before entering the class: verbatim, an ordering such as
 * `'-.'` builds `[^A-Za-z0-9_-.]`, where `_-.` parses as a code-point range and `new RegExp` throws
 * `Range out of order` from inside a diagnostic helper whose purpose is to never break its call
 * site.
 *
 * @param value - The raw, possibly hostile identifier.
 * @param options - Character-set, length and empty-result behavior for this call site.
 */
export function safeIdentifier(value: string, options: SafeIdentifierOptions): string {
  const extras = options.extraChars.replace(/[\\\]^-]/g, '\\$&');
  const pattern = new RegExp(`[^A-Za-z0-9_${extras}]`, 'g');
  return value.replace(pattern, options.replacement).slice(0, options.maxLength) || options.fallback;
}
