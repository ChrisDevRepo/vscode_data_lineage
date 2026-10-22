import type { ZodType } from 'zod';
import { isDeepStrictEqual } from 'node:util';
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
  if (expected === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(text.trim())) return undefined;
    const number = Number(text);
    return Number.isFinite(number) && decimalValue(text.trim()) === decimalValue(Number.isInteger(number) ? BigInt(number).toString() : String(number)) ? number : undefined;
  }
  if (expected === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (expected !== 'object' && expected !== 'array') return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return undefined; }
  const isArray = Array.isArray(decoded);
  if (expected === 'array') return isArray ? decoded : undefined;
  return typeof decoded === 'object' && decoded !== null && !isArray ? decoded : undefined;
}

/** Compares decimal values without losing digits through a floating-point conversion. */
function decimalValue(text: string): string {
  const [coefficient, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  let digits = BigInt(whole + fraction);
  let scale = Number(exponent) - fraction.length;
  while (digits !== 0n && digits % 10n === 0n) { digits /= 10n; scale += 1; }
  return `${digits}e${digits === 0n ? 0 : scale}`;
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

/** Decodes only schema-directed types; union branches must admit one unique result. */
function decodeText(schema: ZodType, input: unknown, path: PropertyKey[] = [], rounds = 0): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  const unchanged = { input, fixes: [] as ModelInputFix[] };
  if (schema.safeParse(input).success) return unchanged;
  const chain = unwrap(schema);
  const core = chain[chain.length - 1]._zod.def as { type: string; shape?: Record<string, ZodType>; element?: ZodType; options?: readonly ZodType[] };
  if (core.type === 'union' && core.options) {
    const candidates = core.options.map(option => ({ option, decoded: decodeText(option, input, path, rounds) }))
      .filter(({ option, decoded }) => decoded.fixes.length > 0 && option.safeParse(decoded.input).success);
    const first = candidates[0]?.decoded;
    return first && candidates.every(({ decoded }) => isDeepStrictEqual(decoded.input, first.input)) ? first : unchanged;
  }
  const fixes: ModelInputFix[] = [];
  let current = input;
  if (typeof current === 'string') {
    if (rounds >= MAX_ROUNDS) return unchanged;
    const after = decodeExact(current, core.type);
    if (after === undefined) return unchanged;
    fixes.push({ path: path.join('.'), before: current, after });
    current = after;
    rounds += 1;
  }
  if (core.type === 'array' && Array.isArray(current) && core.element) {
    const entries = current;
    current = entries.map((entry, index) => {
      const decoded = decodeText(core.element as ZodType, entry, [...path, index], rounds);
      fixes.push(...decoded.fixes);
      return decoded.input;
    });
  } else if (core.type === 'object' && core.shape && typeof current === 'object' && current !== null && !Array.isArray(current)) {
    const record = { ...current } as Record<string, unknown>;
    for (const [key, child] of Object.entries(core.shape)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const decoded = decodeText(child, record[key], [...path, key], rounds);
      record[key] = decoded.input;
      fixes.push(...decoded.fixes);
    }
    current = record;
  }
  return fixes.length > 0 ? { input: current, fixes } : unchanged;
}
