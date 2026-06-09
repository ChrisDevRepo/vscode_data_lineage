import type { DatabaseModel } from './types';
import { groupByWeaklyConnected } from './unionFind';
import { addRawSchemaEdge, collapseRawSchemaEdges } from './schemaEdgeHelpers';

/**
 * Aggregated dependency relation between two schemas.
 *
 * @remarks
 * Direction follows the object-level edge convention (`source` is the object
 * being depended upon, `target` the dependent). Antiparallel relations are
 * collapsed into a single entry with {@link bidirectional} set.
 */
export interface SchemaInterEdge {
  /** Schema on the source side (lexicographically first when bidirectional). */
  source: string;
  /** Schema on the target side. */
  target: string;
  /** Object-level edge count in the `source → target` direction. */
  count: number;
  /** Object-level edge count in the `target → source` direction. */
  reverseCount: number;
  /** Total object-level edges across both directions. */
  totalCount: number;
  /** Whether object-level edges exist in both directions. */
  bidirectional: boolean;
}

/**
 * A weakly-connected group of schemas in the model's schema-level graph.
 */
export interface SchemaComponent {
  /** Member schema names, sorted ascending. */
  schemas: string[];
  /** True when the component is a single schema with no inter-schema edge. */
  isolated: boolean;
}

/**
 * Filter-independent connectivity summary of the full model, at schema granularity.
 *
 * @remarks
 * This is the schema-level quotient of the entire object graph — every schema is
 * present regardless of the current GUI filter, so it shows which schema bridges
 * which (and which bridge a narrowed filter would drop). Used by the debug dump.
 */
export interface ModelConnectivity {
  /** Object count per schema, sorted by schema name. */
  schemaObjectCounts: Array<{ schema: string; objectCount: number }>;
  /** Deduplicated inter-schema relations, sorted by `source` then `target`. */
  interSchemaEdges: SchemaInterEdge[];
  /** Weakly-connected schema groups, largest first then by first schema name. */
  components: SchemaComponent[];
  /** Schemas with no inter-schema edge (their own singleton component), sorted. */
  isolatedSchemas: string[];
}

/**
 * Computes the schema-level connectivity of the entire model.
 *
 * @param model - The database model whose nodes/edges are summarized.
 *
 * @returns Per-schema object counts, deduplicated inter-schema edges, and the
 * weakly-connected schema components (with isolated schemas flagged).
 */
export function summarizeModelConnectivity(model: DatabaseModel): ModelConnectivity {
  // schema universe = declared schemas ∪ schemas seen on nodes (defence against drift)
  const schemaUniverse = new Set<string>();
  const objectCounts = new Map<string, number>();
  const nodeSchema = new Map<string, string>();

  for (const s of model.schemas) {
    if (s.name) schemaUniverse.add(s.name);
  }
  for (const node of model.nodes) {
    nodeSchema.set(node.id, node.schema);
    if (!node.schema) continue;
    schemaUniverse.add(node.schema);
    objectCounts.set(node.schema, (objectCounts.get(node.schema) ?? 0) + 1);
  }

  // directed schema→schema aggregation, intra-schema edges skipped
  const rawEdges = new Map<string, number>();
  for (const edge of model.edges) {
    const src = nodeSchema.get(edge.source);
    const tgt = nodeSchema.get(edge.target);
    if (!src || !tgt || src === tgt) continue;
    addRawSchemaEdge(rawEdges, src, tgt);
  }

  // collapse antiparallel pairs into single bidirectional entries
  const interSchemaEdges: SchemaInterEdge[] = collapseRawSchemaEdges(rawEdges).map((e) => ({
    source: e.sourceSchema, target: e.targetSchema, count: e.count, reverseCount: e.reverseCount, totalCount: e.totalCount, bidirectional: e.bidirectional,
  }));
  interSchemaEdges.sort((x, y) => x.source.localeCompare(y.source) || x.target.localeCompare(y.target));

  // weakly-connected components over the undirected schema graph
  const components: SchemaComponent[] = groupByWeaklyConnected(
    [...schemaUniverse],
    interSchemaEdges.map((e) => [e.source, e.target] as const),
    (schema) => schema,
  ).map((schemas) => ({ schemas, isolated: schemas.length === 1 }));

  const isolatedSchemas = components.filter((c) => c.isolated).map((c) => c.schemas[0]).sort((a, b) => a.localeCompare(b));

  const schemaObjectCounts = [...schemaUniverse]
    .sort((a, b) => a.localeCompare(b))
    .map((schema) => ({ schema, objectCount: objectCounts.get(schema) ?? 0 }));

  return { schemaObjectCounts, interSchemaEdges, components, isolatedSchemas };
}

/**
 * Renders a {@link ModelConnectivity} as the human-readable `MODEL CONNECTIVITY`
 * block used in the debug dump.
 *
 * @param conn - The connectivity summary to format.
 *
 * @returns Indented multi-line text (no trailing newline).
 */
export function formatModelConnectivity(conn: ModelConnectivity): string {
  const lines: string[] = [];
  const countsBySchema = new Map(conn.schemaObjectCounts.map((s) => [s.schema, s.objectCount]));
  lines.push(`  Components: ${conn.components.length}`);
  conn.components.forEach((c, i) => {
    const members = c.schemas.map((s) => `${s} (${countsBySchema.get(s) ?? 0})`).join(', ');
    const tag = c.isolated ? ' — ISOLATED (no inter-schema edges)' : '';
    lines.push(`  [${i + 1}] ${members}${tag}`);
    const schemaSet = new Set(c.schemas);
    const inside = conn.interSchemaEdges.filter((e) => schemaSet.has(e.source) && schemaSet.has(e.target));
    for (const e of inside) {
      const arrow = e.bidirectional ? `↔ (${e.count}/${e.reverseCount})` : `→ (${e.count})`;
      lines.push(`        ${e.source} ${arrow} ${e.target}`);
    }
  });
  if (conn.isolatedSchemas.length > 0) {
    lines.push(`  Schemas with no inter-schema edge: ${conn.isolatedSchemas.join(', ')}`);
  }
  return lines.join('\n');
}
