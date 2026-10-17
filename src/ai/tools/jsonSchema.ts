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
  const fragment = { ...raw };
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}
