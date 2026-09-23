/** Pure MissionSpec + RuntimeFrame entry routing. No natural-language interpretation lives here. */
import type { AgentExecutionTrigger } from './state';

/**
 * The initial agent execution stage derived from semantic intent and physical UI/command triggers.
 */
export type InitialAgentStage = 'discover' | 'visual_preview' | 'sm_entry';

/**
 * Derives the first tool stage from the turn's mechanical execution trigger.
 *
 * @remarks
 * Only a mechanical trigger opens SM entry: the `/trace` command, the user's SM-offer pill, or the
 * discovery budget guard cutting an oversized scope out of discovery. The semantic entry verdict
 * never selects the stage — every free-text turn, a `column_trace` verdict included, runs discovery
 * first, and reaches SM only if the guard trips there.
 *
 * @param trigger - Explicit UI or command trigger for the turn.
 * @returns The first LangGraph tool stage for the turn.
 */
export function selectInitialAgentStage(trigger: AgentExecutionTrigger): InitialAgentStage {
  if (trigger === 'preview_button') return 'visual_preview';
  if (trigger === 'slash_trace' || trigger === 'run_trace' || trigger === 'discovery_budget') return 'sm_entry';
  return 'discover';
}
