import type { NavigationEngine } from '../../sm/smBase';
import type { SubmitResult } from '../../sm/smTypes';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import { normalizeSubmitFindingsInputIds } from '../../support/inputNormalization';
import { makeRejection } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { sanitizeForLog } from '../../../utils/log';
import { getModelNodeMap, type ToolServices } from './toolServices';

/** A hop commit command's tool name. */
type HopCommitTool = 'lineage_submit_findings' | 'lineage_prune_current';

/**
 * Resolves the active engine and normalizes known identity encodings in a hop commit command's
 * raw input, before the command's own schema parses it.
 *
 * @returns The engine and normalized input, or the logged `no_active_session` result.
 */
export function prepareHopCommit(tool: HopCommitTool, input: unknown, s: ToolServices): { engine: NavigationEngine; input: unknown } | string {
  const engine = s.getSession().stateMachine as NavigationEngine | null;
  if (!engine) return s.logAndReturn(tool, makeRejection({ code: REJECTION_CODES.noActiveSession, reason: 'No exploration is active.' }), input);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { engine, input };
  const model = s.requireModel();
  const normalized = normalizeSubmitFindingsInputIds({ ...input }, getModelNodeMap(model), model.identifierCaseSensitive);
  for (const event of normalized.normalizations) s.logger.debug(
    `[Normalize] tool=${tool.replace(/^lineage_/, '')} field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
  );
  return { engine, input: normalized.input };
}

/**
 * Advances one committed hop and returns the shared acknowledgement or synthesis handoff.
 *
 * @remarks
 * The acknowledgement's `pruned` / `cut_ids` are read after the advance, so a pending neighbor
 * prune resolved when the agenda empties is reported with the commit that ended the walk.
 */
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
    ...buildSmCompletionEnvelope(finalResult, sess.memory.getUserQuestion(), s.requireModel().identifierCaseSensitive),
  };
}
