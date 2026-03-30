/**
 * Smart history management for @lineage chat participant.
 *
 * Three operations on tool results re-injected into conversation history:
 * 1. DROP — remove error/empty results, replace with 1-line summary
 * 2. MERGE — deduplicate overlapping search results (keep superset)
 * 3. FIELD-STRIP — remove heavy fields (ddl, columns) from old results by TTL
 *
 * NEVER truncates JSON strings. Operates on parsed objects, re-serializes valid JSON.
 * Zero VS Code imports — pure functions for testability.
 */

// ─── TTL configuration (in response turns) ──────────────────────────────────

/** Fields and their TTL in response turns. After TTL, the field is stripped. */
const FIELD_TTL: Record<string, number> = {
  ddl:          4,   // 80%+ of token cost — AI can re-fetch via get_ddl_batch
  columns:      6,   // medium cost — AI can re-fetch via get_object_detail
  foreign_keys: 6,
  edges:        8,   // aligned with up/dn — model can reference full BFS at same age
  up:           8,   // neighbor arrays — useful, small
  dn:           8,
};

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

// ─── FIELD-STRIP: remove heavy fields by TTL ────────────────────────────────

/**
 * Strip expired fields from a tool result JSON string based on turn age.
 * Returns the modified JSON string with expired fields removed.
 * Never truncates — only removes complete JSON fields.
 */
export function stripExpiredFields(resultJson: string, turnAge: number): string {
  if (turnAge < 4) return resultJson; // nothing expires before turn 4
  try {
    const parsed = JSON.parse(resultJson);
    if (typeof parsed !== 'object' || parsed === null) return resultJson;
    stripFieldsRecursive(parsed, turnAge);
    return JSON.stringify(parsed);
  } catch {
    return resultJson; // not valid JSON — return as-is
  }
}

function stripFieldsRecursive(obj: Record<string, unknown>, age: number): void {
  for (const field of Object.keys(obj)) {
    const ttl = FIELD_TTL[field];
    if (ttl !== undefined && age >= ttl) {
      delete obj[field];
      continue;
    }
    // Recurse into nested objects and arrays
    const val = obj[field];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'object' && item !== null) {
          stripFieldsRecursive(item as Record<string, unknown>, age);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      stripFieldsRecursive(val as Record<string, unknown>, age);
    }
  }
}
