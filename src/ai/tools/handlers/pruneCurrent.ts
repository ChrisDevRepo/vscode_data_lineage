import { PruneCurrentInputSchema } from '../toolSchemas';
import type { ToolServices } from './toolServices';
import { captureToolFact } from '../../support/toolValidation';
import { ingestToolInput, toolInputReceipt } from '../../support/toolIngestion';
import { acknowledgeCommittedHop, activeHopEngine } from './hopCommit';

/** Validates the reason-only command against live candidate eligibility before committing it. */
export function executePruneCurrent(input: unknown, s: ToolServices): string {
  try {
    const engine = activeHopEngine('lineage_prune_current', input, s);
    if (typeof engine === 'string') return engine;
    let focusId: string | undefined;
    const receipt = toolInputReceipt.getStore();
    const outcome = ingestToolInput({ input, schema: PruneCurrentInputSchema, context: receipt?.context ?? '',
      facts: { validated: new Map([['prune.focus', captureToolFact(PruneCurrentInputSchema.shape.focus_node_id, value => { focusId = value; })]]) },
      inspect: view => {
        const plan = engine.preparePruneCurrent(focusId);
        if ('code' in plan) { view.add(plan); return undefined; }
        if (!view.parsed.success) return undefined;
        const data = view.parsed.data;
        return () => {
          const result = engine.commitPruneCurrent(plan, data.reason);
          const diag = engine.getHopDiagnostics();
          s.logger.debug(`[Hop ${diag.hop}] focus=${diag.focus} verdict=prune agenda=${diag.agendaRemaining} tally=R${diag.tally.analyze}/P${diag.tally.passthrough}/I${diag.tally.prune}`);
          return s.logAndReturn('lineage_prune_current', acknowledgeCommittedHop(engine, s, plan.focusId, result), data);
        };
      },
    });
    return typeof outcome === 'string' ? outcome : s.logAndReturn('lineage_prune_current', outcome, input);
  } catch (err) { return s.toolError('prune_current', err); }
}
