import type { NavigationEngine } from '../../sm/smBase';
import { PruneCurrentInputSchema } from '../toolSchemas';
import { normalizeSubmitFindingsInputIds, type SubmitFindingsInputObject } from '../../support/inputNormalization';
import { makeRejection, rejectionFromZodError } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { sanitizeForLog } from '../../../utils/log';
import { getModelNodeMap, type ToolServices } from './toolServices';
import { acknowledgeCommittedHop } from './hopCommit';

/** Validates the reason-only command against live candidate eligibility before committing it. */
export function executePruneCurrent(input: unknown, s: ToolServices): string {
  try {
    const engine = s.getSession().stateMachine as NavigationEngine | null;
    if (!engine) return s.logAndReturn('lineage_prune_current', makeRejection({
      code: REJECTION_CODES.noActiveSession,
      reason: 'No exploration is active.',
    }), input);
    const model = s.requireModel();
    const normalized = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? normalizeSubmitFindingsInputIds(input as SubmitFindingsInputObject, getModelNodeMap(model), model.identifierCaseSensitive)
      : { input, normalizations: [] };
    for (const event of normalized.normalizations) s.logger.debug(
      `[Normalize] tool=prune_current field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
    );
    const parsed = PruneCurrentInputSchema.safeParse(normalized.input);
    if (!parsed.success) return s.logAndReturn('lineage_prune_current', rejectionFromZodError(parsed.error, {
      code: REJECTION_CODES.invalidInput, input: normalized.input, schema: PruneCurrentInputSchema,
    }), normalized.input);
    const result = engine.pruneCurrent(parsed.data.focus_node_id, parsed.data.reason);
    if ('code' in result) return s.logAndReturn('lineage_prune_current', result, parsed.data);
    const diag = engine.getHopDiagnostics();
    s.logger.debug(`[Hop ${diag.hop}] focus=${diag.focus} verdict=prune agenda=${diag.agendaRemaining} tally=R${diag.tally.analyze}/P${diag.tally.passthrough}/I${diag.tally.prune}`);
    return s.logAndReturn('lineage_prune_current', acknowledgeCommittedHop(engine, s, parsed.data.focus_node_id, result), parsed.data);
  } catch (err) { return s.toolError('prune_current', err); }
}
