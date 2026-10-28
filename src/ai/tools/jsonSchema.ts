/** Zod → model-facing JSON Schema conversion. */
import { z } from 'zod';

/** A plain JSON-Schema fragment. */
type JsonSchemaNode = Record<string, unknown>;

/** Per-schema-object memo for {@link toModelJsonSchema}. */
const modelJsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaNode>();

/** Generates a fidelity-preserving model-facing JSON Schema for a tool's Zod input schema. */
export function toModelJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const cached = modelJsonSchemaCache.get(schema);
  if (cached) return cached;
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonSchemaNode;
  const fragment = structuredClone(raw);
  const project = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ('toolDisplay' in node) { Object.assign(node, node.toolDisplay); delete node.toolDisplay; }
    for (const key of ['toolAdmission', 'toolIdentifier', 'toolUniqueLabels', 'toolNoteCaptions', 'toolFindingShape', 'toolStringFact', 'toolArrayFact', 'toolObjectFact', 'toolGroups', 'toolValidated', 'toolDepthOpen', 'toolIssue']) delete (node as Record<string, unknown>)[key];
    Object.values(node).forEach(project);
  };
  project(fragment);
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}

const updateSchemaCache = new WeakMap<z.ZodType, z.ZodType>();

/** Stable wire card for replacement drafts: named object fields may be corrected alone; array entries remain complete. Canonical validation still uses the owner. */
export function modelUpdateSchema(schema: z.ZodType): z.ZodType {
  const cached = updateSchemaCache.get(schema);
  if (cached) return cached;
  const card = structuredClone(toModelJsonSchema(schema));
  const relax = (node: JsonSchemaNode): void => {
    delete node.required;
    if (node.properties) for (const child of Object.values(node.properties as Record<string, JsonSchemaNode>)) relax(child);
    for (const key of ['anyOf', 'oneOf', 'allOf']) for (const child of node[key] as JsonSchemaNode[] ?? []) relax(child);
  };
  relax(card);
  const projected = schema.meta({ ...card, required: [] });
  updateSchemaCache.set(schema, projected);
  return projected;
}
