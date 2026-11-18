/**
 * Shared types for non-Zod interaction/process rule checks. Zod owns structural input validation at
 * tool boundaries; these rule helpers own phase/state-dependent constraints that static schemas
 * cannot express (engine status, focus alignment, per-round invariants).
 */
import type { ToolRejection } from '../support/toolErrorEnvelope';

/** `null` means the rule passed. */
export type InteractionRuleResult = ToolRejection | null;
