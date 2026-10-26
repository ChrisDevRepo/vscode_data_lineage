/** Minimal `ToolServices` for driving a tool handler (typically `executeStartExploration`) without a registry: a silent logger, the shipped turn budget, and a `logAndReturn` that records the payload. */
import type { ToolServices } from '../../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../../../../src/ai/support/tokenBudget';
import type { SerializedFilterState } from '../../../../src/engine/shared/bridgeContract';

export interface StubToolServicesOptions {
  readonly session: unknown;
  readonly model: unknown;
  readonly graph: unknown;
  readonly activeFilter?: SerializedFilterState | Record<string, never>;
  readonly turnEpoch?: () => number;
  readonly budget?: TurnTokenBudget;
  readonly textModel?: unknown;
}

/** Builds the stub and a reader for the last payload the handler returned. */
export function stubToolServices(options: StubToolServicesOptions): {
  services: ToolServices;
  getReturned: () => Record<string, unknown>;
} {
  let returned: Record<string, unknown> = {};
  const services = {
    getSession: () => options.session,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    budget: options.budget ?? DEFAULT_TURN_TOKEN_BUDGET,
    textModel: options.textModel,
    turnEpoch: options.turnEpoch ?? (() => 1),
    requireModel: () => options.model,
    requireGraph: () => options.graph,
    buildActiveFilter: () => options.activeFilter ?? {},
    logAndReturn: (_tool: string, data: Record<string, unknown>) => {
      returned = data;
      return JSON.stringify(data);
    },
    toolError: (_tool: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  return { services, getReturned: () => returned };
}

/** A metadata-derived invalid value; paths are the oracle, never copied from a validator result. */
export interface SchemaFault {
  path: Array<string | number>;
  kind: string;
  value?: unknown;
  remove?: boolean;
}
type SchemaNode = {
  type?: string | string[]; enum?: unknown[]; const?: unknown;
  anyOf?: SchemaNode[]; oneOf?: SchemaNode[]; properties?: Record<string, SchemaNode>;
  items?: SchemaNode; required?: string[]; additionalProperties?: boolean;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; pattern?: string;
};

/** Generates type, domain, bound, required and strict-key faults from the actual served schema and a valid fixture. */
export function schemaFaults(raw: Record<string, unknown>, seed: unknown, path: Array<string | number> = [], columns?: ReadonlyMap<string, readonly string[]>): SchemaFault[] {
  const node = raw as SchemaNode;
  const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const variants = [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])];
  const types = variants.flatMap(part => part.type ?? []).map(type => type === 'integer' ? 'number' : type);
  const active = variants.find(part => (part.type === 'integer' ? 'number' : part.type) === typeOf(seed)) ?? node;
  const faults: SchemaFault[] = [];
  const add = (kind: string, value: unknown) => { if (path.length) faults.push({ path, kind, value }); };
  const invalidType = [null, false, [], {}, 1, '__wrong_type__'].find(value => !types.includes(typeOf(value)));
  if (types.length && invalidType !== undefined) add('type', invalidType);
  const domain = active.enum ?? (Object.hasOwn(active, 'const') ? [active.const] : undefined);
  if (domain?.length) {
    let value: unknown = typeof seed === 'number' ? Math.max(...domain.filter(item => typeof item === 'number')) + 1 : '__outside_domain__';
    while (domain.includes(value)) value = `${value}_`;
    add('enum', value);
  }
  if (typeof seed === 'string') {
    if (active.minLength) add('minLength', '');
    if (active.maxLength !== undefined) add('maxLength', 'x'.repeat(active.maxLength + 1));
    if (active.pattern) {
      const invalid = ['', '\0', '__outside_pattern__'].find(value => !new RegExp(active.pattern!).test(value));
      if (invalid !== undefined) add('pattern', invalid);
    }
  } else if (typeof seed === 'number') {
    if (active.type === 'integer') add('integer', seed + 0.5);
    if (active.minimum !== undefined) add('minimum', active.minimum - 1);
    if (active.maximum !== undefined) add('maximum', active.maximum + 1);
    if (active.exclusiveMinimum !== undefined) add('exclusiveMinimum', active.exclusiveMinimum);
    if (active.exclusiveMaximum !== undefined) add('exclusiveMaximum', active.exclusiveMaximum);
  } else if (Array.isArray(seed)) {
    if (active.minItems) add('minItems', []);
    if (active.maxItems !== undefined && seed.length) add('maxItems', Array.from({ length: active.maxItems + 1 }, () => structuredClone(seed[0])));
    if (active.items && seed.length) faults.push(...schemaFaults(active.items as Record<string, unknown>, seed[0], [...path, 0], columns));
  } else if (seed && typeof seed === 'object' && active.properties) {
    const reference = seed as { node?: string; col?: string };
    const declared = reference.node ? columns?.get(reference.node) : undefined;
    if (declared?.length && typeof reference.col === 'string') {
      let value = '__undeclared_column__';
      while (declared.includes(value)) value += '_';
      faults.push({ path: [...path, 'col'], kind: 'metadata-column', value });
    }
    for (const [key, value] of Object.entries(seed)) if (active.properties[key]) {
      if (active.required?.includes(key)) faults.push({ path: [...path, key], kind: 'required', remove: true });
      faults.push(...schemaFaults(active.properties[key] as Record<string, unknown>, value, [...path, key], columns));
    }
    if (active.additionalProperties === false) faults.push({ path: [...path, '__unsupported__'], kind: 'unknown', value: true });
  }
  return faults;
}

/** Applies declared mutations without modifying the valid fixture. */
export function withSchemaFaults(seed: unknown, faults: readonly SchemaFault[]): Record<string, unknown> {
  const value = structuredClone(seed) as Record<string | number, unknown>;
  for (const fault of faults) {
    const parent = fault.path.slice(0, -1).reduce((node, key) => node[key] as Record<string | number, unknown>, value);
    const key = fault.path.at(-1)!;
    if (fault.remove) delete parent[key];
    else parent[key] = structuredClone(fault.value);
  }
  return value;
}
