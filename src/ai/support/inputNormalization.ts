/**
 * Input normalization helpers for AI-controlled fields: deterministic boundary normalization
 * reusable across tool handlers, state-machine init and prompt rendering.
 */
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';

/**
 * Re-exported so AI callers keep importing node-id resolution from here; the implementation lives
 * in `src/engine/shared/` because the webview needs it too and must not reach into `src/ai/**`.
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
interface SubmitFindingsIdNormalization {
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
 * Resolves multiple node ids, preserving order and removing duplicates; returns resolved and
 * unresolved id arrays.
 *
 * @param identifierCaseSensitive - Proven source policy; missing/false retains legacy
 *   case-insensitive lookup.
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

/** The escape letter a JSON string decodes to each C0 control character LaTeX commands start with. */
const ESCAPE_LETTER: Readonly<Record<string, string>> = { '\b': 'b', '\t': 't', '\f': 'f', '\r': 'r' };

/**
 * Restores single-backslash LaTeX in every string of an AI tool input. RFC 8259 section 7
 * lets a JSON string hold a BACKSPACE, TAB, FORM FEED or CR only through its escape, so a model's
 * `\text`, `\times`, `\beta` or `\frac` arrives as that control character plus the rest of the
 * command; the backslash and letter are put back. A CR before LF is a line ending and is dropped;
 * LF and every other character stay. Returns the value itself when nothing changes.
 */
export function restoreEscapedControlCharacters<T>(value: T): T {
  if (typeof value === 'string') {
    if (!/[\b\t\f\r]/u.test(value)) return value;
    return value.replace(/[\b\t\f\r]/gu, (char, offset: number) => (char === '\r' && value[offset + 1] === '\n' ? '' : `\\${ESCAPE_LETTER[char]}`)) as T;
  }
  if (Array.isArray(value)) {
    const items = value.map(item => restoreEscapedControlCharacters(item));
    return (items.some((item, index) => item !== value[index]) ? items : value) as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, restoreEscapedControlCharacters(item)] as const);
    return (entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

/**
 * Normalizes submit_findings node-id encodings into a cloned input object. Deliberately narrow:
 * canonicalizes bracket/case/name encodings only and never removes unknown fields or changes the
 * model's raw object. Source case sensitivity preserves spelling and never substitutes a distinct
 * object. The caller must still run the clone through the strict BB/CT Zod schema.
 *
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

/** Catalog facts {@link normalizeSearchQueryInput} uses to confirm a reading of a dotted name. */
export interface SearchQueryCatalog {
  /** Canonical node id to node. */
  readonly nodeMap: Map<string, { name: string; schema: string; columns?: readonly { name: string }[] }>;
  /** Schema names of the model. */
  readonly schemas: readonly string[];
  /** Proven source policy; missing/false compares names case-insensitively. */
  readonly identifierCaseSensitive?: boolean;
}

/**
 * Normalizes a free-form `lineage_search_objects.query` string. Accepts id-like forms the AI may
 * emit (`[dbo].[FactSales]`, `dbo.FactSales`, `[db].[dbo].[FactSales]`) and extracts `query` (the
 * object token, `FactSales`) and an optional `schemaHint` (`dbo`) usable as a schema filter. Parts
 * are split and undelimited by {@link splitSqlName} and {@link stripBrackets}, so a dot or escaped
 * `]]` inside a bracketed or quoted part stays in the name. With more than three parts it returns
 * the trimmed input and no schema hint.
 *
 * With `catalog`, a dotted name the catalog confirms as a column reference reads as one: three
 * parts `schema.object.column` when `schema.object` is an object, two parts `object.column` when
 * the first part is no schema and the object has that column. The column token is dropped like the
 * `db` token; the object is searched (an object that is also a schema name wins, deterministically).
 * Several schemas holding that object and column leave the schema out. Anything the catalog does not
 * confirm keeps the reading above.
 */
export function normalizeSearchQueryInput(raw: string, catalog?: SearchQueryCatalog): { query: string; schemaHint?: string } {
  const input = (raw ?? '').trim();
  if (!input) return { query: '' };

  const parts = splitSqlName(input).map(p => stripBrackets(p.trim()).trim()).filter(Boolean);
  const caseSensitive = catalog?.identifierCaseSensitive ?? false;
  const same = (a: string, b: string): boolean => schemaKey(a, caseSensitive) === schemaKey(b, caseSensitive);

  if (parts.length === 1) return { query: parts[0] };
  if (parts.length === 2) {
    const [first, second] = parts;
    if (catalog && !catalog.schemas.some(schema => same(schema, first))) {
      const owners = [...catalog.nodeMap.values()].filter(n => same(n.name, first) && n.columns?.some(c => same(c.name, second)));
      if (owners.length > 0) {
        const schemas = new Set(owners.map(n => n.schema));
        return schemas.size === 1 ? { query: owners[0].name, schemaHint: owners[0].schema } : { query: owners[0].name };
      }
    }
    return { query: second, schemaHint: first };
  }
  if (parts.length === 3) {
    const object = catalog && catalog.nodeMap.get(resolveModelNodeId(`${quoteIdentifier(parts[0])}.${quoteIdentifier(parts[1])}`, catalog.nodeMap, caseSensitive) ?? '');
    return object ? { query: object.name, schemaHint: object.schema } : { query: parts[2], schemaHint: parts[1] };
  }

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
  /** The payload with every stringified structure decoded; the input object if nothing changed. */
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
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Characters quoted before and after a located character. */
const WINDOW_BEFORE = 20;
export const WINDOW_AFTER = 14;

/**
 * The short window around one character of a text, in its canonical JSON escape (a TAB shows as `\t`,
 * a line break as `\n`, a backslash as `\\`): the offender is invisible or uncountable to a model, so
 * the rejection quotes it by its neighbours, never more than the window.
 *
 * @param chars - The text as code points.
 * @param index - Offset of the located character in `chars`.
 * @returns The quoted window, with an ellipsis where the text goes on.
 */
export function quotedWindow(chars: readonly string[], index: number): string {
  const from = Math.max(0, index - WINDOW_BEFORE);
  const to = Math.min(chars.length, index + 1 + WINDOW_AFTER);
  const context = JSON.stringify(chars.slice(from, to).join('')).slice(1, -1);
  return `"${from > 0 ? '…' : ''}${context}${to < chars.length ? '…' : ''}"`;
}

const JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Locates the first fault of a text that opens an object or array but is not valid JSON, for the
 * reason of a rejection (the text itself is never completed or repaired): the text ends before the
 * value closes, a closing bracket follows its end, a raw line break sits inside a string, or a
 * backslash escape is invalid. Any other fault is not located.
 *
 * @returns The fault kind with its character position, window and the edit that removes it, or
 *   `undefined` for valid JSON or an unlocated fault.
 */
export function locateJsonTextFault(text: string): string | undefined {
  if (parseJson(text) !== undefined) return undefined;
  const chars = [...text];
  const closers: string[] = [];
  let inString = false;
  let ended = false;
  const noun = text.trimStart().startsWith('[') ? 'array' : 'object';
  const at = (kind: string, index: number, edit: string): string => `${kind} at character ${index + 1} of ${chars.length} (${quotedWindow(chars, index)}): ${edit}`;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (inString) {
      if (char === '\\') {
        if (!JSON_ESCAPES.has(chars[index + 1] ?? '')) return at('an invalid backslash escape', index, 'write \\\\');
        index++;
      } else if (char === '"') inString = false;
      else if (char === '\n' || char === '\r') return at('a raw line break inside a string', index, 'write \\n');
      else if (char < ' ') return undefined;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      if (ended) return undefined;
      closers.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (ended) return at(`an extra "${char}" after the end of the ${noun}`, index, 'remove it');
      if (closers.pop() !== char) return undefined;
      ended = closers.length === 0;
    }
  }
  // Text cut inside a string asks for the rest of the sentence first: a bare closer would keep the cut sentence.
  return closers.length > 0
    ? at(`the text ends before the ${noun} closes`, chars.length - 1, `${inString ? 'finish the cut string, then add `"' : 'add `'}${closers.reverse().join('')}\` at the end`)
    : undefined;
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
 * Decodes JSON-string values where the tool's JSON Schema declares an array or object (or `null`
 * beside one). Some model servers return such an argument as a JSON string (`"targetColumns":
 * "[\"A\"]"`); the product cannot know which server it talks to, so the decode (`JSON.parse`) runs
 * once at the model boundary for every tool and model, driven by the declared schema alone. Text
 * that is not valid JSON (cut off, or with raw line breaks inside a string) is never completed or
 * repaired: it stays a string and fails schema validation at its field. The caller logs
 * {@link StringifiedArgumentsResult.paths}.
 *
 * @returns The coerced payload and the paths decoded.
 */
export function coerceStringifiedArguments(input: unknown, jsonSchema: unknown): StringifiedArgumentsResult {
  const paths: string[] = [];
  const value = coerce(input, jsonSchema as JsonSchemaNode, '', paths);
  return { value: paths.length > 0 ? value : input, paths };
}
