/**
 * The one behavioural difference between the two SM modes, expressed as a base class and its
 * subclass.
 *
 * @remarks
 * CT is BB plus a column overlay: same origin, same direction, same depth, same breadth-first node
 * set. Traversal, scope, border and depth belong to `NavigationEngine` and are shared verbatim;
 * what a mode may change is validation of a submitted hop, and that is what lives here.
 *
 * {@link CtStrategy} therefore EXTENDS {@link BbStrategy} rather than restating it, and overrides
 * exactly one member. A second difference between the modes belongs here as a second override — a
 * `this.mode.kind === 'ct'` branch inside the engine is the defect, not the fix.
 *
 * Strategies validate and stage; they never mutate engine state. All mutations happen in the engine
 * after the strategy returns.
 */
import type { HopFinding, InvalidRoute } from './smTypes';

/**
 * Breadth-first (BB) mode strategy, and the base contract both modes share.
 *
 * @remarks
 * Errors are pushed onto the caller's accumulator rather than thrown, so the engine keeps control
 * of error accumulation and state transitions.
 */
export class BbStrategy {
  /**
   * Verifies that every required neighbour appears in `route_requests` or `prune_neighbors`.
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
  ): void {
    const required = requiredNodeIds;
    const attemptedPrunes = new Set((finding.prune_neighbors ?? []).map(id => id.toLowerCase()));
    const missing = required.filter(reqId => !acceptedNids.has(reqId) && !prunedNeighborNids.has(reqId));
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

/**
 * Column Trace (CT) mode strategy — {@link BbStrategy} with the column overlay's one exemption.
 *
 * @remarks
 * Everything BB validates, CT validates identically by inheritance. The single override is the
 * required-neighbour guard, and it is paired with `buildActiveStagePrompt` in
 * `src/ai/agent/stagePrompts.ts`, which withholds `<required_neighbors>` from a CT hop: enforcing a
 * checklist the model was never shown would only add rejections. The two halves move together —
 * showing CT the list is what makes deleting this override correct.
 */
export class CtStrategy extends BbStrategy {
  /** {@inheritDoc BbStrategy.runRequiredNodesGuard} */
  override runRequiredNodesGuard(): void {}
}
