/**
 * Executes active-hop submissions for the `lineage_submit_findings` tool.
 *
 * @remarks
 * Raw arguments are parsed once against the current hop's served contract, before id resolution
 * and internal conversion. Turn-lease validation and effect serialization remain in the registry.
 */
import { NavigationEngine } from '../../sm/smBase';
import { sanitizeForLog } from '../../../utils/log';
import { toHopFinding, submitFindingsSchemaForMode, heldSubmissionRepairHint } from '../../tools/toolSchemas';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import { makeRejection, rejectionFromZodError, zodFieldRepairHint } from '../../support/toolErrorEnvelope';
import {
  normalizeSubmitFindingsInputIds,
  type SubmitFindingsInputObject,
} from '../../support/inputNormalization';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import type { ColumnFlowEntry } from '../../sm/smTypes';
import { COLUMN_TRANSFORM_DIRECTION } from '../../../engine/shared/bridgeContract';
import { type ToolServices, getModelNodeMap } from './toolServices';

/**
 * Hop-log counters over the submitted column refs: `refs_no_note` counts refs without a `note`,
 * `role_mixed` counts refs that pair an INDIRECT class with a DIRECT one.
 *
 * @param columnFlow - The hop's submitted `column_flow`; absent yields zero counts.
 * @returns The suffix for the `[Hop N]` log line.
 */
export function columnRefSuffix(columnFlow: readonly ColumnFlowEntry[] | undefined): string {
  const refs = (columnFlow ?? []).flatMap(entry => entry.upstream_columns);
  const noNote = refs.filter(ref => !ref.note).length;
  const mixed = refs.filter(ref => {
    const rowRoles = (ref.transforms ?? []).filter(role => COLUMN_TRANSFORM_DIRECTION[role] === 'INDIRECT').length;
    return rowRoles > 0 && rowRoles < (ref.transforms ?? []).length;
  }).length;
  return ` refs=${refs.length} refs_no_note=${noNote} role_mixed=${mixed}`;
}

/**
 * Validates and submits findings for the current exploration focus.
 *
 * @param input - Raw model-supplied tool input.
 * @param s - Host capabilities for the active tool session.
 * @returns The accepted-hop result, completion envelope, or structured rejection.
 */
export function executeSubmitFindings(input: unknown, s: ToolServices): string {
    try {
      const sess = s.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) return s.logAndReturn('lineage_submit_findings', makeRejection({
        code: REJECTION_CODES.noActiveSession,
        reason: 'No exploration is active.',
      }), input);

      const focus = engine.currentFocus;
      const fresh = engine.heldFindingFocus === null && (!focus || sess.memory.getArchivedAngles(focus).size === 0);
      const schema = submitFindingsSchemaForMode(engine.currentHopAnalysisMode, sess.classification ?? undefined, fresh, engine.hopSubmitColumns, engine.heldColumnFlow);
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
        const held = engine.holdRejectedSubmission(input, rejection.issuePaths ?? []);
        if (held) rejection.hint = [zodFieldRepairHint(parsed.error, input, schema), heldSubmissionRepairHint(held)].filter(Boolean).join(' ');
        return s.logAndReturn('lineage_submit_findings', rejection, input);
      }
      const rawInput: SubmitFindingsInputObject = parsed.data;

      const model = s.requireModel();
      const modelNodeMap = getModelNodeMap(model);
      const normalized = normalizeSubmitFindingsInputIds(rawInput, modelNodeMap, model.identifierCaseSensitive);
      const normalizedInput = normalized.input;
      for (const event of normalized.normalizations) {
        s.logger.debug(
          `[Normalize] tool=submit_findings field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
        );
      }
      const flat = normalizedInput as typeof parsed.data;

      const finding = toHopFinding(flat);

      const result = engine.submitFindings(finding);
      if ('code' in result) {
        const detail = result.detail as Array<{ id?: string; reason?: string }> | undefined;
        if (Array.isArray(detail)) {
          for (const d of detail) {
            if (d.reason) s.logger.debug(`[CT] rejection: id=${d.id ?? '?'} — ${d.reason}`);
          }
        }
        return s.logAndReturn('lineage_submit_findings', result, normalizedInput);
      }

      const diag = engine.getHopDiagnostics();
      const ctSuffix = diag.columnEdgeCount !== undefined
        ? ` ct_edges=${diag.columnEdgeCount} cols=${diag.activeColumnCount} flow=${diag.columnFlowEntries}${columnRefSuffix(finding.column_flow)}`
        : '';
      s.logger.debug(
        `[Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} verdict=${diag.verdict ?? 'none'} ` +
        `detail=${diag.detailChars} summary=${diag.summaryChars} archive=${diag.archiveChars} ` +
        `routed=${diag.routedNew}/${diag.routedRejected} agenda=${diag.agendaRemaining} ` +
        `tally=R${diag.tally.analyze}/P${diag.tally.passthrough}/I${diag.tally.prune} expansions=${diag.scopeExpansions} allowed_schemas=${diag.allowedSchemaCount}${ctSuffix}`
      );

      const nextHop = engine.getHopContext();
      if (nextHop.done) {
        const finalResult = engine.getResult();
        sess.storeSmResult(finalResult, s.turnEpoch(sess));
        if (!sess.classification) throw new Error('classification missing at synthesis handoff — start_exploration contract violated');
        const envelope = buildSmCompletionEnvelope(
          finalResult,
          sess.memory.getUserQuestion(),
          model.identifierCaseSensitive,
        );
        return s.logAndReturn('lineage_submit_findings', envelope, normalizedInput);
      }
      return s.logAndReturn('lineage_submit_findings', {
        ok: true,
        done: false,
        accepted_focus: finding.focus_node_id,
        hop: nextHop.hop,
        next_focus: nextHop.focus_node?.id,
        ...(result.unaccounted_columns ? { unaccounted_columns: result.unaccounted_columns } : {}),
      }, normalizedInput);
    } catch (err) { return s.toolError('submit_findings', err); }
}
