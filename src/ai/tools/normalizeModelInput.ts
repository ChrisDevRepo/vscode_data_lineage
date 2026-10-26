import { z, type ZodType } from 'zod';
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

/** Structured-text values: a backslash before a code unit >= U+0020 outside JSON's escape alphabet
 * denotes a literal backslash and that character; raw C0 code units are JSON-escaped unchanged.
 * Keys and standard escapes stay strict, including malformed Unicode and incomplete syntax. */
function normalizeJsonStringValues(text: string): string {
  let quoted = false;
  let valueSyntaxChanged = false;
  let stringStart = 0;
  const objectKeys: Set<string>[] = [];
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!quoted && char === '{') objectKeys.push(new Set());
    if (!quoted && char === '}') objectKeys.pop();
    if (char === '"') {
      if (!quoted) stringStart = index;
      else if (text.slice(index + 1).trimStart().startsWith(':')) {
        if (valueSyntaxChanged) return text;
        const key = JSON.parse(text.slice(stringStart, index + 1)) as string;
        const keys = objectKeys.at(-1);
        if (keys?.has(key)) throw new SyntaxError('Duplicate JSON object key cannot be decoded losslessly.');
        keys?.add(key);
      }
      quoted = !quoted;
      valueSyntaxChanged = false;
    }
    if (quoted && char.charCodeAt(0) < 0x20) {
      result += JSON.stringify(char).slice(1, -1);
      valueSyntaxChanged = true;
      continue;
    }
    result += char;
    if (!quoted || char !== '\\' || index + 1 === text.length) continue;
    const next = text[++index];
    if (next.charCodeAt(0) >= 0x20 && !'"\\/bfnrtu'.includes(next)) { result += '\\'; valueSyntaxChanged = true; }
    result += next;
  }
  return result;
}

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
  try {
    decoded = JSON.parse(normalizeJsonStringValues(text), (_key, value: unknown, context?: { source?: string }) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || !context?.source
        || decimalValue(context.source) !== decimalValue(Number.isInteger(value) ? BigInt(value).toString() : String(value)))) {
        throw new Error('JSON number cannot be decoded without changing its value.');
      }
      return value;
    });
  } catch { return undefined; }
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
    const branches = core.options.map(option => {
      const branchFixes: ModelInputFix[] = [];
      const clone = structuredClone(value);
      respell(option, clone, path, branchFixes);
      return { clone, branchFixes, valid: option.safeParse(clone).success };
    }).filter(branch => branch.branchFixes.length > 0);
    const preferred = branches.filter(branch => branch.valid);
    const candidates = preferred.length > 0 ? preferred : branches;
    const first = candidates[0];
    if (first && typeof value === 'object' && value !== null && !Array.isArray(value)
      && candidates.every(branch => isDeepStrictEqual(branch.clone, first.clone))) {
      Object.assign(value, first.clone as object);
      fixes.push(...first.branchFixes);
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

/** The one admitted id an equivalent spelling names, or `undefined` when it is already exact, unknown or ambiguous. Invisible format characters around the spelling are ignored; inside an identifier they stay part of it. */
function respellId(raw: string, field: ObjectIdField): string | undefined {
  if (field.ids.has(raw)) return undefined;
  return resolveModelNodeId(raw.replace(/^\p{Cf}+|\p{Cf}+$/gu, ''), field.ids, field.identifierCaseSensitive) ?? undefined;
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

/** Decodes values through the schema; union branches must agree on one valid result. */
function decodeText(schema: ZodType, input: unknown, path: PropertyKey[] = [], rounds = MAX_ROUNDS): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  if (schema.safeParse(input).success || rounds === 0) return { input, fixes: [] };
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault
    || schema instanceof z.ZodPrefault || schema instanceof z.ZodCatch || schema instanceof z.ZodReadonly
    || schema instanceof z.ZodNonOptional) return decodeText(schema.unwrap() as ZodType, input, path, rounds);
  if (schema instanceof z.ZodPipe) return decodeText(schema.in as ZodType, input, path, rounds);
  if (schema instanceof z.ZodUnion) {
    const candidates = schema.options.map(option => option as ZodType).map(option => ({ option, decoded: decodeText(option, input, path, rounds) }))
      .filter(({ option, decoded }) => decoded.fixes.length > 0 && option.safeParse(decoded.input).success);
    const first = candidates[0]?.decoded;
    return first && candidates.every(({ decoded }) => isDeepStrictEqual(decoded.input, first.input))
      ? first : { input, fixes: [] };
  }
  if (typeof input === 'string' && (schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum)) {
    const values = schema instanceof z.ZodLiteral ? [...schema.values] : schema.options;
    for (const expected of ['number', 'boolean']) {
      if (!values.some(value => typeof value === expected)) continue;
      const after = decodeExact(input, expected);
      if (after !== undefined && schema.safeParse(after).success) {
        return { input: after, fixes: [{ path: path.join('.'), before: input, after }] };
      }
    }
    return { input, fixes: [] };
  }
  const expected = schema instanceof z.ZodObject ? 'object' : schema instanceof z.ZodArray ? 'array'
    : schema instanceof z.ZodNumber ? 'number' : schema instanceof z.ZodBoolean ? 'boolean' : undefined;
  if (typeof input === 'string' && expected) {
    const after = decodeExact(input, expected);
    if (after === undefined) return { input, fixes: [] };
    const nested = decodeText(schema, after, path, rounds - 1);
    return { input: nested.input, fixes: [{ path: path.join('.'), before: input, after }, ...nested.fixes] };
  }
  const fixes: ModelInputFix[] = [];
  let current = input;
  const visit = (child: ZodType, key: string | number, value: unknown): void => {
    const decoded = decodeText(child, value, [...path, key], rounds);
    if (decoded.fixes.length === 0) return;
    if (fixes.length === 0) current = structuredClone(input);
    (current as Record<string | number, unknown>)[key] = decoded.input;
    fixes.push(...decoded.fixes);
  };
  if (schema instanceof z.ZodArray && Array.isArray(input)) {
    input.forEach((value, index) => visit(schema.element as ZodType, index, value));
  } else if (schema instanceof z.ZodObject && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const [key, child] of Object.entries(schema.shape)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) visit(child as ZodType, key, record[key]);
    }
  } else {
    // Other schema compositions retain the existing issue-path decoding contract.
    const parsed = schema.safeParse(input);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;
      const parentPath = issue.path.slice(0, -1);
      const key = issue.path[issue.path.length - 1];
      const parent = parentPath.reduce<unknown>((node, step) => (node as Record<PropertyKey, unknown> | undefined)?.[step], input);
      const value = (parent as Record<PropertyKey, unknown> | undefined)?.[key];
      if (typeof value !== 'string') continue;
      const after = decodeExact(value, issue.expected);
      if (after === undefined) continue;
      if (fixes.length === 0) current = structuredClone(input);
      const target = parentPath.reduce<unknown>((node, step) => (node as Record<PropertyKey, unknown>)[step], current);
      (target as Record<PropertyKey, unknown>)[key] = after;
      fixes.push({ path: [...path, ...issue.path].join('.'), before: value, after });
    }
    if (fixes.length > 0) {
      const nested = decodeText(schema, current, path, rounds - 1);
      return { input: nested.input, fixes: [...fixes, ...nested.fixes] };
    }
  }
  return { input: current, fixes };
}
