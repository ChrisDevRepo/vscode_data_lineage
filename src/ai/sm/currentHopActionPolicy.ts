import type { InvalidRoute } from './smTypes';

/** One model-authored route/prune target after identifier resolution. */
export interface CurrentHopActionTarget {
  /** Verbatim model-authored identifier used in notices. */
  raw: string;
  /** Canonical model id, or null when the reference is unresolved. */
  resolved: string | null;
  /** Exact submit_findings field path. */
  path: string;
}

/** Immutable facts needed to classify current-hop route and prune actions. */
export interface CurrentHopActionPolicyInput {
  /** Canonical exploration origin. */
  originId: string;
  /** Explicit route_requests targets. */
  routeTargets: CurrentHopActionTarget[];
  /** BB prune_neighbors targets. */
  pruneTargets: CurrentHopActionTarget[];
  /** Nodes admitted to the approved exploration scope. */
  scopeNodeIds: ReadonlySet<string>;
  /** Current-hop directional neighbors still requiring accounting. */
  requiredNeighborIds: ReadonlySet<string>;
  /** Nodes already processed or removed. */
  visitedIds: ReadonlySet<string>;
  /** Nodes already removed by an earlier accepted prune. */
  removedIds: ReadonlySet<string>;
  /** Nodes whose authored detail is already committed. */
  notedIds: ReadonlySet<string>;
}

/** Pure action classification consumed atomically by NavigationEngine. */
export interface CurrentHopActionPolicyResult {
  /** Fatal conflicts that reject the complete submission. */
  fatalErrors: InvalidRoute[];
  /** Nonfatal refused/unknown actions recorded for the next hop. */
  notices: InvalidRoute[];
  /** Out-of-scope prune targets eligible for topology validation. */
  acceptedPruneIds: string[];
}

/**
 * Classifies current-hop actions without mutating engine state.
 *
 * @remarks
 * This consolidates the former scattered guards while preserving their observable contract:
 * unresolved routes and refused no-op prunes are notices; route/prune conflicts and origin
 * mutation are fatal. Reachable routes are not restricted to direct neighbors, and approved
 * in-scope/queued work is protected rather than turned into a retry-loop rejection.
 */
export function evaluateCurrentHopActionPolicy(input: CurrentHopActionPolicyInput): CurrentHopActionPolicyResult {
  const fatalErrors: InvalidRoute[] = [];
  const notices: InvalidRoute[] = [];
  const acceptedPruneIds: string[] = [];
  const routedIds = new Set<string>();

  for (const target of input.routeTargets) {
    routedIds.add(target.resolved ?? target.raw.toLowerCase());
    if (!target.resolved) {
      notices.push({
        kind: 'absent_route',
        id: target.raw,
        path: target.path,
        reason: 'Route target absent from the loaded graph model — recorded as an unresolved reference and skipped.',
      });
      continue;
    }
  }

  for (const target of input.pruneTargets) {
    const id = target.resolved ?? target.raw.toLowerCase();
    if (routedIds.has(id)) {
      fatalErrors.push({ kind: 'prune_route_conflict', id, path: target.path, reason: `\`${id}\` was submitted in both route_requests and prune_neighbors in the same hop.` });
      continue;
    }
    if (!target.resolved) {
      notices.push({ kind: 'prune_absent', id: target.raw, path: target.path, reason: `\`${target.raw}\` is not in the loaded model.` });
      continue;
    }
    if (id === input.originId) {
      fatalErrors.push({ kind: 'prune_origin_forbidden', id, path: target.path, reason: `\`${id}\` is the origin node and anchors the lineage.` });
      continue;
    }
    if (input.removedIds.has(id)) {
      notices.push({ kind: 'prune_noop_removed', id, path: target.path, reason: `\`${id}\` was already pruned on an earlier hop.` });
      continue;
    }
    if (input.visitedIds.has(id)) {
      notices.push({ kind: 'prune_noop_visited', id, path: target.path, reason: `\`${id}\` was already analyzed on an earlier hop.` });
      continue;
    }
    if (input.notedIds.has(id)) {
      notices.push({ kind: 'prune_noop_analyzed', id, path: target.path, reason: `\`${id}\` is already recorded as an analyzed node.` });
      continue;
    }
    if (input.scopeNodeIds.has(id)) {
      // The required-neighbor guard owns the fatal missing-route result. Other in-scope work is
      // protected with a notice so an already-queued seed cannot manufacture a repair loop.
      if (!input.requiredNeighborIds.has(id)) {
        notices.push({
          kind: 'prune_noop_in_scope',
          id,
          path: target.path,
          reason: `\`${id}\` is inside the approved exploration scope and cannot be pruned via prune_neighbors.`,
        });
      }
      continue;
    }
    acceptedPruneIds.push(id);
  }

  return { fatalErrors, notices, acceptedPruneIds };
}
