import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (schema: z.ZodType | undefined): Record<string, z.ZodType> => {
  while ((schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)) schema = schema.unwrap() as z.ZodType;
  return schema instanceof z.ZodObject ? schema.shape as Record<string, z.ZodType> : {};
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

  /** Generation identity belongs to transport; two state-changing calls cannot own one draft. */
  public own(context: string, generation: number): boolean {
    if (this.ownerContext !== context || this.generation !== generation) { this.ownerContext = context; this.generation = generation; this.calls = 0; }
    return ++this.calls === 1;
  }

  /** One current-context subscription belongs to the draft, and clear releases it. */
  public bindCancellation(signal: AbortSignal, context: string): void {
    this.releaseAbort?.();
    const cancel = () => { if (this.matches(context)) this.clear(); };
    signal.addEventListener('abort', cancel, { once: true });
    this.releaseAbort = () => signal.removeEventListener('abort', cancel);
  }

  public get(): Partial<T> | null { return this.value && Object.keys(this.value).length ? this.value as Partial<T> : null; }
  public matches(context: string): boolean { return this.context === context; }
  public get unchanged(): boolean { return this._unchanged; }

  /** Compose a candidate without validating it; its handler owns the one full-schema check. */
  public apply(context: string, input: unknown, schema: z.ZodType): unknown {
    if (this.context !== context) { this.clear(); this.context = context; }
    this.sent = [];
    if (!object(input)) { this._unchanged = isDeepStrictEqual(input, this.previous); this.previous = input; return input; }
    const named = (path: string, value: unknown): boolean => this.faults.includes(path)
      || (object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, leaf]) => named(`${path}.${key}`, leaf)));
    const replace = (held: Record<string, unknown>, patch: Record<string, unknown>, owner: z.ZodType, prefix: string): Record<string, unknown> => {
      const result = { ...held }, fields = shape(owner);
      for (const [key, value] of Object.entries(patch)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const child = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
        const namedLeaves = object(value) && object(held[key]) && !this.faults.includes(path) && named(path, value);
        if (namedLeaves && child) result[key] = replace(held[key] as Record<string, unknown>, value as Record<string, unknown>, child, path);
        else {
          this.sent.push(path);
          if (value === null && child?.isOptional() && !((owner.meta()?.required as string[] | undefined) ?? []).includes(key)) delete result[key];
          else Object.defineProperty(result, key, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
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
  public retain(candidate: unknown, paths: readonly string[], schema: z.ZodType): string[] {
    const overwritten = new Set<string>();
    // A wildcard names owed subjects, not an invalid submitted value at a concrete path.
    const invalid = paths.filter(path => !path.split('.').includes('*'));
    const keep = (input: Record<string, unknown>, held: Record<string, unknown>, owner: z.ZodType, prefix: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape(owner))) {
        const path = prefix ? `${prefix}.${key}` : key;
        const faulty = invalid.some(fault => fault === path || fault.startsWith(`${path}.`));
        const had = Object.prototype.hasOwnProperty.call(held, key);
        if (faulty && had && this.sent.includes(path)) { result[key] = held[key]; overwritten.add(path); }
        else if (faulty && object(input[key]) && Object.keys(shape(child)).length) {
          const nested = keep(input[key] as Record<string, unknown>, object(held[key]) ? held[key] as Record<string, unknown> : {}, child, path);
          if (Object.keys(nested).length) result[key] = nested;
        } else if (faulty) { if (had) result[key] = held[key]; }
        else if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = structuredClone(input[key]);
      }
      return result;
    };
    this.value = object(candidate) ? keep(candidate, this.value ?? {}, schema, '') : this.value;
    this.faults = [...paths];
    return [...overwritten];
  }

  public clear(): void { this.releaseAbort?.(); this.releaseAbort = undefined; this.value = null; this.context = null; this.faults = []; this.sent = []; this.previous = undefined; this._unchanged = false; }
}
