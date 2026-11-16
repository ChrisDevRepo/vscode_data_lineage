import Ajv2020 from 'ajv/dist/2020';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import { findingShapeIssues } from './findingShape';
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

/** Annotations Ajv carries without code; the error facts and receipts read them from nodes. */
const TOOL_VOCABULARY = [
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
const RECORDED = [
  'toolUniqueLabels',
  'toolNoteCaptions',
  'toolFindingShape',
  'toolDepthOpen',
  'toolValidated',
  'toolArrayFact',
  'toolObjectFact',
  'toolStringFact',
];

/** Where Ajv evaluated a recorded annotation: its setting and node, the value and path there. */
interface Recorded {
  keyword: string;
  setting: unknown;
  node: AnySchemaObject | undefined;
  value: unknown;
  pointer: string;
}

/**
 * Canonical admission never coerces, fills defaults, or removes submitted fields. One instance per
 * compiled schema: an Ajv instance keeps every schema it compiled, even after `removeSchema`. A
 * recorded annotation never decides validity; it only pushes where Ajv evaluated it onto the array
 * its check is called with (`check.call(records, input)`: every call passes a fresh one).
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
    passContext: true,
  });
  ajv.addVocabulary(TOOL_VOCABULARY);
  for (const keyword of RECORDED)
    ajv.addKeyword({
      keyword,
      before: 'not',
      errors: false,
      validate: function (
        this: Recorded[],
        setting: unknown,
        value: unknown,
        node?: AnySchemaObject,
        context?: { instancePath: string },
      ) {
        this.push({
          keyword,
          setting,
          node,
          value,
          pointer: context?.instancePath ?? '',
        });
        return true;
      },
    });
  return ajv;
}
/** Per-call fact receipts, called after validation; never part of the compiled validator. */
export interface ToolFactContext {
  /**
   * The ids a field offers where its own value fails, looked up by the field's `toolStringFact` or
   * `toolValidated` annotation name with the field's JSON pointer. A missing, mistyped or
   * out-of-set value lists them; `undefined` keeps the schema's own values.
   */
  offers?: ReadonlyMap<string, (pointer: string) => string[] | undefined>;
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

/** A plain JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
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
const compiled = new WeakMap<z.ZodType, ValidateFunction>();
/** The validator of the canonical schema, compiled once per schema object. */
function compiledSchema(schema: z.ZodType): ValidateFunction {
  let check = compiled.get(schema);
  if (!check) {
    check = newValidator().compile(canonicalSchema(schema));
    compiled.set(schema, check);
  }
  return check;
}
/** The root fields the admitted schema still requires of a call holding `held`. */
export function requiredFields(
  schema: z.ZodType,
  held: Record<string, unknown>,
): string[] {
  const check = compiledSchema(schema);
  check.call([], held);
  return [
    ...new Set(
      (check.errors ?? [])
        .filter(
          (error) => error.keyword === 'required' && error.instancePath === '',
        )
        .map((error) => String(error.params.missingProperty)),
    ),
  ];
}
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

/**
 * Kind and character offset of a positioned JSON SyntaxError. Its only reader is the
 * trailing-closer trim in `decodeExact` (normalizeModelInput.ts); no rejection carries either.
 */
export function syntaxFault(
  error: unknown,
): { readonly kind: string; readonly offset: number } | undefined {
  const positioned =
    error instanceof SyntaxError
      ? /^(.*) at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(
          error.message,
        )
      : null;
  return positioned
    ? { kind: positioned[1], offset: Number(positioned[2]) }
    : undefined;
}

/** The JSON type name of a decoded value, as a type fault reports what it received. */
const jsonType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** A JSON pointer has one original position; escaped identifiers never become array slices. */
export const toolErrorPath = (error: ErrorObject): string =>
  errorPointer(error)
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');

/** The JSON pointer of a dotted rejection path, the inverse of {@link toolErrorPath}. */
export const toolPointer = (path: string): string =>
  `/${path.split('.').join('/')}`;

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

/** The size a bound keyword measures: characters, items or keys; a number is the value itself. */
function sentSize(data: unknown): number | undefined {
  if (typeof data === 'string') return [...data].length;
  if (Array.isArray(data)) return data.length;
  return isRecord(data) ? Object.keys(data).length : undefined;
}

/** The annotation names a schema node carries that an `offers` lookup can key. */
const offerNames = (node: unknown): string[] =>
  isRecord(node)
    ? [node.toolValidated, node.toolStringFact]
        .flat()
        .filter((name): name is string => typeof name === 'string')
    : [];

/**
 * Native schema faults enter the same issue list and renderer as domain faults, each with the
 * schema facts of its keyword: accepted values, or type and bound. A missing, mistyped or
 * out-of-set value lists the field's offer when the call supplies one.
 */
function rejection(
  errors: readonly ErrorObject[],
  domain: readonly ToolError[],
  facts: ToolFactContext,
  named: ReadonlyMap<string, string[]>,
): ToolRejection {
  /** The offer of the field at `pointer`, by the annotation names of the served schema there. */
  const offered = (names: readonly string[], pointer: string) => {
    for (const name of names) {
      const ids = facts.offers?.get(name)?.(pointer);
      if (ids) return ids;
    }
    return undefined;
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
        types: ToolError['types'],
        bound: ToolError['bound'],
        exit: ToolError['exit'],
        received: ToolError['received'],
        category: ToolError['category'];
      if (parentSchema?.toolIssue && parentSchema.toolIssue in ISSUES) {
        code = parentSchema.toolIssue as IssueCode;
        if (code === 'never') exit = 'omit';
      } else if (keyword === 'required') {
        code = 'missing';
        // A missing field lists its served values; its schema type is a fact, never a value.
        const field = parentSchema?.properties?.[params.missingProperty];
        values =
          offered(offerNames(field), errorPointer(error)) ??
          (Array.isArray(field?.enum)
            ? field.enum.map(String)
            : field && 'const' in field
              ? [String(field.const)]
              : undefined);
        types = schemaTypes(field);
      } else if (keyword === 'additionalProperties') {
        code = 'unknown_key';
        values = Object.keys(parentSchema?.properties ?? {});
        // A stray key on an object whose fields name served references is a reference fault.
        if (parentSchema?.toolCategory === 'reference') category = 'reference';
      } else if (keyword === 'type') {
        types = [params.type].flat();
        code = error.data === undefined ? 'missing' : 'type';
        values = offered(
          named.get(error.instancePath) ?? [],
          error.instancePath,
        );
        if (code === 'type') received = jsonType(error.data);
      } else if (keyword === 'enum' || keyword === 'const') {
        // A value the field names as an enum fault is a known object it does not offer, not the
        // identifier's own issue for an unknown one.
        code = parentSchema?.toolIdentifier?.enumFaultValues?.includes(
          error.data,
        )
          ? 'enum'
          : (parentSchema?.toolIdentifier?.issue ?? 'enum');
        const allowed = (params.allowedValues ?? [params.allowedValue]).map(
          String,
        );
        // An offer lists only what the field's own enum accepts.
        values =
          offered(
            named.get(error.instancePath) ?? [],
            error.instancePath,
          )?.filter((id) => allowed.includes(id)) ?? allowed;
      } else if (
        /^(?:min|max)(?:Items|Length|imum|Properties)$/.test(keyword) ||
        keyword === 'exclusiveMinimum' ||
        keyword === 'exclusiveMaximum'
      ) {
        code = 'size';
        const sent = sentSize(error.data);
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
      return {
        path: toolErrorPath(error),
        code,
        ...(values?.length ? { values } : {}),
        ...(types?.length ? { types } : {}),
        ...(bound ? { bound } : {}),
        ...(received ? { received } : {}),
        ...(exit ? { exit } : {}),
        ...(category ? { category } : {}),
      };
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
  const check = compiledSchema(schema),
    records: Recorded[] = [];
  const native = check.call(records, input),
    errors = [...(check.errors ?? [])],
    faults: ToolError[] = [],
    problems: ToolRejection[] = [];
  const accepted = native && !errors.length;
  const failed = errors.map(errorPointer);
  const under = (pointer: string, key?: string) =>
    failed.some((path) =>
      key === undefined
        ? path === pointer || path.startsWith(`${pointer}/`)
        : path === `${pointer}/${key}` || path.startsWith(`${pointer}/${key}/`),
    );
  // A union evaluates every branch: one record per annotation setting and path.
  const seen = new Set<string>();
  const recorded = records.filter(({ keyword, setting, pointer }) => {
    const key = JSON.stringify([keyword, setting, pointer]);
    return !seen.has(key) && !!seen.add(key);
  });
  for (const { keyword, setting, value, pointer } of recorded)
    faults.push(
      ...(DOMAIN_RULES[keyword]?.(
        setting as never,
        value,
        pointer.split('/').slice(1).join('.'),
        (relative) => !under(pointer, relative),
      ) ?? []),
    );
  failed.push(
    ...faults.map((fault) => (fault.path ? toolPointer(fault.path) : '')),
  );
  const add = (problem: ToolRejection | null | void) => {
    if (problem) problems.push(problem);
  };
  /** The annotation names found at each pointer, which an `offers` lookup keys. */
  const named = new Map<string, string[]>();
  for (const { keyword, setting, node, value, pointer } of recorded) {
    named.set(pointer, [
      ...(named.get(pointer) ?? []),
      ...offerNames({ [keyword]: setting }),
    ]);
    const context = { instancePath: pointer };
    if (keyword === 'toolValidated') {
      const fields = node?.toolFields as string[] | undefined;
      if (
        fields
          ? isRecord(value) &&
            !failed.includes(pointer) &&
            !fields.some((key) => under(pointer, key))
          : !under(pointer)
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
        for (const name of [setting].flat() as string[])
          add(facts.validated?.get(name)?.(received, pointer));
      }
    } else if (keyword === 'toolArrayFact' && Array.isArray(value))
      add(facts.arrays?.get(setting as string)?.(value, context));
    else if (keyword === 'toolObjectFact' && isRecord(value))
      add(facts.objects?.get(setting as string)?.(value, context));
    else if (keyword === 'toolStringFact' && typeof value === 'string')
      add(facts.strings?.get(setting as string)?.(value, context));
  }
  if (accepted && !faults.length && !problems.length)
    return { success: true, data: input as z.output<S> };
  return {
    success: false,
    errors,
    rejection: combineToolRejections([
      ...(errors.length || faults.length
        ? [rejection(errors, faults, facts, named)]
        : []),
      ...problems,
    ]),
  };
}
