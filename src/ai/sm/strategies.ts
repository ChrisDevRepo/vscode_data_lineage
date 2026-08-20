/**
 * Navigation strategy implementations — one per SM mode (BB vs CT).
 *
 * @remarks
 * Encapsulates mode-specific validation logic so `NavigationEngine.submitFindings`
 * dispatches to the active strategy rather than branching on `this.mode.kind`.
 * Both strategies implement {@link INavigationStrategy}. The engine holds a
 * reference as `this._strategy` (set in `init` / `startCt`) and delegates all
 * mode-sensitive guards here.
 *
 * Kept intentionally thin: strategies validate and stage — they never mutate
 * engine state directly. All mutations go through the engine after the strategy
 * returns a result.
 */
import type { HopFinding, InvalidRoute } from './smTypes';

/**
 * Contract for mode-specific validation delegates used by `NavigationEngine`.
 *
 * @remarks
 * Each method returns errors/staged data rather than throwing, so the engine
 * retains full control over error accumulation and state transitions.
 */
export interface INavigationStrategy {
  /**
   * BB-only guard: verifies that nodes identified as required neighbors appear in
   * `route_requests` or `prune_neighbors`. CT skips this check.
   *
   * @param focusId - The id of the current focus node.
   * @param finding - The submitted hop findings.
   * @param acceptedNids - Set of node ids successfully accepted.
   * @param prunedNeighborNids - Set of neighbor node ids successfully pruned.
   * @param invalidRoutes - Accumulator array; push errors here.
   * @param requiredNodeIds - Precomputed required neighbor ids for `focusId`.
   */
  runRequiredNodesGuard(
    focusId: string,
    finding: HopFinding,
    acceptedNids: Set<string>,
    prunedNeighborNids: Set<string>,
    invalidRoutes: InvalidRoute[],
    requiredNodeIds: string[],
  ): void;

}

/**
 * Breadth-first (BB) mode strategy.
 *
 * @remarks
 * BB accepts the `prune_neighbors` field, while the pure current-hop action policy classifies each
 * target as fatal, notice-only, or eligible for topology validation. This strategy owns only the
 * required in-scope route-accounting guard. Column tracking fields are handled by CT.
 */
export class BbStrategy implements INavigationStrategy {
  /** {@inheritDoc INavigationStrategy.runRequiredNodesGuard} */
  runRequiredNodesGuard(
    focusId: string,
    finding: HopFinding,
    acceptedNids: Set<string>,
    prunedNeighborNids: Set<string>,
    invalidRoutes: InvalidRoute[],
    requiredNodeIds: string[],
  ): void {
    const required = requiredNodeIds;
    const attemptedPrunes = new Set((finding.prune_neighbors ?? []).map(id => id.toLowerCase()));
    const missing = required.filter(reqId => !acceptedNids.has(reqId) && !prunedNeighborNids.has(reqId));
    if (missing.length > 0) {
      for (const reqId of missing) {
        const invalidlyPruned = attemptedPrunes.has(reqId);
        invalidRoutes.push({
          kind: 'missing_required_route',
          id: reqId,
          invalidlyPruned,
          reason: invalidlyPruned
            ? `Required neighbor was submitted in prune_neighbors from focus ${focusId}, but approved in-scope neighbors must be routed: ${reqId}`
            : `Required neighbor was not accounted for from focus ${focusId}: ${reqId}`,
          available_routes: required,
        });
      }
    }
  }

}

/**
 * Column Trace (CT) mode strategy.
 *
 * @remarks
 * CT forbids `prune_neighbors` and requires the AI to account for every tracked
 * column in `column_flow`. Column flow validation and edge staging are handled
 * directly by `NavigationEngine` via `ColumnTracer`.
 */
export class CtStrategy implements INavigationStrategy {
  /** CT mode does NOT check required nodes — the AI's column_flow drives routing. */
  runRequiredNodesGuard(
    _focusId: string, _finding: HopFinding, _acceptedNids: Set<string>,
    _prunedNeighborNids: Set<string>, _invalidRoutes: InvalidRoute[], _requiredNodeIds: string[],
  ): void {}

}
