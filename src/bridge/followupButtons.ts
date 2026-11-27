import { buildRunTracePrompt, NEXT_QUESTIONS_TRIGGER, SHOW_FULL_DESCRIPTION_TRIGGER } from '../ai/prompting/prompts';
import type { AiSession } from '../ai/session/session';
import type { ChatFollowup } from '../engine/shared/chatContract';

const RUN_TRACE_BUTTON = { label: 'Start deeper hop-by-hop analysis', prompt: 'Run trace' };
const runTraceOfferId = (session: AiSession): string => `${session.id}:${session.turnEpoch}`;

/** The follow-up buttons the session offers as it stands; none while a gate is pending. The chat controller adds the running-turn case. */
export function followupButtons(session: AiSession): ChatFollowup[] {
  if (session.phase.kind === 'awaiting_gate') return [];
  return [
    ...(session.phase.kind === 'completed' ? [{ label: 'Next questions and related objects', prompt: NEXT_QUESTIONS_TRIGGER }] : []),
    ...(session.lastPresentResultDescription ? [{ label: 'Show full description', prompt: SHOW_FULL_DESCRIPTION_TRIGGER }] : []),
    ...(session.smOfferAvailable() ? [{ ...RUN_TRACE_BUTTON, offerId: runTraceOfferId(session) }] : []),
  ];
}

/** Resolves the explicit deeper-analysis action against the session's current discovery offer. */
export function runTraceRequest(session: AiSession, offerId: string) {
  if (!session.smOfferAvailable() || offerId !== runTraceOfferId(session)) return undefined;
  return {
    request: {
      prompt: buildRunTracePrompt(session.lastDiscoveryQuestion, session.lastDiscoveryAnswer),
      executionTrigger: 'run_trace' as const,
    },
    text: RUN_TRACE_BUTTON.prompt,
  };
}
