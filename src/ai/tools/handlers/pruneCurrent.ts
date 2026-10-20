import { PruneCurrentInputSchema } from '../toolSchemas';
import { rejectionFromZodError } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import type { ToolServices } from './toolServices';
import { acknowledgeCommittedHop, prepareHopCommit } from './hopCommit';

/** Validates the reason-only command against live candidate eligibility before committing it. */
export function executePruneCurrent(input: unknown, s: ToolServices): string {
  try {
    const prepared = prepareHopCommit('lineage_prune_current', input, s);
    if (typeof prepared === 'string') return prepared;
    const { engine } = prepared;
    const parsed = PruneCurrentInputSchema.safeParse(prepared.input);
    if (!parsed.success) return s.logAndReturn('lineage_prune_current', rejectionFromZodError(parsed.error, {
      code: REJECTION_CODES.invalidInput, input: prepared.input, schema: PruneCurrentInputSchema,
    }), prepared.input);
    const focus = engine.currentFocus!;
    const result = engine.pruneCurrent(parsed.data.focus_node_id, parsed.data.reason);
    if ('code' in result) return s.logAndReturn('lineage_prune_current', result, parsed.data);
    const diag = engine.getHopDiagnostics();
    s.logger.debug(`[Hop ${diag.hop}] focus=${diag.focus} verdict=prune agenda=${diag.agendaRemaining} tally=R${diag.tally.analyze}/P${diag.tally.passthrough}/I${diag.tally.prune}`);
    return s.logAndReturn('lineage_prune_current', acknowledgeCommittedHop(engine, s, focus, result), parsed.data);
  } catch (err) { return s.toolError('prune_current', err); }
}
