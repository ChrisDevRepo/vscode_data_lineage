import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { findingShapeIssues } from './findingShape';
import type { ClassificationValue } from '../session/classification';
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

/** Canonical admission never coerces, fills defaults, or removes submitted fields. */
const validator = new Ajv2020({
  allErrors: true,
  strict: false,
  strictSchema: true,
  verbose: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
/** Annotations Ajv carries without code; the domain rules and fact receipts they name run after validation (D-126). */
validator.addVocabulary([
  'toolIssue',
  'toolValidated',
  'toolFields',
  'toolIdentifier',
  'toolChoice',
  'toolUniqueLabels',
  'toolNoteCaptions',
  'toolFindingShape',
  'toolDepthOpen',
  'toolArrayFact',
  'toolObjectFact',
  'toolStringFact',
]);
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

/** Domain rules named by schema annotations: plain functions of a supplied value that return its issues, run after schema validation. */
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
    {
      fresh,
      classification,
    }: { fresh: boolean; classification?: ClassificationValue },
    value: unknown,
    path: string,
    valid,
  ) =>
    isRecord(value)
      ? findingShapeIssues(
          {
            summary: valid('summary') ? value.summary : undefined,
            sections: valid('sections') ? value.sections : undefined,
          },
          fresh,
          classification,
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
      ? [{ path, code: 'invalid' }]
      : [];
  },
};

/** Visits annotations through properties, items and allOf only; not anyOf, oneOf, if/then/else, not, $defs or additionalProperties. */
function walk(
  node: unknown,
  value: unknown,
  pointer: string,
  visit: (
    node: Record<string, unknown>,
    value: unknown,
    pointer: string,
  ) => void,
): void {
  if (!isRecord(node)) return;
  visit(node, value, pointer);
  for (const member of (node.allOf as unknown[] | undefined) ?? [])
    walk(member, value, pointer, visit);
  if (Array.isArray(value))
    value.forEach((item, index) =>
      walk(node.items, item, `${pointer}/${index}`, visit),
    );
  else if (isRecord(value))
    for (const [key, schema] of Object.entries(
      isRecord(node.properties) ? node.properties : {},
    )) {
      if (Object.prototype.hasOwnProperty.call(value, key))
        walk(schema, value[key], `${pointer}/${key}`, visit);
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

/** A JSON pointer has one original position; escaped identifiers never become array slices. */
const toolErrorPath = (error: ErrorObject): string =>
  errorPointer(error)
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');

/** Native schema faults enter the same issue list and renderer as domain faults. */
function rejection(
  errors: readonly ErrorObject[],
  domain: readonly ToolError[],
  facts: ToolFactContext,
): ToolRejection {
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
        values: string[] | undefined;
      if (parentSchema?.toolIssue && parentSchema.toolIssue in ISSUES)
        code = parentSchema.toolIssue as IssueCode;
      else if (keyword === 'required') code = 'missing';
      else if (keyword === 'additionalProperties') {
        code = 'unknown_key';
        values = Object.keys(parentSchema?.properties ?? {});
      } else if (keyword === 'type') {
        const types: string[] = [params.type].flat();
        code =
          error.data === undefined
            ? 'missing'
            : types.some((type) => type === 'array' || type === 'object') &&
                typeof error.data === 'string' &&
                /^\s*[[{]/.test(error.data)
              ? 'json_text'
              : 'type';
        if (code !== 'json_text') values = types;
      } else if (keyword === 'enum' || keyword === 'const') {
        code = parentSchema?.toolIdentifier?.issue ?? 'enum';
        values = (params.allowedValues ?? [params.allowedValue]).map(String);
      } else if (
        /^(?:min|max)(?:Items|Length|imum|Properties)$/.test(keyword) ||
        keyword === 'exclusiveMinimum' ||
        keyword === 'exclusiveMaximum'
      )
        code = 'size';
      else if (keyword === 'false schema') code = 'never';
      const mapped = {
        path: toolErrorPath(error),
        code,
        ...(values?.length ? { values } : {}),
      };
      return facts.nativeIssue?.(error, mapped) ?? mapped;
    });
  const faults = [...native, ...domain];
  return makeRejection({
    code: REJECTION_CODES.invalidInput,
    errors: faults.length ? faults : at('invalid'),
  });
}

/** The schema object is the cache identity; parsed data is typed only after native admission and the domain rules succeed. */
export function validateToolCandidate<S extends z.ZodType>(
  schema: S,
  input: unknown,
  facts: ToolFactContext = {},
): ToolValidation<z.output<S>> {
  let entry = compiled.get(schema);
  if (!entry) {
    const json = canonicalSchema(schema);
    entry = { json, check: validator.compile(json) };
    validator.removeSchema(json); // Ajv would keep every compiled schema for good; the WeakMap owns the validator's lifetime.
    compiled.set(schema, entry);
  }
  const { json, check } = entry;
  const accepted = check(input),
    errors = [...(check.errors ?? [])],
    faults: ToolError[] = [],
    problems: ToolRejection[] = [];
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
  walk(json, input, '', (node, value, pointer) => {
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
  });
  if (accepted && !faults.length && !problems.length)
    return { success: true, data: input as z.output<S> };
  return {
    success: false,
    errors,
    rejection: combineToolRejections([
      ...(errors.length || faults.length
        ? [rejection(errors, faults, facts)]
        : []),
      ...problems,
    ]),
  };
}
