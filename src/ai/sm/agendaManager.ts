import Graph from 'graphology';
import { stronglyConnectedComponents } from 'graphology-components';
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
   * - 3: Origin/Root node or post-delivery follow-up.
   *
   * Only tier 3 affects dispatch order ({@link worklistRank}); 0 and 2 are kept for the
   * persisted snapshot shape.
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
 * The one surviving cross-hop column-carry conflict rule in the engine (the same-hop rule is a
 * rejection, not a merge — see `smBase.ts` `routeCarryFor`). A stated decision beats an unstated
 * one, and the later statement wins between two stated ones: an absent carry is "no opinion" and
 * never overwrites what is already recorded, while a router that names columns or a row role has
 * judged this exact neighbor and its word stands until the router says otherwise. This is how a
 * route's `columns: 'none'` against a node an EARLIER hop already committed `column_flow` columns
 * to is honored rather than rejected — neither statement is wrong for the hop that made it, so the
 * later one simply supersedes on the shared agenda entry (the earlier committed column can still
 * resurface at dispatch; see `smBase.ts` `getHopContext`).
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
 * The engine's view of the note graph, read fresh on every {@link AgendaManager.dequeue}.
 *
 * @remarks
 * A note written at `u`'s hop can reach `v` (`u ⇒ v`) along the routing direction, contracted
 * through non-bodied carriers. The engine owns that definition; the scheduler only orders.
 */
export interface WorklistView {
  /**
   * Unfinished note-graph successors of `nodeId` — the not-yet-visited, not-removed, in-scope
   * nodes a note written at its hop can still reach. A finished node is never returned.
   */
  successors(nodeId: string): Iterable<string>;
  /** Directed distance from the origin used as the second tie-break key. */
  distance(entry: AgendaEntry): number;
}

/** Lexicographic dispatch key among ready entries: tier, then directed distance, then node id. */
export interface WorklistRank {
  /** `0` for an origin or follow-up entry (priority 3), `1` for every other entry. */
  readonly tier: number;
  readonly distance: number;
  readonly nodeId: string;
}

/** The dispatch key of one agenda entry under `view`. */
export function worklistRank(entry: AgendaEntry, view: WorklistView): WorklistRank {
  return { tier: entry.priority === 3 ? 0 : 1, distance: view.distance(entry), nodeId: entry.nodeId };
}

/** Total order over {@link WorklistRank} — smaller dispatches first. */
export function compareWorklistRank(a: WorklistRank, b: WorklistRank): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/**
 * The queued node ids that are ready to dispatch: Kahn readiness over the live note graph, with
 * every strongly connected component treated as one unit.
 *
 * @remarks
 * Live = the queued nodes plus every unfinished node reachable from one along `⇒`
 * ({@link WorklistView.successors} returns unfinished nodes only, so visited, removed and
 * out-of-scope nodes count as finished). A queued node is ready when its SCC (Tarjan, via
 * `graphology-components`) has no incoming edge from another live SCC. The condensation of Live
 * is a DAG, and a source SCC is either one containing a queued node or unreachable from the queue —
 * the latter cannot be live — so the ready set is non-empty whenever `queued` is.
 *
 * @param queued - Node ids currently on the agenda.
 * @param successors - Unfinished note-graph successors of a node.
 * @returns The ready subset of `queued`, in `queued` order.
 */
export function readyNodeIds(queued: readonly string[], successors: (nodeId: string) => Iterable<string>): string[] {
  const live = new Graph({ type: 'directed', allowSelfLoops: false, multi: false });
  const frontier: string[] = [];
  for (const id of queued) {
    if (!live.hasNode(id)) { live.addNode(id); frontier.push(id); }
  }
  for (let i = 0; i < frontier.length; i++) {
    const from = frontier[i];
    for (const to of successors(from)) {
      if (to === from) continue;
      if (!live.hasNode(to)) { live.addNode(to); frontier.push(to); }
      if (!live.hasDirectedEdge(from, to)) live.addDirectedEdge(from, to);
    }
  }
  const componentOf = new Map<string, number>();
  stronglyConnectedComponents(live).forEach((members, index) => {
    for (const id of members) componentOf.set(id, index);
  });
  const blocked = new Set<number>();
  live.forEachDirectedEdge((_edge, _attr, from, to) => {
    const target = componentOf.get(to)!;
    if (componentOf.get(from) !== target) blocked.add(target);
  });
  return queued.filter(id => !blocked.has(componentOf.get(id)!));
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
   * existing entry, priority keeps the highest tier and depth the shortest known path.
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
   * Removes and returns the next entry in worklist order.
   *
   * @remarks
   * The textbook dynamic topological schedule, recomputed from `view` on every call so scope
   * growth, contraction admits and prunes take effect immediately: among the
   * {@link readyNodeIds ready} entries, the smallest {@link worklistRank} wins. The order is the
   * same in both modes — nothing in it reads columns or question text.
   *
   * @param view - The engine's current note graph and distances.
   * @returns The next entry, or `undefined` when the agenda is empty.
   * @throws Error when entries remain but none is ready — impossible by the progress argument in
   *   {@link readyNodeIds}, so reaching it is an engine defect, never a state to recover from.
   */
  public dequeue(view: WorklistView): AgendaEntry | undefined {
    if (this._entries.length === 0) return undefined;
    const ready = new Set(readyNodeIds(this._entries.map(entry => entry.nodeId), id => view.successors(id)));
    let nextIdx = -1;
    let best: WorklistRank | undefined;
    this._entries.forEach((entry, index) => {
      if (!ready.has(entry.nodeId)) return;
      const rank = worklistRank(entry, view);
      if (!best || compareWorklistRank(rank, best) < 0) { best = rank; nextIdx = index; }
    });
    if (nextIdx < 0) throw new Error(`agenda has ${this._entries.length} entries and no ready node`);
    const entry = this._entries.splice(nextIdx, 1)[0];
    this._byId.delete(entry.nodeId);
    return entry;
  }

  /**
   * Removes the queued entry for `nodeId`, if any — the cut of an `end_branch` or prune.
   *
   * @param nodeId - Node whose entry leaves the agenda.
   * @returns The removed entry, or `undefined` when the node was not queued.
   */
  public remove(nodeId: string): AgendaEntry | undefined {
    const entry = this._byId.get(nodeId);
    if (!entry) return undefined;
    this._entries.splice(this._entries.indexOf(entry), 1);
    this._byId.delete(nodeId);
    return entry;
  }

  /** Clears the agenda completely. */
  public clear(): void {
    this._entries = [];
    this._byId.clear();
  }
}
