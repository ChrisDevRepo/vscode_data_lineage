/**
 * History management for @lineage chat participant.
 *
 * Three operations on tool results re-injected into conversation history:
 * 1. DROP — remove error/empty results, replace with 1-line summary
 * 2. MERGE — deduplicate overlapping search results (keep superset)
 * 3. EVICT — under context pressure, drop oldest turns to fit token budget
 *
 * Token budget decisions (inline vs on-demand) are made at tool call time
 * by shouldInline() in tokenBudget.ts. History manager never truncates data
 * within a single tool response — eviction operates at the turn level.
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

// ─── MERGE: deduplicate overlapping results ─────────────────────────────────

interface ToolCallInfo {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Given tool calls across all rounds of a response turn, identify duplicate/subset calls.
 * Returns a Set of callIds that should be DROPPED (subsets/duplicates).
 */
export function findMergeableCallIds(rounds: Array<{ toolCalls: ToolCallInfo[] }>): Set<string> {
  const dropIds = new Set<string>();
  const searchCalls: Array<{ callId: string; query: string; schemas: string[] | undefined }> = [];

  // Collect all search_objects calls
  for (const round of rounds) {
    for (const tc of round.toolCalls) {
      if (tc.name === 'lineage_search_objects' || tc.name === 'search_objects') {
        const input = tc.input as Record<string, unknown>;
        searchCalls.push({
          callId: tc.callId,
          query: (input.query as string || '').toLowerCase(),
          schemas: input.schemas as string[] | undefined,
        });
      }
    }
  }

  // For each pair of search calls, if one is a subset of the other, drop the subset
  for (let i = 0; i < searchCalls.length; i++) {
    for (let j = i + 1; j < searchCalls.length; j++) {
      const a = searchCalls[i];
      const b = searchCalls[j];
      // Same query text — check schema scope
      if (a.query === b.query) {
        const aHasSchemas = a.schemas && a.schemas.length > 0;
        const bHasSchemas = b.schemas && b.schemas.length > 0;
        if (aHasSchemas && !bHasSchemas) {
          // b is broader (no schema filter) — drop a
          dropIds.add(a.callId);
        } else if (!aHasSchemas && bHasSchemas) {
          // a is broader — drop b
          dropIds.add(b.callId);
        } else if (aHasSchemas && bHasSchemas) {
          // Both have schemas — keep the one with more schemas (broader)
          const aSet = new Set(a.schemas!.map(s => s.toLowerCase()));
          const bSet = new Set(b.schemas!.map(s => s.toLowerCase()));
          const aSubsetOfB = [...aSet].every(s => bSet.has(s));
          const bSubsetOfA = [...bSet].every(s => aSet.has(s));
          if (aSubsetOfB && !bSubsetOfA) dropIds.add(a.callId);
          else if (bSubsetOfA && !aSubsetOfB) dropIds.add(b.callId);
          else if (aSubsetOfB && bSubsetOfA) dropIds.add(a.callId); // identical — drop older
        } else {
          // Both have no schema filter, same query — drop older
          dropIds.add(a.callId);
        }
      }
    }
  }

  // Deduplicate BFS traces with same origin
  const bfsCalls: Array<{ callId: string; id: string; upHops: number; downHops: number }> = [];
  for (const round of rounds) {
    for (const tc of round.toolCalls) {
      if (tc.name === 'lineage_run_bfs_trace' || tc.name === 'run_bfs_trace') {
        const input = tc.input as Record<string, unknown>;
        bfsCalls.push({
          callId: tc.callId,
          id: (input.id as string || '').toLowerCase(),
          upHops: (input.upstream_hops as number) ?? 3,
          downHops: (input.downstream_hops as number) ?? 3,
        });
      }
    }
  }

  for (let i = 0; i < bfsCalls.length; i++) {
    for (let j = i + 1; j < bfsCalls.length; j++) {
      const a = bfsCalls[i];
      const b = bfsCalls[j];
      if (a.id === b.id) {
        // Same origin — keep the one with more hops
        const aTotalHops = a.upHops + a.downHops;
        const bTotalHops = b.upHops + b.downHops;
        if (aTotalHops <= bTotalHops) dropIds.add(a.callId);
        else dropIds.add(b.callId);
      }
    }
  }

  return dropIds;
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

