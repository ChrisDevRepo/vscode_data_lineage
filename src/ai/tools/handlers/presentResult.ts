/**
 * Executes validation, assembly, and persistence for `lineage_present_result`.
 *
 * @remarks
 * Provider-neutral validation and assembly helpers remain in the sibling
 * `presentResult.ts`; this handler owns session persistence and the validated
 * webview effect. Turn-lease validation and effect serialization remain in the
 * registry wrapper.
 */
import { type AiSession } from '../../session/session';
import { trunc, sanitizeForLog } from '../../../utils/log';
import {
  validatePresentResult, orderAndAssemble, findDisconnectedViewNodes,
  findBareNonPrunedNodes,
  isRepairablePresentResultFailure,
  discoveryPreviewNarrative,
  mergePresentResultRepairPatch,
  stripUnchangedRepairEnvelopeKeys,
  findDiscoveryPreviewReuseViolations,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultStage,
} from '../../tools/presentResult';
import {
  PresentResultBoundarySchema,
  PRESENT_RESULT_NAME_MAX,
  presentResultRepairPatchSchemaForFields,
} from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { coercedBoolean, resolveModelNodeId, resolveModelNodeIds } from '../../support/inputNormalization';
import { readToolError } from '../../support/toolErrorEnvelope';
import { quoteIds } from '../../support/text';
import { evaluatePresentResultPreconditionsRule } from '../../interaction/rules/presentResultRules';
import { postToWebview } from '../../../bridge/host';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';

function findMissingCtTerminalSources(
  resultGraph: AiSession['resultGraph'],
  input: PresentResultInput,
  resolvedNodeIds: string[],
): string[] {
  const edges = resultGraph?.columnAspect?.edges ?? [];
  if (edges.length === 0) return [];
  const toNodes = new Set(edges.map(e => e.to_node));
  const terminalSources = Array.from(new Set(edges.map(e => e.from_node)))
    .filter(id => !toNodes.has(id) && resolvedNodeIds.includes(id));
  if (terminalSources.length === 0) return [];

  const linked = new Set<string>();
  for (const sec of input.sections ?? []) {
    for (const id of sec.node_ids ?? []) linked.add(id);
  }
  for (const group of input.highlight_groups ?? []) {
    if (group.color !== 'source') continue;
    for (const id of group.node_ids ?? []) linked.add(id);
  }
  return terminalSources.filter(id => !linked.has(id));
}

function notePresentResultFailure(sess: AiSession, token: number, data: object): void {
  const rejection = readToolError(data);
  if (!rejection) return;
  const reason = rejection.hint
    ? `${rejection.reason} (${rejection.hint})`
    : rejection.reason;
  sess.recordPresentResultFailure(token, trunc(sanitizeForLog(reason), 240));
}

/**
 * Builds and persists the final lineage presentation for the active turn.
 *
 * @param input - Raw model-supplied tool input.
 * @param s - Host capabilities for the active tool session.
 * @returns The successful view summary or a structured validation rejection.
 */
export async function executePresentResult(input: unknown, s: ToolServices): Promise<string> {
    try {
      const sess = s.getSession();
      const rawInput = input;
      const turnEpoch = s.turnEpoch(sess);
      const attemptWrite = sess.beginPresentResultAttempt(turnEpoch);
      if (attemptWrite.kind !== 'accepted') {
        return s.logAndReturn('present_result', {
          error: 'stale_turn',
          hint: 'The turn no longer owns this session. Do not render this result.',
        }, rawInput);
      }
      const model = s.requireModel();
      const isVisualPreview = sess.activeLmStage?.kind === 'visual_preview';
      const previewNarrative = isVisualPreview && sess.lastDiscoveryAnswer
        ? discoveryPreviewNarrative(sess.lastDiscoveryAnswer)
        : null;

      // One reject funnel for every uniform failure exit: session-note + logged return, optionally
      // dropping the held repair draft first. The two draft-HOLDING rejects below (CT terminal
      // sources, repairable validation) intentionally bypass this — they preserve the draft.
      const reject = (failure: object, opts: { clearDraft?: boolean } = {}): string => {
        if (opts.clearDraft) sess.presentResultRepairDraft.clear();
        notePresentResultFailure(sess, turnEpoch, failure);
        return s.logAndReturn('present_result', failure, rawInput);
      };

      // L1 encoding-only: unwrap a JSON-string-encoded is_update before the pre-Zod repair gate,
      // matching the advertised coercedBoolean() contract (known local-model string-encoding class).
      const rawIsUpdate = typeof input === 'object' && input !== null
        ? (input as { is_update?: unknown }).is_update
        : undefined;
      const coercedIsUpdate = coercedBoolean().safeParse(rawIsUpdate);
      if (coercedIsUpdate.success && typeof rawIsUpdate === 'string') {
        input = { ...(input as Record<string, unknown>), is_update: coercedIsUpdate.data };
        s.logger.debug(`presentResult normalization: is_update "${rawIsUpdate}" → ${coercedIsUpdate.data} (string-encoded boolean unwrapped)`);
      }
      const requestedRepair = coercedIsUpdate.success && coercedIsUpdate.data === true;

      if (isVisualPreview && !sess.presentResultRepairDraft.hasRepairableDraft()) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
          ? sess.discoveryScopeArtifact
          : null;
        if (!previewNarrative || !scope) {
          return reject({
            error: 'preview_source_unavailable',
            hint: 'Run the discovery question again, then request its graph preview.',
          }, { clearDraft: true });
        }
        input = {
          ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
          name: `${scope.origin} graph preview`.slice(0, PRESENT_RESULT_NAME_MAX),
          summary: previewNarrative.summary,
          title: previewNarrative.title,
        };
      }

      if (sess.presentResultRepairDraft.hasRepairableDraft()) {
        // Declared default (R009 middleware contract): while a repairable draft is held the projected
        // schema IS the repair patch, so any present_result in this state is a repair. is_update is a
        // redundant authorization echo the engine backfills — not a value every model must emit — and it
        // does not drive isAmendment during synthesis (that needs the completed phase).
        if (coercedIsUpdate.data !== true) {
          input = { ...(input as Record<string, unknown>), is_update: true };
          s.logger.debug('presentResult normalization: repairable draft held — is_update defaulted to true (declared authorization backfill)');
        }
        const allowedFields = sess.presentResultRepairDraft.getAuthorization();
        if (!allowedFields?.length) {
          return reject({
            success: false,
            errors: ['Held present_result repair authorization is missing.'],
            hint: 'Call lineage_present_result again with the full required payload.',
          }, { clearDraft: true });
        }
        // L1 encoding-only (Guard Discipline layer 1): a repair-turn model that cannot see its own
        // held draft tends to blindly re-send the FULL prior envelope rather than a scoped patch.
        // Drop only the unauthorized keys whose resent value is structurally unchanged; a genuinely
        // differing value stays in place so the strict patch schema below still rejects it.
        const heldDraftForStrip = sess.presentResultRepairDraft.get();
        if (heldDraftForStrip && input && typeof input === 'object' && !Array.isArray(input)) {
          const { input: strippedInput, stripped } = stripUnchangedRepairEnvelopeKeys(
            input as Record<string, unknown>, heldDraftForStrip, allowedFields,
          );
          if (stripped.length) {
            input = strippedInput;
            for (const key of stripped) {
              s.logger.debug(`[AI] repair patch: stripped unchanged envelope key ${key}`);
            }
          }
        }
        const patch = presentResultRepairPatchSchemaForFields(allowedFields).safeParse(input);
        if (!patch.success) {
          const fieldErrors = patch.error.issues.slice(0, 3)
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
          return reject({
            success: false,
            errors: fieldErrors,
            hint: `Invalid present_result repair patch. Send only is_update:true plus these authorized fields: ${allowedFields.join(', ')}.`,
          });
        }
        const merged = sess.presentResultRepairDraft.merge(
          patch.data,
          (draft, repairPatch) => mergePresentResultRepairPatch(draft, repairPatch, allowedFields),
        );
        if (!merged) {
          return reject({
            success: false,
            errors: ['No held present_result draft is available for repair.'],
            hint: 'Call lineage_present_result with the full required payload.',
          });
        }
        input = merged;
      } else if (sess.phase.kind === 'exploring' && requestedRepair) {
        return reject({
          error: 'invalid_input',
          hint: 'is_update:true is accepted during synthesis only for a session-authorized held repair draft. Send the full new-render payload without is_update.',
        }, { clearDraft: true });
      }

      // Zod at the boundary: the advertised structural contract IS the runtime contract.
      // A type/enum/cap violation rejects with field paths the model can self-heal from —
      // never silently nulled fields. Conditional rules stay in validatePresentResult.
      const boundary = PresentResultBoundarySchema.safeParse(input);
      if (!boundary.success) {
        const fieldErrors = boundary.error.issues.slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
        return reject({
          success: false,
          errors: fieldErrors,
          hint: 'Fix the listed fields and call lineage_present_result again with the corrected content.',
        }, { clearDraft: true });
      }
      const presentInput = boundary.data as PresentResultInput;

      // Only Completed Phase has an existing committed render to amend. A held synthesis draft has
      // never committed, so its merged repair must pass the complete fresh-render validation contract
      // (including non-empty highlight_groups) before the one atomic commit.
      const isAmendment = !isVisualPreview && sess.phase.kind === 'completed' && presentInput.is_update === true;

      if (isVisualPreview || sess.phase.kind !== 'completed') {
        const hasAdd = presentInput.add_node_ids && presentInput.add_node_ids.length > 0;
        const hasPrune = presentInput.prune_node_ids && presentInput.prune_node_ids.length > 0;
        if (hasAdd || hasPrune) {
          return reject({
            error: 'invalid_input',
            hint: 'Graph structure is locked during an initial presentation. add_node_ids and prune_node_ids are strictly forbidden. Only provide sections, notes, and highlights.',
          }, { clearDraft: true });
        }
      }

      const previewScope = isVisualPreview && sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
        ? sess.discoveryScopeArtifact
        : null;
      const previewGraph: ResultGraph | null = previewScope ? {
        nodeIds: [...previewScope.nodeIds],
        edges: [...previewScope.edges],
        source: 'discovery_preview',
        originNodeId: previewScope.origin,
      } : null;
      const resultGraph = previewGraph ?? sess.resultGraph;
      if (!resultGraph) {
        return reject(evaluatePresentResultPreconditionsRule(false)!, { clearDraft: true });
      }

      let resolvedNodeIds: string[] = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      const modelNodeMap = getModelNodeMap(model);

      if (Array.isArray(presentInput.sections) && presentInput.sections.length > 0) {
        presentInput.sections = presentInput.sections.map((sec) => {
          if (!Array.isArray(sec.node_ids) || sec.node_ids.length === 0) return sec;
          const normalizedNodeIds = sec.node_ids.map((id) => resolveModelNodeId(id, modelNodeMap) ?? id);
          return { ...sec, node_ids: normalizedNodeIds };
        });
      }
      if (Array.isArray(presentInput.notes) && presentInput.notes.length > 0) {
        presentInput.notes = presentInput.notes.map(note => ({
          ...note,
          node_id: resolveModelNodeId(note.node_id, modelNodeMap) ?? note.node_id,
        }));
      }
      if (Array.isArray(presentInput.highlight_groups) && presentInput.highlight_groups.length > 0) {
        presentInput.highlight_groups = presentInput.highlight_groups.map(group => ({
          ...group,
          node_ids: group.node_ids.map(id => resolveModelNodeId(id, modelNodeMap) ?? id),
        }));
      }

      if (!isVisualPreview && sess.phase.kind === 'completed' && presentInput.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const addResolution = resolveModelNodeIds(presentInput.add_node_ids, modelNodeMap);
        if (addResolution.unresolved.length > 0) {
          return reject({
            success: false,
            errors: [
              `Unknown add_node_ids after bracket/case normalization: ${quoteIds(addResolution.unresolved)}.`,
              'Use lineage_search_objects to resolve canonical IDs, then retry present_result.',
            ],
          }, { clearDraft: true });
        }
        const toAdd = addResolution.resolved.filter(id => !currentSet.has(id));
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);
      }

      if (!isVisualPreview && sess.phase.kind === 'completed' && presentInput.prune_node_ids?.length) {
        const pruneResolution = resolveModelNodeIds(presentInput.prune_node_ids, modelNodeMap);
        if (pruneResolution.unresolved.length > 0) {
          return reject({
            success: false,
            errors: [
              `Unknown prune_node_ids after bracket/case normalization: ${quoteIds(pruneResolution.unresolved)}.`,
              'Use lineage_search_objects to resolve canonical IDs, then retry present_result.',
            ],
          }, { clearDraft: true });
        }
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, pruneResolution.resolved);
        resolvedNodeIds = pruned.nodeIds;
        resolvedEdges = pruned.edges;
      }

      // Closed-graph invariant: completed-phase add/prune edits must keep every
      // node connected to the original origin node in the rendered view.
      if (resultGraph.originNodeId) {
        const disconnected = findDisconnectedViewNodes(resolvedNodeIds, resolvedEdges, resultGraph.originNodeId);
        if (disconnected.length > 0) {
          return reject({
            success: false,
            errors: [
              `Closed-graph invariant failed: ${quoteIds(disconnected, 5)} ${disconnected.length === 1 ? 'is' : 'are'} disconnected from origin \`${resultGraph.originNodeId}\`.`,
              'Adjust add_node_ids / prune_node_ids so the view remains connected from the starting node.',
            ],
          }, { clearDraft: true });
        }
      }

      s.logger.debug(`presentResult section[0] preview: ${trunc(presentInput.sections?.[0]?.text ?? '(empty)', 200)}`);

      // Bare-by-choice is a permitted AI decision (prompt contract: nodes left out of both preview
      // surfaces stay bare) — observe and log, never re-link. Bare nodes still render via resolvedNodeIds.
      const bareNodeIds = findBareNonPrunedNodes(resultGraph, presentInput, resolvedNodeIds);
      if (bareNodeIds.length > 0) {
        s.logger.debug(`[Presentation] ${bareNodeIds.length} non-pruned node(s) left bare by the AI (rendered unlabeled/uncolored) — ${trunc(bareNodeIds.join(', '), 200)}`);
      }

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (presentInput.sections?.length) {
        const nodeMap = getModelNodeMap(model);
        const assembled = orderAndAssemble(presentInput.sections, { title: presentInput.title, intro: presentInput.intro, closing: presentInput.closing, nodeMap });
        assembledBadges = assembled.badges;
        assembledDescription = assembled.description;
      }

      s.logger.info(
        `[Presentation] Output assembled — title="${trunc(presentInput.title ?? '(none)', 60)}" sections=${presentInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount}`
      );

      // Checks that need context validatePresentResult does not hold — the cached discovery answer
      // and the result graph. They are findings, not verdicts: reporting them through the shared
      // accumulator is what lets a payload that breaks one of these AND a structural rule be told
      // both at once. Each defect class reported on its own round costs its own semantic-failure
      // charge, and three charges end the phase.
      const externalViolations: PresentResultViolation[] = [];
      if (isVisualPreview && previewNarrative) {
        externalViolations.push(...findDiscoveryPreviewReuseViolations(previewNarrative.body, presentInput));
      }
      const missingTerminalSources = findMissingCtTerminalSources(resultGraph, presentInput, resolvedNodeIds);
      if (missingTerminalSources.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `CT terminal source node(s) missing from final presentation: ${quoteIds(missingTerminalSources, 5)}.`,
            'Link them in sections[].node_ids or include them in highlight_groups[] with color:"source". Tables can be source nodes even when they have no detail slot.',
          ],
          repairFields: ['sections', 'highlight_groups'],
          paths: ['sections', 'highlight_groups'],
          soleHint: 'Fix CT source presentation only. Keep existing section text where possible; add the terminal source table(s) to the source section or source highlight group.',
        });
      }

      // Mirrors the toolPolicy.ts stage gate this same handler already branches on above
      // (isVisualPreview / sess.phase.kind === 'completed'): visual_preview and synthesis never
      // expose lineage_search_objects, so the unknown-node-id repair hint must not name it there.
      const presentResultStage: PresentResultStage = isVisualPreview
        ? 'visual_preview'
        : sess.phase.kind === 'completed'
        ? 'completed'
        : 'synthesis';
      const validation = validatePresentResult(presentInput, resolvedNodeIds, assembledBadges, assembledDescription, isAmendment, externalViolations, presentResultStage);

      if (!validation.success) {
        if (isRepairablePresentResultFailure(validation)) {
          sess.presentResultRepairDraft.hold(presentInput, validation.repairFields);
          validation.hint = `${validation.hint} You may repair the held draft by calling lineage_present_result with is_update:true and only these corrected fields: ${validation.repairFields.join(', ')}.`;
        } else {
          sess.presentResultRepairDraft.clear();
        }
        notePresentResultFailure(sess, turnEpoch, validation);
        return s.logAndReturn('present_result', validation, rawInput);
      }

      const aiMetadata: PresentationArtifact['aiMetadata'] = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName ?? 'unknown',
        runId: sess.id,
        highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
        badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
        notes: validation.notes.map(n => ({ nodeId: n.node_id, text: n.text })),
        layoutDirection: validation.layout_direction,
        ...(resultGraph.columnAspect ? {
          columnAspect: {
            edges: resultGraph.columnAspect.edges.map(e => ({
              hopNode:  e.hop_node,
              fromNode: e.from_node,
              toNode:   e.to_node,
              fromCol:  e.from_col,
              toCol:    e.to_col,
            })),
          },
          // Every node the column edges reference needs a verdict, hop nodes included — a hop that
          // is not itself an answer node still decides whether its lines read as a transformation.
          // Compared case-insensitively: node ids reach these two lists from different sources.
          nodeVerdicts: (() => {
            const referenced = new Set(validation.node_ids.map(id => id.toLowerCase()));
            for (const e of resultGraph.columnAspect.edges) referenced.add(e.hop_node.toLowerCase());
            return (resultGraph.node_states ?? [])
              .filter(ns => referenced.has(ns.nodeId.toLowerCase()))
              .map(ns => ({ nodeId: ns.nodeId, verdict: ns.action }));
          })(),
        } : {}),
      };
      // The engine checkpoint rides the artifact so a bookmark saved from this view can recall the
      // run; captured here so the single guarded commit below is the only write of the artifact.
      let checkpoint: PresentationArtifact['checkpoint'];
      if (sess.stateMachine) {
        try {
          checkpoint = sess.stateMachine.toJSON();
        } catch (error) {
          s.logger.debug(`presentResult checkpoint capture skipped: ${error instanceof Error ? error.name : 'Error'}`);
        }
      }
      const artifact: PresentationArtifact = {
        name: validation.name,
        nodeIds: [...validation.node_ids],
        aiMetadata,
        ...(checkpoint ? { runId: sess.id, checkpoint } : {}),
      };

      const panel = s.getPanel();
      let autoDispatched = false;
      if (panel) {
        // Validated send through the bridge sink — the render reflection rides the contract, not a raw
        // side-channel. The webview normalizes node_ids against its model and ACKs via view-render-result.
        try {
          autoDispatched = await postToWebview(
            panel,
            { type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata },
            s.logger,
          );
        } catch (error) {
          s.logger.warn(`AI preview dispatch failed: ${error instanceof Error ? error.name : 'Error'}`);
        }
        if (autoDispatched) panel.reveal();
      }

      // A second success violates the single-shot presentation contract; retain a diagnostic canary.
      const repeatedSuccess = sess.presentResultCalledThisTurn;
      const successWrite = sess.commitPresentResultSuccess(turnEpoch, artifact, autoDispatched);
      if (successWrite.kind !== 'accepted') {
        return s.logAndReturn('present_result', {
          error: 'stale_turn',
          hint: 'The result was not committed because the turn no longer owns this session.',
        }, rawInput);
      }
      // Outside the preview path resultGraph aliases the live session graph, so every write below
      // must stay behind the accepted commit — a turn superseded during the webview await must not
      // clobber the owning turn's graph.
      if (isAmendment) {
        resultGraph.nodeIds = resolvedNodeIds;
        resultGraph.edges = resolvedEdges;
        const existingNotes = new Map((resultGraph.notes ?? []).map(n => [n.nodeId, n]));
        for (const n of validation.notes) existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
        resultGraph.notes = Array.from(existingNotes.values());
      } else {
        resultGraph.notes = validation.notes.map(n => ({ nodeId: n.node_id, summary: n.text }));
      }
      // Persist the same assembled body fields exposed by the serialized result state.
      {
        resultGraph.description = validation.description ?? undefined;
        resultGraph.summary = validation.summary ?? undefined;
        resultGraph.title = presentInput.title ?? undefined;
        resultGraph.intro = presentInput.intro ?? undefined;
        resultGraph.closing = presentInput.closing ?? undefined;
        if (Array.isArray(presentInput.sections)) {
          resultGraph.sections = presentInput.sections.map(sec => ({
            label: sec.label,
            node_ids: sec.node_ids,
            text: sec.text,
          }));
        }
      }
      if (previewGraph) sess.resultGraph = resultGraph;
      if (repeatedSuccess) {
        s.logger.debug(`[Presentation] repeated present_result in one turn (success #${sess.presentResultAttemptCountThisTurn}) — single-shot guard may have regressed`);
      }

      s.logger.info(`AI view "${validation.name}" displayed — nodes=${validation.node_ids.length} sections=${presentInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} badges=${validation.badges.length} classification=${sess.classification ?? '(none)'} attempts=${sess.presentResultAttemptCountThisTurn} failures=${sess.presentResultFailureCountThisTurn}`);
      return s.logAndReturn('present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, rawInput);
    } catch (err) { return s.toolError('present_result', err); }
}
