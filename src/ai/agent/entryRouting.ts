/** Pure MissionSpec + RuntimeFrame entry routing. No natural-language interpretation lives here. */
import type { AgentEntryRoute, AgentExecutionTrigger } from './state';

/**
 * The initial agent execution stage derived from semantic intent and physical UI/command triggers.
 */
export type InitialAgentStage = 'discover' | 'visual_preview' | 'sm_entry';

/**
 * Derives the first tool stage from semantic intent and a mechanical execution trigger.
 *
 * @param entry - Zod-validated semantic route selected by the model.
 * @param trigger - Explicit UI or command trigger for the turn.
 * @returns The first LangGraph tool stage for the turn.
 */
export function selectInitialAgentStage(
  entry: AgentEntryRoute,
  trigger: AgentExecutionTrigger,
): InitialAgentStage {
  if (trigger === 'preview_button') return 'visual_preview';
  if (trigger === 'slash_trace' || trigger === 'run_trace' || trigger === 'discovery_budget') return 'sm_entry';
  if (entry === 'column_trace') return 'sm_entry';
  if (entry === 'visual_render') return 'sm_entry';
  return 'discover';
}
