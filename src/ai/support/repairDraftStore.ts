import { z } from 'zod';

/** Tiny lifecycle holder for "hold-and-amend" AI repair drafts. */
export class RepairDraftStore<TFull, TAuthorization = undefined> {
  private draft: TFull | null = null;
  private authorization: TAuthorization | null = null;

  /** Stores a full draft after a narrow, repairable validation failure. */
  public hold(draft: TFull, authorization?: TAuthorization): void {
    this.draft = draft;
    this.authorization = authorization ?? null;
  }

  /** Returns the held draft, or `null` when no repairable draft is active. */
  public get(): TFull | null {
    return this.draft;
  }

  /** Returns domain-owned authorization metadata associated with the held draft. */
  public getAuthorization(): TAuthorization | null {
    return this.authorization;
  }

  /** Clears the held draft on success or turn reset. */
  public clear(): void {
    this.draft = null;
    this.authorization = null;
  }

  /** Retains valid leaves; declared alternatives may retain schema-valid required candidates for final handler validation. */
  public static inputParts(schema: z.ZodType, input: unknown, faults: readonly string[] = [], hasAlternative = false): Record<string, unknown> {
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return this.inputParts(schema.unwrap() as z.ZodType, input, faults, hasAlternative);
    if (!(schema instanceof z.ZodObject) || !input || typeof input !== 'object' || Array.isArray(input)) return {};
    const kept = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
      const owner = Object.prototype.hasOwnProperty.call(schema.shape, key) ? schema.shape[key] as z.ZodType : undefined;
      if (!owner) return [];
      if (faults.includes(key)) return hasAlternative && !owner.safeParse(undefined).success && owner.safeParse(value).success
        ? [[key, structuredClone(value)]] : [];
      const nested = faults.filter(path => path.startsWith(`${key}.`)).map(path => path.slice(key.length + 1));
      if (nested.length && Array.isArray(value)) return [];
      if (!nested.length && owner.safeParse(value).success) return [[key, structuredClone(value)]];
      const parts = this.inputParts(owner, value, nested, hasAlternative);
      return Object.keys(parts).length ? [[key, parts]] : [];
    }));
    return kept;
  }

  /** Explicit object leaves amend held values; a sent array or scalar replaces its value whole. */
  public static mergeInput(held: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries([...new Set([...Object.keys(held), ...Object.keys(patch)])].map(key => {
      const value = patch[key];
      return [key, !Object.prototype.hasOwnProperty.call(patch, key) ? held[key]
        : value && typeof value === 'object' && !Array.isArray(value)
          ? this.mergeInput(held[key] && typeof held[key] === 'object' && !Array.isArray(held[key]) ? held[key] as Record<string, unknown> : {}, value as Record<string, unknown>) : value];
    }));
  }

  /** Merges keyed patch entries into held entries: a patch entry overlays the held entry with the same key in place, a new key appends, and `{ remove: true }` drops the held entry (a key not held is a no-op). Every held entry the patch does not name is kept as authored. */
  public static mergeByKey<T extends object>(
    held: readonly T[],
    patch: ReadonlyArray<Partial<T> & { remove?: boolean }>,
    keyOf: (entry: Partial<T>) => string,
  ): T[] {
    const byKey = new Map(held.map(entry => [keyOf(entry), entry]));
    for (const { remove, ...entry } of patch) {
      const key = keyOf(entry as Partial<T>);
      if (remove) byKey.delete(key);
      else byKey.set(key, { ...byKey.get(key), ...entry } as T);
    }
    return [...byKey.values()];
  }

  /** Replaces only authorized indexed fields, preserving other entries, fields and order. */
  public static mergeIndexed<T extends object>(
    held: readonly T[],
    patch: readonly ({ index: number } & object)[],
    leaves: readonly IndexedRepairFields[],
  ): T[] {
    const allowed = new Map(leaves.map(leaf => [leaf.index, new Set(leaf.fields)]));
    const replacements = new Map<number, object>();
    for (const { index, ...fields } of patch) {
      const keys = Object.keys(fields);
      const permitted = allowed.get(index);
      if (!permitted || !held[index] || replacements.has(index)
        || keys.length !== permitted.size || keys.some(key => !permitted.has(key))
        || Object.values(fields).some(value => value === undefined)) {
        throw new Error(`Invalid indexed repair at index ${index}; send each authorized index and its fields exactly once.`);
      }
      replacements.set(index, fields);
    }
    if (replacements.size !== allowed.size) throw new Error('Indexed repair omitted an authorized index.');
    return held.map((entry, index) => replacements.has(index) ? { ...entry, ...replacements.get(index) } : entry);
  }
}

/** An indexed entry and the fields a held-draft rejection permits replacing. */
export interface IndexedRepairFields<Field extends string = string> {
  readonly index: number;
  readonly fields: readonly Field[];
}

/** Projects field paths onto safe indexed repairs; structural or unknown entry faults need a list repair. */
export function indexedRepairFields<Field extends string>(
  paths: readonly string[],
  list: string,
  entries: unknown,
  allowed: readonly Field[],
): IndexedRepairFields<Field>[] | undefined {
  const relevant = paths.filter(path => path === list || path.startsWith(`${list}.`));
  if (!relevant.length || !Array.isArray(entries)) return undefined;
  const byIndex = new Map<number, Set<Field>>();
  for (const path of relevant) {
    const [, rawIndex, field] = path.split('.');
    const index = Number(rawIndex);
    if (!/^\d+$/.test(rawIndex ?? '') || !entries[index] || typeof entries[index] !== 'object'
      || Array.isArray(entries[index]) || !allowed.includes(field as Field)) return undefined;
    const fields = byIndex.get(index) ?? new Set<Field>();
    fields.add(field as Field);
    byIndex.set(index, fields);
  }
  return [...byIndex].sort(([a], [b]) => a - b).map(([index, fields]) => ({ index, fields: [...fields].sort() }));
}

/** Scope of one unambiguous rejected input, before any handler commit. */
export interface InputRepairAuthorization {
  readonly context: string;
  readonly round: number;
  readonly paths: readonly string[];
  readonly ambiguous?: boolean;
}
