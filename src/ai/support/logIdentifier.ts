/** Shared bounding for provider-controlled identifiers (tool names, call ids, phase labels, field paths) embedded in single-line debug logs and trace attributes. */

/** Behavior for a character outside the allowed set. */
interface SafeIdentifierOptions {
  /** Extra characters allowed beyond `[A-Za-z0-9_]`; each is escaped before entering the class. */
  readonly extraChars: string;
  /** Substitution text for a disallowed character — pass `''` to strip it instead. */
  readonly replacement: string;
  /** Characters kept from the start of the sanitized value. */
  readonly maxLength: number;
  /** Value returned when sanitizing yields an empty string. */
  readonly fallback: string;
}

/** Bounds a provider-controlled identifier for safe embedding in a single-line log or trace attribute: replaces (or strips) disallowed characters, then hard-slices to `maxLength`. */
export function safeIdentifier(value: string, options: SafeIdentifierOptions): string {
  const extras = options.extraChars.replace(/[\\\]^-]/g, '\\$&');
  const pattern = new RegExp(`[^A-Za-z0-9_${extras}]`, 'g');
  return value.replace(pattern, options.replacement).slice(0, options.maxLength) || options.fallback;
}
