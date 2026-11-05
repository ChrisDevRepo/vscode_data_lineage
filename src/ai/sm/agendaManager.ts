import Graph from 'graphology';
import { stronglyConnectedComponents } from 'graphology-components';
import type { ColumnCarry } from './smTypes';
import { normalizeColName } from '../../utils/sql';

/** Represents an entry in the navigation agenda. */
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
   */
  priority: number;
  /** The topological depth relative to the origin node. */
  depth: number;
  /** Specific columns of interest for this node (primarily used in Column Trace mode). */
  activeColumns?: string[];
  /**
   * The router's per-neighbor column decision as authored; only `row_role_only` changes dispatch,
   * `carry` is already expressed by `activeColumns`.
   */
  columnCarry?: ColumnCarry;
  /**
   * CT chain-continuation questions opened for this node by an earlier hop; rendered only when this
   * entry is dispatched.
   */
  lineageQuestions?: string[];
}

/** Unions column demands; a row-only arrival cannot erase an existing demand. */
function mergeColumnCarry(
  existing: ColumnCarry | undefined,
  incoming: ColumnCarry | undefined,
  identifierCaseSensitive = false,
): ColumnCarry | undefined {
  if (existing?.kind === 'carry' || incoming?.kind === 'carry') {
    return {
      kind: 'carry',
      columns: mergeUnique(
        existing?.kind === 'carry' ? existing.columns : undefined,
        incoming?.kind === 'carry' ? incoming.columns : [],
        (column) => normalizeColName(column, identifierCaseSensitive),
      ),
    };
  }
  return incoming ?? existing;
}

/** Unions `incoming` into `existing` (order-preserving on first occurrence), deduplicated. */
function mergeUnique(
  existing: readonly string[] | undefined,
  incoming: readonly string[],
  keyOf: (value: string) => string,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(existing ?? []), ...incoming]) {
    const key = keyOf(value);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(value);
    }
  }
  return merged;
}

/** The engine's view of the note graph, read fresh on every {@link AgendaManager.dequeue}. */
export interface WorklistView {
  /**
   * Unfinished note-graph successors of `nodeId` — the not-yet-visited, not-removed, in-scope nodes
   * a note written at its hop can still reach. A finished node is never returned.
   */
  successors(nodeId: string): Iterable<string>;
  /** Directed distance from the origin, after column work and after an origin or follow-up. */
  distance(entry: AgendaEntry): number;
}

/**
 * Lexicographic key among ready entries: column work, then an origin or follow-up,
 * then distance from the origin, then node id.
 */
interface WorklistRank {
  /** `0` when this arrival has column work, else `1`. */
  readonly columnTier: number;
  /** `0` for an origin or follow-up entry (priority 3), `1` for every other entry. */
  readonly tier: number;
  readonly distance: number;
  readonly nodeId: string;
}

/** The dispatch key of one agenda entry under `view`. */
function worklistRank(entry: AgendaEntry, view: WorklistView): WorklistRank {
  return {
    columnTier: hasColumnWork(entry) ? 0 : 1,
    tier: entry.priority === 3 ? 0 : 1,
    distance: view.distance(entry),
    nodeId: entry.nodeId,
  };
}

/**
 * Only this arrival's persisted demand selects CT; global provenance never selects a queue tier.
 */
function hasColumnWork(entry: AgendaEntry): boolean {
  if (entry.columnCarry?.kind === 'row_role_only') return false;
  return (entry.activeColumns?.length ?? 0) > 0;
}

/** Total order over {@link WorklistRank} — smaller dispatches first. */
function compareWorklistRank(a: WorklistRank, b: WorklistRank): number {
  if (a.columnTier !== b.columnTier) return a.columnTier - b.columnTier;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/**
 * Readiness of the queued node ids — Kahn readiness over the live note graph, with every strongly
 * connected component treated as one unit.
 */
function analyzeWorklist(
  queued: readonly string[],
  successors: (nodeId: string) => Iterable<string>,
): { ready: string[] } {
  const live = new Graph({
    type: 'directed',
    allowSelfLoops: false,
    multi: false,
  });
  const frontier: string[] = [];
  for (const id of queued) {
    if (!live.hasNode(id)) {
      live.addNode(id);
      frontier.push(id);
    }
  }
  for (let i = 0; i < frontier.length; i++) {
    const from = frontier[i];
    for (const to of successors(from)) {
      if (to === from) continue;
      if (!live.hasNode(to)) {
        live.addNode(to);
        frontier.push(to);
      }
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
    const source = componentOf.get(from)!;
    if (source !== target) blocked.add(target);
  });
  return {
    ready: queued.filter((id) => !blocked.has(componentOf.get(id)!)),
  };
}

/** Manages the NavigationEngine's agenda queue. */
export class AgendaManager {
  constructor(private readonly identifierCaseSensitive = false) {}
  private _entries: AgendaEntry[] = [];
  /** Id-keyed index onto `_entries`, kept in sync at every mutation site for O(1) lookups. */
  private _byId = new Map<string, AgendaEntry>();

  /** Returns all current entries. */
  public get entries(): ReadonlyArray<AgendaEntry> {
    return this._entries;
  }

  public get(nodeId: string): AgendaEntry | undefined {
    return this._byId.get(nodeId);
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
   * Adds or merges an entry: a node consumes at most one hop; priority keeps the highest tier and
   * depth the shortest path.
   */
  public push(entry: AgendaEntry): void {
    const existing = this._byId.get(entry.nodeId);
    if (existing) {
      for (const taskId of entry.taskIds) {
        if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
      }
      const carry = mergeColumnCarry(
        existing.columnCarry,
        entry.columnCarry,
        this.identifierCaseSensitive,
      );
      if (carry) existing.columnCarry = carry;
      if (carry?.kind === 'row_role_only') {
        existing.activeColumns = [];
      } else if (entry.activeColumns) {
        existing.activeColumns = mergeUnique(
          existing.activeColumns,
          entry.activeColumns,
          (column) => normalizeColName(column, this.identifierCaseSensitive),
        );
      }
      if (entry.lineageQuestions) {
        existing.lineageQuestions = mergeUnique(
          existing.lineageQuestions,
          entry.lineageQuestions,
          (question) => question,
        );
      }
      existing.priority = Math.max(existing.priority, entry.priority);
      existing.depth = Math.min(existing.depth, entry.depth);
    } else {
      this._entries.push(entry);
      this._byId.set(entry.nodeId, entry);
    }
  }

  /** Removes and returns the next entry in worklist order. */
  public dequeue(view: WorklistView): AgendaEntry | undefined {
    if (this._entries.length === 0) return undefined;
    const ready = new Set(
      analyzeWorklist(
        this._entries.map((entry) => entry.nodeId),
        (id) => view.successors(id),
      ).ready,
    );
    let nextIdx = -1;
    let best: WorklistRank | undefined;
    this._entries.forEach((entry, index) => {
      if (!ready.has(entry.nodeId)) return;
      const rank = worklistRank(entry, view);
      if (!best || compareWorklistRank(rank, best) < 0) {
        best = rank;
        nextIdx = index;
      }
    });
    if (nextIdx < 0)
      throw new Error(
        `agenda has ${this._entries.length} entries and no ready node`,
      );
    const entry = this._entries.splice(nextIdx, 1)[0];
    this._byId.delete(entry.nodeId);
    return entry;
  }

  /** Removes the queued entry for `nodeId`, if any — the cut of a resolved prune. */
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
