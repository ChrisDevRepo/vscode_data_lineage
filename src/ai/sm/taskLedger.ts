import type { InvestigationTask, PendingLead } from './smTypes';

type InvestigationTaskInput = {
  source: InvestigationTask['source'];
  question: string;
  nodeId?: string;
  parentTaskId?: string;
  status?: InvestigationTask['status'];
  createdHop: number;
  resolvedHop?: number;
} & (
  | { kind: 'root' | 'analytical'; activeColumns?: never }
  | { kind: 'column_lineage'; activeColumns: [string, ...string[]] }
);

/** Normalizes authored questions for exact identity comparison without substring matching. */
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function leadIdentity(input: Pick<PendingLead, 'taskId' | 'nodeId' | 'fromNodeId' | 'reason'>): string {
  return JSON.stringify([input.taskId, input.nodeId.toLowerCase(), input.fromNodeId.toLowerCase(), input.reason]);
}

function stableId(prefix: 'task' | 'lead', identity: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

/**
 * Engine-owned registry for investigation questions and post-run leads.
 *
 * @remarks
 * Task identity is the exact normalized tuple, not a node-only or substring match. This keeps
 * two different questions about the same node distinct while making retries idempotent.
 */
export class TaskLedger {
  private readonly tasks = new Map<string, InvestigationTask>();
  private readonly taskIdsByIdentity = new Map<string, string>();
  private readonly leads = new Map<string, PendingLead>();
  private readonly leadIdsByIdentity = new Map<string, string>();

  /** Returns immutable copies in insertion order. */
  public get investigationTasks(): ReadonlyArray<InvestigationTask> {
    return Array.from(this.tasks.values(), task => task.kind === 'column_lineage'
      ? { ...task, activeColumns: [...task.activeColumns] as [string, ...string[]] }
      : { ...task });
  }

  /** Returns immutable copies in insertion order. */
  public get pendingLeads(): ReadonlyArray<PendingLead> {
    return Array.from(this.leads.values(), lead => ({ ...lead }));
  }

  /** Clears all tasks and leads after a validated exploration re-initialization. */
  public clear(): void {
    this.tasks.clear();
    this.taskIdsByIdentity.clear();
    this.leads.clear();
    this.leadIdsByIdentity.clear();
  }

  /**
   * Shared identity-keyed upsert mechanics for {@link ensureTask} and {@link ensureLead}: an
   * identity hit and a fresh insert behave differently per caller (`onHit` / `buildRecord`), but
   * the id lookup, `stableId` derivation, and same-id-different-identity collision guard are
   * identical for both.
   */
  private upsertByIdentity<T extends { id: string }>(
    store: Map<string, T>,
    idsByIdentity: Map<string, string>,
    identity: string,
    prefix: 'task' | 'lead',
    collisionLabel: string,
    onHit: (existing: T) => T,
    buildRecord: (id: string) => T,
  ): T {
    const existingId = idsByIdentity.get(identity);
    if (existingId) return onHit(store.get(existingId)!);

    const id = stableId(prefix, identity);
    const collision = store.get(id);
    if (collision) throw new Error(`${collisionLabel} id collision: ${id}`);
    const record = buildRecord(id);
    store.set(id, record);
    idsByIdentity.set(identity, id);
    return record;
  }

  /**
   * Creates or returns the task with the same normalized identity tuple.
   * @param input - Typed task content without its derived ID.
   * @returns Existing or newly stored task.
  */
  public ensureTask(input: InvestigationTaskInput): InvestigationTask {
    const rawInput = input as { kind: string; activeColumns?: unknown };
    if (rawInput.activeColumns !== undefined && !Array.isArray(rawInput.activeColumns)) {
      throw new Error('activeColumns must be an array');
    }
    const canonicalColumns = (rawInput.activeColumns as string[] | undefined)?.map(column => column.trim()).filter(Boolean);
    const identityColumns = canonicalColumns?.map(normalizeText);
    if (input.kind === 'column_lineage' && (!canonicalColumns || canonicalColumns.length === 0)) {
      throw new Error('column_lineage tasks require at least one active column');
    }
    if (input.kind !== 'column_lineage' && rawInput.activeColumns !== undefined) {
      throw new Error(`${rawInput.kind} tasks must not carry active columns`);
    }
    const identity = JSON.stringify([
      input.kind,
      input.source,
      normalizeText(input.question),
      input.nodeId?.toLowerCase() ?? '',
      input.parentTaskId ?? '',
      identityColumns ?? [],
    ]);
    return this.upsertByIdentity(
      this.tasks,
      this.taskIdsByIdentity,
      identity,
      'task',
      'Investigation task',
      existing => existing,
      id => ({
        ...input,
        id,
        status: input.status ?? 'pending',
        ...(canonicalColumns ? { activeColumns: canonicalColumns as [string, ...string[]] } : {}),
      } as InvestigationTask),
    );
  }

  /**
   * Returns a task by stable id.
   * @param taskId - Engine-owned task identity.
   * @returns Stored task, or `undefined` when absent.
   */
  public getTask(taskId: string): InvestigationTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Applies a valid task lifecycle transition.
   * @param taskId - Task to update.
   * @param status - New engine-owned lifecycle state.
   * @param hop - Resolution hop when applicable.
   * @returns Whether the task existed.
   */
  public setTaskStatus(taskId: string, status: InvestigationTask['status'], hop?: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.status = status;
    if (status === 'resolved' && hop !== undefined) task.resolvedHop = hop;
    else if (status !== 'resolved') delete task.resolvedHop;
    return true;
  }

  /**
   * Creates or updates the lead for a deferred task and boundary.
   * @param input - Lead content without its derived ID.
   * @returns Existing or newly stored lead.
   */
  public ensureLead(input: Omit<PendingLead, 'id' | 'status'> & { status?: PendingLead['status'] }): PendingLead {
    const identity = leadIdentity(input);
    return this.upsertByIdentity(
      this.leads,
      this.leadIdsByIdentity,
      identity,
      'lead',
      'Pending lead',
      existing => {
        existing.valueToUser = input.valueToUser;
        return existing;
      },
      id => ({ ...input, id, status: input.status ?? 'pending' }),
    );
  }

  /**
   * Marks an unresolved lead scheduled and reactivates its task.
   * @param leadId - Pending lead selected by the host.
   * @returns Scheduled lead, or `undefined` when it cannot be scheduled.
   */
  public scheduleLead(leadId: string): PendingLead | undefined {
    const lead = this.leads.get(leadId);
    if (!lead || lead.status === 'resolved' || lead.status === 'dismissed') return undefined;
    lead.status = 'scheduled';
    this.setTaskStatus(lead.taskId, 'pending');
    return lead;
  }

  /**
   * Resolves every scheduled lead backed by the completed task.
   * @param taskId - Task that completed successfully.
   */
  public resolveTaskLeads(taskId: string): void {
    for (const lead of this.leads.values()) {
      if (lead.taskId === taskId && lead.status === 'scheduled') lead.status = 'resolved';
    }
  }

  /**
   * Restores a validated current-format checkpoint ledger without recomputing identifiers.
   * @param tasks - Validated persisted task records.
   * @param leads - Validated persisted follow-up records.
   */
  public restore(tasks: ReadonlyArray<InvestigationTask>, leads: ReadonlyArray<PendingLead>): void {
    this.clear();
    for (const task of tasks) {
      const { id: _id, ...input } = task;
      const restored = this.ensureTask(input);
      if (restored.id !== task.id) throw new Error(`Investigation task id drift: ${task.id}`);
      Object.assign(restored, task);
    }
    for (const lead of leads) {
      this.leads.set(lead.id, { ...lead });
      this.leadIdsByIdentity.set(leadIdentity(lead), lead.id);
    }
  }
}
