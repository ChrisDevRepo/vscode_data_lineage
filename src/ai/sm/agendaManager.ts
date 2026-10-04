import Graph from 'graphology';
import { stronglyConnectedComponents } from 'graphology-components';
import type { ColumnCarry } from './smTypes';
import { uniqueScalarReturnTargets } from './scalarReturnBinding';
import { schemaKey } from '../../utils/sql';

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

/** Unions column demands; a row-only arrival cannot erase an existing demand. */
function mergeColumnCarry(existing: ColumnCarry | undefined, incoming: ColumnCarry | undefined, identifierCaseSensitive = false): ColumnCarry | undefined {
  if (existing?.kind === 'scalar_return' && incoming?.kind === 'carry' || existing?.kind === 'carry' && incoming?.kind === 'scalar_return') {
    // Mixed arrival; defensive fallback keeping the existing kind's constraints
    if (existing?.kind === 'scalar_return') return { kind: 'scalar_return', outputs: uniqueScalarReturnTargets(existing.outputs, identifierCaseSensitive) };
    return { kind: 'scalar_return', outputs: uniqueScalarReturnTargets((incoming as any).outputs, identifierCaseSensitive) };
  }
  if (existing?.kind === 'scalar_return' || incoming?.kind === 'scalar_return') {
    const outputs = [...(existing?.kind === 'scalar_return' ? existing.outputs : []), ...(incoming?.kind === 'scalar_return' ? incoming.outputs : [])];
    return { kind: 'scalar_return', outputs: uniqueScalarReturnTargets(outputs, identifierCaseSensitive) };
  }
  if (existing?.kind === 'carry' || incoming?.kind === 'carry') {
    return { kind: 'carry', columns: mergeUnique(existing?.kind === 'carry' ? existing.columns : undefined, incoming?.kind === 'carry' ? incoming.columns : [], identifierCaseSensitive) };
  }
  return incoming ?? existing;
}



/** Unions `incoming` into `existing` (order-preserving on first occurrence), deduplicated. */
function mergeUnique(existing: readonly string[] | undefined, incoming: readonly string[], identifierCaseSensitive = false): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(existing ?? []), ...incoming]) {
    const key = schemaKey(value, identifierCaseSensitive);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(value);
    }
  }
  return merged;
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

/** Lexicographic key among ready entries: column class, explicit priority, distance, then node id. */
export interface WorklistRank {
  /** Ready CT, then a BB prerequisite of pending CT, then ordinary BB. */
  readonly columnTier: number;
  /** `0` for an origin or follow-up entry (priority 3), `1` for every other entry. */
  readonly tier: number;
  readonly distance: number;
  readonly nodeId: string;
}

/** The dispatch key of one agenda entry under `view`. */
function worklistRank(entry: AgendaEntry, view: WorklistView, prerequisites: ReadonlySet<string>): WorklistRank {
  return { columnTier: hasColumnWork(entry) ? 0 : prerequisites.has(entry.nodeId) ? 1 : 2,
    tier: entry.priority === 3 ? 0 : 1, distance: view.distance(entry), nodeId: entry.nodeId };
}

/** Only this arrival's persisted demand selects CT; global provenance never selects a queue tier. */
function hasColumnWork(entry: AgendaEntry): boolean {
  if (entry.columnCarry?.kind === 'row_role_only') return false;
  return entry.columnCarry?.kind === 'scalar_return'
    || (entry.activeColumns?.length ?? 0) > 0;
}

/** Total order over {@link WorklistRank} — smaller dispatches first. */
export function compareWorklistRank(a: WorklistRank, b: WorklistRank): number {
  if (a.columnTier !== b.columnTier) return a.columnTier - b.columnTier;
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
  return analyzeWorklist(queued, successors, []).ready;
}

/** One condensation owns readiness and the predecessors needed to unblock pending CT. */
function analyzeWorklist(queued: readonly string[], successors: (nodeId: string) => Iterable<string>, columnNodes: readonly string[]): {
  ready: string[]; prerequisites: ReadonlySet<string>;
} {
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
  const predecessors = new Map<number, Set<number>>();
  live.forEachDirectedEdge((_edge, _attr, from, to) => {
    const target = componentOf.get(to)!;
    const source = componentOf.get(from)!;
    if (source !== target) {
      blocked.add(target);
      const incoming = predecessors.get(target) ?? new Set<number>();
      incoming.add(source);
      predecessors.set(target, incoming);
    }
  });
  const needed = new Set<number>();
  const frontierComponents = columnNodes.map(id => componentOf.get(id)!);
  for (let i = 0; i < frontierComponents.length; i++) {
    const component = frontierComponents[i];
    if (needed.has(component)) continue;
    needed.add(component);
    frontierComponents.push(...(predecessors.get(component) ?? []));
  }
  return {
    ready: queued.filter(id => !blocked.has(componentOf.get(id)!)),
    prerequisites: new Set(queued.filter(id => needed.has(componentOf.get(id)!))),
  };
}

/**
 * Manages the NavigationEngine's agenda queue.
 *
 * @remarks
 * Encapsulates queue operations while keeping one executable hop per node. Distinct
 * questions remain independently addressable in the task ledger.
 */
export class AgendaManager {
  /** Uses the source policy when merging qualified column destinations. */
  constructor(private readonly identifierCaseSensitive = false) {}
  private _entries: AgendaEntry[] = [];
  /** Id-keyed index onto `_entries`, kept in sync at every mutation site for O(1) lookups. */
  private _byId = new Map<string, AgendaEntry>();

  /** Returns all current entries. */
  public get entries(): ReadonlyArray<AgendaEntry> {
    return this._entries;
  }

  /** Returns true if the node is currently in the agenda. */
  public get(nodeId: string): AgendaEntry | undefined {
    return this._byId.get(nodeId);
  }

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
      const carry = mergeColumnCarry(existing.columnCarry, entry.columnCarry, this.identifierCaseSensitive);
      if (carry) existing.columnCarry = carry;
      if (carry?.kind === 'row_role_only') {
        existing.activeColumns = [];
      } else if (carry?.kind === 'scalar_return') {
        existing.activeColumns = mergeUnique(carry.outputs.map(o => o.col), [], this.identifierCaseSensitive);
      } else if (entry.activeColumns) {
        existing.activeColumns = mergeUnique(existing.activeColumns, entry.activeColumns, this.identifierCaseSensitive);
      }
      if (entry.lineageQuestions) {
        existing.lineageQuestions = mergeUnique(existing.lineageQuestions, entry.lineageQuestions, this.identifierCaseSensitive);
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
   * {@link readyNodeIds ready} entries, the smallest {@link worklistRank} wins. The order is
   * shared by both modes. Column work changes rank only after structural readiness.
   *
   * @param view - The engine's current note graph and distances.
   * @returns The next entry, or `undefined` when the agenda is empty.
   * @throws Error when entries remain but none is ready — impossible by the progress argument in
   *   {@link readyNodeIds}, so reaching it is an engine defect, never a state to recover from.
   */
  public dequeue(view: WorklistView): AgendaEntry | undefined {
    if (this._entries.length === 0) return undefined;
    const analysis = analyzeWorklist(this._entries.map(entry => entry.nodeId), id => view.successors(id),
      this._entries.filter(hasColumnWork).map(entry => entry.nodeId));
    const ready = new Set(analysis.ready);
    let nextIdx = -1;
    let best: WorklistRank | undefined;
    this._entries.forEach((entry, index) => {
      if (!ready.has(entry.nodeId)) return;
      const rank = worklistRank(entry, view, analysis.prerequisites);
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
