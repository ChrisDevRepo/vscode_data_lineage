/**
 * Tiny lifecycle holder for "hold-and-amend" AI repair drafts.
 *
 * @remarks
 * The store is deliberately domain-neutral: it does not know which fields are safe to preserve,
 * which failures are repairable, or how patches should merge. Tool/domain dispatchers own those
 * policies and inject the merge function. This keeps retry state DRY without turning repair into a
 * monolithic engine.
 */
export class RepairDraftStore<TFull, TPatch, TAuthorization = undefined> {
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

  /** `true` when a retry can be interpreted as a patch for the currently held draft. */
  public hasRepairableDraft(): boolean {
    return this.draft !== null;
  }

  /** Clears the held draft after commit or after any non-repairable failure. */
  public clear(): void {
    this.draft = null;
    this.authorization = null;
  }

  /**
   * Merges a patch into the held draft using the caller's domain-specific merge policy.
   *
   * @param patch - Strictly validated patch payload.
   * @param merge - Pure merge function supplied by the domain adapter.
   * @returns The merged full draft, or `null` when no draft is held.
   */
  public merge(patch: TPatch, merge: (draft: TFull, patch: TPatch) => TFull): TFull | null {
    if (!this.draft) return null;
    return merge(this.draft, patch);
  }
}
