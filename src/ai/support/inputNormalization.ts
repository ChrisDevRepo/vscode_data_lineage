/**
 * Input normalization helpers for AI-controlled fields.
 *
 * @remarks
 * Keeps boundary normalization deterministic and reusable across tool handlers,
 * state-machine init, and prompt rendering.
 */
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { splitSqlName, stripBrackets } from '../../utils/sql';

/**
 * Re-exported so AI callers keep importing node-id resolution from here.
 * Implementation lives in `src/engine/shared/` because the webview needs it too and must not
 * reach into `src/ai/**`.
 */
export { resolveModelNodeId };

/** Raw object-like `submit_findings` payload before strict BB/CT schema validation. */
export type SubmitFindingsInputObject = Record<string, unknown> & {
  focus_node_id?: unknown;
  prune_neighbors?: unknown;
  questions?: unknown;
  column_flow?: unknown;
};

/** One field-level ID canonicalization applied to a cloned `submit_findings` payload. */
export interface SubmitFindingsIdNormalization {
  /** Dot-path of the normalized field in the cloned input. */
  readonly field: string;
  /** Original model-supplied ID spelling. */
  readonly from: string;
  /** Canonical model ID used for validation and dispatch. */
  readonly to: string;
}

/** Result of cloned `submit_findings` ID normalization. */
export interface SubmitFindingsNormalizationResult {
  /** Cloned payload passed to strict mode-specific Zod validation. */
  readonly input: SubmitFindingsInputObject;
  /** Canonicalization events emitted for debug logging. */
  readonly normalizations: SubmitFindingsIdNormalization[];
}

/**
 * Resolves multiple node ids while preserving order and removing duplicates.
 *
 * @param raws - An array of raw node id strings.
 * @param nodeMap - The map of canonical nodes to check against.
 * @param identifierCaseSensitive - Proven source policy; missing/false retains legacy case-insensitive lookup.
 * @returns An object containing resolved and unresolved node id arrays.
 */
export function resolveModelNodeIds(
  raws: string[],
  nodeMap: Map<string, unknown>,
  identifierCaseSensitive = false,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seenResolved = new Set<string>();
  for (const raw of raws) {
    const id = resolveModelNodeId(raw, nodeMap, identifierCaseSensitive);
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seenResolved.has(id)) continue;
    seenResolved.add(id);
    resolved.push(id);
  }
  return { resolved, unresolved };
}

/**
 * Normalizes submit_findings node-id encodings into a cloned input object.
 *
 * @remarks
 * This is intentionally narrow: it canonicalizes bracket/case/name encodings only
 * and never removes unknown fields or changes the raw object supplied by the model.
 * Source case sensitivity preserves spelling and never substitutes a distinct object.
 * The caller must still run the cloned output through the strict BB/CT Zod schema.
 *
 * @param rawInput - Raw model input object.
 * @param nodeMap - Canonical model node map used by {@link resolveModelNodeId}.
 * @returns The cloned input and a list of field-level normalization events.
 */
export function normalizeSubmitFindingsInputIds(
  rawInput: SubmitFindingsInputObject,
  nodeMap: Map<string, unknown>,
  identifierCaseSensitive = false,
): SubmitFindingsNormalizationResult {
  const input: SubmitFindingsInputObject = { ...rawInput };
  const normalizations: SubmitFindingsIdNormalization[] = [];
  const note = (field: string, from: string, to: string): void => {
    if (from !== to) normalizations.push({ field, from, to });
  };

  if (typeof rawInput.focus_node_id === 'string') {
    const resolved = resolveModelNodeId(rawInput.focus_node_id, nodeMap, identifierCaseSensitive);
    if (resolved) {
      input.focus_node_id = resolved;
      note('focus_node_id', rawInput.focus_node_id, resolved);
    }
  }

  const normalizeEntryIds = (list: unknown[], listName: string, key: string): unknown[] => list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value !== 'string') return entry;
    const resolved = resolveModelNodeId(value, nodeMap, identifierCaseSensitive) ?? value;
    note(`${listName}.${index}.${key}`, value, resolved);
    return { ...(entry as Record<string, unknown>), [key]: resolved };
  });
  if (Array.isArray(rawInput.prune_neighbors)) {
    input.prune_neighbors = normalizeEntryIds(rawInput.prune_neighbors, 'prune_neighbors', 'id');
  }
  if (Array.isArray(rawInput.questions)) {
    input.questions = normalizeEntryIds(rawInput.questions, 'questions', 'nodeId');
  }

  return { input, normalizations };
}

/**
 * Normalizes a free-form `lineage_search_objects.query` string.
 *
 * @remarks
 * Accepts common id-like forms the AI may emit (e.g. `[dbo].[FactSales]`,
 * `dbo.FactSales`, `[db].[dbo].[FactSales]`) and extracts:
 * - `query`: the object token to search by (e.g. `FactSales`)
 * - `schemaHint`: optional schema token (`dbo`) usable as a schema filter
 *
 * Parts are split and undelimited by {@link splitSqlName} and {@link stripBrackets}, so a dot or
 * an escaped `]]` inside a bracketed or quoted part stays in the name. With more than three
 * parts, returns the trimmed input unchanged and no schema hint.
 *
 * @param raw - The free-form query string.
 * @returns An object with the extracted query and optional schema hint.
 */
export function normalizeSearchQueryInput(raw: string): { query: string; schemaHint?: string } {
  const input = (raw ?? '').trim();
  if (!input) return { query: '' };

  const parts = splitSqlName(input).map(p => stripBrackets(p.trim()).trim()).filter(Boolean);

  if (parts.length === 1) return { query: parts[0] };
  if (parts.length === 2) return { query: parts[1], schemaHint: parts[0] };
  if (parts.length === 3) return { query: parts[2], schemaHint: parts[1] };

  return { query: input };
}

/** JSON Schema fragment the coercion reads. */
interface JsonSchemaNode {
  type?: string | string[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
}

/** Result of coercing one tool-argument payload. */
export interface StringifiedArgumentsResult {
  /** The payload with every stringified structure decoded; the input object when nothing changed. */
  readonly value: unknown;
  /** Dotted paths that were decoded. */
  readonly paths: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function branches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
  if (!schema) return [];
  return [schema, ...(schema.anyOf ?? []).flatMap(branches), ...(schema.oneOf ?? []).flatMap(branches)];
}

function declaredTypes(schema: JsonSchemaNode | undefined): Set<string> {
  return new Set(branches(schema).flatMap((node) => (node.type === undefined ? [] : [node.type].flat())));
}

/** Parses a JSON text with the platform parser; `undefined` when the text is not valid JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function coerce(value: unknown, schema: JsonSchemaNode | undefined, path: string, paths: string[]): unknown {
  const types = declaredTypes(schema);
  if (typeof value === 'string' && !types.has('string') && (types.has('array') || types.has('object'))) {
    const decoded: unknown = parseJson(value);
    if (
      (Array.isArray(decoded) && types.has('array')) ||
      (isPlainObject(decoded) && types.has('object')) ||
      (decoded === null && value.trim() === 'null' && types.has('null'))
    ) {
      paths.push(path);
      return coerce(decoded, schema, path, paths);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = branches(schema).find((node) => node.items)?.items;
    return items ? value.map((item, index) => coerce(item, items, `${path}.${index}`, paths)) : value;
  }
  if (isPlainObject(value)) {
    const properties = branches(schema).flatMap((node) => Object.entries(node.properties ?? {}));
    if (properties.length === 0) return value;
    const declared = new Map<string, JsonSchemaNode>();
    for (const [key, node] of properties) if (!declared.has(key)) declared.set(key, node);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      coerce(child, declared.get(key), path ? `${path}.${key}` : key, paths),
    ]));
  }
  return value;
}

/**
 * Decodes JSON-string values where the tool's JSON Schema declares an array or object, or `null`
 * beside one of them.
 *
 * @remarks
 * Some model servers return an array- or object-typed argument as a JSON string
 * (`"targetColumns": "[\"A\"]"`); the product cannot know which server it talks to, so the decode
 * runs once at the model boundary for every tool and model, driven by the declared schema alone.
 * The decode is `JSON.parse`. A text that is not valid JSON — cut off before its value closes, or
 * carrying raw line breaks inside a string — is never completed or repaired: it stays a string and
 * fails schema validation at its field.
 * The caller logs {@link StringifiedArgumentsResult.paths}.
 *
 * @param input - Tool arguments as the provider returned them.
 * @param jsonSchema - The tool's model-facing JSON Schema.
 * @returns The coerced payload and the paths decoded; a value that does not parse to the declared
 * kind stays as sent so schema validation rejects it with its field path.
 */
export function coerceStringifiedArguments(input: unknown, jsonSchema: unknown): StringifiedArgumentsResult {
  const paths: string[] = [];
  const value = coerce(input, jsonSchema as JsonSchemaNode, '', paths);
  return { value: paths.length > 0 ? value : input, paths };
}
