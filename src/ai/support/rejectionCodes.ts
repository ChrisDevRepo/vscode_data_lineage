/**
 * Single owner of every top-level rejection code; issue codes classify each fault, and an emit site
 * never writes a code literal.
 */
export const REJECTION_CODES = {
  /** Every fault a model reply can correct; its issue codes name what to change. */
  invalidInput: 'invalid_input',
  /**
   * Consent-gate marker sharing the rejection envelope without being a rejection
   * (`isConsentGateRejection`).
   */
  actionRequired: 'action_required',
  /**
   * A proposal or scope change exceeded `ai.maxRounds` or `ai.maxTraceColumns` at admission, and no
   * approval card is opened; or a scope bundle exceeded the discovery budget, and the turn reroutes
   * to exploration entry.
   */
  overActiveScopeBudget: 'over_active_scope_budget',
  /**
   * No model reply can repair it (a handler or the engine failed, the turn lease moved on, no
   * session or project is loaded); the run ends.
   */
  backendFault: 'backend_fault',
} as const;
