import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { _, stringify } from 'ajv/dist/compile/codegen';
import names from 'ajv/dist/compile/names';
import type { DataValidationCxt } from 'ajv/dist/types';
import { normalizeColName } from '../../utils/sql';
import { resolveModelNodeId } from './modelReferences';
import { findingShapeIssues } from './findingShape';
import type { ClassificationValue } from '../session/classification';
import { bothSidesClosed } from '../../engine/shared/explorationDepthContract';
import { z } from 'zod';
import { at, ISSUES, makeRejection, combineToolRejections, type IssueCode, type ToolError, type ToolRejection } from './toolErrorEnvelope';
import { REJECTION_CODES } from './rejectionCodes';

/** Canonical admission never coerces, fills defaults, or removes submitted fields. */
const validator = new Ajv2020({ allErrors: true, passContext: true, strict: false, strictSchema: true, verbose: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
validator.addKeyword({ keyword: 'toolIssue', schemaType: 'string', valid: true });
/** Per-call domain facts never enter the compiled-validator cache. */
export interface ToolFactContext {
  problems?: ToolRejection[];
  validated?: ReadonlyMap<string, (value: unknown, path: string) => ToolRejection | null | void>;
  arrays?: ReadonlyMap<string, (value: unknown[], context: DataValidationCxt) => ToolRejection | null | void>;
  objects?: ReadonlyMap<string, (value: Record<string, unknown>, context: DataValidationCxt) => ToolRejection | null | void>;
  strings?: ReadonlyMap<string, (value: string, context: DataValidationCxt) => ToolRejection | null | void>;
}

/** Called only by the native valid branch of the authored field's one subschema evaluation. */
export function captureToolFact<S extends z.ZodType>(_schema: S, receive: (value: z.output<S>, path: string) => ToolRejection | null | void): (value: unknown, path: string) => ToolRejection | null | void {
  return (value, path) => receive(value as z.output<S>, path);
}
function collectValidated(this: ToolFactContext, name: string | readonly string[], value: unknown, path: string, fields?: string[]): void {
  if (fields) {
    const supplied = value as Record<string, unknown>;
    value = Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(supplied, key)).map(key => [key, supplied[key]]));
  }
  for (const role of typeof name === 'string' ? [name] : name) {
    const problem = this.validated?.get(role)?.(value, path);
    if (problem) (this.problems ??= []).push(problem);
  }
}
for (const [keyword, type] of [['toolValidated', undefined], ['toolValidatedObject', 'object']] as const) validator.addKeyword({ keyword, ...(type ? { type } : {}), schemaType: 'object', code(cxt) {
  const valid = cxt.gen.name('valid');
  cxt.subschema({ keyword, schemaProp: 'schema' }, valid);
  const collect = cxt.gen.scopeValue('func', { ref: collectValidated });
  const fields = cxt.schema.fields ? stringify(cxt.schema.fields) : _`undefined`;
  cxt.gen.if(valid, () => cxt.gen.code(_`${collect}.call(this, ${stringify(cxt.schema.name)}, ${cxt.data}, ${names.instancePath} + ${cxt.it.errorPath}, ${fields})`));
} });

/** The same label identity serves native uniqueness checks and report amendments. */
export const normalizePresentSectionLabel = (label: string): string => label.replace(/\s+/g, ' ').trim().toLowerCase();

function keyword<S, T>(name: string, type: 'string' | 'array' | 'object', prepare: (setting: S) => (value: T, context: DataValidationCxt, facts: ToolFactContext) => ErrorObject[]) {
  validator.addKeyword({ keyword: name, type, errors: true, compile: (setting: S) => {
    const check = prepare(setting);
    const validate = Object.assign(function (this: ToolFactContext, value: T, context?: DataValidationCxt) {
      validate.errors = check(value, context!, this);
      return validate.errors.length === 0;
    }, { errors: [] as ErrorObject[] });
    return validate;
  } });
}
keyword<{ kind: 'object' | 'column'; values: string[]; caseSensitive: boolean; issue: IssueCode }, string>('toolIdentifier', 'string', setting => {
  const ids = new Map(setting.values.map(id => [id, true]));
  const names = new Set(setting.values.map(name => normalizeColName(name, setting.caseSensitive)));
  return (value, context) => {
  const admitted = setting.kind === 'object'
    ? resolveModelNodeId(value, ids, setting.caseSensitive) !== null
    : names.has(normalizeColName(value, setting.caseSensitive));
  return admitted ? [] : [{ keyword: 'toolIdentifier', instancePath: context.instancePath, schemaPath: '#/toolIdentifier', params: { issue: setting.issue, allowed_values: setting.values } }];
  };
});
keyword<boolean, unknown[]>('toolUniqueLabels', 'array', () => (value, context) => {
  const seen = new Set<string>();
  return value.flatMap((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || !('label' in entry) || typeof entry.label !== 'string') return [];
    const key = normalizePresentSectionLabel(entry.label), duplicate = seen.has(key); seen.add(key);
    return duplicate ? [{ keyword: 'toolUniqueLabels', instancePath: `${context.instancePath}/${index}/label`, schemaPath: '#/toolUniqueLabels', params: { issue: 'duplicate' } }] : [];
  });
});
keyword<boolean, unknown[]>('toolNoteCaptions', 'array', () => (value, context) => {
  const captions = new Map<string, string>();
  return value.flatMap((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || !('node_id' in entry) || !('caption' in entry) || typeof entry.node_id !== 'string' || typeof entry.caption !== 'string') return [];
    const first = captions.get(entry.node_id); captions.set(entry.node_id, entry.caption);
    return first !== undefined && first !== entry.caption ? [{ keyword: 'toolNoteCaptions', instancePath: `${context.instancePath}/${index}/caption`, schemaPath: '#/toolNoteCaptions', params: { issue: 'invalid' } }] : [];
  });
});

keyword<{ fresh: boolean; classification?: ClassificationValue }, Record<string, unknown>>('toolFindingShape', 'object', setting => (value, context) =>
  findingShapeIssues(value, setting.fresh, setting.classification).map(error => ({ keyword: 'toolFindingShape', instancePath: `${context.instancePath}/${error.path.split('.').join('/')}`,
    schemaPath: '#/toolFindingShape', params: { issue: error.code, allowed_values: error.values } })));

keyword<boolean, Record<string, unknown>>('toolDepthOpen', 'object', () => (value, context) => {
  const { upstream, downstream } = value;
  if (!upstream || typeof upstream !== 'object' || !('levels' in upstream) || !downstream || typeof downstream !== 'object' || !('levels' in downstream)) return [];
  return bothSidesClosed(upstream, downstream) ? [{ keyword: 'toolDepthOpen', instancePath: context.instancePath, schemaPath: '#/toolDepthOpen', params: { issue: 'invalid' } }] : [];
});

keyword<string, unknown[]>('toolArrayFact', 'array', name => (value, context, facts) => {
  const problem = facts.arrays?.get(name)?.(value, context);
  if (problem) (facts.problems ??= []).push(problem);
  return [];
});

keyword<string, Record<string, unknown>>('toolObjectFact', 'object', name => (value, context, facts) => {
  const problem = facts.objects?.get(name)?.(value, context);
  if (problem) (facts.problems ??= []).push(problem);
  return [];
});

keyword<string, string>('toolStringFact', 'string', name => (value, context, facts) => {
  const problem = facts.strings?.get(name)?.(value, context);
  if (problem) (facts.problems ??= []).push(problem);
  return [];
});

/** Display enums are hints for SQL identifiers; canonical comparison is the declared typed keyword. */
function canonicalSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw', override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema instanceof z.ZodNever) jsonSchema.toolIssue = 'never';
    if (!(zodSchema instanceof z.ZodNullable)) return;
    const variants = jsonSchema.anyOf as Array<Record<string, unknown>> | undefined;
    const nonNull = variants?.filter(node => node.type !== 'null');
    if (nonNull?.length !== 1 || typeof nonNull[0].type !== 'string') return;
    const inner = nonNull[0];
    delete jsonSchema.anyOf;
    Object.assign(jsonSchema, inner, { type: [inner.type, 'null'] });
    if (Array.isArray(inner.enum)) jsonSchema.enum = [...inner.enum, null];
    if ('const' in inner) { delete jsonSchema.const; Object.assign(jsonSchema, { enum: [inner.const, null] }); }
  } });
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ('toolDisplay' in node) delete node.toolDisplay;
    if ('toolAdmission' in node) { Object.assign(node, node.toolAdmission); delete node.toolAdmission; }
    if ('toolIdentifier' in node) delete (node as Record<string, unknown>).enum;
    if ('toolGroups' in node) {
      const owner = node as Record<string, unknown>, properties = owner.properties as Record<string, unknown>;
      const groups = owner.toolGroups as Array<{ name: string; fields: string[]; assertions?: Record<string, unknown> }>;
      delete owner.toolGroups;
      for (const group of groups) {
        const fields = group.fields.filter(key => Object.prototype.hasOwnProperty.call(properties, key));
        const required = (owner.required ?? []) as string[];
        const schema = { properties: Object.fromEntries(fields.map(key => [key, properties[key]])), required: required.filter(key => fields.includes(key)), ...group.assertions };
        for (const key of fields) properties[key] = {};
        owner.required = required.filter(key => !fields.includes(key));
        owner.allOf = [...(owner.allOf as unknown[] ?? []), { toolValidatedObject: { name: group.name, fields, schema } }];
      }
    }
    const fact = 'toolValidated' in node ? node.toolValidated : undefined;
    if ('toolValidated' in node) delete node.toolValidated;
    Object.values(node).forEach(visit);
    if (typeof fact === 'string' || Array.isArray(fact)) {
      const schema = { ...node };
      Object.keys(node).forEach(key => delete (node as Record<string, unknown>)[key]);
      Object.assign(node, { toolValidated: { name: fact, schema } });
    }
  };
  visit(result);
  return result;
}
const compiled = new WeakMap<z.ZodType, ValidateFunction>();
/** The sole canonical admission verdict and original native schema faults. */
export type ToolValidation<T> = { success: true; data: T } | { success: false; errors: readonly ErrorObject[]; rejection: ToolRejection };

/** A JSON pointer has one original position; escaped identifiers never become array slices. */
function toolErrorPath(error: ErrorObject): string {
  const path = error.instancePath.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const leaf = error.keyword === 'required' ? error.params.missingProperty : error.keyword === 'additionalProperties' ? error.params.additionalProperty : undefined;
  if (typeof leaf === 'string') path.push(leaf);
  return path.join('.');
}

/** Native schema faults enter the same issue vocabulary and renderer as domain faults. */
function rejection(errors: readonly ErrorObject[]): ToolRejection {
  const faults: ToolError[] = [];
  for (const error of errors) {
    const { keyword, params, parentSchema } = error;
    // A value outside an enum or const is one fault; the wrong JSON type of the same node restates it.
    if (['anyOf', 'oneOf', 'if'].includes(keyword) || (keyword === 'type' && (Array.isArray(parentSchema?.enum) || 'const' in (parentSchema ?? {})))) continue;
    const path = toolErrorPath(error);
    let code: IssueCode = 'invalid', values: string[] | undefined;
    if (parentSchema?.toolIssue && parentSchema.toolIssue in ISSUES) code = parentSchema.toolIssue as IssueCode;
    else if (keyword === 'required') code = 'missing';
    else if (keyword === 'additionalProperties') { code = 'unknown_key'; values = Object.keys(parentSchema?.properties ?? {}); }
    else if (keyword === 'type') {
      const types: string[] = [params.type].flat();
      code = error.data === undefined ? 'missing' : types.some(type => type === 'array' || type === 'object') && typeof error.data === 'string' && /^\s*[[{]/.test(error.data) ? 'json_text' : 'type';
      if (code !== 'json_text') values = types;
    } else if (keyword === 'enum' || keyword === 'const') { code = 'enum'; values = (params.allowedValues ?? [params.allowedValue]).map(String); }
    else if (/^(?:min|max)(?:Items|Length|imum|Properties)$/.test(keyword) || keyword === 'exclusiveMinimum' || keyword === 'exclusiveMaximum') code = 'size';
    else if (keyword === 'false schema') code = 'never';
    else if (typeof params.issue === 'string' && params.issue in ISSUES) { code = params.issue as IssueCode; values = params.allowed_values; }
    const previous = faults.find(fault => fault.path === path && fault.code === code);
    if (previous) { if (values) previous.values = [...new Set([...(previous.values ?? []), ...values])]; }
    else faults.push({ path, code, ...(values?.length ? { values } : {}) });
  }
  return makeRejection({ code: REJECTION_CODES.invalidInput, errors: faults.length ? faults : at('invalid') });
}

/** The schema object is the cache identity; parsed data is typed only after native admission succeeds. */
export function validateToolCandidate<S extends z.ZodType>(schema: S, input: unknown, facts: ToolFactContext = {}): ToolValidation<z.output<S>> {
  let check = compiled.get(schema) as ValidateFunction<z.output<S>> | undefined;
  if (!check) {
    const json = canonicalSchema(schema);
    check = validator.compile<z.output<S>>(json);
    validator.removeSchema(json); // Ajv would keep every compiled schema for good; the WeakMap owns the validator's lifetime.
    compiled.set(schema, check);
  }
  const evaluate: ValidateFunction<z.output<S>> = check.bind(facts);
  const accepted = evaluate(input);
  const errors = [...(check.errors ?? [])], domain = facts.problems ?? [];
  if (accepted && !domain.length) return { success: true, data: input };
  return { success: false, errors, rejection: combineToolRejections([...(errors.length ? [rejection(errors)] : []), ...domain]) };
}
