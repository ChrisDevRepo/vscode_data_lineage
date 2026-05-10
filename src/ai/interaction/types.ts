/**
 * Shared types for non-Zod interaction/process rule checks.
 *
 * @remarks
 * Zod owns structural input validation at tool boundaries. These rule helpers
 * own phase/state-dependent constraints that cannot be expressed as static
 * schemas (engine status, focus alignment, per-round invariants).
 */
export type InteractionRuleFailure = {
  error: string;
  hint: string;
  next_action?: string;
  [key: string]: unknown;
};

/** `null` means the rule passed. */
export type InteractionRuleResult = InteractionRuleFailure | null;

