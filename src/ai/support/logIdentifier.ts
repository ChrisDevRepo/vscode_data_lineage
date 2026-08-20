/**
 * Shared bounding for provider-controlled identifiers (tool names, call ids, phase labels, field
 * paths) embedded in single-line debug logs and trace attributes.
 *
 * @remarks
 * Distinct from the content/JSON log-truncation helpers in `utils/log.ts` (`trunc`,
 * `LOG_TRUNC_CONTENT`/`LOG_TRUNC_JSON`): those preview human-readable prose and mark where they
 * cut with an omission suffix, which would embed a space into what must stay one contiguous,
 * greppable token. This helper instead sanitizes the character set (so the value can never break
 * a single-line log format) and hard-bounds the length with a silent cut — no marker — matching
 * the call sites this consolidates (the tool-call id and tool-name bounds in `agent/toolAttempt.ts`).
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
 * Bounds a provider-controlled identifier for safe embedding in a single-line log or trace
 * attribute: replaces (or strips) disallowed characters, then hard-slices to `maxLength`.
 * @remarks
 * `extraChars` is escaped per character before it enters the class: interpolated verbatim, an
 * unlucky ordering such as `'-.'` builds `[^A-Za-z0-9_-.]`, where `_-.` parses as a code-point
 * range and `new RegExp` throws `SyntaxError: Range out of order` — from inside a diagnostic
 * helper whose whole purpose is to never break its call site.
 * @param value - The raw, possibly hostile identifier (tool name, call id, phase, field path).
 * @param options - Character-set, length, and empty-result behavior for this call site.
 * @returns A bounded token safe to interpolate into a single-line message.
 */
export function safeIdentifier(value: string, options: SafeIdentifierOptions): string {
  const extras = options.extraChars.replace(/[\\\]^-]/g, '\\$&');
  const pattern = new RegExp(`[^A-Za-z0-9_${extras}]`, 'g');
  return value.replace(pattern, options.replacement).slice(0, options.maxLength) || options.fallback;
}
