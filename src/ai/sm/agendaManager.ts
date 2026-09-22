import type { ColumnCarry } from './smTypes';

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
   * The router's per-neighbor column decision for this hop, as authored — distinct from
   * `activeColumns`, which is the engine's resolved projection and is rewritten at dispatch.
   * Only `row_role_only` changes what dispatch does; `carry` is already fully expressed by
   * `activeColumns`. Absent on a checkpoint written before this field existed, or on a BB entry,
   * which carries no column state at all.
   */
  columnCarry?: ColumnCarry;
  /**
   * CT chain-continuation questions opened for this node by an earlier hop's `column_flow`
   * edges — rendered as `<lineage_questions>` only when this entry is dispatched, never by
   * whichever node happens to dequeue next.
   */
  lineageQuestions?: string[];
}

/**
 * Resolves the carry decision when two enqueues land on one node.
 *
 * @remarks
 * The one surviving cross-hop column-carry conflict rule in the engine (see `smBase.ts`
 * `routeCarryFor`'s remarks for the same-hop rule, which is a rejection, not a merge). A stated
 * decision beats an unstated one, and the later statement wins between two stated ones: an absent
 * carry is "no opinion" and never overwrites what is already recorded, while a router that names
 * columns or names a row role has judged this exact neighbor and its word stands until the router
 * says otherwise.
 *
 * This is how a route's `columns: 'none'` against a node an EARLIER hop already committed
 * `column_flow` columns to is honored rather than rejected: neither statement is wrong for the
 * hop that made it, so the later one simply supersedes on the shared agenda entry. The column the
 * earlier hop committed is not re-padded back on by this merge — see `smBase.ts`
 * `getHopContext`'s remarks for where that committed column can still resurface at dispatch, and
 * the follow-up that resolution is left waiting on.
 *
 * @param existing - Carry already on the queued entry, if any.
 * @param incoming - Carry supplied by the re-push, if any.
 * @returns The carry to record, or `undefined` when neither side stated one.
 */
function mergeColumnCarry(existing: ColumnCarry | undefined, incoming: ColumnCarry | undefined): ColumnCarry | undefined {
  if (incoming === undefined) return existing;
  return incoming;
}

/** Unions `incoming` into `existing` (order-preserving on first occurrence), deduplicated. */
function mergeUnique(existing: string[] | undefined, incoming: string[]): string[] {
  const merged = new Set(existing ?? []);
  for (const value of incoming) merged.add(value);
  return Array.from(merged);
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
      const carry = mergeColumnCarry(existing.columnCarry, entry.columnCarry);
      if (carry) existing.columnCarry = carry;
      if (carry?.kind === 'row_role_only') {
        // The router stated this neighbor carries no traced value. That replaces whatever a BFS
        // seed or an earlier unstated carry put on the entry, rather than unioning with it — a
        // union would re-pad the very columns the statement removed.
        if (entry.activeColumns !== undefined) existing.activeColumns = [...entry.activeColumns];
      } else if (entry.activeColumns) {
        existing.activeColumns = mergeUnique(existing.activeColumns, entry.activeColumns);
      }
      if (entry.lineageQuestions) {
        existing.lineageQuestions = mergeUnique(existing.lineageQuestions, entry.lineageQuestions);
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
