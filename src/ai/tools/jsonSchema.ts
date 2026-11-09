/** Zod → model-facing JSON Schema conversion. */
import { z } from 'zod';

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
    // `pattern` is outside the common vendor keyword subset; admission enforces it.
    if ('pattern' in node && typeof node.pattern === 'string')
      delete node.pattern;
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
      'toolReportMath',
      'toolStringFact',
      'toolArrayFact',
      'toolObjectFact',
      'toolGroups',
      'toolFields',
      'toolValidated',
      'toolDepthOpen',
      'toolIssue',
    ])
      delete (node as Record<string, unknown>)[key];
    Object.values(node).forEach(project);
    const members = (node as { allOf?: unknown[] }).allOf;
    if (Array.isArray(members)) {
      const kept = members.filter(
        (member) =>
          !member ||
          typeof member !== 'object' ||
          Object.keys(member).length > 0,
      );
      if (kept.length) (node as { allOf?: unknown[] }).allOf = kept;
      else delete (node as { allOf?: unknown[] }).allOf;
    }
  };
  project(fragment);
  delete fragment.$schema;
  modelJsonSchemaCache.set(schema, fragment);
  return fragment;
}
