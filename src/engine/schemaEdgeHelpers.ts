/**
 * Shared helpers for aggregating object-level edges into schema-level edges.
 *
 * Pure, zero-import module used by both the webview projection layer
 * (`schemaProjection`) and the host-side connectivity summarizer
 * (`schemaAdjacency`) so the bidirectional-collapse rules cannot drift.
 */

/** Separator that cannot appear in schema names, for composite edge keys. */
const SCHEMA_EDGE_KEY_SEPARATOR = '\u0000';

/**
 * Aggregated schema-to-schema dependency edge with antiparallel pairs
 * collapsed into a single bidirectional entry.
 */
export interface CollapsedSchemaEdge {
  /** Source schema (lexicographically first when bidirectional). */
  sourceSchema: string;
  /** Target schema for the aggregated dependency edge. */
  targetSchema: string;
  /** Directed edge count from `sourceSchema` to `targetSchema`. */
  count: number;
  /** Directed edge count in the opposite direction. */
  reverseCount: number;
  /** Total count across both directions. */
  totalCount: number;
  /** Whether edges exist in both directions between the schemas. */
  bidirectional: boolean;
}

/** Returns the pair sorted lexicographically ascending. */
function orderedSchemas(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

/** Builds the directed composite key for a schema pair. */
function schemaEdgeKey(sourceSchema: string, targetSchema: string): string {
  return `${sourceSchema}${SCHEMA_EDGE_KEY_SEPARATOR}${targetSchema}`;
}

/** Increments the directed schema→schema edge count in the raw aggregation map. */
export function addRawSchemaEdge(rawEdges: Map<string, number>, sourceSchema: string, targetSchema: string): void {
  const key = schemaEdgeKey(sourceSchema, targetSchema);
  rawEdges.set(key, (rawEdges.get(key) ?? 0) + 1);
}

/**
 * Collapses a raw directed schema→schema count map into deduplicated edges,
 * merging antiparallel pairs into single bidirectional entries.
 *
 * @param rawEdges - Directed counts keyed by {@link schemaEdgeKey}.
 *
 * @returns Edges in sorted-key encounter order; bidirectional entries use the
 * lexicographically first schema as the source.
 */
export function collapseRawSchemaEdges(rawEdges: ReadonlyMap<string, number>): CollapsedSchemaEdge[] {
  const consumed = new Set<string>();
  const edges: CollapsedSchemaEdge[] = [];

  for (const key of [...rawEdges.keys()].sort((a, b) => a.localeCompare(b))) {
    if (consumed.has(key)) continue;
    const [sourceSchema, targetSchema] = key.split(SCHEMA_EDGE_KEY_SEPARATOR);
    const reverseKey = schemaEdgeKey(targetSchema, sourceSchema);
    const reverseCount = rawEdges.get(reverseKey);

    if (reverseCount !== undefined) {
      const [source, target] = orderedSchemas(sourceSchema, targetSchema);
      const forwardKey = schemaEdgeKey(source, target);
      const backwardKey = schemaEdgeKey(target, source);
      const count = rawEdges.get(forwardKey) ?? 0;
      const reverse = rawEdges.get(backwardKey) ?? 0;
      consumed.add(forwardKey);
      consumed.add(backwardKey);
      edges.push({
        sourceSchema: source,
        targetSchema: target,
        count,
        reverseCount: reverse,
        totalCount: count + reverse,
        bidirectional: true,
      });
      continue;
    }

    consumed.add(key);
    const count = rawEdges.get(key)!;
    edges.push({
      sourceSchema,
      targetSchema,
      count,
      reverseCount: 0,
      totalCount: count,
      bidirectional: false,
    });
  }

  return edges;
}
