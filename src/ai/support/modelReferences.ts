/** Metadata-bound SQL representations at the AI boundary; saved aliases remain separate. */
import { normalizeColName } from '../../utils/sql';
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

/** Matches declared column names using exact spelling first, then unique source-policy aliases; absent metadata stays trusted. */
export function resolveModelColumnNames(declaredNames: readonly string[], columns: readonly string[], identifierCaseSensitive = false): { resolved: string[]; unmatched: string[] } {
  const declared = new Set(declaredNames);
  const resolved: string[] = [], unmatched: string[] = [];
  for (const column of columns) {
    if (declared.size === 0 || declared.has(column)) { resolved.push(column); continue; }
    const matches = [...declared].filter(name => normalizeColName(name, identifierCaseSensitive) === normalizeColName(column, identifierCaseSensitive));
    if (matches.length === 1) resolved.push(matches[0]!);
    else unmatched.push(column);
  }
  return { resolved, unmatched };
}
