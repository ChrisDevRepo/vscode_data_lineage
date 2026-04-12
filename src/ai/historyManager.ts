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
  } catch (e) {
    if (!(e instanceof SyntaxError)) console.debug('[AI] compactNoiseResult unexpected error:', e);
    /* not JSON — keep as-is */
  }
  return null;
}

// ─── COMPACT: shrink stale SM hop results after completion ──────────────────

/** Tool names whose results should be compacted once the owning SM is complete. */
const BB_HOP_TOOLS = new Set(['lineage_submit_findings', 'lineage_start_exploration']);
const CT_HOP_TOOLS = new Set(['lineage_submit_hop_analysis', 'lineage_start_column_trace']);

/**
 * If a tool result is from a completed SM's hop phase, return a compact 1-line summary.
 * During active hops (smComplete=false), returns null — full results preserved.
 * After SM completion, hop results are stale: the synthesis result already contains
 * all accumulated evidence via detail_slots + short_memory.
 */
export function compactStaleHopResult(
  toolName: string,
  resultJson: string,
  bbComplete: boolean,
  ctComplete: boolean,
): string | null {
  const isBbTool = BB_HOP_TOOLS.has(toolName);
  const isCtTool = CT_HOP_TOOLS.has(toolName);
  if (!isBbTool && !isCtTool) return null;
  if (isBbTool && !bbComplete) return null;
  if (isCtTool && !ctComplete) return null;

  const shortName = toolName.replace('lineage_', '');
  try {
    const parsed = JSON.parse(resultJson);
    const node = parsed.focus_node?.n ?? parsed.originNode?.n ?? '';
    const hop = parsed.hop ?? '';
    const status = parsed.bb_mode ?? parsed.status ?? '';
    return JSON.stringify({
      _compacted: true,
      summary: `${shortName} → ${node ? node + ' · ' : ''}${hop ? 'hop ' + hop + ' · ' : ''}${status}`,
    });
  } catch (e) {
    if (!(e instanceof SyntaxError)) console.debug('[AI] compactStaleHopResult unexpected error:', e);
    return JSON.stringify({ _compacted: true, summary: `${shortName} → (compacted)` });
  }
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

