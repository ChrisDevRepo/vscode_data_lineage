/**
 * Executes active-hop submissions for the `lineage_submit_findings` tool.
 *
 * @remarks
 * The input arrives already parsed against the mode-and-classification schema the hop served (the
 * tool-attempt boundary owns that parse); engine-state rules and state-machine submission stay
 * local to this handler. Turn-lease validation and effect serialization remain in the registry
 * wrapper.
 */
import { NavigationEngine } from '../../sm/smBase';
import { sanitizeForLog } from '../../../utils/log';
import { toHopFinding, type FlatSubmitFindings } from '../../tools/toolSchemas';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import { assignEvidenceIds } from '../../tools/presentResult';
import { makeRejection } from '../../support/toolErrorEnvelope';
import {
  normalizeSubmitFindingsInputIds,
  type SubmitFindingsInputObject,
} from '../../support/inputNormalization';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { validateSectionsAgainstClassification } from '../../interaction/rules/submitFindingsRules';
import { type ToolServices, getModelNodeMap } from './toolServices';

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
        hint: 'No active exploration. Call lineage_start_exploration first.',
        detail: { next_action: 'start_exploration' },
      }), input);

      const rawInput: SubmitFindingsInputObject =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as SubmitFindingsInputObject
          : {};

      if (!engine.columnAspect && rawInput.column_flow !== undefined) {
        return s.logAndReturn('lineage_submit_findings', makeRejection({
          code: REJECTION_CODES.bbFieldUnknown,
          hint: 'This session is in BB mode — `column_flow` is not accepted. Submit verdict + sections + optional prune_neighbors/questions.',
        }), rawInput);
      }

      const modelNodeMap = getModelNodeMap(s.requireModel());
      const normalized = normalizeSubmitFindingsInputIds(rawInput, modelNodeMap);
      const normalizedInput = normalized.input;
      for (const event of normalized.normalizations) {
        s.logger.debug(
          `[Normalize] tool=submit_findings field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
        );
      }
      const flat = normalizedInput as FlatSubmitFindings;

      if (flat.verdict === 'end_branch' && (flat.summary != null || flat.sections != null)) {
        s.logger.debug(
          `[Normalize] tool=submit_findings verdict=end_branch dropped=${[flat.summary != null ? 'summary' : '', flat.sections != null ? 'sections' : ''].filter(Boolean).join(',')}`,
        );
      }
      const finding = engine.applyHeldContent(toHopFinding(flat));
      if ('code' in finding) return s.logAndReturn('lineage_submit_findings', finding, normalizedInput);

      const archivedAngles = sess.memory.getArchivedAngles(finding.focus_node_id);
      const violation = validateSectionsAgainstClassification(finding.verdict === 'end_branch' ? [] : finding.sections, sess.classification, finding.verdict, archivedAngles);
      if (violation) {
        return s.logAndReturn('lineage_submit_findings', makeRejection({
          code: REJECTION_CODES.classificationLockViolation,
          hint: violation,
        }), normalizedInput);
      }

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

      if ('done' in result && result.done && result.result) {
        sess.storeSmResult(result.result, s.turnEpoch(sess));
        const lmResult = {
          status: result.result.status,
          originNodeId: result.result.originNodeId,
          scope: { nodes: result.result.fullNodes.length, edges: result.result.edges.length },
          suggested_sections: result.result.suggested_sections,
          node_states: result.result.node_states,
          detail_slots: assignEvidenceIds(result.result.detail_slots).slots,
        };
        return s.logAndReturn('lineage_submit_findings', { ...result, result: lmResult }, normalizedInput);
      }

      const diag = engine.getHopDiagnostics();
      const ctSuffix = diag.columnEdgeCount !== undefined
        ? ` ct_edges=${diag.columnEdgeCount} cols=${diag.activeColumnCount} flow=${diag.columnFlowEntries}`
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
          sess.stateMachine?.deferredQuestions ?? [],
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
