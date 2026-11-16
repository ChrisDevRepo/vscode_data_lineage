import { z, type ZodType } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { resolveModelNodeId } from '../support/modelReferences';
import { splitSqlName, stripBrackets, normalizeColName } from '../../utils/sql';
import type { AnySchemaObject, ErrorObject } from 'ajv';
import {
  branchErrors,
  syntaxFault,
  validateToolCandidate,
} from '../support/toolValidation';

/** Admission by the served JSON Schema decides every normalization step. */
const admits = (schema: ZodType, value: unknown): boolean =>
  validateToolCandidate(schema, value).success;

/** One lossless format fix: same data, different spelling, exactly one possible result. */
interface ModelInputFix {
  readonly path: string;
  readonly before: string;
  readonly after: unknown;
}

/**
 * Fields that name an object id and inputs that take an id-form search; never sent to the model. A
 * clone made with `.describe()` or `.meta()` inherits its source's entry; an `.optional()` wrapper
 * does not, so the respell walk unwraps. A field authored with a `toolIdentifier` meta needs no
 * entry.
 */
type IdMark =
  | { readonly served: true }
  | { readonly search: true }
  | { readonly ids: readonly string[]; readonly caseSensitive: boolean };
const idMarks = z.registry<IdMark>();

/** The ids a served root schema binds to every served field beneath it. */
interface ServedCatalog {
  readonly ids: Map<string, unknown>;
  readonly caseSensitive: boolean;
}
const servedCatalogs = z.registry<ServedCatalog>();

/** The ids one field admits, as the respell walk reads them. */
interface IdCatalog extends ServedCatalog {
  readonly kind?: 'column';
}

/** Marks a string schema as an object-id field admitting `ids`. */
export function markObjectIdField(
  schema: ZodType,
  ids: readonly string[],
  caseSensitive: boolean,
): void {
  idMarks.add(schema, { ids, caseSensitive });
}

/** Marks a string field whose object-id catalog is supplied by {@link serveObjectIdFields}. */
export function markServedObjectIdField(schema: ZodType): void {
  idMarks.add(schema, { served: true });
}

/** Marks a search input whose `query` may be written as an object id. */
export function markIdFormSearch(schema: ZodType): void {
  idMarks.add(schema, { search: true });
}

const servedObjectIdSchemas = new WeakMap<
  ZodType,
  WeakMap<object, { cs: boolean; schema: ZodType }>
>();

/**
 * Returns `schema` as a root that binds its served object-id fields to `ids`; the fields stay the
 * authored instances. The same pair of schema and `cacheKey` is reused so the model-facing JSON
 * Schema keeps a stable identity.
 */
export function serveObjectIdFields<T extends ZodType>(
  schema: T,
  ids: Map<string, unknown>,
  identifierCaseSensitive: boolean,
  cacheKey: object,
): T {
  if (ids.size === 0) return schema;
  let byKey = servedObjectIdSchemas.get(schema);
  if (!byKey) {
    byKey = new WeakMap();
    servedObjectIdSchemas.set(schema, byKey);
  }
  const cached = byKey.get(cacheKey);
  if (cached && cached.cs === identifierCaseSensitive)
    return cached.schema as T;
  const served = schema.meta({});
  servedCatalogs.add(served, { ids, caseSensitive: identifierCaseSensitive });
  byKey.set(cacheKey, { cs: identifierCaseSensitive, schema: served });
  return served;
}

/**
 * Upper bound on decode rounds; each round can only open values nested inside the previous round's
 * fixes.
 */
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
      else if (
        text
          .slice(index + 1)
          .trimStart()
          .startsWith(':')
      ) {
        if (valueSyntaxChanged) return text;
        const key = JSON.parse(text.slice(stringStart, index + 1)) as string;
        const keys = objectKeys.at(-1);
        if (keys?.has(key))
          throw new SyntaxError(
            'Duplicate JSON object key cannot be decoded losslessly.',
          );
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
    if (next.charCodeAt(0) < 0x20) {
      result += '\\' + JSON.stringify(next).slice(1, -1);
      valueSyntaxChanged = true;
      continue;
    }
    if (next.charCodeAt(0) >= 0x20 && !'"\\/bfnrtu'.includes(next)) {
      result += '\\';
      valueSyntaxChanged = true;
    }
    result += next;
  }
  return result;
}

/** The parser's kind for text that continues after one complete JSON value. */
const TRAILING_JSON_KIND = 'Unexpected non-whitespace character after JSON';

/**
 * The single decoded value of `text` when it is exactly the expected type, otherwise `undefined`.
 */
function decodeExact(text: string, expected: string): unknown {
  if (expected === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(text.trim())) return undefined;
    const number = Number(text);
    return Number.isFinite(number) &&
      decimalValue(text.trim()) ===
        decimalValue(
          Number.isInteger(number) ? BigInt(number).toString() : String(number),
        )
      ? number
      : undefined;
  }
  if (expected === 'boolean')
    return text === 'true' ? true : text === 'false' ? false : undefined;
  if (expected !== 'object' && expected !== 'array') return undefined;
  const parse = (source: string): unknown =>
    JSON.parse(
      source,
      (_key, value: unknown, context?: { source?: string }) => {
        if (
          typeof value === 'number' &&
          (!Number.isFinite(value) ||
            !context?.source ||
            decimalValue(context.source) !==
              decimalValue(
                Number.isInteger(value)
                  ? BigInt(value).toString()
                  : String(value),
              ))
        ) {
          throw new Error(
            'JSON number cannot be decoded without changing its value.',
          );
        }
        return value;
      },
    );
  let decoded: unknown;
  try {
    const source = normalizeJsonStringValues(text);
    try {
      decoded = parse(source);
    } catch (error) {
      // After one complete value (the parser's own end position) only surplus closing
      // brackets or braces and whitespace may follow; they are dropped, nothing else is.
      const fault = syntaxFault(error);
      if (
        fault?.kind !== TRAILING_JSON_KIND ||
        !/^[ \t\n\r}\]]+$/.test(source.slice(fault.offset))
      )
        throw error;
      decoded = parse(source.slice(0, fault.offset));
    }
  } catch {
    // A syntax error stays the sent text, which admission reports as the validator's type fault. A
    // number that cannot be kept exactly is not a value either. Nothing else is repaired.
    return undefined;
  }
  const isArray = Array.isArray(decoded);
  if (expected === 'array') return isArray ? decoded : undefined;
  return typeof decoded === 'object' && decoded !== null && !isArray
    ? decoded
    : undefined;
}

/** Compares decimal values without losing digits through a floating-point conversion. */
function decimalValue(text: string): string {
  const [coefficient, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  let digits = BigInt(whole + fraction);
  let scale = Number(exponent) - fraction.length;
  while (digits !== 0n && digits % 10n === 0n) {
    digits /= 10n;
    scale += 1;
  }
  return `${digits}e${digits === 0n ? 0 : scale}`;
}

/**
 * The one shared format-normalization step at the model boundary, run before the strict checks.
 * Text where the schema expects an object, list, number or true/false is decoded once when it
 * yields exactly that type; an object-id spelling becomes the one admitted id it names; a search
 * written as an id becomes name plus schema filter. Anything else stays as sent so the schema
 * rejects it.
 */
export function normalizeModelInput(
  schema: ZodType,
  input: unknown,
): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  const decoded = decodeText((value) => {
    const admitted = validateToolCandidate(schema, value);
    return admitted.success ? [] : admitted.errors;
  }, input);
  const fixes = [...decoded.fixes];
  let current = decoded.input;
  const spelled = structuredClone(current);
  const spellingFixes: ModelInputFix[] = [];
  // The registry's mapped meta type rewrites a Map member; the stored value is a ServedCatalog.
  const served = servedCatalogs.get(schema) as ServedCatalog | undefined;
  respell(schema, spelled, [], spellingFixes, served);
  if (spellingFixes.length > 0) {
    current = spelled;
    fixes.push(...spellingFixes);
  }
  return { input: current, fixes };
}

/**
 * Wrappers that only add optionality, defaults or a pipeline around the schema that types the
 * value.
 */
function unwrap(schema: ZodType): ZodType[] {
  const chain = [schema];
  for (
    let def = schema._zod.def as {
      type: string;
      innerType?: ZodType;
      in?: ZodType;
    };
    ;

  ) {
    const inner = def.innerType ?? (def.type === 'pipe' ? def.in : undefined);
    if (!inner) return chain;
    chain.push(inner);
    def = inner._zod.def as typeof def;
  }
}

/**
 * Rewrites object-id spellings and id-form searches in place; each rewrite has exactly one result.
 */
function respell(
  schema: ZodType,
  value: unknown,
  path: PropertyKey[],
  fixes: ModelInputFix[],
  served: ServedCatalog | undefined,
): void {
  const chain = unwrap(schema);
  const core = chain[chain.length - 1]._zod.def as {
    type: string;
    shape?: Record<string, ZodType>;
    element?: ZodType;
    options?: readonly ZodType[];
  };
  if (core.type === 'union' && Array.isArray(core.options)) {
    const branches = core.options
      .map((option) => {
        const branchFixes: ModelInputFix[] = [];
        const clone = structuredClone(value);
        respell(option, clone, path, branchFixes, served);
        return { clone, branchFixes, valid: admits(option, clone) };
      })
      .filter((branch) => branch.branchFixes.length > 0);
    const preferred = branches.filter((branch) => branch.valid);
    const candidates = preferred.length > 0 ? preferred : branches;
    const first = candidates[0];
    if (
      first &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      candidates.every((branch) => isDeepStrictEqual(branch.clone, first.clone))
    ) {
      Object.assign(value, first.clone as object);
      fixes.push(...first.branchFixes);
    }
    return;
  }
  if (core.type === 'array' && Array.isArray(value) && core.element) {
    value.forEach((entry, index) => {
      const field =
        typeof entry === 'string'
          ? idCatalog(core.element as ZodType, served)
          : undefined;
      if (field && typeof entry === 'string') {
        const after = respellId(entry, field);
        if (after !== undefined) {
          value[index] = after;
          fixes.push({
            path: [...path, index].join('.'),
            before: entry,
            after,
          });
        }
      } else
        respell(
          core.element as ZodType,
          entry,
          [...path, index],
          fixes,
          served,
        );
    });
    return;
  }
  if (
    core.type !== 'object' ||
    !core.shape ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  )
    return;
  const record = value as Record<string, unknown>;
  if (
    chain.some((link) => {
      const mark = idMarks.get(link);
      return mark !== undefined && 'search' in mark;
    })
  )
    respellSearch(record, path, fixes);
  for (const [key, child] of Object.entries(core.shape)) {
    if (!(key in record)) continue;
    const entry = record[key];
    const field =
      typeof entry === 'string' ? idCatalog(child, served) : undefined;
    if (field && typeof entry === 'string') {
      const after = respellId(entry, field);
      if (after !== undefined) {
        record[key] = after;
        fixes.push({ path: [...path, key].join('.'), before: entry, after });
      }
    } else respell(child, entry, [...path, key], fixes, served);
  }
}

/** What a `toolIdentifier` meta carries; a column field has no `values` and serves its `enum`. */
interface ToolIdentifierMeta {
  readonly kind?: string;
  readonly values?: readonly string[];
  readonly closedValues?: readonly string[];
  readonly enumFaultValues?: readonly string[];
  readonly caseSensitive?: boolean;
}

/**
 * The ids a field schema or any wrapper around it admits: its registry entry, else its own
 * `toolIdentifier` meta (a column field unless `kind` is `object`), else nothing. A served field
 * reads the catalog of the root schema being walked.
 */
function idCatalog(
  schema: ZodType,
  served: ServedCatalog | undefined,
): IdCatalog | undefined {
  for (const link of unwrap(schema)) {
    const mark = idMarks.get(link);
    if (mark && 'served' in mark) return served;
    if (mark && 'ids' in mark)
      return {
        ids: new Map(mark.ids.map((id) => [id, true])),
        caseSensitive: mark.caseSensitive,
      };
    const meta = z.globalRegistry.get(link);
    const identifier = meta?.toolIdentifier as ToolIdentifierMeta | undefined;
    if (!identifier) continue;
    const values =
      identifier.values ?? (meta?.enum as readonly string[] | undefined) ?? [];
    return {
      ids: new Map(
        [
          ...values,
          ...(identifier.closedValues ?? []),
          ...(identifier.enumFaultValues ?? []),
        ].map((id) => [id, true]),
      ),
      caseSensitive: identifier.caseSensitive ?? false,
      ...(identifier.kind === 'object' ? {} : { kind: 'column' as const }),
    };
  }
  return undefined;
}

/**
 * The one admitted id an equivalent spelling names, or `undefined` when it is already exact,
 * unknown or ambiguous. Invisible format characters around the spelling are ignored; inside an
 * identifier they stay part of it.
 */
function respellId(raw: string, field: IdCatalog): string | undefined {
  if (field.ids.has(raw)) return undefined;
  if (field.kind === 'column') {
    const matches = [...field.ids.keys()].filter(
      (value) =>
        normalizeColName(value, field.caseSensitive) ===
        normalizeColName(raw, field.caseSensitive),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  return (
    resolveModelNodeId(
      raw.replace(/^\p{Cf}+|\p{Cf}+$/gu, ''),
      field.ids,
      field.caseSensitive,
    ) ?? undefined
  );
}

/**
 * `[dbo].[FactSales]` as a substring query matches nothing: split into name plus schema filter,
 * when that is the only reading.
 */
function respellSearch(
  record: Record<string, unknown>,
  path: PropertyKey[],
  fixes: ModelInputFix[],
): void {
  const query = record.query;
  if (
    typeof query !== 'string' ||
    (record.mode !== undefined && record.mode !== 'substring')
  )
    return;
  const parts = splitSqlName(query.trim());
  if (parts.length !== 2) return;
  const [schemaName, name] = parts.map((part) => stripBrackets(part).trim());
  if (!schemaName || !name) return;
  const schemas = record.schemas;
  if (
    schemas !== undefined &&
    !(
      Array.isArray(schemas) &&
      schemas.length === 1 &&
      schemas[0] === schemaName
    )
  )
    return;
  record.query = name;
  fixes.push({
    path: [...path, 'query'].join('.'),
    before: query,
    after: name,
  });
  if (schemas === undefined) {
    record.schemas = [schemaName];
    fixes.push({
      path: [...path, 'schemas'].join('.'),
      before: '',
      after: [schemaName],
    });
  }
}

/** The faults of a value: admission of the whole schema, or of one union branch. */
type Faults = (value: unknown) => readonly ErrorObject[];
type Decoded = ReturnType<typeof normalizeModelInput>;

/** The property names and indices of a fault's instance path. */
const stepsOf = (error: ErrorObject): string[] =>
  error.instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

/** `root` with the value at `steps` replaced; only the nodes on the way are copied. */
function withValue(
  root: unknown,
  steps: readonly string[],
  value: unknown,
): unknown {
  if (steps.length === 0) return value;
  const [head, ...rest] = steps;
  const node = root as Record<string, unknown>;
  const copy = (Array.isArray(root) ? [...root] : { ...node }) as Record<
    string,
    unknown
  >;
  copy[head] = withValue(node[head], rest, value);
  return copy;
}

/** The union faults of Ajv's `anyOf` and `oneOf` keywords. */
const isUnionFault = (error: ErrorObject): boolean =>
  error.keyword === 'anyOf' || error.keyword === 'oneOf';

/** Whether `error` was raised by a branch of the union fault `union`. */
const within = (error: ErrorObject, union: ErrorObject): boolean =>
  error.schemaPath.startsWith(`${union.schemaPath}/`) &&
  (error.instancePath === union.instancePath ||
    error.instancePath.startsWith(`${union.instancePath}/`));

/**
 * The one value `text` decodes to for a type, enum or const fault, or `undefined` when it decodes
 * to none or to more than one. A schema with enum or const values leaves its type fault to the
 * enum or const fault, whose result must be one of those values.
 */
function decodeFault(error: ErrorObject, text: string): unknown {
  const parent = error.parentSchema as { enum?: unknown[]; const?: unknown };
  const values =
    'enum' in parent
      ? parent.enum
      : 'const' in parent
        ? [parent.const]
        : undefined;
  const results: unknown[] = [];
  if (error.keyword === 'type' && !values)
    for (const type of [error.params.type].flat() as string[]) {
      const after = decodeExact(text, type === 'integer' ? 'number' : type);
      if (
        after !== undefined &&
        (type !== 'integer' || Number.isInteger(after))
      )
        results.push(after);
    }
  else if (values && (error.keyword === 'enum' || error.keyword === 'const'))
    for (const type of ['number', 'boolean']) {
      const after = decodeExact(text, type);
      if (
        values.some((value) => typeof value === type) &&
        values.includes(after)
      )
        results.push(after);
    }
  return results.length === 1 ? results[0] : undefined;
}

/**
 * Decodes the text values at the paths of the served schema's type, enum and const faults; the
 * branches of a union fault must agree on one result that admits the value.
 */
function decodeText(
  faultsOf: Faults,
  input: unknown,
  base: readonly string[] = [],
  rounds = MAX_ROUNDS,
): Decoded {
  const errors = faultsOf(input);
  if (errors.length === 0 || rounds === 0) return { input, fixes: [] };
  const unions = errors.filter(isUnionFault);
  const fixes: ModelInputFix[] = [];
  let current = input;
  for (const error of errors) {
    if (unions.some((union) => within(error, union))) continue;
    const steps = stepsOf(error);
    const path = [...base, ...steps];
    if (isUnionFault(error)) {
      const branches = (error.schema as AnySchemaObject[])
        .map((branch) => ({
          branch,
          ...decodeText(
            (value) => branchErrors(branch, value),
            error.data,
            path,
            rounds,
          ),
        }))
        .filter(
          ({ branch, input: after, fixes: made }) =>
            made.length > 0 && branchErrors(branch, after).length === 0,
        );
      const first = branches[0];
      if (
        !first ||
        !branches.every(({ input: after }) =>
          isDeepStrictEqual(after, first.input),
        )
      )
        continue;
      current = withValue(current, steps, first.input);
      fixes.push(...first.fixes);
    } else if (typeof error.data === 'string') {
      const after = decodeFault(error, error.data);
      if (after === undefined) continue;
      current = withValue(current, steps, after);
      fixes.push({ path: path.join('.'), before: error.data, after });
    }
  }
  if (fixes.length === 0) return { input, fixes };
  const nested = decodeText(faultsOf, current, base, rounds - 1);
  return { input: nested.input, fixes: [...fixes, ...nested.fixes] };
}
