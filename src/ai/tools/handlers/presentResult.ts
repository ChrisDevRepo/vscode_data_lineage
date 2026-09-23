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
  findBareNonPrunedNodes, findUnrenderedDetailSlotIds, buildColumnChainPreface,
  isRepairablePresentResultFailure,
  discoveryPreviewNarrative,
  mergePresentResultRepairPatch,
  stripUnchangedRepairEnvelopeKeys,
  findDiscoveryPreviewReuseViolations,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultStage,
  type PresentNodeIdState,
  type PresentNodeIdStateLookup,
} from '../../tools/presentResult';
import {
  presentResultBoundarySchemaForPhase,
  PRESENT_RESULT_NAME_MAX,
  PRESENT_RESULT_TITLE_MAX,
  presentResultRepairPatchSchemaForFields,
} from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { coercedBoolean, resolveModelNodeId, resolveModelNodeIds } from '../../support/inputNormalization';
import { readToolError } from '../../support/toolErrorEnvelope';
import { quoteIds } from '../../support/text';
import { evaluatePresentResultPreconditionsRule } from '../../interaction/rules/presentResultRules';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';

function findUncoveredCtChainNodes(
  resultGraph: AiSession['resultGraph'],
  input: PresentResultInput,
  resolvedNodeIds: string[],
  slottedNodeIds: readonly string[],
): string[] {
  const edges = resultGraph?.columnAspect?.edges ?? [];
  if (edges.length === 0) return [];
  const lc = (id: string): string => id.toLowerCase();
  const exempt = new Set<string>(slottedNodeIds.map(lc));
  for (const st of resultGraph?.node_states ?? []) if (st.action === 'prune') exempt.add(lc(st.nodeId));
  const chain = new Set(edges.flatMap(e => [lc(e.from_node), lc(e.to_node), lc(e.hop_node)]));
  const required = resolvedNodeIds.filter(id => chain.has(lc(id)) && !exempt.has(lc(id)));
  if (required.length === 0) return [];

  const linked = new Set<string>();
  for (const sec of input.sections ?? []) {
    for (const id of sec.node_ids ?? []) linked.add(lc(id));
  }
  for (const group of input.highlight_groups ?? []) {
    for (const id of group.node_ids ?? []) linked.add(lc(id));
  }
  for (const note of input.notes ?? []) linked.add(lc(note.node_id));
  return required.filter(id => !linked.has(lc(id)));
}

/** Section labels match on their rendered form: leading AI numbering and case never distinguish two. */
function sectionLabelKey(label: string): string {
  return label.replace(/^\d+\.?\s+/, '').trim().toLowerCase();
}

/**
 * Fills a render that amends a committed report back out to a complete section array.
 *
 * @remarks
 * An omitted `sections` array or empty section text asks to retain the committed body under that
 * label; inherited `node_ids` are narrowed to nodes this render still shows so a retained section
 * cannot re-link a node the same call pruned. Supplied node ids are left alone.
 *
 * @param committed - Sections of the report this run already rendered.
 * @returns The complete sections, or the labels that asked to retain a body that does not exist.
 */
function resolveRetainedSections(
  supplied: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> | undefined,
  committed: NonNullable<ResultGraph['sections']>,
  renderedNodeIds: ReadonlySet<string>,
): { sections: Array<{ label: string; node_ids?: string[]; text: string }>; unknownLabels: string[] } {
  const byLabel = new Map(committed.map(sec => [sectionLabelKey(sec.label), sec]));
  const source: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> = supplied?.length
    ? supplied
    : committed.map(sec => ({ label: sec.label }));
  const sections: Array<{ label: string; node_ids?: string[]; text: string }> = [];
  const unknownLabels: string[] = [];
  for (const sec of source) {
    if (typeof sec.text === 'string' && sec.text.trim().length > 0) {
      sections.push({ ...sec, text: sec.text });
      continue;
    }
    const kept = byLabel.get(sectionLabelKey(sec.label));
    if (!kept?.text) {
      unknownLabels.push(sec.label);
      continue;
    }
    const nodeIds = sec.node_ids ?? kept.node_ids?.filter(id => renderedNodeIds.has(id));
    sections.push({
      label: sec.label,
      ...(nodeIds && nodeIds.length > 0 ? { node_ids: nodeIds } : {}),
      text: kept.text,
    });
  }
  return { sections, unknownLabels };
}

function notePresentResultFailure(sess: AiSession, token: number, data: object): void {
  const rejection = readToolError(data);
  if (!rejection) return;
  const reason = rejection.hint
    ? `${rejection.reason} (${rejection.hint})`
    : rejection.reason;
  sess.recordPresentResultFailure(token, trunc(sanitizeForLog(reason), 240));
}

function buildColumnAspectNodeVerdicts(
  nodeIds: readonly string[],
  columnAspect: NonNullable<ResultGraph['columnAspect']>,
  nodeStates: ResultGraph['node_states'],
) {
  const referenced = new Set(nodeIds.map(id => id.toLowerCase()));
  for (const e of columnAspect.edges) referenced.add(e.hop_node.toLowerCase());
  return (nodeStates ?? [])
    .filter(ns => referenced.has(ns.nodeId.toLowerCase()))
    .map(ns => ({ nodeId: ns.nodeId, verdict: ns.action }));
}

function captureCheckpoint(sess: AiSession, logger: ToolServices['logger']): PresentationArtifact['checkpoint'] {
  if (!sess.stateMachine) return undefined;
  try {
    return sess.stateMachine.toJSON();
  } catch (error) {
    logger.debug(`presentResult checkpoint capture skipped: ${error instanceof Error ? error.name : 'Error'}`);
    return undefined;
  }
}

/**
 * Resolution of {@link resolvePresentResultRepairDraft}: the (possibly merged) input to keep
 * validating, or a terminal tool response the caller must return immediately.
 */
type PresentResultRepairResolution =
  | { readonly kind: 'input'; readonly input: unknown }
  | { readonly kind: 'reject'; readonly response: string };

/**
 * Resolves `executePresentResult`'s repair-draft branch: merges an authorized patch into a held
 * repairable draft, or rejects an `is_update:true` sent with no held draft during synthesis.
 *
 * @remarks
 * Pure move of the branch guarding `sess.presentResultRepairDraft`: every reject path inside it
 * already returns through the caller's `reject` funnel, so this helper hands back either that
 * terminal response or the resolved `input` to keep validating — the caller returns or continues
 * with it unchanged, exactly as the inline branch did.
 *
 * @param sess - Active AI session, source of the held draft and its authorization.
 * @param logger - Host logger for the same debug lines the inline branch emitted.
 * @param input - The current tool input, already `is_update`-normalized by the caller.
 * @param coercedIsUpdateData - The caller's already-coerced `is_update` value (`undefined` on a
 *   failed coercion).
 * @param requestedRepair - Whether the coerced `is_update` asked for a repair this turn.
 * @param reject - The caller's reject funnel, invoked here so every failure logs identically.
 * @returns The resolved input to continue validating, or the terminal response to return.
 */
function resolvePresentResultRepairDraft(
  sess: AiSession,
  logger: ToolServices['logger'],
  input: unknown,
  coercedIsUpdateData: boolean | undefined,
  requestedRepair: boolean | undefined,
  reject: (failure: object, opts?: { clearDraft?: boolean }) => string,
): PresentResultRepairResolution {
  if (sess.presentResultRepairDraft.hasRepairableDraft()) {
    if (coercedIsUpdateData !== true) {
      input = { ...(input as Record<string, unknown>), is_update: true };
      logger.debug('presentResult normalization: repairable draft held — is_update defaulted to true (declared authorization backfill)');
    }
    const allowedFields = sess.presentResultRepairDraft.getAuthorization();
    if (!allowedFields?.length) {
      return {
        kind: 'reject',
        response: reject({
          success: false,
          errors: ['Held present_result repair authorization is missing.'],
          hint: 'Call lineage_present_result again with the full required payload.',
        }, { clearDraft: true }),
      };
    }
    const heldDraftForStrip = sess.presentResultRepairDraft.get();
    if (heldDraftForStrip && input && typeof input === 'object' && !Array.isArray(input)) {
      const { input: strippedInput, stripped } = stripUnchangedRepairEnvelopeKeys(
        input as Record<string, unknown>, heldDraftForStrip, allowedFields,
      );
      if (stripped.length) {
        input = strippedInput;
        for (const key of stripped) {
          logger.debug(`[AI] repair patch: stripped unchanged envelope key ${key}`);
        }
      }
    }
    const patch = presentResultRepairPatchSchemaForFields(allowedFields).safeParse(input);
    if (!patch.success) {
      const fieldErrors = patch.error.issues.slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
      return {
        kind: 'reject',
        response: reject({
          success: false,
          errors: fieldErrors,
          hint: `Invalid present_result repair patch. Send only is_update:true plus these authorized fields: ${allowedFields.join(', ')}.`,
        }),
      };
    }
    const merged = sess.presentResultRepairDraft.merge(
      patch.data,
      (draft, repairPatch) => mergePresentResultRepairPatch(draft, repairPatch, allowedFields),
    );
    if (!merged) {
      return {
        kind: 'reject',
        response: reject({
          success: false,
          errors: ['No held present_result draft is available for repair.'],
          hint: 'Call lineage_present_result with the full required payload.',
        }),
      };
    }
    return { kind: 'input', input: merged };
  }
  if (sess.phase.kind === 'exploring' && requestedRepair) {
    return {
      kind: 'reject',
      response: reject({
        error: REJECTION_CODES.invalidInput,
        hint: 'is_update:true is accepted during synthesis only for a session-authorized held repair draft. Send the full new-render payload without is_update.',
      }, { clearDraft: true }),
    };
  }
  return { kind: 'input', input };
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
        return s.logAndReturn('lineage_present_result', {
          error: REJECTION_CODES.staleTurn,
          hint: 'The turn no longer owns this session. Do not render this result.',
        }, rawInput);
      }
      const model = s.requireModel();
      const isVisualPreview = sess.activeLmStage?.kind === 'visual_preview';
      const previewNarrative = isVisualPreview && sess.lastDiscoveryAnswer
        ? discoveryPreviewNarrative(sess.lastDiscoveryAnswer)
        : null;

      const reject = (failure: object, opts: { clearDraft?: boolean } = {}): string => {
        if (opts.clearDraft) sess.presentResultRepairDraft.clear();
        notePresentResultFailure(sess, turnEpoch, failure);
        return s.logAndReturn('lineage_present_result', failure, rawInput);
      };

      const rawIsUpdate = typeof input === 'object' && input !== null
        ? (input as { is_update?: unknown }).is_update
        : undefined;
      const coercedIsUpdate = coercedBoolean().safeParse(rawIsUpdate);
      if (coercedIsUpdate.success && typeof rawIsUpdate === 'string') {
        input = { ...(input as Record<string, unknown>), is_update: coercedIsUpdate.data };
        s.logger.debug(`presentResult normalization: is_update "${rawIsUpdate}" → ${coercedIsUpdate.data} (string-encoded boolean unwrapped)`);
      }
      const requestedRepair = coercedIsUpdate.success && coercedIsUpdate.data;

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
        const supplied = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        const previewProse: Record<string, string | undefined> = {
          name: `${scope.origin} graph preview`.slice(0, PRESENT_RESULT_NAME_MAX),
          summary: previewNarrative.summary,
          title: previewNarrative.title?.slice(0, PRESENT_RESULT_TITLE_MAX),
        };
        for (const [field, value] of Object.entries(previewProse)) {
          const prior = supplied[field];
          if (typeof prior === 'string' && prior !== value) {
            s.logger.debug(
              `[Normalize] tool=present_result field=${field} from=${sanitizeForLog(prior)} to=${value === undefined ? '(absent)' : sanitizeForLog(value)}`,
            );
          }
        }
        input = { ...supplied, ...previewProse };
      }

      const repairResolution = resolvePresentResultRepairDraft(sess, s.logger, input, coercedIsUpdate.data, requestedRepair, reject);
      if (repairResolution.kind === 'reject') return repairResolution.response;
      input = repairResolution.input;

      const presentResultStage: PresentResultStage = isVisualPreview
        ? 'visual_preview'
        : sess.phase.kind === 'completed'
        ? 'completed'
        : 'synthesis';

      const retainableSections = isVisualPreview ? null : sess.retainableReportSections();

      const boundary = presentResultBoundarySchemaForPhase(presentResultStage, retainableSections !== null).safeParse(input);
      if (!boundary.success) {
        const fieldErrors = boundary.error.issues.slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
        const issuePaths = [...new Set(boundary.error.issues.flatMap(issue =>
          issue.code === 'unrecognized_keys'
            ? [...issue.keys]
            : issue.path.length > 0 ? [issue.path.join('.')] : []))];
        return reject({
          success: false,
          errors: fieldErrors,
          hint: 'Fix the listed fields and call lineage_present_result again with the corrected content.',
          ...(issuePaths.length > 0 ? { detail: issuePaths.map(path => ({ path })) } : {}),
        }, { clearDraft: true });
      }
      const presentInput = boundary.data as PresentResultInput;

      const isAmendment = !isVisualPreview && sess.phase.kind === 'completed' && presentInput.is_update === true;

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

      const canonicalNodeId = (id: string, field: string): string => {
        const resolved = resolveModelNodeId(id, modelNodeMap) ?? id;
        if (resolved !== id) {
          s.logger.debug(
            `[Normalize] tool=present_result field=${field} from=${sanitizeForLog(id)} to=${sanitizeForLog(resolved)}`,
          );
        }
        return resolved;
      };
      if (Array.isArray(presentInput.sections) && presentInput.sections.length > 0) {
        presentInput.sections = presentInput.sections.map((sec, secIndex) => {
          if (!Array.isArray(sec.node_ids) || sec.node_ids.length === 0) return sec;
          const normalizedNodeIds = sec.node_ids.map((id, idIndex) =>
            canonicalNodeId(id, `sections.${secIndex}.node_ids.${idIndex}`));
          return { ...sec, node_ids: normalizedNodeIds };
        });
      }
      if (Array.isArray(presentInput.notes) && presentInput.notes.length > 0) {
        presentInput.notes = presentInput.notes.map((note, noteIndex) => ({
          ...note,
          node_id: canonicalNodeId(note.node_id, `notes.${noteIndex}.node_id`),
        }));
      }
      if (Array.isArray(presentInput.highlight_groups) && presentInput.highlight_groups.length > 0) {
        presentInput.highlight_groups = presentInput.highlight_groups.map((group, groupIndex) => ({
          ...group,
          node_ids: group.node_ids.map((id, idIndex) =>
            canonicalNodeId(id, `highlight_groups.${groupIndex}.node_ids.${idIndex}`)),
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
        const scopeSnapshot = sess.stateMachine?.toJSON() ?? null;
        const outOfScope = scopeSnapshot
          ? toAdd.filter(id => !scopeSnapshot.scopeNodeIds.includes(id))
          : [];
        if (outOfScope.length > 0) {
          return reject({
            success: false,
            errors: [
              `add_node_ids names objects this exploration has not analysed: ${quoteIds(outOfScope, 5)}.`,
              'Rendering reveals analysed objects only. If the user asked to add these objects, call lineage_start_exploration {"supplement":{"nodeIds":[...]}} — that analyses them into this graph — then render. Otherwise do not render them: name them in your chat answer and ask which to add.',
            ],
          }, { clearDraft: true });
        }
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type, modelNodeMap.get(e.source)?.type ?? '')] as [string, string, string]);
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

      if (retainableSections) {
        const retained = resolveRetainedSections(presentInput.sections, retainableSections, new Set(resolvedNodeIds));
        if (retained.unknownLabels.length > 0) {
          return reject({
            success: false,
            errors: [
              `sections[] asks to keep text for ${quoteIds(retained.unknownLabels, 5)}, which the committed report has no body for.`,
              'Send that section with its own text, or use a label from the committed report to keep its text.',
            ],
            hint: 'Fix the listed section labels and call lineage_present_result again.',
          }, { clearDraft: true });
        }
        const keptCount = retained.sections.length - (presentInput.sections ?? []).filter(sec => typeof sec.text === 'string' && sec.text.trim().length > 0).length;
        if (keptCount > 0) {
          s.logger.debug(`[Presentation] ${keptCount} of ${retained.sections.length} section(s) kept from the committed report — run=${sess.explorationRunId ?? '(none)'}`);
        }
        presentInput.sections = retained.sections;
      }

      s.logger.debug(`presentResult section[0] preview: ${trunc(presentInput.sections?.[0]?.text ?? '(empty)', 200)}`);

      const bareNodeIds = findBareNonPrunedNodes(resultGraph, presentInput, resolvedNodeIds);
      if (bareNodeIds.length > 0) {
        s.logger.debug(`[Presentation] ${bareNodeIds.length} non-pruned node(s) left bare by the AI (rendered unlabeled/uncolored) — ${trunc(bareNodeIds.join(', '), 200)}`);
      }

      const renderedNodeIds = new Set(resolvedNodeIds);
      const unrenderedSlotIds = findUnrenderedDetailSlotIds(
        sess.memory.notedNodeIds.filter(id => renderedNodeIds.has(id)),
        presentInput,
      );
      if (unrenderedSlotIds.length > 0) {
        s.logger.debug(`[Presentation] ${unrenderedSlotIds.length} of ${sess.memory.slotCount} detail slot(s) reached no section — ${trunc(unrenderedSlotIds.join(', '), 200)}`);
      }

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (presentInput.sections?.length) {
        const nodeMap = getModelNodeMap(model);
        const columnChainPreface = resultGraph.columnAspect
          ? buildColumnChainPreface(resultGraph.columnAspect.edges)
          : undefined;
        // Slots of rendered nodes ride into assembly so the engine restores any captured ⚠️
        // callout the authored section text omits; unlinked slots stay on the rejection path below.
        const renderedDetailSlots = sess.memory.getResult().detail_slots.filter(slot => renderedNodeIds.has(slot.nodeId));
        const assembled = orderAndAssemble(
          presentInput.sections,
          {
            title: presentInput.title,
            intro: presentInput.intro,
            closing: presentInput.closing,
            nodeMap,
            ...(columnChainPreface ? { preface: columnChainPreface } : {}),
            ...(renderedDetailSlots.length > 0 ? { detailSlots: renderedDetailSlots } : {}),
          },
        );
        assembledBadges = assembled.badges;
        assembledDescription = assembled.description;
        if (assembled.droppedSectionLinks.length > 0) {
          s.logger.debug(`[Presentation] ${assembled.droppedSectionLinks.length} duplicate section link(s) dropped (first section keeps the badge) — ${trunc(assembled.droppedSectionLinks.map(d => `${d.node_id}: "${d.dropped_from}" → kept in "${d.kept_in}"`).join(', '), 300)}`);
        }
      }

      s.logger.info(
        `[Presentation] Output assembled — title="${trunc(presentInput.title ?? '(none)', 60)}" sections=${presentInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount} slotsUnrendered=${unrenderedSlotIds.length}`
      );

      const externalViolations: PresentResultViolation[] = [];
      if (isVisualPreview && previewNarrative) {
        externalViolations.push(...findDiscoveryPreviewReuseViolations(previewNarrative.body, presentInput));
      }
      const uncoveredCtNodes = findUncoveredCtChainNodes(resultGraph, presentInput, resolvedNodeIds, sess.memory.notedNodeIds);
      if (uncoveredCtNodes.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `CT column-chain node(s) missing from final presentation: ${quoteIds(uncoveredCtNodes, 5)}.`,
            'For each one: add its id to a sections[].node_ids, or to any highlight_groups[].node_ids, or give it one grounded notes[].node_id caption. Tables carry the traced column even when they have no detail slot.',
          ],
          repairFields: ['sections', 'highlight_groups', 'notes'],
          paths: ['sections', 'highlight_groups', 'notes'],
          entryIds: uncoveredCtNodes,
          soleHint: 'Fix CT node coverage only. Keep existing section text where possible; add each named node to a section, a highlight group, or notes[].',
        });
      }
      if (unrenderedSlotIds.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `Detail slot(s) reached no section: ${quoteIds(unrenderedSlotIds, 5)}.`,
            'For each one, add its id to a sections[].node_ids so the captured findings render in that section\'s text — a notes[] caption or a highlight color does not carry a detail slot\'s prose.',
          ],
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: unrenderedSlotIds,
          soleHint: 'Fix detail-slot coverage only. Keep existing section text where possible; add each named node to a sections[].node_ids.',
        });
      }

      let smSnapshot: SmState | null | undefined;
      const nodeIdState: PresentNodeIdStateLookup = (nodeId): PresentNodeIdState => {
        if (!modelNodeMap.has(nodeId)) return 'not_in_model';
        if (smSnapshot === undefined) smSnapshot = sess.stateMachine?.toJSON() ?? null;
        if (!smSnapshot) return 'out_of_scope';
        if (smSnapshot.removedSet.includes(nodeId)) return 'pruned';
        if ((smSnapshot.renderDroppedNodeIds ?? []).includes(nodeId)) return 'render_dropped';
        if (smSnapshot.scopeNodeIds.includes(nodeId)) return 'in_scope_undispositioned';
        return 'out_of_scope';
      };
      const validation = validatePresentResult(presentInput, resolvedNodeIds, assembledBadges, assembledDescription, isAmendment, externalViolations, presentResultStage, nodeIdState);

      if (!validation.success) {
        if (isRepairablePresentResultFailure(validation)) {
          sess.presentResultRepairDraft.hold(presentInput, validation.repairFields);
          validation.hint = `${validation.hint} You may repair the held draft by calling lineage_present_result with is_update:true and only these corrected fields: ${validation.repairFields.join(', ')}.`;
        } else {
          sess.presentResultRepairDraft.clear();
        }
        notePresentResultFailure(sess, turnEpoch, validation);
        return s.logAndReturn('lineage_present_result', validation, rawInput);
      }

      const runId = sess.explorationRunId ?? sess.id;
      const aiMetadata: PresentationArtifact['aiMetadata'] = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName ?? 'unknown',
        runId,
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
              ...(e.transforms ? { transforms: e.transforms } : {}),
              ...(e.note ? { note: e.note } : {}),
            })),
          },
          nodeVerdicts: buildColumnAspectNodeVerdicts(validation.node_ids, resultGraph.columnAspect, resultGraph.node_states),
        } : {}),
      };
      const checkpoint = captureCheckpoint(sess, s.logger);
      const artifact: PresentationArtifact = {
        name: validation.name,
        nodeIds: [...validation.node_ids],
        aiMetadata,
        ...(checkpoint ? { runId, checkpoint } : {}),
      };

      let autoDispatched = false;
      try {
        autoDispatched = await s.deliverPreview(
          { type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata },
        );
      } catch (error) {
        s.logger.warn(`AI preview dispatch failed: ${error instanceof Error ? error.name : 'Error'}`);
      }

      const repeatedSuccess = sess.presentResultCalledThisTurn;
      const successWrite = sess.commitPresentResultSuccess(turnEpoch, artifact, autoDispatched);
      if (successWrite.kind !== 'accepted') {
        return s.logAndReturn('lineage_present_result', {
          error: REJECTION_CODES.staleTurn,
          hint: 'The result was not committed because the turn no longer owns this session.',
        }, rawInput);
      }
      if (isAmendment) {
        resultGraph.nodeIds = resolvedNodeIds;
        resultGraph.edges = resolvedEdges;
        const existingNotes = new Map((resultGraph.notes ?? []).map(n => [n.nodeId, n]));
        for (const n of validation.notes) existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
        resultGraph.notes = Array.from(existingNotes.values());
      } else {
        resultGraph.notes = validation.notes.map(n => ({ nodeId: n.node_id, summary: n.text }));
      }
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
          resultGraph.sectionsRunId = sess.explorationRunId ?? undefined;
        }
      }
      if (previewGraph) sess.resultGraph = resultGraph;
      if (repeatedSuccess) {
        s.logger.debug(`[Presentation] repeated present_result in one turn (success #${sess.presentResultAttemptCountThisTurn}) — single-shot guard may have regressed`);
      }

      s.logger.info(`AI view "${validation.name}" displayed — nodes=${validation.node_ids.length} sections=${presentInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} badges=${validation.badges.length} classification=${sess.classification ?? '(none)'} attempts=${sess.presentResultAttemptCountThisTurn} failures=${sess.presentResultFailureCountThisTurn}`);
      return s.logAndReturn('lineage_present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, rawInput);
    } catch (err) { return s.toolError('present_result', err); }
}
