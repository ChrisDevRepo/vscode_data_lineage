import type { NavigationEngine } from '../../sm/smBase';
import type { SubmitResult } from '../../sm/smTypes';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import { at, makeRejection } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import type { ToolServices } from './toolServices';

/** A hop commit command's tool name. */
type HopCommitTool = 'lineage_submit_findings' | 'lineage_prune_current';

/** Resolves the active engine without changing the command payload before schema validation. */
export function prepareHopCommit(tool: HopCommitTool, input: unknown, s: ToolServices): { engine: NavigationEngine; input: unknown } | string {
  const engine = s.getSession().stateMachine as NavigationEngine | null;
  if (!engine) return s.logAndReturn(tool, makeRejection({ code: REJECTION_CODES.noActiveSession, reason: 'No exploration is active.', errors: at('no_session') }), input);
  return { engine, input };
}

/** Advances one committed hop and returns the shared acknowledgement or synthesis handoff. */
export function acknowledgeCommittedHop(
  engine: NavigationEngine,
  s: ToolServices,
  focusNodeId: string,
  result: Extract<SubmitResult, { ok: true }>,
): object {
  const nextHop = engine.getHopContext();
  const ack = { ...result, ...engine.commitRemovals };
  if (!nextHop.done) return {
    ...ack,
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
    ...ack,
    ...buildSmCompletionEnvelope(finalResult, sess.memory.getUserQuestion(), s.requireModel().identifierCaseSensitive, engine.deferredQuestions),
  };
}
