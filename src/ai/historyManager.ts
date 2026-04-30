/**
 * History management for @lineage chat participant.
 *
 * Two operations on tool results re-injected into conversation history:
 * 1. DROP — remove error/empty results, replace with 1-line summary
 * 2. EVICT — under context pressure, drop oldest turns to fit token budget
 *
 * Zero VS Code imports — pure functions for testability.
 */


/**
 * Compacts tool results that represent errors, validation rejections, or empty result sets.
 *
 * @remarks
 * This function identifies "noisy" tool outputs that don't contribute meaningful logic to the
 * model's next turn (e.g., a search with zero matches or a syntax error) and replaces them
 * with a single-line JSON summary to save context tokens.
 *
 * @param toolName - The name of the tool that generated the result.
 * @param resultJson - The raw JSON string returned by the tool.
 * @returns A compacted JSON string if the result is considered "noise", otherwise `null`.
 */
export function compactNoiseResult(toolName: string, resultJson: string): string | null {
  try {
    const parsed = JSON.parse(resultJson);
    const shortName = toolName.replace('lineage_', '');
    // Error responses (excluding action_required which carries gate payload and hop_context)
    if (parsed.error && parsed.error !== 'action_required' && parsed.error !== 'action_required_pending') {
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
  } catch {
    /* not JSON — keep as-is */
  }
  return null;
}


/** Tool names whose results should be compacted once the owning SM is complete. */
const BB_HOP_TOOLS = new Set(['lineage_submit_findings', 'lineage_start_exploration']);

/**
 * Compacts high-volume hop analysis results once the SM execution is complete.
 *
 * @remarks
 * During active exploration, full DDL and analysis results are preserved to allow
 * the model to reason across hops. Once the SM completes, these detailed results
 * become "stale" — their essential findings are already captured in the final synthesis.
 * Compacting them significantly reduces the token footprint for subsequent turns.
 * Column-trace mode reuses the same BB_HOP_TOOLS (start_exploration / submit_findings),
 * so a single completion flag covers both modes.
 *
 * @param toolName - The name of the tool that generated the result.
 * @param resultJson - The raw JSON string returned by the tool.
 * @param smComplete - Whether the owning state machine has finished.
 * @returns A compacted JSON string representing the hop metadata, or `null` if the hop is still active or the tool is not a hop tool.
 */
export function compactStaleHopResult(
  toolName: string,
  resultJson: string,
  smComplete: boolean,
): string | null {
  if (!BB_HOP_TOOLS.has(toolName)) return null;
  if (!smComplete) return null;

  const shortName = toolName.replace('lineage_', '');
  try {
    const parsed = JSON.parse(resultJson);
    const node = parsed.focus_node?.n ?? parsed.originNode?.n ?? '';
    const hop = parsed.hop ?? '';
    const status = parsed.bb_mode ?? parsed.status ?? '';
    return JSON.stringify({
      compacted: true,
      summary: `${shortName} → ${node ? node + ' · ' : ''}${hop ? 'hop ' + hop + ' · ' : ''}${status}`,
    });
  } catch {
    return JSON.stringify({ compacted: true, summary: `${shortName} → (compacted)` });
  }
}


/**
 * The minimum number of history messages to preserve during context eviction.
 *
 * @remarks
 * This threshold ensures that at least 2-3 full conversation turns (User -> Assistant -> Tool)
 * remain in the window, providing the model with enough immediate context to remain coherent.
 */
export const MIN_HISTORY_MESSAGES = 6;

/**
 * Constructs a stub message to replace evicted conversation history.
 *
 * @remarks
 * When messages are dropped from the context window to fit token budgets, this stub is
 * inserted as a system-like notification. It informs the model that earlier context has
 * been removed, preventing it from hallucinating or making assumptions about missing turns.
 *
 * @param evictedCount - The number of messages that were removed from the history.
 * @returns A JSON string representing the eviction metadata.
 */
export function buildEvictionStub(evictedCount: number): string {
  return JSON.stringify({
    evicted: true,
    messages_dropped: evictedCount,
    reason: 'context_pressure',
    hint: 'Earlier conversation was removed to fit context window. Key context from those turns may be missing.',
  });
}

