import type { InteractionRuleResult } from '../types';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { at, makeRejection } from '../../support/toolErrorEnvelope';

/** Evaluates phase policy for a requested tool call: the fault, and the stage's tools as its allowed values (shown from feedback 2, D-105). */
export function evaluateToolPhaseRule(
  toolName: string,
  allowed: ReadonlySet<string>,
): InteractionRuleResult {
  if (allowed.has(toolName)) return null;
  return makeRejection({
    code: REJECTION_CODES.invalidInput,
    reason: `${toolName} is not available in this stage.`,
    errors: at('off_policy', [''], [...allowed]),
  });
}
