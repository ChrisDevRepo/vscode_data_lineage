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
  /** Explicit prune_neighbors targets. */
  pruneTargets: CurrentHopActionTarget[];
  /** Nodes admitted to the approved exploration scope. */
  scopeNodeIds: ReadonlySet<string>;
  /** Nodes already processed or removed. */
  visitedIds: ReadonlySet<string>;
  /** Nodes already removed by an earlier accepted prune. */
  removedIds: ReadonlySet<string>;
  /** Nodes whose authored detail is already committed. */
  notedIds: ReadonlySet<string>;
  /** Nodes already queued for a hop of their own. */
  agendaIds: ReadonlySet<string>;
}

/** Pure action classification consumed atomically by NavigationEngine. */
export interface CurrentHopActionPolicyResult {
  /** Fatal conflicts that reject the complete submission. */
  fatalErrors: InvalidRoute[];
  /** Nonfatal refused/unknown actions recorded for the next hop. */
  notices: InvalidRoute[];
  /** Out-of-scope prune targets, and in-scope ones not already visited, queued, noted, or
   * removed — all eligible for topology (don't-orphan) validation. */
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
      // The hop-level prune decision: an in-scope neighbour the model has decided is off
      // the answer path is pruned at the hop, like any out-of-scope one. Queued work is the one
      // protection — a prune may not pull a neighbour that already owns a pending hop; the
      // don't-orphan topology check governs every accepted prune after this.
      if (input.agendaIds.has(id)) {
        notices.push({
          kind: 'prune_noop_queued',
          id,
          path: target.path,
          reason: `\`${id}\` is already queued for a hop of its own; prune_neighbors does not pull queued work.`,
        });
        continue;
      }
      acceptedPruneIds.push(id);
      continue;
    }
    acceptedPruneIds.push(id);
  }

  return { fatalErrors, notices, acceptedPruneIds };
}
