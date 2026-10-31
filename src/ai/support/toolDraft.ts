import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (schema: z.ZodType | undefined): Record<string, z.ZodType> => {
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    schema = schema.unwrap() as z.ZodType;
  return schema instanceof z.ZodObject
    ? (schema.shape as Record<string, z.ZodType>)
    : {};
};

/** Uncommitted fields for one tool/context. Sent values replace whole; only previously named object leaves may be resent alone. Arrays never merge by key or index. */
export class ToolDraft<T extends object> {
  private value: Record<string, unknown> | null = null;
  private context: string | null = null;
  private faults: readonly string[] = [];
  private sent: string[] = [];
  private previous: unknown;
  private _unchanged = false;
  private generation = -1;
  private ownerContext = '';
  private calls = 0;
  private releaseAbort?: () => void;
  private schemas = new WeakMap<z.ZodType, z.ZodType>();

  /** Generation identity belongs to transport; two state-changing calls cannot own one draft. */
  public own(context: string, generation: number): boolean {
    if (this.ownerContext !== context || this.generation !== generation) {
      this.ownerContext = context;
      this.generation = generation;
      this.calls = 0;
    }
    return ++this.calls === 1;
  }

  /** One current-context subscription belongs to the draft, and clear releases it. */
  public bindCancellation(signal: AbortSignal, context: string): void {
    this.releaseAbort?.();
    const cancel = () => {
      if (this.matches(context)) this.clear();
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.releaseAbort = () => signal.removeEventListener('abort', cancel);
  }

  /** Serves exactly what {@link apply} composes: complete held root fields may be omitted, and a held object accepts a patch whose every leaf is a named fault. Everything else keeps its canonical schema. */
  public modelSchema<S extends z.ZodType>(schema: S): S {
    if (!this.value || Object.keys(this.value).length === 0) return schema;
    const cached = this.schemas.get(schema);
    if (cached) return cached as S;
    type Node = Record<string, unknown>;
    const fields = (node: Node): Record<string, Node> | undefined => {
      const current = {
        ...node,
        ...(object(node.toolDisplay) ? node.toolDisplay : {}),
      };
      return object(current.properties)
        ? (current.properties as Record<string, Node>)
        : (current.anyOf as Node[] | undefined)
            ?.map(fields)
            .find((found) => found !== undefined);
    };
    const required = (node: Node): string[] =>
      ((object(node.toolDisplay) && Array.isArray(node.toolDisplay.required)
        ? node.toolDisplay.required
        : node.required) ?? []) as string[];
    const complete = (node: Node, value: unknown): boolean => {
      const owned = fields(node);
      return (
        value !== undefined &&
        (!owned ||
          !object(value) ||
          required(node).every((key) => complete(owned[key], value[key])))
      );
    };
    // Mirrors apply(): a held, unnamed object merges a non-empty patch built only from named fault leaves.
    const patch = (
      node: Node,
      held: unknown,
      path: string,
    ): Node | undefined => {
      if (!object(held) || this.faults.includes(path)) return undefined;
      const owned = fields(node) ?? {};
      const properties = Object.fromEntries(
        Object.keys(owned).flatMap((key) => {
          const leaf = `${path}.${key}`;
          const value = this.faults.includes(leaf)
            ? owned[key]
            : patch(owned[key], held[key], leaf);
          return value ? [[key, value]] : [];
        }),
      );
      const keys = Object.keys(properties);
      return keys.length
        ? {
            type: 'object',
            minProperties: 1,
            required: required(node).filter(
              (key) => !complete(owned[key], held[key]),
            ),
            propertyNames: { enum: keys },
            properties,
          }
        : undefined;
    };
    const source = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'throw',
    }) as Node;
    const owned = fields(source) ?? {};
    const held = this.value;
    const projected = schema.meta({
      ...schema.meta(),
      toolDisplay: {
        ...(schema.meta()?.toolDisplay as Node | undefined),
        required: required(source).filter(
          (key) => !complete(owned[key], held[key]),
        ),
        properties: Object.fromEntries(
          Object.entries(owned).map(([key, field]) => {
            const named = patch(field, held[key], key);
            return [key, named ? { anyOf: [field, named] } : field];
          }),
        ),
      },
    });
    this.schemas.set(schema, projected);
    this.schemas.set(projected, projected);
    return projected;
  }

  public get(): Partial<T> | null {
    return this.value && Object.keys(this.value).length
      ? (this.value as Partial<T>)
      : null;
  }
  public matches(context: string): boolean {
    return this.context === context;
  }
  public get unchanged(): boolean {
    return this._unchanged;
  }
  /** Paths the last rejection named; cleared with the draft. */
  public get faultPaths(): readonly string[] {
    return this.faults;
  }

  /** Compose a candidate without validating it; its handler owns the one full-schema check. */
  public apply(context: string, input: unknown, schema: z.ZodType): unknown {
    if (this.context !== context) {
      this.clear();
      this.context = context;
    }
    this.sent = [];
    if (!object(input)) {
      this._unchanged = isDeepStrictEqual(input, this.previous);
      this.previous = input;
      return input;
    }
    const named = (path: string, value: unknown): boolean =>
      this.faults.includes(path) ||
      (object(value) &&
        Object.keys(value).length > 0 &&
        Object.entries(value).every(([key, leaf]) =>
          named(`${path}.${key}`, leaf),
        ));
    const replace = (
      held: Record<string, unknown>,
      patch: Record<string, unknown>,
      owner: z.ZodType,
      prefix: string,
    ): Record<string, unknown> => {
      const result = { ...held },
        fields = shape(owner);
      for (const [key, value] of Object.entries(patch)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const child = Object.prototype.hasOwnProperty.call(fields, key)
          ? fields[key]
          : undefined;
        const namedLeaves =
          object(value) &&
          object(held[key]) &&
          !this.faults.includes(path) &&
          named(path, value);
        if (namedLeaves && child)
          result[key] = replace(
            held[key] as Record<string, unknown>,
            value as Record<string, unknown>,
            child,
            path,
          );
        else {
          this.sent.push(path);
          if (
            value === null &&
            child?.isOptional() &&
            !((owner.meta()?.required as string[] | undefined) ?? []).includes(
              key,
            )
          )
            delete result[key];
          else
            Object.defineProperty(result, key, {
              value: structuredClone(value),
              enumerable: true,
              configurable: true,
              writable: true,
            });
        }
      }
      return result;
    };
    const candidate = replace(this.value ?? {}, input, schema, '');
    this._unchanged = isDeepStrictEqual(candidate, this.previous);
    this.previous = structuredClone(candidate);
    return candidate;
  }

  /** Retain only schema-defined, nonfaulty fields, preserving a held value when its replacement failed. No second validation pass. */
  public retain(
    candidate: unknown,
    paths: readonly string[],
    schema: z.ZodType,
  ): string[] {
    const overwritten = new Set<string>();
    // A wildcard names owed subjects, not an invalid submitted value at a concrete path.
    const invalid = paths.filter((path) => !path.split('.').includes('*'));
    const keep = (
      input: Record<string, unknown>,
      held: Record<string, unknown>,
      owner: z.ZodType,
      prefix: string,
    ): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape(owner))) {
        const path = prefix ? `${prefix}.${key}` : key;
        const faulty = invalid.some(
          (fault) => fault === path || fault.startsWith(`${path}.`),
        );
        const had = Object.prototype.hasOwnProperty.call(held, key);
        if (faulty && had && this.sent.includes(path)) {
          result[key] = held[key];
          overwritten.add(path);
        } else if (
          faulty &&
          object(input[key]) &&
          Object.keys(shape(child)).length
        ) {
          const nested = keep(
            input[key] as Record<string, unknown>,
            object(held[key]) ? (held[key] as Record<string, unknown>) : {},
            child,
            path,
          );
          if (Object.keys(nested).length) result[key] = nested;
        } else if (faulty) {
          if (had) result[key] = held[key];
        } else if (Object.prototype.hasOwnProperty.call(input, key))
          result[key] = structuredClone(input[key]);
      }
      return result;
    };
    this.value = object(candidate)
      ? keep(candidate, this.value ?? {}, schema, '')
      : this.value;
    this.faults = [...paths];
    this.schemas = new WeakMap();
    return [...overwritten];
  }

  public clear(): void {
    this.releaseAbort?.();
    this.releaseAbort = undefined;
    this.value = null;
    this.schemas = new WeakMap();
    this.context = null;
    this.faults = [];
    this.sent = [];
    this.previous = undefined;
    this._unchanged = false;
  }
}
