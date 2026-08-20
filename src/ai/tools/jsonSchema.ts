/**
 * Zod → model-facing JSON Schema conversion.
 *
 * @remarks
 * Zod 4's built-in `z.toJSONSchema` is the single projection source. Runtime declarations
 * preserve descriptions, strict-object `additionalProperties:false`, integer semantics,
 * enums, patterns, and supported bounds so providers see the same constraints the dispatcher
 * validates. Only the top-level JSON Schema dialect marker is removed because VS Code expects
 * a schema fragment rather than a standalone schema document.
 *
 * Zero VS Code imports — pure schema transformation, unit-testable in the `ai` project.
 */
import { z } from 'zod';

/** A plain JSON-Schema fragment. */
type JsonSchemaNode = Record<string, unknown>;

/**
 * Per-schema-object memo for {@link toModelJsonSchema}.
 *
 * @remarks
 * Tool input schemas are module-level `z.object(...)` constants declared once in the registry
 * (`toolSchemas.ts`) — the same object reference is passed in on every provider attempt of a
 * self-looping phase (up to `MAX_TOOL_PROVIDER_CALLS` per hop). Keying on schema identity (never a
 * derived string) lets an unrelated schema fall out of scope and be collected normally, and the
 * conversion — pure and options-invariant — runs at most once per distinct schema for the process.
 */
const modelJsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaNode>();

/**
 * Generates a fidelity-preserving model-facing JSON Schema for a tool's Zod input schema.
 *
 * @param schema - The single Zod source for the tool's input.
 * @returns The JSON Schema fragment with runtime constraints intact and no dialect marker.
 */
export function toModelJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const cached = modelJsonSchemaCache.get(schema);
  if (cached) return cached;
  // `io: 'input'` selects the pre-parse (model-supplied) shape — the surface the model
  // must satisfy — so `z.coerce`/`.default()` reflect what the caller actually sends.
  // `unrepresentable: 'throw'` fails loudly if a future schema construct can't be represented,
  // rather than silently widening it to "accepts anything" (which the drift guard would pass).
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonSchemaNode;
  const fragment = { ...raw };
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}
