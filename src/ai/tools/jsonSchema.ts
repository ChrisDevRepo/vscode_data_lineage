/** Zod → JSON Schema projection: the served model-facing card and the admitted schema. */
import { z } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

/** Annotations Ajv carries without code; the error facts and receipts read them from nodes. */
export const TOOL_VOCABULARY = [
  'toolIssue',
  'toolFields',
  'toolIdentifier',
  'toolCategory',
  'toolChoice',
];

/**
 * Annotations whose evaluation point a rejection reads: the domain rules and fact receipts they
 * name run after validation, once per place Ajv evaluated them.
 */
export const RECORDED = [
  'toolUniqueLabels',
  'toolNoteCaptions',
  'toolFindingShape',
  'toolDepthOpen',
  'toolValidated',
  'toolArrayFact',
  'toolObjectFact',
  'toolStringFact',
];

/**
 * The one raw JSON-Schema generation of a tool's Zod input schema, input-side and
 * fidelity-preserving; a `never` node carries its issue. Both projections walk this output.
 */
export function rawJsonSchema(schema: z.ZodType): JsonSchemaNode {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'throw',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodNever) jsonSchema.toolIssue = 'never';
    },
  }) as JsonSchemaNode;
}

/** A node's `toolDisplay` plain JSON merges into the node itself, served and admitted alike. */
const mergeDisplay = (node: object): void => {
  if ('toolDisplay' in node) {
    Object.assign(node, node.toolDisplay);
    delete node.toolDisplay;
  }
};

/** Per-schema-object memo for {@link toModelJsonSchema}. */
const modelJsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaNode>();

/** Generates a fidelity-preserving model-facing JSON Schema for a tool's Zod input schema. */
export function toModelJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const cached = modelJsonSchemaCache.get(schema);
  if (cached) return cached;
  const fragment = structuredClone(rawJsonSchema(schema));
  const project = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    // `pattern` is outside the common vendor keyword subset; admission enforces it.
    if ('pattern' in node && typeof node.pattern === 'string')
      delete node.pattern;
    mergeDisplay(node);
    for (const key of [
      ...TOOL_VOCABULARY,
      ...RECORDED,
      'toolAdmission',
      'toolGroups',
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

/** Served constraints remain canonical after ModelPort representation normalization. */
export function admittedJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const result = rawJsonSchema(schema);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    mergeDisplay(node);
    if ('toolAdmission' in node) {
      Object.assign(node, node.toolAdmission);
      delete node.toolAdmission;
    }
    if ('toolGroups' in node) {
      const owner = node as Record<string, unknown>,
        properties = owner.properties as Record<string, unknown>;
      const groups = owner.toolGroups as Array<{
        name: string;
        fields: string[];
        assertions?: Record<string, unknown>;
      }>;
      delete owner.toolGroups;
      for (const group of groups) {
        const fields = group.fields.filter((key) =>
          Object.prototype.hasOwnProperty.call(properties, key),
        );
        const required = (owner.required ?? []) as string[];
        // Fields the group asserts as required join its own, beside their property schemas.
        const { required: asserted = [], ...assertions } =
          group.assertions ?? {};
        const schema = {
          properties: Object.fromEntries(
            fields.map((key) => [key, properties[key]]),
          ),
          required: [
            ...new Set([
              ...required.filter((key) => fields.includes(key)),
              ...(asserted as string[]),
            ]),
          ],
          ...assertions,
        };
        for (const key of fields) properties[key] = {};
        owner.required = required.filter((key) => !fields.includes(key));
        owner.allOf = [
          ...((owner.allOf as unknown[]) ?? []),
          { ...schema, toolValidated: group.name, toolFields: fields },
        ];
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(result);
  return result;
}
