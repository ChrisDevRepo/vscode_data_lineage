/**
 * Surrogate-pair-safe text truncation shared by the host-graph retry-context projector
 * (`agent/toolAttempt.ts`) and the discovery-transcript bound (`session/session.ts`).
 *
 * @remarks
 * `String.prototype.slice` operates on UTF-16 code units and can split a surrogate pair in half,
 * leaving a lone unpaired surrogate at the end of the returned prefix — which a downstream UTF-8
 * encoder (`Buffer`/`TextEncoder`) then silently replaces with U+FFFD, corrupting the trailing
 * character instead of cleanly omitting it. This primitive binary-searches over code-unit length
 * using a caller-supplied `fits` predicate, backing off one position whenever the candidate split
 * boundary lands on a high surrogate, so every returned prefix ends on a complete code point.
 */

/**
 * Finds the longest prefix of `text` for which `fits` returns true, never splitting a UTF-16
 * surrogate pair, via binary search over code-unit length.
 *
 * @remarks
 * `fits` must be monotonic in prefix length (true for a byte-length budget check, since appending
 * more text never shrinks its encoded size) — callers compose their own marker/suffix and budget
 * semantics into the predicate rather than this primitive assuming one shape.
 * @param text - Source string to shrink.
 * @param fits - Predicate over a candidate prefix.
 * @returns The longest prefix accepted by `fits`; empty string when even `''` fails.
 */
export function longestPrefixFitting(text: string, fits: (candidatePrefix: string) => boolean): string {
  const prefixAt = (length: number): string => {
    const last = text.charCodeAt(length - 1);
    return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? length - 1 : length);
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (fits(prefixAt(count))) low = count;
    else high = count - 1;
  }
  return prefixAt(low);
}
