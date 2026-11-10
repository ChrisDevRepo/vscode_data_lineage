import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { findingShapeIssues } from './findingShape';
import { hasDamagedMath } from './reportMath';
import { bothSidesClosed } from '../../engine/shared/explorationDepthContract';
import { z } from 'zod';
import {
  at,
  ISSUES,
  makeRejection,
  combineToolRejections,
  type IssueCode,
  type ToolError,
  type ToolRejection,
} from './toolErrorEnvelope';
import { REJECTION_CODES } from './rejectionCodes';

/**
 * Annotations Ajv carries without code; the domain rules and fact receipts they name run after
 * validation.
 */
const TOOL_VOCABULARY = [
  'toolIssue',
  'toolValidated',
  'toolFields',
  'toolIdentifier',
  'toolChoice',
  'toolUniqueLabels',
  'toolNoteCaptions',
  'toolFindingShape',
  'toolReportMath',
  'toolDepthOpen',
  'toolArrayFact',
  'toolObjectFact',
  'toolStringFact',
  'toolPattern',
];

/**
 * Canonical admission never coerces, fills defaults, or removes submitted fields. One instance per
 * compiled schema: an Ajv instance keeps every schema it compiled, even after `removeSchema`.
 */
function newValidator(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    strictSchema: true,
    verbose: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  ajv.addVocabulary(TOOL_VOCABULARY);
  return ajv;
}
/** Per-call fact receipts, called after validation; never part of the compiled validator. */
export interface ToolFactContext {
  nativeIssue?: (
    error: ErrorObject,
    mapped: ToolError,
  ) => ToolError | undefined;
  validated?: ReadonlyMap<
    string,
    (value: unknown, path: string) => ToolRejection | null | void
  >;
  arrays?: ReadonlyMap<
    string,
    (
      value: unknown[],
      context: { instancePath: string },
    ) => ToolRejection | null | void
  >;
  objects?: ReadonlyMap<
    string,
    (
      value: Record<string, unknown>,
      context: { instancePath: string },
    ) => ToolRejection | null | void
  >;
  strings?: ReadonlyMap<
    string,
    (
      value: string,
      context: { instancePath: string },
    ) => ToolRejection | null | void
  >;
}

/** Called only for a field whose own subtree has no schema or domain fault. */
export function captureToolFact<S extends z.ZodType>(
  _schema: S,
  receive: (value: z.output<S>, path: string) => ToolRejection | null | void,
): (value: unknown, path: string) => ToolRejection | null | void {
  return (value, path) => receive(value as z.output<S>, path);
}

/** The same label identity serves native uniqueness checks and report amendments. */
export const normalizePresentSectionLabel = (label: string): string =>
  label.replace(/\s+/g, ' ').trim().toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const child = (path: string, key: string | number): string =>
  path ? `${path}.${key}` : String(key);

/**
 * Domain rules named by schema annotations: plain functions of a supplied value that return its
 * issues, run after schema validation.
 */
const DOMAIN_RULES: Record<
  string,
  (
    setting: never,
    value: unknown,
    path: string,
    valid: (relative: string) => boolean,
  ) => ToolError[]
> = {
  toolUniqueLabels: (_setting: never, value: unknown, path: string, valid) => {
    const seen = new Set<string>();
    return (Array.isArray(value) ? value : []).flatMap(
      (entry: unknown, index) => {
        if (
          !isRecord(entry) ||
          typeof entry.label !== 'string' ||
          !valid(`${index}/label`)
        )
          return [];
        const key = normalizePresentSectionLabel(entry.label),
          duplicate = seen.has(key);
        seen.add(key);
        return duplicate
          ? [
              {
                path: child(child(path, index), 'label'),
                code: 'duplicate' as const,
              },
            ]
          : [];
      },
    );
  },
  toolNoteCaptions: (_setting: never, value: unknown, path: string, valid) => {
    const captions = new Map<string, string>();
    return (Array.isArray(value) ? value : []).flatMap(
      (entry: unknown, index) => {
        if (
          !isRecord(entry) ||
          typeof entry.node_id !== 'string' ||
          typeof entry.caption !== 'string' ||
          !valid(`${index}/node_id`) ||
          !valid(`${index}/caption`)
        )
          return [];
        const first = captions.get(entry.node_id);
        captions.set(entry.node_id, entry.caption);
        return first !== undefined && first !== entry.caption
          ? [
              {
                path: child(child(path, index), 'caption'),
                code: 'invalid' as const,
              },
            ]
          : [];
      },
    );
  },
  toolFindingShape: (
    { fresh }: { fresh: boolean },
    value: unknown,
    path: string,
    valid,
  ) =>
    isRecord(value)
      ? findingShapeIssues(
          {
            summary: valid('summary') ? value.summary : undefined,
          },
          fresh,
        ).map((error) => ({ ...error, path: child(path, error.path) }))
      : [],
  toolReportMath: (_setting: never, value: unknown, path: string) =>
    typeof value === 'string' && hasDamagedMath(value)
      ? [{ path, code: 'math_escape' }]
      : [],
  toolDepthOpen: (_setting: never, value: unknown, path: string) => {
    const { upstream, downstream } = isRecord(value) ? value : {};
    return isRecord(upstream) &&
      isRecord(downstream) &&
      bothSidesClosed(
        { levels: upstream.levels },
        { levels: downstream.levels },
      )
      ? [{ path, code: 'depth_zero' }]
      : [];
  },
};

const branchChecks = new WeakMap<object, ValidateFunction>();
/** Native fault count of one branch; compiling it alone relies on zod inlining (no $ref/$defs). */
function branchFaults(branch: Record<string, unknown>, value: unknown): number {
  let check = branchChecks.get(branch);
  if (!check) {
    check = newValidator().compile(branch);
    branchChecks.set(branch, check);
  }
  check(value);
  return check.errors?.length ?? 0;
}

/**
 * Visits annotations through properties, items, allOf and the anyOf/oneOf branches that admit the
 * value, or when none does, those with the fewest native faults (so independent faults surface in
 * one pass); `once` visits only the first such branch. Not if/then/else, not, $defs or
 * additionalProperties.
 */
function walk(
  node: unknown,
  value: unknown,
  pointer: string,
  visit: (
    node: Record<string, unknown>,
    value: unknown,
    pointer: string,
  ) => void,
  once = false,
): void {
  if (!isRecord(node)) return;
  visit(node, value, pointer);
  for (const member of (node.allOf as unknown[] | undefined) ?? [])
    walk(member, value, pointer, visit, once);
  const branches = [
    ...((node.anyOf as unknown[] | undefined) ?? []),
    ...((node.oneOf as unknown[] | undefined) ?? []),
  ]
    .filter(isRecord)
    .map((branch) => ({ branch, faults: branchFaults(branch, value) }));
  const fewest = Math.min(...branches.map(({ faults }) => faults));
  const chosen = branches.filter(({ faults }) => faults === fewest);
  for (const { branch } of once ? chosen.slice(0, 1) : chosen)
    walk(branch, value, pointer, visit, once);
  if (Array.isArray(value))
    value.forEach((item, index) =>
      walk(node.items, item, `${pointer}/${index}`, visit, once),
    );
  else if (isRecord(value))
    for (const [key, schema] of Object.entries(
      isRecord(node.properties) ? node.properties : {},
    )) {
      if (Object.prototype.hasOwnProperty.call(value, key))
        walk(schema, value[key], `${pointer}/${key}`, visit, once);
    }
}

/** Served constraints remain canonical after ModelPort representation normalization. */
function canonicalSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'throw',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodNever) jsonSchema.toolIssue = 'never';
      if (!(zodSchema instanceof z.ZodNullable)) return;
      const variants = jsonSchema.anyOf as
        | Array<Record<string, unknown>>
        | undefined;
      const nonNull = variants?.filter((node) => node.type !== 'null');
      if (nonNull?.length !== 1 || typeof nonNull[0].type !== 'string') return;
      const inner = nonNull[0];
      delete jsonSchema.anyOf;
      Object.assign(jsonSchema, inner, { type: [inner.type, 'null'] });
      if (Array.isArray(inner.enum)) jsonSchema.enum = [...inner.enum, null];
      if ('const' in inner) {
        delete jsonSchema.const;
        Object.assign(jsonSchema, { enum: [inner.const, null] });
      }
    },
  });
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ('pattern' in node && typeof node.pattern === 'string') {
      Object.assign(node, { toolPattern: node.pattern });
      delete node.pattern;
    }
    if ('toolDisplay' in node) {
      Object.assign(node, node.toolDisplay);
      delete node.toolDisplay;
    }
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
        const schema = {
          properties: Object.fromEntries(
            fields.map((key) => [key, properties[key]]),
          ),
          required: required.filter((key) => fields.includes(key)),
          ...group.assertions,
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
const compiled = new WeakMap<
  z.ZodType,
  { json: Record<string, unknown>; check: ValidateFunction }
>();
/** The sole canonical admission verdict and original native schema faults. */
export type ToolValidation<T> =
  | { success: true; data: T }
  | {
      success: false;
      errors: readonly ErrorObject[];
      rejection: ToolRejection;
    };

/** The JSON pointer of a fault, with a missing or undeclared property as its leaf. */
function errorPointer(error: ErrorObject): string {
  const leaf =
    error.keyword === 'required'
      ? error.params.missingProperty
      : error.keyword === 'additionalProperties'
        ? error.params.additionalProperty
        : undefined;
  return typeof leaf === 'string'
    ? `${error.instancePath}/${leaf.replace(/~/g, '~0').replace(/\//g, '~1')}`
    : error.instancePath;
}

/** The parser's kind for text that continues after a complete JSON value. */
export const TRAILING_JSON_KIND =
  'Unexpected non-whitespace character after JSON';

/**
 * Kind and, when the parser reports one, character offset of a JSON SyntaxError.
 * The submitted text is never copied into the kind.
 */
export function syntaxFault(
  error: unknown,
  text: string,
): { readonly kind: string; readonly offset?: number } | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const safe = (kind: string): string =>
    text.length >= 8 && kind.includes(text) ? 'JSON parse error' : kind;
  const positioned =
    /^(.*) at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(error.message);
  if (positioned) {
    return {
      kind: safe(positioned[1]),
      offset: Number(positioned[2]),
    };
  }
  // No index is reported; the text ended at this offset.
  if (error.message === 'Unexpected end of JSON input')
    return { kind: error.message, offset: text.length };
  const token = /^Unexpected token ('(?:[^'\\]|\\.)*'|\S+), /.exec(
    error.message,
  );
  if (!token?.[1]) return { kind: 'JSON parse error' };
  const raw = token[1];
  const lexeme = raw.startsWith("'")
    ? raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    : raw;
  return { kind: safe(`Unexpected token ${lexeme}`) };
}

/**
 * A string where an object or array is required: decoded JSON stays `json_text`; text that does not
 * parse is the syntax fault. Anything else is not this classification.
 */
function containerTextIssue(
  data: unknown,
  types: readonly string[],
):
  | {
      readonly code: 'json_text' | 'json_parse';
      readonly parse?: ToolError['parse'];
    }
  | undefined {
  if (typeof data !== 'string') return undefined;
  if (!types.some((type) => type === 'array' || type === 'object'))
    return undefined;
  if (!/^\s*[[{]/.test(data)) return undefined;
  try {
    JSON.parse(data);
    return { code: 'json_text' };
  } catch (error) {
    const fault = syntaxFault(error, data);
    return fault ? { code: 'json_parse', parse: fault } : { code: 'json_text' };
  }
}

/** A JSON pointer has one original position; escaped identifiers never become array slices. */
const toolErrorPath = (error: ErrorObject): string =>
  errorPointer(error)
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');

/** The JSON types a schema node accepts: its own, or those of its union branches. */
function schemaTypes(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const own = [node.type].flat().filter((type) => typeof type === 'string');
  return own.length
    ? own
    : [
        ...new Set(
          [node.anyOf, node.oneOf].flatMap((branches) =>
            Array.isArray(branches) ? branches.flatMap(schemaTypes) : [],
          ),
        ),
      ];
}

/** By JSON pointer of each object the value holds: its required fields with their schema types. */
function requiredForms(
  json: Record<string, unknown>,
  input: unknown,
): Map<string, Record<string, string[]>> {
  const forms = new Map<string, Record<string, string[]>>();
  walk(json, input, '', (node, value, pointer) => {
    if (!isRecord(value)) return;
    const properties = isRecord(node.properties) ? node.properties : {};
    const form = forms.get(pointer) ?? {};
    for (const key of (node.required as string[] | undefined) ?? []) {
      const types = schemaTypes(properties[key]);
      if (types.length) form[key] = types;
    }
    forms.set(pointer, form);
  });
  return forms;
}

/** The size a bound keyword measures: characters, items or keys; a number is the value itself. */
function sentSize(data: unknown): number | undefined {
  if (typeof data === 'string') return [...data].length;
  if (Array.isArray(data)) return data.length;
  return isRecord(data) ? Object.keys(data).length : undefined;
}

/**
 * Native schema faults enter the same issue list and renderer as domain faults, each with the
 * schema facts of its keyword: accepted values, or type, bound and required form.
 */
function rejection(
  errors: readonly ErrorObject[],
  domain: readonly ToolError[],
  facts: ToolFactContext,
  json: Record<string, unknown>,
  input: unknown,
): ToolRejection {
  const forms = requiredForms(json, input);
  /**
   * The required form of the nearest object holding a fault's field, with the field itself under
   * its path inside that object (an optional field, an array item) and, where an object was
   * expected and not sent, that object's required fields under the same paths; for the call
   * itself, the required form the schema expects. None when the schema does not type the field or
   * the form would name that field alone.
   */
  const formOf = (
    error: ErrorObject,
    types: readonly string[],
  ): ToolError['form'] => {
    if (!types.length) return undefined;
    const parts = errorPointer(error).split('/').slice(1);
    if (!parts.length) {
      const expected = requiredForms(json, {}).get('');
      return expected && Object.keys(expected).length ? expected : undefined;
    }
    let held = parts.length - 1;
    while (held > 0 && !forms.has(`/${parts.slice(0, held).join('/')}`)) held--;
    const form = forms.get(held ? `/${parts.slice(0, held).join('/')}` : '');
    const field = parts
      .slice(held)
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .join('.');
    const expected =
      error.keyword === 'type' && !isRecord(error.data)
        ? Object.entries(
            requiredForms(error.parentSchema ?? {}, {}).get('') ?? {},
          ).map(([key, inner]) => [`${field}.${key}`, inner])
        : [];
    const named = form && {
      ...form,
      [field]: form[field] ?? [...types],
      ...Object.fromEntries(expected),
    };
    return named && Object.keys(named).length > 1 ? named : undefined;
  };
  // Wrong JSON type and a forbidden value at the same schema node describe one native fault.
  const native = errors
    .filter(
      (error) =>
        !['anyOf', 'oneOf', 'if'].includes(error.keyword) &&
        !(
          error.keyword === 'type' &&
          !error.parentSchema?.toolIdentifier &&
          (Array.isArray(error.parentSchema?.enum) ||
            'const' in (error.parentSchema ?? {}))
        ) &&
        !(
          ['enum', 'const'].includes(error.keyword) &&
          error.parentSchema?.toolIdentifier &&
          errors.some(
            (other) =>
              other.keyword === 'type' &&
              other.instancePath === error.instancePath &&
              other.parentSchema === error.parentSchema,
          )
        ),
    )
    .map((error): ToolError => {
      const { keyword, params, parentSchema } = error;
      let code: IssueCode = 'invalid',
        values: string[] | undefined,
        shape: Pick<ToolError, 'types' | 'form'> | undefined,
        bound: ToolError['bound'],
        exit: ToolError['exit'],
        parse: ToolError['parse'];
      if (parentSchema?.toolIssue && parentSchema.toolIssue in ISSUES) {
        code = parentSchema.toolIssue as IssueCode;
        if (code === 'never') exit = 'omit';
      } else if (keyword === 'required') {
        code = 'missing';
        // A missing field lists its served values; its schema type is a fact, never a value.
        const field = parentSchema?.properties?.[params.missingProperty];
        values = Array.isArray(field?.enum)
          ? field.enum.map(String)
          : field && 'const' in field
            ? [String(field.const)]
            : undefined;
        const types = schemaTypes(field);
        shape = { types, form: formOf(error, types) };
      } else if (keyword === 'additionalProperties') {
        code = 'unknown_key';
        values = Object.keys(parentSchema?.properties ?? {});
      } else if (keyword === 'type') {
        const types: string[] = [params.type].flat();
        const container = containerTextIssue(error.data, types);
        if (container) {
          code = container.code;
          parse = container.parse;
        } else code = error.data === undefined ? 'missing' : 'type';
        shape = { types, form: formOf(error, types) };
      } else if (keyword === 'enum' || keyword === 'const') {
        code = parentSchema?.toolIdentifier?.issue ?? 'enum';
        values = (params.allowedValues ?? [params.allowedValue]).map(String);
      } else if (
        /^(?:min|max)(?:Items|Length|imum|Properties)$/.test(keyword) ||
        keyword === 'exclusiveMinimum' ||
        keyword === 'exclusiveMaximum'
      ) {
        code = 'size';
        const sent = sentSize(error.data);
        // A numeric bound has no size to state: its further schema fact is the holding form.
        if (sent === undefined)
          shape = { form: formOf(error, schemaTypes(parentSchema)) };
        if (typeof params.limit === 'number')
          bound = {
            keyword,
            limit: params.limit,
            ...(sent !== undefined ? { sent } : {}),
          };
      } else if (keyword === 'false schema') {
        code = 'never';
        exit = 'omit';
      }
      const mapped: ToolError = {
        path: toolErrorPath(error),
        code,
        ...(values?.length ? { values } : {}),
        ...(shape?.types?.length ? { types: shape.types } : {}),
        ...(shape?.form ? { form: shape.form } : {}),
        ...(bound ? { bound } : {}),
        ...(exit ? { exit } : {}),
        ...(parse ? { parse } : {}),
      };
      return facts.nativeIssue?.(error, mapped) ?? mapped;
    });
  const faults = [...native, ...domain];
  return makeRejection({
    code: REJECTION_CODES.invalidInput,
    errors: faults.length ? faults : at('invalid'),
  });
}

/**
 * The schema object is the cache identity; parsed data is typed only after native admission and the
 * domain rules succeed.
 */
export function validateToolCandidate<S extends z.ZodType>(
  schema: S,
  input: unknown,
  facts: ToolFactContext = {},
): ToolValidation<z.output<S>> {
  let entry = compiled.get(schema);
  if (!entry) {
    const json = canonicalSchema(schema);
    entry = { json, check: newValidator().compile(json) };
    compiled.set(schema, entry);
  }
  const { json, check } = entry;
  const native = check(input),
    errors = [...(check.errors ?? [])],
    faults: ToolError[] = [],
    problems: ToolRejection[] = [];
  // Served schemas omit `pattern` (provider compatibility); each regex is checked here instead.
  walk(json, input, '', (node, value, pointer) => {
    if (
      typeof node.toolPattern === 'string' &&
      typeof value === 'string' &&
      !new RegExp(node.toolPattern, 'u').test(value)
    )
      errors.push({
        keyword: 'pattern',
        instancePath: pointer,
        schemaPath: '',
        params: { pattern: node.toolPattern },
        message: `must match pattern "${node.toolPattern}"`,
        schema: node.toolPattern,
        parentSchema: node,
        data: value,
      });
  });
  const accepted = native && !errors.length;
  const failed = errors.map(errorPointer);
  const under = (pointer: string, key?: string) =>
    failed.some((path) =>
      key === undefined
        ? path === pointer || path.startsWith(`${pointer}/`)
        : path === `${pointer}/${key}` || path.startsWith(`${pointer}/${key}/`),
    );
  walk(json, input, '', (node, value, pointer) => {
    for (const [name, rule] of Object.entries(DOMAIN_RULES))
      if (name in node)
        faults.push(
          ...rule(
            node[name] as never,
            value,
            pointer.split('/').slice(1).join('.'),
            (relative) => !under(pointer, relative),
          ),
        );
  });
  failed.push(
    ...faults.map((fault) =>
      fault.path ? `/${fault.path.split('.').join('/')}` : '',
    ),
  );
  const add = (problem: ToolRejection | null | void) => {
    if (problem) problems.push(problem);
  };
  walk(
    json,
    input,
    '',
    (node, value, pointer) => {
      const fields = node.toolFields as string[] | undefined,
        names = node.toolValidated as string | string[] | undefined;
      if (
        names !== undefined &&
        (fields
          ? isRecord(value) &&
            !failed.includes(pointer) &&
            !fields.some((key) => under(pointer, key))
          : !under(pointer))
      ) {
        const received =
          fields && isRecord(value)
            ? Object.fromEntries(
                fields
                  .filter((key) =>
                    Object.prototype.hasOwnProperty.call(value, key),
                  )
                  .map((key) => [key, value[key]]),
              )
            : value;
        for (const name of [names].flat())
          add(facts.validated?.get(name)?.(received, pointer));
      }
      const context = { instancePath: pointer };
      if (Array.isArray(value) && typeof node.toolArrayFact === 'string')
        add(facts.arrays?.get(node.toolArrayFact)?.(value, context));
      if (isRecord(value) && typeof node.toolObjectFact === 'string')
        add(facts.objects?.get(node.toolObjectFact)?.(value, context));
      if (typeof value === 'string' && typeof node.toolStringFact === 'string')
        add(facts.strings?.get(node.toolStringFact)?.(value, context));
    },
    true,
  );
  if (accepted && !faults.length && !problems.length)
    return { success: true, data: input as z.output<S> };
  return {
    success: false,
    errors,
    rejection: combineToolRejections([
      ...(errors.length || faults.length
        ? [rejection(errors, faults, facts, json, input)]
        : []),
      ...problems,
    ]),
  };
}
