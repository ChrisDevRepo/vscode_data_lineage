import { z } from 'zod';
import { requiredFields } from './toolValidation';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Root fields of an object schema, through optional and nullable wrappers. */
const shape = (schema: z.ZodType | undefined): Record<string, z.ZodType> => {
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    schema = schema.unwrap() as z.ZodType;
  return schema instanceof z.ZodObject
    ? (schema.shape as Record<string, z.ZodType>)
    : {};
};
/** A wildcard fault path names owed subjects, not an invalid submitted value at a concrete path. */
export const owedSubjectPath = (path: string): boolean =>
  path.split('.').includes('*');

/**
 * Uncommitted fields for one tool/context. A top-level field is a section: it is accepted whole or
 * resent whole, and one the model does not send stays as accepted. Arrays and objects never merge.
 */
export class ToolDraft<T extends object> {
  private value: Record<string, unknown> | null = null;
  private context: string | null = null;
  private faults: readonly string[] = [];
  private sent: string[] = [];
  private generation = -1;
  private ownerContext = '';
  private calls = 0;
  private releaseAbort?: () => void;
  private schemas = new WeakMap<z.ZodType, z.ZodType>();

  /** `heldDescription`: the card's root description once the draft holds fields. */
  constructor(private readonly heldDescription?: string) {}

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

  /**
   * Serves exactly what {@link apply} composes: held top-level fields may be omitted. A held field
   * is served without its bare "Required." presence prefix. Everything else keeps its canonical
   * schema.
   */
  public modelSchema<S extends z.ZodType>(schema: S): S {
    if (!this.value || Object.keys(this.value).length === 0) return schema;
    const cached = this.schemas.get(schema);
    if (cached) return cached as S;
    const held = this.value;
    const source = jsonSchema(schema);
    const owned = fields(source);
    const projected = schema.meta({
      ...schema.meta(),
      toolDisplay: {
        ...(schema.meta()?.toolDisplay as Node | undefined),
        ...(this.heldDescription && { description: this.heldDescription }),
        required: requiredOf(source).filter((key) => held[key] === undefined),
        properties: Object.fromEntries(
          Object.entries(owned).map(([key, field]) => [
            key,
            // Shared descriptions mark bare presence with a leading "Required. "; a held field is
            // not required on this card, so only that prefix is dropped and the rest stays.
            held[key] !== undefined && typeof field.description === 'string'
              ? {
                  ...field,
                  description: field.description.replace(/^Required\.\s+/, ''),
                }
              : field,
          ]),
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
  /** Paths the last rejection named; cleared with the draft. */
  public get faultPaths(): readonly string[] {
    return this.faults;
  }

  /** Compose a candidate without validating it; its handler owns the one full-schema check. */
  public apply(context: string, input: unknown): unknown {
    if (this.context !== context) {
      this.clear();
      this.context = context;
    }
    this.sent = object(input) ? Object.keys(input) : [];
    return object(input) ? { ...this.value, ...structuredClone(input) } : input;
  }

  /**
   * The one writer of the rejection's lists. Keeps every sent top-level field without a fault and
   * every held one whose replacement failed; a candidate that is no object is the empty call and
   * leaves the draft and the faults it answers. Returns the held fields a faulty resend could not
   * overwrite and `resend`: the faulty fields, an owed subject's root and the required fields
   * not held, in schema order. No second validation pass.
   */
  public retain(
    candidate: unknown,
    paths: readonly string[],
    schema: z.ZodType,
  ): { overwritten: string[]; resend: string[] } {
    const roots = Object.keys(shape(schema));
    if (object(candidate)) this.faults = [...paths];
    const rootsOf = (owed: boolean) =>
      this.faults
        .filter((path) => owedSubjectPath(path) === owed)
        .map((path) => path.split('.')[0]);
    const faulty = new Set(rootsOf(false));
    const held = this.value ?? {};
    const overwritten = roots.filter(
      (key) =>
        faulty.has(key) &&
        Object.prototype.hasOwnProperty.call(held, key) &&
        this.sent.includes(key),
    );
    if (object(candidate))
      this.value = Object.fromEntries(
        roots.flatMap((key) =>
          faulty.has(key)
            ? Object.prototype.hasOwnProperty.call(held, key)
              ? [[key, held[key]]]
              : []
            : Object.prototype.hasOwnProperty.call(candidate, key)
              ? [[key, structuredClone(candidate[key])]]
              : [],
        ),
      );
    this.schemas = new WeakMap();
    const value = this.value ?? {};
    // An owed subject's root is resent even where it is held: the subject is added to it.
    const owed = new Set([
      ...rootsOf(true),
      ...requiredFields(schema).filter((key) => value[key] === undefined),
    ]);
    return {
      overwritten,
      resend: roots.filter((key) => faulty.has(key) || owed.has(key)),
    };
  }

  public clear(): void {
    this.releaseAbort?.();
    this.releaseAbort = undefined;
    this.value = null;
    this.schemas = new WeakMap();
    this.context = null;
    this.faults = [];
    this.sent = [];
  }
}

type Node = Record<string, unknown>;
const jsonSchema = (schema: z.ZodType): Node =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as Node;
/** The properties of an object schema node, through its display projection and union branches. */
const fields = (node: Node): Record<string, Node> => {
  const current = {
    ...node,
    ...(object(node.toolDisplay) ? node.toolDisplay : {}),
  };
  return object(current.properties)
    ? (current.properties as Record<string, Node>)
    : ((current.anyOf as Node[] | undefined)
        ?.map(fields)
        .find((found) => Object.keys(found).length) ?? {});
};
const requiredOf = (node: Node): string[] =>
  ((object(node.toolDisplay) && Array.isArray(node.toolDisplay.required)
    ? node.toolDisplay.required
    : node.required) ?? []) as string[];
