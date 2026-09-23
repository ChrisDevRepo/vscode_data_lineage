import type { InvalidRoute } from './smTypes';

/** One model-authored prune target after identifier resolution. */
export interface CurrentHopActionTarget {
  /** Verbatim model-authored identifier used in notices. */
  raw: string;
  /** Canonical model id, or null when the reference is unresolved. */
  resolved: string | null;
  /** Exact submit_findings field path. */
  path: string;
}

/** Immutable facts needed to classify current-hop prune actions. */
export interface CurrentHopActionPolicyInput {
  /** Canonical exploration origin. */
  originId: string;
  /** Explicit prune_neighbors targets. */
  pruneTargets: CurrentHopActionTarget[];
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
  /** Prune targets — in scope or out — that are not already visited, queued, noted or removed, eligible for the declared-column check. */
  acceptedPruneIds: string[];
}

/**
 * Classifies current-hop prune actions without mutating engine state.
 *
 * @remarks
 * Unresolved and no-op prunes are notices; pruning the origin is fatal. Queued, visited and
 * removed targets are protected rather than turned into a retry-loop rejection.
 */
export function evaluateCurrentHopActionPolicy(input: CurrentHopActionPolicyInput): CurrentHopActionPolicyResult {
  const fatalErrors: InvalidRoute[] = [];
  const notices: InvalidRoute[] = [];
  const acceptedPruneIds: string[] = [];

  for (const target of input.pruneTargets) {
    const id = target.resolved ?? target.raw.toLowerCase();
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
  }

  return { fatalErrors, notices, acceptedPruneIds };
}
