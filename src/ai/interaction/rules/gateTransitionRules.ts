import type { PendingGate } from '../../session/sessionPhase';

/**
 * Represents the discrete actions the engine can take when transitioning
 * out of a pending human-in-the-loop gate.
 */
type GateTransitionDecision =
  | { action: 'cancel' }
  | { action: 'approve_confirm_sm' }
  | { action: 'approve_scope_expansion' }
  | { action: 'refine_confirm_sm' }
  | { action: 'redirect_non_confirm' };

/**
 * Central classifier for pending-gate transition actions.
 *
 * @remarks
 * Keeps the high-level gate state matrix explicit and reusable across participant
 * flow code and documentation.
 */
export function decideGateTransition(
  gate: PendingGate,
  answer: 'yes' | 'no' | 'refine' | 'redirect',
): GateTransitionDecision {
  if (answer === 'no') return { action: 'cancel' };
  if (gate.gate === 'confirm_sm_start') {
    if (answer === 'yes') return { action: 'approve_confirm_sm' };
    return { action: 'refine_confirm_sm' };
  }
  // Preserve legacy behavior for non-confirm gates:
  // only explicit "redirect" resets; refine-style replies are treated as approve.
  if (answer === 'redirect') return { action: 'redirect_non_confirm' };
  return { action: 'approve_scope_expansion' };
}
