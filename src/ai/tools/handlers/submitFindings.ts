/**
 * Executes active-hop submissions for the `lineage_submit_findings` tool.
 *
 * @remarks
 * Mode-specific boundary validation and state-machine submission stay local to
 * this handler. Turn-lease validation and effect serialization remain in the
 * registry wrapper.
 */
import { NavigationEngine } from '../../sm/smBase';
import { sanitizeForLog } from '../../../utils/log';
import {
  submitFindingsSchemaForMode,
} from '../../tools/toolSchemas';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import { zodFieldRepairHint } from '../../support/toolErrorEnvelope';
import {
  normalizeSubmitFindingsInputIds,
  type SubmitFindingsInputObject,
} from '../../support/inputNormalization';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import {
  mapSubmitFindingsEngineGuard,
  validateSectionsAgainstClassification,
} from '../../interaction/rules/submitFindingsRules';
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
      if (!engine) return s.logAndReturn('submit_findings', {
        error: REJECTION_CODES.noActiveSession,
        hint: 'No active exploration. Call lineage_start_exploration first.',
        next_action: 'start_exploration',
      }, input);

      const rawInput: SubmitFindingsInputObject =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as SubmitFindingsInputObject
          : {};

      // Pre-Zod mode guard — fires before schema parse so the AI gets an unambiguous
      // mode-specific error rather than a generic `.strict()` failure.
      if (!engine.columnAspect && rawInput.column_flow !== undefined) {
        return s.logAndReturn('submit_findings', {
          error: REJECTION_CODES.bbFieldUnknown,
          hint: 'This session is in BB mode — `column_flow` is not accepted. Submit verdict + sections + optional route_requests/prune_neighbors.',
        }, rawInput);
      }
      // `route_requests[].columns` is a column-trace-only decision. BB's dispatched schema
      // (`SubmitFindingsBbInputSchema` -> `BbRouteRequestSchema`, `toolSchemas.ts`) never advertises
      // it, so a BB hop naming it anyway fails `.strict()` in the parse below and rejects through the
      // generic invalid-input path with a hint naming the field — the same treatment every other
      // unrecognized BB field gets. Nothing here rewrites the model's payload.

      // Middleware: normalize identifier encodings into a local copy only. The raw model payload
      // stays immutable; strict mode-specific Zod parses the normalized copy below.
      const modelNodeMap = getModelNodeMap(s.requireModel());
      const normalized = normalizeSubmitFindingsInputIds(rawInput, modelNodeMap);
      const normalizedInput = normalized.input;
      for (const event of normalized.normalizations) {
        s.logger.debug(
          `[Normalize] tool=submit_findings field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
        );
      }

      // Structure only. `badge_label` and `column_flow[].upstream_columns[].note` advertise their
      // cap without parsing it (`advertisedMax`, `toolSchemas.ts`); the engine enforces both ahead
      // of every mutation, so an overrun holds the draft and is repaired as one corrected field
      // instead of failing the hop. One contract for advertise and validate: this is the exact
      // schema `instructionPlan.ts` dispatched for this mode/classification (mode-and-classification
      // narrowed `sections[].angle`), not just the mode-only base — a provider that does not enforce
      // the advertised schema is still held to it here.
      const parsed = submitFindingsSchemaForMode(engine.columnAspect ? 'ct' : 'bb', sess.classification)
        .safeParse(normalizedInput);
      if (!parsed.success) {
        const isCtMode = !!engine.columnAspect;
        // Surface specific field paths so the model can correct the right field on retry.
        const seen = new Set<string>();
        const fieldErrors: string[] = [];
        for (const issue of parsed.error.issues) {
          if (issue.path.length === 0) continue;
          const key = issue.path.join('.');
          if (seen.has(key)) continue;
          seen.add(key);
          fieldErrors.push(`${key}: ${issue.message}`);
          if (fieldErrors.length >= 3) break;
        }
        const modeLabel = isCtMode ? 'CT' : 'BB';
        const summary = fieldErrors.length > 0
          ? `Invalid ${modeLabel} submit_findings input — ${fieldErrors.join('; ')}.`
          : `Invalid ${modeLabel} submit_findings input: ${parsed.error.issues[0]?.message ?? 'validation failed'}. Required: focus_node_id, sections[], summary, verdict.`;
        // The bare per-field Zod message above (e.g. "column_flow: Invalid input: expected array,
        // received undefined") never says whether the field was sent with the wrong type or omitted
        // entirely — the same envelope on a genuine omission (m17-head-azure-foundry run-T7,
        // `column_flow` x5) gives a model nothing but a byte-identical string to regenerate against.
        // Reuses the same schema-derived, field-name-agnostic chain `rejectionFromZodError` already
        // applies to every other invalid_tool_input reject, so an omitted required field states the
        // addition repair here too instead of a second, drifting implementation of the same gap.
        const repairHint = zodFieldRepairHint(parsed.error, normalizedInput);
        const hint = repairHint ? `${summary} ${repairHint}` : summary;
        return s.logAndReturn('submit_findings', {
          error: isCtMode ? REJECTION_CODES.ctFieldRequired : REJECTION_CODES.invalidInput,
          hint,
        }, normalizedInput);
      }

      // Hold-and-amend restores authored prose when only routing/column completeness or a field-scoped
      // reference needed a retry.
      const finding = engine.applyHeldContent(parsed.data);

      // The agreement-phase gate locks `sess.classification`. `submitFindingsSchemaForMode`
      // (`toolSchemas.ts`) already narrowed the dispatched `sections[].angle` enum to the angle(s)
      // this lock keeps, so an off-lock angle fails Zod parsing above and never reaches here — this
      // check only catches a locked angle the model omitted (e.g. `both` submitted business only).
      const violation = validateSectionsAgainstClassification(finding.sections, sess.classification, finding.verdict);
      if (violation) {
        return s.logAndReturn('submit_findings', {
          error: 'classification_lock_violation',
          hint: violation,
        }, normalizedInput);
      }

      const result = engine.submitFindings(finding, s.budget);
      if ('error' in result) {
        // Log each rejection reason untruncated — the detail array is buried past the 300-char JSON cap.
        const detail = (result as { detail?: Array<{ id?: string; reason?: string }> }).detail;
        if (Array.isArray(detail)) {
          for (const d of detail) {
            if (d.reason) s.logger.debug(`[CT] rejection: id=${d.id ?? '?'} — ${d.reason}`);
          }
        }

        const guardEnvelope = mapSubmitFindingsEngineGuard(result);
        if (guardEnvelope) return s.logAndReturn('submit_findings', guardEnvelope, normalizedInput);

        return s.logAndReturn('submit_findings', result, normalizedInput);
      }

      if ('done' in result && result.done && result.result) {
        sess.storeSmResult(result.result, s.turnEpoch(sess));
        const lmResult = {
          status: result.result.status,
          originNodeId: result.result.originNodeId,
          scope: { nodes: result.result.fullNodes.length, edges: result.result.edges.length },
          suggested_sections: result.result.suggested_sections,
          node_states: result.result.node_states,
          detail_slots: result.result.detail_slots,
        };
        return s.logAndReturn('submit_findings', { ...result, result: lmResult }, normalizedInput);
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
        // `classification` is a Zod-required enum on `start_exploration`, so it is always locked
        // before synthesis — a miss here means the start contract broke upstream. Hard-fail, no default.
        if (!sess.classification) throw new Error('classification missing at synthesis handoff — start_exploration contract violated');
        // Single source of truth for the synthesis evidence surface (shared with the host-graph
        // synthesis node), so the terminal tool result and synthesis call receive the same CT chain.
        const envelope = buildSmCompletionEnvelope(
          finalResult,
          sess.memory.getUserQuestion(),
          sess.stateMachine?.deferredQuestions ?? [],
        );
        return s.logAndReturn('submit_findings', envelope, normalizedInput);
      }
      // Minimal ack only: the next worker user message's <hop_context> is the single carrier of the
      // full hop payload — returning nextHop here too doubled the focus DDL+neighbors every hop.
      return s.logAndReturn('submit_findings', {
        ok: true,
        done: false,
        accepted_focus: finding.focus_node_id,
        hop: nextHop.hop,
        next_focus: nextHop.focus_node?.id,
      }, normalizedInput);
    } catch (err) { return s.toolError('submit_findings', err); }
}
