import { normalizeColName, schemaKey } from '../../utils/sql';
import type { InvestigationTask, PendingLead, ScalarReturnTarget } from './smTypes';

/** What a caller supplies to open a ledger task; the ledger assigns the id and the closed state. */
export type InvestigationTaskInput = {
  /** Who raised the task — the user's question, the engine, or the model. */
  source: InvestigationTask['source'];
  /** The question this task exists to answer, compared verbatim so SQL literals stay distinct. */
  question: string;
  /** Object the task is pinned to, when it concerns one node rather than the walk. */
  nodeId?: string;
  /** Task this one was split from, so a resolved child rolls up to its parent. */
  parentTaskId?: string;
  /** Engine-owned storage object traversed before this task; retained in task identity. */
  passthroughFromNodeId?: string;
  traversalSide?: InvestigationTask['traversalSide'];
  /** Initial status; defaults to pending. */
  status?: InvestigationTask['status'];
  /** Hop at which the task was raised. */
  createdHop: number;
  /** Hop at which the task was closed, when it is opened already resolved. */
  resolvedHop?: number;
  callerContext?: InvestigationTask['callerContext'];
} & (
  /** Root or analytical task: no traced column rides along. */
  | { kind: 'root' | 'analytical'; activeColumns?: never }
  /** Column-lineage task: the traced columns it must follow, at least one. */
  | { kind: 'column_lineage'; activeColumns: [string, ...string[]]; returnTargets?: ScalarReturnTarget[]; sourceRefs?: ScalarReturnTarget[] }
);

function leadIdentity(input: Pick<PendingLead, 'taskId' | 'nodeId' | 'fromNodeId' | 'reason'>, caseSensitive = false): string {
  return JSON.stringify([input.taskId, schemaKey(input.nodeId, caseSensitive), schemaKey(input.fromNodeId, caseSensitive), input.reason]);
}

/** Engine-owned registry for investigation questions and post-run leads. */
export class TaskLedger {
  /** Follows the proven source identifier policy; existing callers default to case-insensitive. */
  constructor(private readonly identifierCaseSensitive = false) {}

  private identifierKey(value: string): string {
    return schemaKey(value, this.identifierCaseSensitive);
  }
  private readonly tasks = new Map<string, InvestigationTask>();
  private readonly taskIdsByIdentity = new Map<string, string>();
  private readonly leads = new Map<string, PendingLead>();
  private readonly leadIdsByIdentity = new Map<string, string>();

  /** Returns immutable copies in insertion order. */
  public get investigationTasks(): ReadonlyArray<InvestigationTask> {
    return Array.from(this.tasks.values(), task => task.kind === 'column_lineage'
      ? { ...task, ...(task.callerContext ? { callerContext: { ...task.callerContext } } : {}), activeColumns: [...task.activeColumns] as [string, ...string[]], ...(task.returnTargets ? { returnTargets: task.returnTargets.map(target => ({ ...target })) } : {}), ...(task.sourceRefs ? { sourceRefs: task.sourceRefs.map(ref => ({ ...ref })) } : {}) }
      : { ...task, ...(task.callerContext ? { callerContext: { ...task.callerContext } } : {}) });
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

  /** Shared identity-keyed upsert mechanics for {@link ensureTask} and {@link ensureLead}. A new identity gets the next sequence number in its store (`task_1`, `lead_1`, …): records are never removed except by {@link clear}, so ids are unique by construction and repeat in insertion order. Only the identity-hit and fresh-insert behavior (`onHit` / `buildRecord`) differs per caller. */
  private upsertByIdentity<T extends { id: string }>(
    store: Map<string, T>,
    idsByIdentity: Map<string, string>,
    identity: string,
    prefix: 'task' | 'lead',
    onHit: (existing: T) => T,
    buildRecord: (id: string) => T,
  ): T {
    const existingId = idsByIdentity.get(identity);
    if (existingId) return onHit(store.get(existingId)!);

    const id = `${prefix}_${store.size + 1}`;
    const record = buildRecord(id);
    store.set(id, record);
    idsByIdentity.set(identity, id);
    return record;
  }

  /** Creates or returns the task with the same question and qualified identity tuple. */
  public ensureTask(input: InvestigationTaskInput): InvestigationTask {
    const rawInput = input as { kind: string; activeColumns?: unknown };
    if (rawInput.activeColumns !== undefined && !Array.isArray(rawInput.activeColumns)) {
      throw new Error('activeColumns must be an array');
    }
    const canonicalColumns = (rawInput.activeColumns as string[] | undefined)?.map(column => column.trim()).filter(Boolean);
    const identityColumns = canonicalColumns?.map(column => normalizeColName(column, this.identifierCaseSensitive));
    if (input.kind === 'column_lineage' && (!canonicalColumns || canonicalColumns.length === 0)) {
      throw new Error('column_lineage tasks require at least one active column');
    }
    if (input.kind !== 'column_lineage' && rawInput.activeColumns !== undefined) {
      throw new Error(`${rawInput.kind} tasks must not carry active columns`);
    }
    const identity = JSON.stringify([
      input.kind,
      input.source,
      input.question,
      input.nodeId === undefined ? '' : this.identifierKey(input.nodeId),
      input.parentTaskId ?? '',
      identityColumns ?? [],
      ...(input.traversalSide ? [{ traversalSide: input.traversalSide }] : []),
      ...(input.passthroughFromNodeId ? [{ passthroughFromNodeId: this.identifierKey(input.passthroughFromNodeId) }] : []),
      ...(input.kind === 'column_lineage' && input.sourceRefs
        ? [{ sourceRefs: input.sourceRefs.map(ref => [this.identifierKey(ref.node), normalizeColName(ref.col, this.identifierCaseSensitive)]).sort() }]
        : []),
      ...(input.kind === 'column_lineage' && input.returnTargets
        ? [input.returnTargets.map(target => [this.identifierKey(target.node), normalizeColName(target.col, this.identifierCaseSensitive)]).sort()]
        : []),
      ...(input.callerContext ? [[this.identifierKey(input.callerContext.node), normalizeColName(input.callerContext.col, this.identifierCaseSensitive), input.callerContext.callerTaskId, input.callerContext.ddlHash]] : []),
    ]);
    return this.upsertByIdentity(
      this.tasks,
      this.taskIdsByIdentity,
      identity,
      'task',
      existing => existing,
      id => ({
        ...input,
        ...(input.callerContext ? { callerContext: { ...input.callerContext } } : {}),
        ...(input.kind === 'column_lineage' && input.returnTargets ? { returnTargets: input.returnTargets.map(target => ({ ...target })) } : {}),
        ...(input.kind === 'column_lineage' && input.sourceRefs ? { sourceRefs: input.sourceRefs.map(ref => ({ ...ref })) } : {}),
        id,
        status: input.status ?? 'pending',
        ...(canonicalColumns ? { activeColumns: canonicalColumns as [string, ...string[]] } : {}),
      } as InvestigationTask),
    );
  }

  /** Returns a task by stable id. */
  public getTask(taskId: string): InvestigationTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Applies a valid task lifecycle transition. */
  public setTaskStatus(taskId: string, status: InvestigationTask['status'], hop?: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.status = status;
    if (status === 'resolved' && hop !== undefined) task.resolvedHop = hop;
    else if (status !== 'resolved') delete task.resolvedHop;
    return true;
  }

  /** Creates or updates the lead for a deferred task and boundary. */
  public ensureLead(input: Omit<PendingLead, 'id' | 'status'> & { status?: PendingLead['status'] }): PendingLead {
    const identity = leadIdentity(input, this.identifierCaseSensitive);
    return this.upsertByIdentity(
      this.leads,
      this.leadIdsByIdentity,
      identity,
      'lead',
      existing => {
        existing.valueToUser = input.valueToUser;
        if (input.status) existing.status = input.status;
        return existing;
      },
      id => ({ ...input, id, status: input.status ?? 'pending' }),
    );
  }

  /** Dismisses every pending lead of one reason on a node. */
  public dismissNodeLeads(nodeId: string, reason: PendingLead['reason']): void {
    const key = this.identifierKey(nodeId);
    for (const lead of this.leads.values()) {
      if (lead.status === 'pending' && lead.reason === reason && this.identifierKey(lead.nodeId) === key) lead.status = 'dismissed';
    }
  }
}
