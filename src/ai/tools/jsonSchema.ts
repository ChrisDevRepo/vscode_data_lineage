/**
 * Zod → model-facing JSON Schema conversion. Zod 4's `z.toJSONSchema` is the single projection
 * source: runtime declarations keep descriptions, strict-object `additionalProperties:false`,
 * integer semantics, enums, patterns and supported bounds, so providers see the constraints the
 * dispatcher validates. Only the top-level dialect marker is removed, because VS Code expects a
 * schema fragment, not a standalone document. No VS Code imports; unit-testable in the `ai`
 * project.
 */
import { z } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

/**
 * Per-schema-object memo for {@link toModelJsonSchema}. Tool input schemas are module-level
 * `z.object(...)` constants (`toolSchemas.ts`), passed on every provider attempt of a self-looping
 * phase (up to `MAX_TOOL_PROVIDER_CALLS` per hop). Keying on schema identity (never a derived
 * string) lets an unrelated schema be collected normally, and the pure, options-invariant
 * conversion runs at most once per distinct schema per process.
 */
const modelJsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaNode>();

/**
 * Generates a fidelity-preserving model-facing JSON Schema fragment (runtime constraints intact, no
 * dialect marker) for a tool's Zod input schema.
 */
export function toModelJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const cached = modelJsonSchemaCache.get(schema);
  if (cached) return cached;
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonSchemaNode;
  const fragment = { ...raw };
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}
