/**
 * History management for @lineage chat participant.
 *
 * Two operations on tool results re-injected into conversation history:
 * 1. DROP — remove error/empty results, replace with 1-line summary
 * 2. EVICT — under context pressure, drop oldest turns to fit token budget
 *
 * Zero VS Code imports — pure functions for testability.
 */

// ─── DROP: remove noise results ─────────────────────────────────────────────

/**
 * If a tool result is an error or empty, return a compact 1-line summary.
 * Returns null if the result should be kept as-is.
 */
export function compactNoiseResult(toolName: string, resultJson: string): string | null {
  try {
    const parsed = JSON.parse(resultJson);
    const shortName = toolName.replace('lineage_', '');
    // Error responses
    if (parsed.error) {
      return JSON.stringify({ summary: `${shortName} → error: ${parsed.error}` });
    }
    // Validation rejections (success: false with errors array)
    if (parsed.success === false && Array.isArray(parsed.errors)) {
      return JSON.stringify({ summary: `${shortName} → rejected: ${parsed.errors.length} error(s)` });
    }
    // Empty search results
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length === 0) {
      return JSON.stringify({ summary: `${shortName} → 0 matches` });
    }
  } catch { /* not JSON or parse error — keep as-is */ }
  return null;
}

// ─── EVICT: constants for context-pressure eviction ─────────────────────────

/**
 * Minimum history messages to preserve during eviction.
 * Each "turn" is typically 2-3 messages (user + assistant + tool results).
 * Preserving 6 messages ≈ 2 turns minimum — enough for the model to
 * understand current context.
 */
export const MIN_HISTORY_MESSAGES = 6;

/**
 * Build the stub message content inserted after eviction so the model
 * knows earlier conversation existed.
 */
export function buildEvictionStub(evictedCount: number): string {
  return JSON.stringify({
    _evicted: true,
    messages_dropped: evictedCount,
    reason: 'context_pressure',
    hint: 'Earlier conversation was removed to fit context window. Key context from those turns may be missing.',
  });
}

