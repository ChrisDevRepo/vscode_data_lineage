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

/** The slice of a JSON Schema node the repair hints and argument coercion read. */
export interface JsonSchemaShape {
  type?: string | string[];
  anyOf?: JsonSchemaShape[];
  oneOf?: JsonSchemaShape[];
  items?: JsonSchemaShape;
  properties?: Record<string, JsonSchemaShape>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
}

/** A node followed by its `anyOf` and `oneOf` branches, nested unions flattened; empty for a missing node. */
export function schemaBranches(node: JsonSchemaShape | undefined): JsonSchemaShape[] {
  if (!node) return [];
  return [node, ...(node.anyOf ?? []).flatMap(schemaBranches), ...(node.oneOf ?? []).flatMap(schemaBranches)];
}


/** Azure/OpenAI strict Structured Outputs limits used to decide projectability at build time. */
const STRICT_SCHEMA_MAX_PROPERTIES = 100;
const STRICT_SCHEMA_MAX_DEPTH = 5;

/** Why a schema cannot be served as a strict tool. */
type StrictSchemaFault = 'root-not-object' | 'record' | 'too-many-properties' | 'too-deep';

/** The served strict projection, or the original fragment when the schema cannot be projected. */
export type StrictSchemaProjection =
  | { readonly strict: true; readonly schema: JsonSchemaNode }
  | { readonly strict: false; readonly schema: JsonSchemaNode; readonly reason: StrictSchemaFault };

const strictProjectionCache = new WeakMap<z.ZodType, StrictSchemaProjection>();

/** Keywords the strict subset does not represent; the Zod parse still enforces them. */
const DROPPED_STRICT_KEYWORDS = [
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
  'uniqueItems',
  'not',
  'if',
  'then',
  'else',
] as const;

/**
 * Projects a Zod schema into the strict Structured Outputs subset (every key required,
 * `additionalProperties: false`, optional properties `anyOf` with `null`, `oneOf` as `anyOf`,
 * unsupported keywords dropped). An unprojectable schema (non-object root, record, more than
 * {@link STRICT_SCHEMA_MAX_PROPERTIES} properties on one object, or deeper than
 * {@link STRICT_SCHEMA_MAX_DEPTH} object levels) stays non-strict and keeps {@link toModelJsonSchema}.
 */
export function toStrictJsonSchema(schema: z.ZodType): StrictSchemaProjection {
  const cached = strictProjectionCache.get(schema);
  if (cached) return cached;
  const original = toModelJsonSchema(schema);
  const fault = rootStrictSchemaFault(original);
  const result: StrictSchemaProjection = fault
    ? { strict: false, schema: original, reason: fault }
    : { strict: true, schema: projectStrictNode(structuredClone(original), original) };
  strictProjectionCache.set(schema, result);
  return result;
}

/** Whether a JSON Schema node admits `null` (nullable / nullish / `anyOf` with a null branch). */
export function schemaAcceptsNull(node: JsonSchemaShape | undefined): boolean {
  return schemaBranches(node).some((branch) => (
    branch.type === 'null'
    || (Array.isArray(branch.type) && branch.type.includes('null'))
    || branch.const === null
  ));
}

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let cursor: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (!isSchemaObject(cursor) || !(part in cursor)) return node;
    cursor = cursor[part];
  }
  return isSchemaObject(cursor) ? cursor : node;
}

function isRecordSchema(node: JsonSchemaNode): boolean {
  return isSchemaObject(node.additionalProperties);
}

function isObjectSchema(node: JsonSchemaNode): boolean {
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) return true;
  return isSchemaObject(node.properties) || node.additionalProperties !== undefined;
}

function rootStrictSchemaFault(root: JsonSchemaNode): StrictSchemaFault | undefined {
  if (root.anyOf || root.oneOf || (Array.isArray(root.allOf) && root.allOf.length > 1)) return 'root-not-object';
  if (!isObjectSchema(root) || (root.type !== undefined && root.type !== 'object')) return 'root-not-object';
  const seen = new Set<JsonSchemaNode>();
  const fault = walkStrictSchemaFault(root, root, 1, seen);
  if (fault) return fault;
  if (isSchemaObject(root.$defs)) {
    for (const def of Object.values(root.$defs)) {
      if (!isSchemaObject(def)) continue;
      const defFault = walkStrictSchemaFault(def, root, 1, seen);
      if (defFault) return defFault;
    }
  }
  return undefined;
}

function walkStrictSchemaFault(
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  objectDepth: number,
  seen: Set<JsonSchemaNode>,
): StrictSchemaFault | undefined {
  const resolved = resolveRef(node, root);
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);
  const object = isObjectSchema(resolved);
  if (object) {
    if (objectDepth > STRICT_SCHEMA_MAX_DEPTH) return 'too-deep';
    if (isRecordSchema(resolved)) return 'record';
    const properties = resolved.properties;
    if (isSchemaObject(properties) && Object.keys(properties).length > STRICT_SCHEMA_MAX_PROPERTIES) {
      return 'too-many-properties';
    }
  }
  if (Array.isArray(resolved.allOf) && resolved.allOf.length > 1) return 'root-not-object';
  const childObjectDepth = object ? objectDepth + 1 : objectDepth;
  for (const child of schemaChildren(resolved)) {
    const childResolved = resolveRef(child, root);
    const nextDepth = isObjectSchema(childResolved) ? childObjectDepth : objectDepth;
    const fault = walkStrictSchemaFault(child, root, nextDepth, seen);
    if (fault) return fault;
  }
  return undefined;
}

function schemaChildren(node: JsonSchemaNode): JsonSchemaNode[] {
  const children: JsonSchemaNode[] = [];
  const properties = node.properties;
  if (isSchemaObject(properties)) {
    for (const value of Object.values(properties)) {
      if (isSchemaObject(value)) children.push(value);
    }
  }
  if (isSchemaObject(node.items)) children.push(node.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isSchemaObject(branch)) children.push(branch);
    }
  }
  return children;
}

function dropUnsupportedKeywords(node: JsonSchemaNode): void {
  for (const key of DROPPED_STRICT_KEYWORDS) delete node[key];
}

function withNullBranch(node: JsonSchemaNode): JsonSchemaNode {
  if (schemaAcceptsNull(node as JsonSchemaShape)) return node;
  return { anyOf: [node, { type: 'null' }] };
}

function projectStrictNode(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  if (typeof node.$ref === 'string') return node;
  dropUnsupportedKeywords(node);
  if (Array.isArray(node.oneOf)) {
    node.anyOf = [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...node.oneOf];
    delete node.oneOf;
  }
  if (Array.isArray(node.allOf) && node.allOf.length === 1 && isSchemaObject(node.allOf[0])) {
    const flattened = projectStrictNode(node.allOf[0], root);
    delete node.allOf;
    const rest = { ...node };
    Object.keys(node).forEach((key) => delete node[key]);
    Object.assign(node, flattened, rest);
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf = node.anyOf.map((branch) => (isSchemaObject(branch) ? projectStrictNode(branch, root) : branch));
  }
  if (isSchemaObject(node.items)) node.items = projectStrictNode(node.items, root);
  const properties = node.properties;
  if (isSchemaObject(properties)) {
    const required = new Set(
      Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === 'string') : [],
    );
    for (const [key, value] of Object.entries(properties)) {
      if (!isSchemaObject(value)) continue;
      const projected = projectStrictNode(value, root);
      properties[key] = required.has(key) ? projected : withNullBranch(projected);
    }
    node.required = Object.keys(properties);
    node.additionalProperties = false;
  } else if (isObjectSchema(node) && (node.type === 'object' || node.type === undefined)) {
    if (!Array.isArray(node.required)) node.required = [];
    node.additionalProperties = false;
  }
  if (isSchemaObject(node.$defs)) {
    for (const [key, def] of Object.entries(node.$defs)) {
      if (isSchemaObject(def)) node.$defs[key] = projectStrictNode(def, root);
    }
  }
  return node;
}
