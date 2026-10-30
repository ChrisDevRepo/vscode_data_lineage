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
  const raw = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'throw',
  }) as JsonSchemaNode;
  const fragment = structuredClone(raw);
  const project = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ('toolDisplay' in node) {
      Object.assign(node, node.toolDisplay);
      delete node.toolDisplay;
    }
    for (const key of [
      'toolAdmission',
      'toolIdentifier',
      'toolChoice',
      'toolUniqueLabels',
      'toolNoteCaptions',
      'toolFindingShape',
      'toolStringFact',
      'toolArrayFact',
      'toolObjectFact',
      'toolGroups',
      'toolValidated',
      'toolDepthOpen',
      'toolIssue',
    ])
      delete (node as Record<string, unknown>)[key];
    Object.values(node).forEach(project);
  };
  project(fragment);
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}
