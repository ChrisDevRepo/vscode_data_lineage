/** Metadata-bound SQL representations at the AI boundary; saved aliases remain separate. */
import { sqlIdentifierComparisonKey } from '../../engine/shared/sqlIdentifier';

/** Binds an equivalent SQL spelling only when one loaded identity owns it under source CI/CS. */
export function resolveModelNodeId(raw: string, nodeMap: Map<string, unknown>, identifierCaseSensitive = false): string | null {
  if (nodeMap.has(raw)) return raw;
  const key = sqlIdentifierComparisonKey(raw, identifierCaseSensitive);
  if (key === null) return null;
  let owner: string | null = null;
  for (const id of nodeMap.keys()) {
    if (sqlIdentifierComparisonKey(id, identifierCaseSensitive) !== key) continue;
    if (owner !== null && owner !== id) return null;
    owner = id;
  }
  return owner;
}

/**
 * Resolves multiple node ids while preserving order and removing duplicates.
 *
 * @param raws - An array of raw node id strings.
 * @param nodeMap - The map of canonical nodes to check against.
 * @returns An object containing resolved and unresolved node id arrays.
 */
export function resolveModelNodeIds(
  raws: string[],
  nodeMap: Map<string, unknown>,
  identifierCaseSensitive = false,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seenResolved = new Set<string>();
  for (const raw of raws) {
    const id = resolveModelNodeId(raw, nodeMap, identifierCaseSensitive);
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seenResolved.has(id)) continue;
    seenResolved.add(id);
    resolved.push(id);
  }
  return { resolved, unresolved };
}
