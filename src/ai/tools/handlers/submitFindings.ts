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
  COLUMN_FLOW_ENTRY_KEYS,
  COLUMN_FLOW_WRITES_TO_KEYS,
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
} from '../../tools/toolSchemas';
import { buildSmCompletionEnvelope } from '../../prompting/smPrompts';
import {
  normalizeSubmitFindingsInputIds,
  type SubmitFindingsInputObject,
} from '../../support/inputNormalization';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import {
  mapSubmitFindingsEngineGuard,
  filterSectionsForClassification,
  validateSectionsAgainstClassification,
} from '../../interaction/rules/submitFindingsRules';
import { type ToolServices, getModelNodeMap } from './toolServices';

// `declaredKeysOnly` (`inputNormalization.ts`) strips undeclared `column_flow[].*` keys inside
// `ColumnFlowEntrySchema` — silently, since it also backs `SubmitFindingsModelSchema`, the
// permissive registered union `vscodeModelPort` parses first, ahead of this handler, where no logger
// is reachable. This strip runs on the actual submit path so each drop is named
// (entry index, dropped keys); the key sets are the schema's own, so a new field cannot go missing.
function stripUndeclaredColumnFlowKeys(columnFlow: unknown[], logger: ToolServices['logger']): unknown[] {
  const dropped: string[] = [];
  const stripKeys = (rec: Record<string, unknown>, declared: ReadonlySet<string>, label: string) => {
    const surplus = Object.keys(rec).filter(key => !declared.has(key));
    if (surplus.length === 0) return rec;
    dropped.push(`${label}: ${surplus.join(', ')}`);
    return Object.fromEntries(Object.entries(rec).filter(([key]) => declared.has(key)));
  };
  const next = columnFlow.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const result = stripKeys(entry as Record<string, unknown>, COLUMN_FLOW_ENTRY_KEYS, `column_flow[${index}]`);
    const writesTo = result.writes_to;
    if (writesTo === null || typeof writesTo !== 'object' || Array.isArray(writesTo)) return result;
    return { ...result, writes_to: stripKeys(writesTo as Record<string, unknown>, COLUMN_FLOW_WRITES_TO_KEYS, `column_flow[${index}].writes_to`) };
  });
  if (dropped.length > 0) {
    logger.debug(`[submit_findings] dropped undeclared column_flow key(s): ${dropped.join('; ')}`);
  }
  return next;
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
      if (!engine) return s.logAndReturn('submit_findings', {
        error: 'no_active_session',
        hint: 'No active exploration. Call lineage_start_exploration first.',
        next_action: 'start_exploration',
      }, input);

      const rawInput: SubmitFindingsInputObject =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as SubmitFindingsInputObject
          : {};

      // Pre-Zod mode guards — fire before schema parse so the AI gets an unambiguous
      // mode-specific error rather than a generic `.strict()` failure.
      if (!engine.columnAspect && rawInput.column_flow !== undefined) {
        return s.logAndReturn('submit_findings', {
          error: REJECTION_CODES.bbFieldUnknown,
          hint: 'This session is in BB mode — `column_flow` is not accepted. Submit verdict + sections + optional route_requests/prune_neighbors.',
        }, rawInput);
      }
      // `route_requests[].columns` rides on the shared route schema BB also advertises, so a BB hop
      // can fill a field its own mode cannot read. The engine serves that hop perfectly by ignoring
      // the field, so it is dropped from a local copy and logged — never rejected. A rejection here
      // would spend a generation on a field that carries no meaning in the mode.
      let bbColumnRoutes = 0;
      let stripped: SubmitFindingsInputObject = rawInput;
      if (!engine.columnAspect && Array.isArray(rawInput.route_requests)) {
        const routes = rawInput.route_requests.map(req => {
          if (req === null || typeof req !== 'object' || Array.isArray(req) || !('columns' in req)) return req;
          bbColumnRoutes++;
          const { columns: _bbHasNoTracedColumns, ...rest } = req as Record<string, unknown>;
          return rest;
        });
        if (bbColumnRoutes > 0) {
          stripped = { ...rawInput, route_requests: routes };
          s.logger.debug(`[submit_findings] dropped route_requests[].columns on ${bbColumnRoutes} route(s): BB mode traces no columns`);
        }
      }

      // `column_flow[].*` entries are `.strict()` (`toolSchemas.ts`) and already stripped silently
      // by `declaredKeysOnly` there (needed for the pre-handler registered union). Strip here too,
      // on this local copy, so the actual submit path logs the drop instead of losing it silently.
      if (Array.isArray(stripped.column_flow)) {
        stripped = { ...stripped, column_flow: stripUndeclaredColumnFlowKeys(stripped.column_flow, s.logger) };
      }

      // Middleware: normalize identifier encodings into a local copy only. The raw model payload
      // stays immutable; strict mode-specific Zod parses the normalized copy below.
      const modelNodeMap = getModelNodeMap(s.requireModel());
      const normalized = normalizeSubmitFindingsInputIds(stripped, modelNodeMap);
      const normalizedInput = normalized.input;
      for (const event of normalized.normalizations) {
        s.logger.debug(
          `[Normalize] tool=submit_findings field=${event.field} from=${sanitizeForLog(event.from)} to=${sanitizeForLog(event.to)}`,
        );
      }

      const parsed = engine.columnAspect
        ? SubmitFindingsCtInputSchema.safeParse(normalizedInput)
        : SubmitFindingsBbInputSchema.safeParse(normalizedInput);
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
        const hint = fieldErrors.length > 0
          ? `Invalid ${modeLabel} submit_findings input — ${fieldErrors.join('; ')}.`
          : `Invalid ${modeLabel} submit_findings input: ${parsed.error.issues[0]?.message ?? 'validation failed'}. Required: focus_node_id, sections[], summary, verdict.`;
        return s.logAndReturn('submit_findings', {
          error: isCtMode ? REJECTION_CODES.ctFieldRequired : REJECTION_CODES.invalidInput,
          hint,
        }, normalizedInput);
      }

      // Hold-and-amend restores authored prose when only routing/column completeness needed a retry.
      const finding = engine.applyHeldContent(parsed.data);

      // The agreement-phase gate locks `sess.classification`. The finding's
      // sections[] must include the required angle(s); off-classification angles are
      // dropped deterministically below rather than rejected — a surplus section is
      // not a field-scoped defect the held-draft repair flow could patch.
      const violation = validateSectionsAgainstClassification(finding.sections, sess.classification, finding.verdict);
      if (violation) {
        return s.logAndReturn('submit_findings', {
          error: 'classification_lock_violation',
          hint: violation,
        }, normalizedInput);
      }
      if (finding.sections) {
        const { kept, droppedAngles } = filterSectionsForClassification(finding.sections, sess.classification);
        if (droppedAngles.length > 0) {
          s.logger.debug(`[submit_findings] dropped ${droppedAngles.length} off-classification section(s): ${droppedAngles.join(', ')} (classification=${sess.classification})`);
          finding.sections = kept;
        }
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
