/** Pure MissionSpec + RuntimeFrame entry routing. No natural-language interpretation lives here. */
import type { AgentExecutionTrigger } from './state';

/** The initial agent execution stage derived from semantic intent and physical UI/command triggers. */
type InitialAgentStage = 'discover' | 'visual_preview' | 'sm_entry';

/** Derives the first tool stage from the turn's mechanical execution trigger. */
export function selectInitialAgentStage(trigger: AgentExecutionTrigger): InitialAgentStage {
  if (trigger === 'preview_button') return 'visual_preview';
  if (trigger === 'slash_trace' || trigger === 'run_trace' || trigger === 'discovery_budget') return 'sm_entry';
  return 'discover';
}
