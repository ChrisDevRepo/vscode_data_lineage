import type { DatabaseModel } from './types';
import { groupByWeaklyConnected } from './unionFind';

/** A weakly-connected group of schemas in the model's schema-level graph. */
interface SchemaComponent {
  /** Member schema names, sorted ascending. */
  schemas: string[];
}

/** Filter-independent connectivity summary of the full model, at schema granularity. */
export interface ModelConnectivity {
  /** Weakly-connected schema groups, largest first then by first schema name. */
  components: SchemaComponent[];
  /** Schemas with no inter-schema edge (their own singleton component), sorted. */
  isolatedSchemas: string[];
}

/** Computes the schema-level connectivity of the entire model. */
export function summarizeModelConnectivity(
  model: DatabaseModel,
): ModelConnectivity {
  const schemaUniverse = new Set<string>();
  const nodeSchema = new Map<string, string>();

  for (const s of model.schemas) {
    if (s.name) schemaUniverse.add(s.name);
  }
  for (const node of model.nodes) {
    nodeSchema.set(node.id, node.schema);
    if (node.schema) schemaUniverse.add(node.schema);
  }

  const schemaLinks: Array<readonly [string, string]> = [];
  for (const edge of model.edges) {
    const src = nodeSchema.get(edge.source);
    const tgt = nodeSchema.get(edge.target);
    if (src && tgt && src !== tgt) schemaLinks.push([src, tgt]);
  }

  const components: SchemaComponent[] = groupByWeaklyConnected(
    [...schemaUniverse],
    schemaLinks,
    (schema) => schema,
  ).map((schemas) => ({ schemas }));
  const isolatedSchemas = components
    .filter((c) => c.schemas.length === 1)
    .map((c) => c.schemas[0])
    .sort((a, b) => a.localeCompare(b));

  return { components, isolatedSchemas };
}

/** Isolated schema names printed before the dump says how many more there are. */
const ISOLATED_SCHEMA_NAME_CAP = 8;

/** Renders a {@link ModelConnectivity} as the short `MODEL CONNECTIVITY` block in the debug dump. */
export function formatModelConnectivity(conn: ModelConnectivity): string {
  const lines = [
    `  Components: ${conn.components.length}`,
    `  Isolated schemas: ${conn.isolatedSchemas.length}`,
  ];
  if (conn.isolatedSchemas.length > 0) {
    const shown = conn.isolatedSchemas.slice(0, ISOLATED_SCHEMA_NAME_CAP);
    const extra = conn.isolatedSchemas.length - shown.length;
    lines.push(
      `  Isolated: ${shown.join(', ')}${extra > 0 ? ` … +${extra} more` : ''}`,
    );
  }
  return lines.join('\n');
}
