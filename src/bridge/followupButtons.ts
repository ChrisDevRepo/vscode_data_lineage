import { NEXT_QUESTIONS_TRIGGER, RUN_TRACE_TRIGGER, SHOW_FULL_DESCRIPTION_TRIGGER } from '../ai/prompting/prompts';
import type { AiSession } from '../ai/session/session';

/** One follow-up button of the chat panel: the label the user sees and the prompt a click sends as the next user turn. */
export interface FollowupButton { label: string; prompt: string }

/** The follow-up buttons the session offers as it stands; none while a gate is pending. The chat controller adds the running-turn case. */
export function followupButtons(session: AiSession): FollowupButton[] {
  if (session.phase.kind === 'awaiting_gate') return [];
  return [
    ...(session.phase.kind === 'completed' ? [{ label: 'Next questions and related objects', prompt: NEXT_QUESTIONS_TRIGGER }] : []),
    ...(session.lastPresentResultDescription ? [{ label: 'Show full description', prompt: SHOW_FULL_DESCRIPTION_TRIGGER }] : []),
    ...(session.smOfferAvailable() ? [{ label: 'Start deeper hop-by-hop analysis', prompt: RUN_TRACE_TRIGGER }] : []),
  ];
}
