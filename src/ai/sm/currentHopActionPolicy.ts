import type { InvalidRoute } from './smTypes';

/** One model-authored prune target after identifier resolution. */
export interface CurrentHopActionTarget {
  /** Verbatim model-authored identifier used in rejection details. */
  raw: string;
  /** Canonical model id, or null when the reference is unresolved. */
  resolved: string | null;
  /** Exact submit_findings field path. */
  path: string;
}

/** Immutable facts needed to classify current-hop prune actions. */
interface CurrentHopActionPolicyInput {
  /** Canonical exploration origin. */
  originId: string;
  /** Explicit prune_neighbors targets. */
  pruneTargets: CurrentHopActionTarget[];
  /** Nodes already processed: analyzed on a hop of their own, or the carrier the engine passed through into the current focus. */
  visitedIds: ReadonlySet<string>;
  /** Nodes already removed by an earlier accepted prune. */
  removedIds: ReadonlySet<string>;
  /** Nodes whose authored detail is already committed. */
  notedIds: ReadonlySet<string>;
  /** Nodes kept by a different branch; a prune here is a losing vote. */
  keptIds: ReadonlySet<string>;
  /** Nodes already queued for a hop of their own. */
  agendaIds: ReadonlySet<string>;
}

/** Pure action classification consumed atomically by NavigationEngine. */
interface CurrentHopActionPolicyResult {
  /** Refused or unknown actions that reject this submission atomically. */
  invalidRoutes: InvalidRoute[];
  /** Resolved prune targets that are not the origin and not already visited, noted or removed; another branch may have queued them. */
  acceptedPruneIds: string[];
}

/** Classifies current-hop prune actions without mutating engine state. */
export function evaluateCurrentHopActionPolicy(input: CurrentHopActionPolicyInput): CurrentHopActionPolicyResult {
  const invalidRoutes: InvalidRoute[] = [];
  const acceptedPruneIds: string[] = [];

  for (const target of input.pruneTargets) {
    const id = target.resolved;
    if (!id) {
      invalidRoutes.push({ kind: 'prune_absent', id: target.raw, path: target.path, reason: `\`${target.raw}\` is not in the loaded model.` });
      continue;
    }
    if (id === input.originId) {
      invalidRoutes.push({ kind: 'prune_noop_visited', id, path: target.path, reason: `\`${id}\` is the origin node and anchors the lineage; a prune cannot remove it.` });
      continue;
    }
    if (input.removedIds.has(id)) {
      invalidRoutes.push({ kind: 'prune_noop_removed', id, path: target.path, reason: `\`${id}\` was already pruned on an earlier hop.` });
      continue;
    }
    if (input.visitedIds.has(id)) {
      invalidRoutes.push({ kind: 'prune_noop_visited', id, path: target.path, reason: `\`${id}\` was already visited on an earlier hop and stays on the answer path.` });
      continue;
    }
    if (input.notedIds.has(id)) {
      invalidRoutes.push({ kind: 'prune_noop_analyzed', id, path: target.path, reason: `\`${id}\` is already recorded as an analyzed node.` });
      continue;
    }
    if (input.agendaIds.has(id) && !input.keptIds.has(id)) {
      invalidRoutes.push({
        kind: 'prune_noop_queued',
        id,
        path: target.path,
        reason: `\`${id}\` is already queued for a hop of its own; prune_neighbors does not pull queued work.`,
      });
      continue;
    }
    acceptedPruneIds.push(id);
  }

  return { invalidRoutes, acceptedPruneIds };
}
