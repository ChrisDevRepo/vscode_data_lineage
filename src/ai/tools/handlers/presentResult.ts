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
  findBareNonPrunedNodes, findUnrenderedDetailSlotIds, requiredDetailSlotIds, buildColumnChainPreface,
  discoveryPreviewNarrative,
  mergePresentResultRepairPatch,
  findTextlessNewSectionLabels,
  presentResultRepairInstruction,
  assemblePreviewSections,
  findDiscoveryPreviewNoteViolations,
  assignEvidenceIds,
  expandEvidenceRefs,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultStage,
  type PresentNodeIdState,
  type PresentNodeIdStateLookup,
} from '../../tools/presentResult';
import {
  presentResultBoundarySchemaForPhase,
  normalizePresentSectionLabel,
  presentResultRepairPatchSchemaForFields,
  type PresentResultRepairField,
} from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { resolveModelNodeId, resolveModelNodeIds } from '../../support/inputNormalization';
import { makeRejection, readToolError } from '../../support/toolErrorEnvelope';
import { quoteIds } from '../../support/text';
import { evaluatePresentResultPreconditionsRule } from '../../interaction/rules/presentResultRules';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';

/** Zod issue path of a preview section's block range — a failure the range's own resend clears. */
const PREVIEW_BLOCK_RANGE_PATH = /^sections\.\d+\.blocks$/;

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

/**
 * Fills a render that amends a committed report back out to a complete section array.
 *
 * @remarks
 * An omitted `sections` array or empty section text asks to retain the committed body under that
 * label, and omitted section `node_ids` ask to retain its committed links; inherited `node_ids` are
 * narrowed to nodes this render still shows so a retained section cannot re-link a node the same
 * call pruned. Supplied node ids are left alone. Committed text is stored with its evidence
 * references already expanded, so a retained body keeps its SQL verbatim.
 *
 * @param committed - Sections of the report this run already rendered.
 * @returns The complete sections, or the labels that asked to retain a body that does not exist.
 */
function resolveRetainedSections(
  supplied: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> | undefined,
  committed: NonNullable<ResultGraph['sections']>,
  renderedNodeIds: ReadonlySet<string>,
): { sections: Array<{ label: string; node_ids: string[]; text: string }>; unknownLabels: string[] } {
  const byLabel = new Map(committed.map(sec => [normalizePresentSectionLabel(sec.label), sec]));
  const source: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> = supplied?.length
    ? supplied
    : committed.map(sec => ({ label: sec.label }));
  const sections: Array<{ label: string; node_ids: string[]; text: string }> = [];
  const unknownLabels: string[] = [];
  for (const sec of source) {
    const kept = byLabel.get(normalizePresentSectionLabel(sec.label));
    const nodeIds = sec.node_ids ?? kept?.node_ids?.filter(id => renderedNodeIds.has(id)) ?? [];
    if (typeof sec.text === 'string' && sec.text.trim().length > 0) {
      sections.push({ label: sec.label, node_ids: nodeIds, text: sec.text });
      continue;
    }
    if (!kept?.text) {
      unknownLabels.push(sec.label);
      continue;
    }
    sections.push({ label: sec.label, node_ids: nodeIds, text: kept.text });
  }
  return { sections, unknownLabels };
}

/**
 * The notes an amendment renders: the committed captions for nodes still shown, overlaid by this
 * call's notes by node id — the one merge both the rendered view and the committed
 * `resultGraph.notes` take, so a follow-up that edits one caption does not blank every other
 * caption on the graph.
 */
function mergeAmendedNotes(
  committed: ReadonlyArray<{ nodeId: string; summary: string }> | undefined,
  supplied: ReadonlyArray<{ node_id: string; caption: string }>,
  renderedNodeIds: readonly string[],
): Array<{ nodeId: string; text: string }> {
  const rendered = new Set(renderedNodeIds);
  const byNode = new Map<string, string>();
  for (const note of committed ?? []) if (rendered.has(note.nodeId) && note.summary) byNode.set(note.nodeId, note.summary);
  for (const note of supplied) byNode.set(note.node_id, note.caption);
  return [...byNode].map(([nodeId, text]) => ({ nodeId, text }));
}

function notePresentResultFailure(sess: AiSession, token: number, data: object): void {
  const rejection = readToolError(data);
  if (!rejection) return;
  const reason = rejection.hint
    ? `${rejection.reason} (${rejection.hint})`
    : rejection.reason;
  sess.recordPresentResultFailure(token, sanitizeForLog(reason));
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
 * repairable draft, or passes the input through when no draft is held.
 *
 * @remarks
 * Every reject path returns through the caller's `reject` funnel; otherwise the caller
 * continues validating the resolved `input`.
 *
 * @param sess - Active AI session, source of the held draft and its authorization.
 * @param input - The current tool input.
 * @param stage - Stage the call was dispatched in; selects the patch shape a held draft accepts.
 * @param reject - The caller's reject funnel, invoked here so every failure logs identically.
 * @returns The resolved input to continue validating, or the terminal response to return.
 */
function resolvePresentResultRepairDraft(
  sess: AiSession,
  input: unknown,
  stage: PresentResultStage,
  reject: (failure: object, opts?: { clearDraft?: boolean }) => string,
): PresentResultRepairResolution {
  const held = sess.presentResultRepairDraft.get();
  const authorization = sess.presentResultRepairDraft.getAuthorization();
  if (!held || !authorization) return { kind: 'input', input };
  const patch = presentResultRepairPatchSchemaForFields(authorization.fields, stage).safeParse(input);
  if (!patch.success) {
    const fieldErrors = patch.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
    return {
      kind: 'reject',
      response: reject({
        success: false,
        errors: fieldErrors,
        hint: `Invalid present_result repair patch. Send only these authorized fields: ${authorization.fields.join(', ')}.`,
      }),
    };
  }
  const textlessNewLabels = patch.data.sections
    ? findTextlessNewSectionLabels(held.sections, patch.data.sections)
    : [];
  if (textlessNewLabels.length > 0) {
    return {
      kind: 'reject',
      response: reject({
        success: false,
        errors: [`sections[] names label(s) not on file with no text: ${quoteIds(textlessNewLabels)}.`],
        hint: 'A label already on file may omit text to keep it; a new label needs its text. Use the exact held label to change an existing section. To fix: add text: under the offending label, or move its node_ids into an exact held label. Nothing from the rejected call was stored; resend every field it carried, notes[] included.',
        detail: [{ path: 'sections' }],
      }),
    };
  }
  return { kind: 'input', input: mergePresentResultRepairPatch(held, patch.data, authorization) };
}

/** Builds and persists the final lineage presentation for the active turn. */
export async function executePresentResult(input: unknown, s: ToolServices): Promise<string> {
    try {
      const sess = s.getSession();
      const rawInput = input;
      const turnEpoch = s.turnEpoch(sess);
      const attemptWrite = sess.beginPresentResultAttempt(turnEpoch);
      if (attemptWrite.kind !== 'accepted') {
        return s.logAndReturn('lineage_present_result', makeRejection({
          code: REJECTION_CODES.staleTurn,
          hint: 'The turn no longer owns this session. Do not render this result.',
        }), rawInput);
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

      if (isVisualPreview && !sess.presentResultRepairDraft.hasRepairableDraft()) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
          ? sess.discoveryScopeArtifact
          : null;
        if (!previewNarrative || !scope) {
          return reject(makeRejection({
            code: 'preview_source_unavailable',
            hint: 'Run the discovery question again, then request its graph preview.',
          }), { clearDraft: true });
        }
        const supplied = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        const previewProse: Record<string, string | undefined> = {
          summary: previewNarrative.summary,
          title: previewNarrative.title,
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

      const presentResultStage: PresentResultStage = isVisualPreview
        ? 'visual_preview'
        : sess.phase.kind === 'completed'
        ? 'completed'
        : 'synthesis';

      const repairResolution = resolvePresentResultRepairDraft(sess, input, presentResultStage, reject);
      if (repairResolution.kind === 'reject') return repairResolution.response;
      input = repairResolution.input;

      const retainableSections = isVisualPreview ? null : sess.retainableReportSections();

      const boundary = presentResultBoundarySchemaForPhase(
        presentResultStage,
        retainableSections !== null,
        previewNarrative?.blocks.length,
      ).safeParse(input);
      if (!boundary.success) {
        const fieldErrors = boundary.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
        const issuePaths = [...new Set(boundary.error.issues.flatMap(issue =>
          issue.code === 'unrecognized_keys'
            ? [...issue.keys]
            : issue.path.length > 0 ? [issue.path.join('.')] : []))];
        const detail = issuePaths.length > 0 ? { detail: issuePaths.map(path => ({ path })) } : {};
        if (isVisualPreview && issuePaths.length > 0 && issuePaths.every(path => PREVIEW_BLOCK_RANGE_PATH.test(path))) {
          const repairFields: readonly PresentResultRepairField[] = ['sections'];
          sess.presentResultRepairDraft.hold(input as PresentResultInput, { fields: repairFields, sectionsMerge: 'by_label' });
          return reject({
            success: false,
            errors: fieldErrors,
            hint: presentResultRepairInstruction(repairFields, 'by_label', presentResultStage),
            repairable: true,
            repairFields,
            ...detail,
          });
        }
        return reject({
          success: false,
          errors: fieldErrors,
          hint: 'Fix the listed fields and call lineage_present_result again with the corrected content.',
          ...detail,
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
              `add_node_ids names objects this exploration has not analysed: ${quoteIds(outOfScope)}.`,
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
              `Closed-graph invariant failed: ${quoteIds(disconnected)} ${disconnected.length === 1 ? 'is' : 'are'} disconnected from origin \`${resultGraph.originNodeId}\`.`,
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
              `sections[] asks to keep text for ${quoteIds(retained.unknownLabels)}, which the committed report has no body for.`,
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

      const unknownEvidenceIds: string[] = [];
      let renderInput: PresentResultInput = isVisualPreview && presentInput.sections
        ? { ...presentInput, sections: assemblePreviewSections(previewNarrative?.blocks ?? [], presentInput.sections) }
        : presentInput;
      if (!isVisualPreview && presentInput.sections?.length) {
        const { blocks: evidenceBlocks } = assignEvidenceIds(sess.memory.getResult().detail_slots);
        const expand = (text: string, fieldLabel: string): string => {
          const expanded = expandEvidenceRefs(text, evidenceBlocks);
          unknownEvidenceIds.push(...expanded.unknownIds);
          for (const entry of expanded.normalized) {
            s.logger.debug(`presentResult normalization: evidence reference ${entry} — ${fieldLabel}`);
          }
          return expanded.text;
        };
        const expandOptional = (text: string | undefined, fieldLabel: string): string | undefined =>
          text === undefined ? text : expand(text, fieldLabel);
        renderInput = {
          ...presentInput,
          title: expandOptional(presentInput.title, 'title'),
          intro: expandOptional(presentInput.intro, 'intro'),
          closing: expandOptional(presentInput.closing, 'closing'),
          sections: presentInput.sections.map(sec => {
            const expanded = expand(sec.text, `section "${trunc(sec.label, 60)}"`);
            return expanded === sec.text ? sec : { ...sec, text: expanded };
          }),
        };
      }

      s.logger.debug(`presentResult section[0] preview: ${trunc(renderInput.sections?.[0]?.text ?? '(empty)', 200)}`);

      const bareNodeIds = findBareNonPrunedNodes(resultGraph, renderInput, resolvedNodeIds);
      if (bareNodeIds.length > 0) {
        s.logger.debug(`[Presentation] ${bareNodeIds.length} non-pruned node(s) left bare by the AI (rendered unlabeled/uncolored) — ${trunc(bareNodeIds.join(', '), 200)}`);
      }

      const renderedNodeIds = new Set(resolvedNodeIds);
      const unrenderedSlotIds = findUnrenderedDetailSlotIds(
        requiredDetailSlotIds(sess.memory.notedNodeIds, renderedNodeIds),
        renderInput,
      );
      if (unrenderedSlotIds.length > 0) {
        s.logger.debug(`[Presentation] ${unrenderedSlotIds.length} of ${sess.memory.slotCount} detail slot(s) reached no section — ${trunc(unrenderedSlotIds.join(', '), 200)}`);
      }

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (renderInput.sections?.length) {
        const nodeMap = getModelNodeMap(model);
        const columnChainPreface = resultGraph.columnAspect
          ? buildColumnChainPreface(resultGraph.columnAspect.edges)
          : undefined;
        const assembled = orderAndAssemble(
          renderInput.sections,
          {
            title: renderInput.title,
            intro: renderInput.intro,
            closing: renderInput.closing,
            nodeMap,
            ...(columnChainPreface ? { preface: columnChainPreface } : {}),
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
        externalViolations.push(...findDiscoveryPreviewNoteViolations(previewNarrative.blocks, renderInput.notes));
      }
      const uncoveredCtNodes = findUncoveredCtChainNodes(resultGraph, renderInput, resolvedNodeIds, sess.memory.notedNodeIds);
      if (uncoveredCtNodes.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `CT column-chain node(s) missing from final presentation: ${quoteIds(uncoveredCtNodes)}.`,
            'For each one: add its id to a sections[].node_ids, or to any highlight_groups[].node_ids, or give it one grounded notes[] entry. Tables carry the traced column even when they have no detail slot.',
          ],
          repairFields: ['sections', 'highlight_groups', 'notes'],
          paths: ['sections', 'highlight_groups', 'notes'],
          entryIds: uncoveredCtNodes,
          soleHint: 'Fix CT node coverage only: link each named node in a section, a highlight group, or notes.',
        });
      }
      if (unrenderedSlotIds.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `Detail slot(s) reached no section: ${quoteIds(unrenderedSlotIds)}.`,
            'For each one, add its id to a sections[].node_ids so the captured findings render in that section\'s text — a notes caption or a highlight color does not carry a detail slot\'s prose.',
          ],
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: unrenderedSlotIds,
          soleHint: 'Fix detail-slot coverage only: add each named node to a sections[].node_ids.',
        });
      }
      if (unknownEvidenceIds.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `Evidence id(s) ${quoteIds([...new Set(unknownEvidenceIds)])} name no captured SQL block. `
            + 'Use an id shown on a ```sql fence line in detail_slots, or write the SQL inside that fence yourself.',
          ],
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: [...new Set(unknownEvidenceIds)],
          soleHint: 'Fix evidence references only: replace each named id with a served one, or write that SQL out in the fence.',
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
      const validation = validatePresentResult(renderInput, resolvedNodeIds, assembledBadges, assembledDescription, isAmendment, externalViolations, presentResultStage, nodeIdState);

      if (!validation.success) {
        if (validation.repairable) {
          sess.presentResultRepairDraft.hold(presentInput, { fields: validation.repairFields, sectionsMerge: validation.sectionsMerge });
        } else {
          sess.presentResultRepairDraft.clear();
        }
        const { sectionsMerge: _heldOnly, ...rejection } = validation;
        notePresentResultFailure(sess, turnEpoch, rejection);
        return s.logAndReturn('lineage_present_result', rejection, rawInput);
      }

      const runId = sess.explorationRunId ?? sess.id;
      const renderedNotes = isAmendment
        ? mergeAmendedNotes(resultGraph.notes, validation.notes, validation.node_ids)
        : validation.notes.map(n => ({ nodeId: n.node_id, text: n.caption }));
      const aiMetadata: PresentationArtifact['aiMetadata'] = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName ?? 'unknown',
        runId,
        highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
        badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
        notes: renderedNotes,
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
        sess.markSynthesisRenderDegraded('preview_dispatch');
      }

      const repeatedSuccess = sess.presentResultCalledThisTurn;
      const successWrite = sess.commitPresentResultSuccess(turnEpoch, artifact, autoDispatched);
      if (successWrite.kind !== 'accepted') {
        return s.logAndReturn('lineage_present_result', makeRejection({
          code: REJECTION_CODES.staleTurn,
          hint: 'The result was not committed because the turn no longer owns this session.',
        }), rawInput);
      }
      if (isAmendment) {
        resultGraph.nodeIds = resolvedNodeIds;
        resultGraph.edges = resolvedEdges;
      }
      resultGraph.notes = renderedNotes.map(n => ({ nodeId: n.nodeId, summary: n.text }));
      {
        resultGraph.description = validation.description ?? undefined;
        resultGraph.summary = validation.summary ?? undefined;
        resultGraph.title = renderInput.title ?? undefined;
        resultGraph.intro = renderInput.intro ?? undefined;
        resultGraph.closing = renderInput.closing ?? undefined;
        if (Array.isArray(renderInput.sections)) {
          resultGraph.sections = renderInput.sections.map(sec => ({ label: sec.label, node_ids: sec.node_ids, text: sec.text }));
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
