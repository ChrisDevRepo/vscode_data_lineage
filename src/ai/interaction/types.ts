/** Shared types for non-Zod interaction/process rule checks. */
import type { ToolRejection } from '../support/toolErrorEnvelope';

/** `null` means the rule passed. */
export type InteractionRuleResult = ToolRejection | null;
