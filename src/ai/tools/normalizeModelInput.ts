import type { ZodType } from 'zod';
import { resolveModelNodeId } from '../support/modelReferences';
import { splitSqlName, stripBrackets } from '../../utils/sql';

/** One lossless format fix: same data, different spelling, exactly one possible result. */
export interface ModelInputFix {
  readonly path: string;
  readonly before: string;
  readonly after: unknown;
}

/** Object-id fields and the ids they admit, keyed by definition so `.describe()` clones keep the marker; never sent to the model. */
const objectIdFields = new WeakMap<object, ObjectIdField>();

interface ObjectIdField {
  readonly ids: Map<string, unknown>;
  readonly identifierCaseSensitive: boolean;
}

/** Object schemas whose `query` may name an object id, rewritten to name plus schema filter. */
const idFormSearchInputs = new WeakSet<object>();

/** Marks a string schema as an object-id field admitting `ids`. */
export function markObjectIdField(schema: ZodType, ids: Map<string, unknown>, identifierCaseSensitive: boolean): void {
  objectIdFields.set(schema._zod.def, { ids, identifierCaseSensitive });
}

/** Marks a search input whose `query` may be written as an object id. */
export function markIdFormSearch(schema: ZodType): void {
  idFormSearchInputs.add(schema._zod.def);
}

/** Upper bound on decode rounds; each round can only open values nested inside the previous round's fixes. */
const MAX_ROUNDS = 8;

/** The single decoded value of `text` when it is exactly the expected type, otherwise `undefined`. */
function decodeExact(text: string, expected: string): unknown {
  if (expected === 'number') return /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : undefined;
  if (expected === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (expected !== 'object' && expected !== 'array') return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return undefined; }
  const isArray = Array.isArray(decoded);
  if (expected === 'array') return isArray ? decoded : undefined;
  return typeof decoded === 'object' && decoded !== null && !isArray ? decoded : undefined;
}

/**
 * The one shared format-normalization step at the model boundary, run before the strict
 * checks. Text where the schema expects an object, list, number or true/false is decoded once when it
 * yields exactly that type; an object-id spelling becomes the one admitted id it names; a search written
 * as an id becomes name plus schema filter. Anything else stays as sent so the schema rejects it.
 */
export function normalizeModelInput(schema: ZodType, input: unknown): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  const decoded = decodeText(schema, input);
  const fixes = [...decoded.fixes];
  let current = decoded.input;
  const spelled = structuredClone(current);
  const spellingFixes: ModelInputFix[] = [];
  respell(schema, spelled, [], spellingFixes);
  if (spellingFixes.length > 0) {
    current = spelled;
    fixes.push(...spellingFixes);
  }
  return { input: current, fixes };
}

/** Wrappers that only add optionality, defaults or a pipeline around the schema that types the value. */
function unwrap(schema: ZodType): ZodType[] {
  const chain = [schema];
  for (let def = schema._zod.def as { type: string; innerType?: ZodType; in?: ZodType }; ;) {
    const inner = def.innerType ?? (def.type === 'pipe' ? def.in : undefined);
    if (!inner) return chain;
    chain.push(inner);
    def = inner._zod.def as typeof def;
  }
}

/** Rewrites object-id spellings and id-form searches in place; each rewrite has exactly one result. */
function respell(schema: ZodType, value: unknown, path: PropertyKey[], fixes: ModelInputFix[]): void {
  const chain = unwrap(schema);
  const core = chain[chain.length - 1]._zod.def as { type: string; shape?: Record<string, ZodType>; element?: ZodType; options?: readonly ZodType[] };
  if (core.type === 'union' && Array.isArray(core.options)) {
    for (const option of core.options) {
      const branchFixes: ModelInputFix[] = [];
      const clone = structuredClone(value);
      respell(option, clone, path, branchFixes);
      if (branchFixes.length > 0 && option.safeParse(clone).success) {
        Object.assign(value as object, clone);
        fixes.push(...branchFixes);
        return;
      }
    }
    for (const option of core.options) {
      const branchFixes: ModelInputFix[] = [];
      const clone = structuredClone(value);
      respell(option, clone, path, branchFixes);
      if (branchFixes.length > 0) {
        Object.assign(value as object, clone);
        fixes.push(...branchFixes);
        return;
      }
    }
    return;
  }
  if (core.type === 'array' && Array.isArray(value) && core.element) {
    value.forEach((entry, index) => {
      const field = objectIdEntry(core.element as ZodType);
      if (field && typeof entry === 'string') {
        const after = respellId(entry, field);
        if (after !== undefined) { value[index] = after; fixes.push({ path: [...path, index].join('.'), before: entry, after }); }
      } else respell(core.element as ZodType, entry, [...path, index], fixes);
    });
    return;
  }
  if (core.type !== 'object' || !core.shape || typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (chain.some(link => idFormSearchInputs.has(link._zod.def))) respellSearch(record, path, fixes);
  for (const [key, child] of Object.entries(core.shape)) {
    if (!(key in record)) continue;
    const field = objectIdEntry(child);
    const entry = record[key];
    if (field && typeof entry === 'string') {
      const after = respellId(entry, field);
      if (after !== undefined) { record[key] = after; fixes.push({ path: [...path, key].join('.'), before: entry, after }); }
    } else respell(child, entry, [...path, key], fixes);
  }
}

/** The id marker on a field schema or any wrapper around it. */
function objectIdEntry(schema: ZodType): ObjectIdField | undefined {
  for (const link of unwrap(schema)) {
    const entry = objectIdFields.get(link._zod.def);
    if (entry) return entry;
  }
  return undefined;
}

/** The one admitted id an equivalent spelling names, or `undefined` when it is already exact, unknown or ambiguous. */
function respellId(raw: string, field: ObjectIdField): string | undefined {
  if (field.ids.has(raw)) return undefined;
  return resolveModelNodeId(raw.replace(/\p{Cf}/gu, ''), field.ids, field.identifierCaseSensitive) ?? undefined;
}

/** `[dbo].[FactSales]` as a substring query matches nothing: split into name plus schema filter, when that is the only reading. */
function respellSearch(record: Record<string, unknown>, path: PropertyKey[], fixes: ModelInputFix[]): void {
  const query = record.query;
  if (typeof query !== 'string' || (record.mode !== undefined && record.mode !== 'substring')) return;
  const parts = splitSqlName(query.trim());
  if (parts.length !== 2) return;
  const [schemaName, name] = parts.map(part => stripBrackets(part).trim());
  if (!schemaName || !name) return;
  const schemas = record.schemas;
  if (schemas !== undefined && !(Array.isArray(schemas) && schemas.length === 1 && schemas[0] === schemaName)) return;
  record.query = name;
  fixes.push({ path: [...path, 'query'].join('.'), before: query, after: name });
  if (schemas === undefined) {
    record.schemas = [schemaName];
    fixes.push({ path: [...path, 'schemas'].join('.'), before: '', after: [schemaName] });
  }
}

/** Decodes text where the schema expects an object, list, number or true/false, round by round. */
function decodeText(schema: ZodType, input: unknown): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  const fixes: ModelInputFix[] = [];
  let current = input;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const parsed = schema.safeParse(current);
    if (parsed.success) break;
    let fixed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;
      const parent = issue.path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<PropertyKey, unknown> | undefined)?.[key], current);
      const key = issue.path[issue.path.length - 1];
      const value = (parent as Record<PropertyKey, unknown> | undefined)?.[key];
      if (typeof value !== 'string') continue;
      const after = decodeExact(value, issue.expected);
      if (after === undefined) continue;
      if (!fixed) current = structuredClone(current);
      const target = issue.path.slice(0, -1).reduce<unknown>((node, step) => (node as Record<PropertyKey, unknown>)[step], current);
      (target as Record<PropertyKey, unknown>)[key] = after;
      fixes.push({ path: issue.path.join('.'), before: value, after });
      fixed = true;
    }
    if (!fixed) break;
  }
  return { input: current, fixes };
}
