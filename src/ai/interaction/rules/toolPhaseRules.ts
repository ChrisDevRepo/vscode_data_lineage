import type { LmStage } from '../../tools/toolPolicy';
import type { InteractionRuleResult } from '../types';
import { REJECTION_CODES } from '../../support/rejectionCodes';

/**
 * Tool-specific routing hint for off-policy responses.
 */
function offPolicyHint(toolName: string, stage: LmStage): string {
  if (stage.kind !== 'active') return 'Wait for the appropriate phase or call a different tool.';
  switch (toolName) {
    case 'lineage_search_objects':
    case 'lineage_search_ddl':
    case 'lineage_get_object_detail':
    case 'lineage_get_scope_bundle':
    case 'lineage_get_context':
    case 'lineage_get_screen_state':
    case 'lineage_detect_graph_patterns':
      return 'Use route_requests with nodeIds taken verbatim from the prior submit_findings result\'s neighbors[] / next_hop. The agenda is delivered explicitly - searching mid-hop is unnecessary.';
    case 'lineage_start_exploration':
      return 'Exploration is already in progress. Continue the agenda via submit_findings.';
    case 'lineage_present_result':
      return 'present_result is the synthesis-phase tool. Drain the agenda first; the engine emits the synthesis trigger when ready.';
    default:
      return 'Continue with submit_findings on the current focus node.';
  }
}

/**
 * Evaluates phase policy for a requested tool call.
 *
 * @param toolName - The name of the requested tool.
 * @param stage - The current LM stage.
 * @param allowed - Set of allowed tool names for the stage.
 * @returns A rule result error if the tool is off-policy, otherwise null.
 */
export function evaluateToolPhaseRule(
  toolName: string,
  stage: LmStage,
  allowed: ReadonlySet<string>,
): InteractionRuleResult {
  if (allowed.has(toolName)) return null;
  const stageLabel = stage.kind === 'active' ? `active(${stage.mode})` : stage.kind;
  return {
    error: REJECTION_CODES.offPolicy,
    hint: `Tool ${toolName.replace('lineage_', '')} is not available in stage ${stageLabel}. Allowed tools this stage: ${[...allowed].map(n => n.replace('lineage_', '')).join(', ')}. ${offPolicyHint(toolName, stage)}`,
  };
}
