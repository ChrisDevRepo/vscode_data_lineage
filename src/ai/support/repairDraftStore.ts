/**
 * Tiny lifecycle holder for "hold-and-amend" AI repair drafts.
 *
 * @remarks
 * The store is deliberately domain-neutral: it does not know which fields are safe to preserve or
 * which failures are repairable; tool/domain dispatchers own those policies. A held draft is cleared
 * only on success or turn reset, never by a failed retry.
 */
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

  /**
   * Merges keyed patch entries into held entries: a patch entry overlays the held entry with the
   * same key in place, a new key appends, and `{ remove: true }` drops the held entry (a key not
   * held is a no-op). Every held entry the patch does not name is kept as authored.
   *
   * @param keyOf - Identity of an entry; the caller owns any key normalization.
   */
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

/**
 * The one resend rule every held-draft hint states for a keyed list, so no tool teaches a second
 * contract for the same merge ({@link RepairDraftStore.mergeByKey}).
 *
 * @param field - The list field a resend carries, e.g. `sections`.
 * @param key - What identifies an entry in that list, e.g. `label` or `angle`.
 * @param partialFields - The entry fields the stage accepts and a resent entry may omit to keep the
 * held value, the first being the body a new key needs. Absent for a list whose entries are only
 * replaced by key.
 */
export function keyedResendRule(field: string, key: string, partialFields: readonly string[] = []): string {
  const rule = `${field}: resend only the entries you add or change, each under its held ${key}; a held entry left unnamed is kept as authored.`;
  if (partialFields.length === 0) return rule;
  return `${rule} Omit a resent entry's ${partialFields.join(' or ')} to keep the held value; a ${key} not on file appends a new entry and needs its ${partialFields[0]}; {${key}: …, remove: true} drops a held entry.`;
}
