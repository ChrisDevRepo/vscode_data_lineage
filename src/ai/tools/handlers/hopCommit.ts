import type { NavigationEngine } from '../../sm/smBase';
import type { SubmitResult } from '../../sm/smTypes';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import type { ToolServices } from './toolServices';

/** Advances one committed hop and returns the shared acknowledgement or synthesis handoff. */
export function acknowledgeCommittedHop(
  engine: NavigationEngine,
  s: ToolServices,
  focusNodeId: string,
  result: Extract<SubmitResult, { ok: true }>,
): object {
  const nextHop = engine.getHopContext();
  if (!nextHop.done) return {
    ...result,
    done: false,
    accepted_focus: focusNodeId,
    hop: nextHop.hop,
    next_focus: nextHop.focus_node?.id,
  };
  const sess = s.getSession();
  const finalResult = engine.getResult();
  sess.storeSmResult(finalResult, s.turnEpoch(sess));
  if (!sess.classification) throw new Error('classification missing at synthesis handoff — start_exploration contract violated');
  return {
    ...result,
    ...buildSmCompletionEnvelope(finalResult, sess.memory.getUserQuestion(), s.requireModel().identifierCaseSensitive),
  };
}
