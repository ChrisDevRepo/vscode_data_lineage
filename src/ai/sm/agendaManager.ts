/**
 * Represents an entry in the navigation agenda.
 *
 * @remarks
 * The agenda tracks nodes scheduled for investigation. Each entry references a typed
 * task in the engine-owned ledger instead of encoding question history in a string.
 */
export interface AgendaEntry {
  /** Stable task identities answered by this node's single hop. */
  taskIds: string[];
  /** The unique identifier of the node to visit. */
  nodeId: string;
  /**
   * The priority of this visit.
   * - 0: Default BFS discovery.
   * - 2: AI-requested detour.
   * - 3: Origin/Root node (highest).
   */
  priority: number;
  /** The topological depth relative to the origin node. */
  depth: number;
  /** Specific columns of interest for this node (primarily used in Column Trace mode). */
  activeColumns?: string[];
  /**
   * CT chain-continuation questions opened for this node by an earlier hop's `column_flow`
   * edges — rendered as `<lineage_questions>` only when this entry is dispatched, never by
   * whichever node happens to dequeue next.
   */
  lineageQuestions?: string[];
}


/**
 * Manages the NavigationEngine's agenda queue.
 *
 * @remarks
 * Encapsulates queue operations while keeping one executable hop per node. Distinct
 * questions remain independently addressable in the task ledger.
 */
export class AgendaManager {
  private _entries: AgendaEntry[] = [];
  /** Id-keyed index onto `_entries`, kept in sync at every mutation site for O(1) lookups. */
  private _byId = new Map<string, AgendaEntry>();

  /** Returns all current entries. */
  public get entries(): ReadonlyArray<AgendaEntry> {
    return this._entries;
  }

  /** Returns true if the node is currently in the agenda. */
  public has(nodeId: string): boolean {
    return this._byId.has(nodeId);
  }

  /** Number of items in the agenda. */
  public get length(): number {
    return this._entries.length;
  }

  /**
   * Adds or updates an entry in the agenda.
   * A node consumes at most one hop: a re-push merges task identities and columns onto the
   * existing entry. A later explicit route promotes the existing seeded entry so authored
   * follow-up work is dispatched before untouched BFS seeds; depth keeps the shortest known path.
   *
   * @param entry - The agenda entry to add or update.
   */
  public push(entry: AgendaEntry): void {
    const existing = this._byId.get(entry.nodeId);
    if (existing) {
      for (const taskId of entry.taskIds) {
        if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
      }
      if (entry.activeColumns) {
        const cols = new Set(existing.activeColumns ?? []);
        for (const c of entry.activeColumns) cols.add(c);
        existing.activeColumns = Array.from(cols);
      }
      if (entry.lineageQuestions) {
        const questions = new Set(existing.lineageQuestions ?? []);
        for (const q of entry.lineageQuestions) questions.add(q);
        existing.lineageQuestions = Array.from(questions);
      }
      existing.priority = Math.max(existing.priority, entry.priority);
      existing.depth = Math.min(existing.depth, entry.depth);
    } else {
      this._entries.push(entry);
      this._byId.set(entry.nodeId, entry);
    }
  }

  /**
   * Removes and returns the highest priority entry.
   *
   * @returns The highest priority agenda entry, or undefined if empty.
   */
  public dequeue(): AgendaEntry | undefined {
    if (this._entries.length === 0) return undefined;
    const nextIdx = this._entries.reduce((best, curr, i, arr) => curr.priority > arr[best].priority ? i : best, 0);
    const entry = this._entries.splice(nextIdx, 1)[0];
    this._byId.delete(entry.nodeId);
    return entry;
  }

  /** Clears the agenda completely. */
  public clear(): void {
    this._entries = [];
    this._byId.clear();
  }
}
