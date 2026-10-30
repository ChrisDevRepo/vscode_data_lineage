/** Executes active-hop submissions for the `lineage_submit_findings` tool. */
import type { ColumnEdge } from '../../sm/smTypes';
import { COLUMN_TRANSFORM_DIRECTION } from '../../../engine/shared/bridgeContract';
import type { ToolServices } from './toolServices';
import { acknowledgeCommittedHop, activeHopEngine } from './hopCommit';

/** Hop-log counters over committed column refs, including held flow: missing notes and mixed INDIRECT/DIRECT classes. */
function columnRefSuffix(columnRefs: readonly Pick<ColumnEdge, 'transforms' | 'note'>[] | undefined): string {
  const refs = columnRefs ?? [];
  const noNote = refs.filter(ref => !ref.note).length;
  const mixed = refs.filter(ref => {
    const rowRoles = (ref.transforms ?? []).filter(role => COLUMN_TRANSFORM_DIRECTION[role] === 'INDIRECT').length;
    return rowRoles > 0 && rowRoles < (ref.transforms ?? []).length;
  }).length;
  return ` refs=${refs.length} refs_no_note=${noNote} role_mixed=${mixed}`;
}

/** Validates and submits findings for the current exploration focus. */
export function executeSubmitFindings(input: unknown, s: ToolServices): string {
    try {
      const engine = activeHopEngine('lineage_submit_findings', input, s);
      if (typeof engine === 'string') return engine;
      const focus = engine.currentFocus;
      const result = engine.submitModelFindings(input);
      if ('code' in result) {
        const detail = result.detail as Array<{ id?: string; reason?: string }> | undefined;
        if (Array.isArray(detail)) {
          for (const d of detail) {
            if (d.reason) s.logger.debug(`[CT] rejection: id=${d.id ?? '?'} — ${d.reason}`);
          }
        }
        return s.logAndReturn('lineage_submit_findings', result, input);
      }

      const diag = engine.getHopDiagnostics();
      const ctSuffix = diag.columnEdgeCount !== undefined
        ? ` ct_edges=${diag.columnEdgeCount} cols=${diag.activeColumnCount} flow=${diag.columnFlowEntries}${columnRefSuffix(engine.columnAspect?.edges.filter(edge => edge.hop === diag.hop && edge.hop_node === focus))}`
        : '';
      s.logger.debug(
        `[Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} verdict=${diag.verdict ?? 'none'} ` +
        `detail=${diag.detailChars} summary=${diag.summaryChars} archive=${diag.archiveChars} ` +
        `routed=${diag.routedNew}/${diag.routedRejected} agenda=${diag.agendaRemaining} ` +
        `tally=R${diag.tally.analyze}/P${diag.tally.passthrough}/I${diag.tally.prune} expansions=${diag.scopeExpansions} allowed_schemas=${diag.allowedSchemaCount}${ctSuffix}`
      );

      return s.logAndReturn('lineage_submit_findings', acknowledgeCommittedHop(engine, s, focus!, result), input);
    } catch (err) { return s.toolError('submit_findings', err); }
}
