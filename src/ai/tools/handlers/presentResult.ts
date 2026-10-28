/** Executes validation, assembly, and persistence for `lineage_present_result`. */
import { type AiSession } from '../../session/session';
import { trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import {
  validatePresentResult, orderAndAssemble, findDisconnectedViewNodes,
  findBareNonPrunedNodes, findUnrenderedDetailSlotIds, requiredDetailSlotIds, buildColumnChainPreface,
  discoveryPreviewNarrative,
  mergePresentResultRepairPatch,
  holdRejectedPresentResult,
  findTextlessNewSections,
  findStartOrderIssues,
  START_ORDER_FAULT,
  presentResultResendRules,
  assemblePreviewSections,
  assignEvidenceIds,
  expandEvidenceRefs,
  evidenceCoverage,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultRepairPatch,
  type PresentResultStage,
  type PresentNodeIdState,
  type PresentNodeIdStateLookup,
} from '../../tools/presentResult';
import { mergedSectionsSchemaForPhase, normalizePresentSectionLabel, presentResultSchemaForPhase } from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { resolveModelNodeId, resolveModelNodeIds } from '../../support/modelReferences';
import { at, makeRejection, rejectionFromZodError, type IssueCode, type ToolRejection } from '../../support/toolErrorEnvelope';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { isCancellationOutcome } from '../../support/cancellation';

/** Binds only declared report-reference fields; raw arguments and authored text remain intact. */
function bindPresentationReferences<T extends PresentResultInput | PresentResultRepairPatch>(input: T, model: NonNullable<AiSession['model']>): T {
  const nodeMap = getModelNodeMap(model);
  const bind = (id: string): string => typeof id === 'string'
    ? resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive) ?? id : id;
  return {
    ...input,
    ...(Array.isArray(input.sections) ? { sections: input.sections.map(section => section && typeof section === 'object' ? ({ ...section,
      ...('node_ids' in section && Array.isArray(section.node_ids) ? { node_ids: section.node_ids.map(bind) } : {}),
    }) : section) } : {}),
    ...(Array.isArray(input.highlight_groups) ? { highlight_groups: input.highlight_groups.map(group => group && typeof group === 'object' ? ({ ...group,
      ...('node_ids' in group && Array.isArray(group.node_ids) ? { node_ids: group.node_ids.map(bind) } : {}),
    }) : group) } : {}),
    ...(Array.isArray(input.notes) ? { notes: input.notes.map(note => note && typeof note === 'object' && 'node_id' in note
      ? { ...note, node_id: bind(note.node_id) } : note) } : {}),
    ...(Array.isArray(input.add_node_ids) ? { add_node_ids: input.add_node_ids.map(bind) } : {}),
    ...(Array.isArray(input.prune_node_ids) ? { prune_node_ids: input.prune_node_ids.map(bind) } : {}),
  } as T;
}

/** One fault per offending entry of a graph-edit id list, at its element path, never echoing the id (D-102). */
function idFaults(field: 'add_node_ids' | 'prune_node_ids', sent: readonly string[], offenders: readonly string[], code: IssueCode): ToolRejection {
  return makeRejection({ code: REJECTION_CODES.validation, issuePaths: [field], resend: [field],
    errors: at(code, sent.flatMap((id, index) => offenders.includes(id) ? [`${field}.${index}`] : [])) });
}

/** Fills a render that amends a committed report back out to a complete section array. */
function resolveRetainedSections(
  supplied: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> | undefined,
  committed: NonNullable<ResultGraph['sections']>,
  renderedNodeIds: ReadonlySet<string>,
): { sections: Array<{ label: string; node_ids: string[]; text: string }>; unknownIndexes: number[] } {
  const byLabel = new Map(committed.map(sec => [normalizePresentSectionLabel(sec.label), sec]));
  const source: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> = supplied?.length
    ? supplied
    : committed.map(sec => ({ label: sec.label }));
  const sections: Array<{ label: string; node_ids: string[]; text: string }> = [];
  const unknownIndexes: number[] = [];
  for (const [index, sec] of source.entries()) {
    const kept = byLabel.get(normalizePresentSectionLabel(sec.label));
    const nodeIds = sec.node_ids ?? kept?.node_ids?.filter(id => renderedNodeIds.has(id)) ?? [];
    if (typeof sec.text === 'string') {
      sections.push({ label: sec.label, node_ids: nodeIds, text: sec.text });
      continue;
    }
    if (!kept?.text) {
      unknownIndexes.push(index);
      continue;
    }
    sections.push({ label: sec.label, node_ids: nodeIds, text: kept.text });
  }
  return { sections, unknownIndexes };
}

/** The notes an amendment renders: the committed captions for nodes still shown, overlaid by this call's notes by node id — the one merge both the rendered view and the committed `resultGraph.notes` take, so a follow-up that edits one caption does not blank every other caption on the graph. */
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

function buildColumnAspectNodeVerdicts(
  nodeIds: readonly string[],
  columnAspect: NonNullable<ResultGraph['columnAspect']>,
  nodeStates: ResultGraph['node_states'],
  identifierCaseSensitive = false,
) {
  const key = (id: string): string => schemaKey(id, identifierCaseSensitive);
  const referenced = new Set(nodeIds.map(key));
  for (const e of columnAspect.edges) referenced.add(key(e.hop_node));
  return (nodeStates ?? [])
    .filter(ns => referenced.has(key(ns.nodeId)))
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

/** Builds and persists the final lineage presentation for the active turn. */
export async function executePresentResult(input: unknown, s: ToolServices): Promise<string> {
    try {
      const sess = s.getSession();
      const rawInput = input;
      const turnEpoch = s.turnEpoch(sess);
      const drafts = sess.presentResultRepairDraft;
      const presentResultStage: PresentResultStage = sess.activeLmStage?.kind === 'visual_preview'
        ? 'visual_preview' : sess.phase.kind === 'completed' ? 'completed' : 'synthesis';
      const attemptWrite = sess.beginPresentResultAttempt(turnEpoch);
      if (attemptWrite.kind !== 'accepted') {
        return s.logAndReturn('lineage_present_result', makeRejection({
          code: REJECTION_CODES.staleTurn,
          reason: 'The turn no longer owns this session; the result was not rendered.',
          errors: at('backend_fault'),
        }), rawInput);
      }
      const model = s.requireModel();
      const isVisualPreview = presentResultStage === 'visual_preview';
      const previewNarrative = isVisualPreview && sess.lastDiscoveryAnswer
        ? discoveryPreviewNarrative(sess.lastDiscoveryAnswer)
        : null;

      const reject = (rejection: ToolRejection): string => {
        sess.recordPresentResultFailure(turnEpoch);
        return s.logAndReturn('lineage_present_result', rejection, rawInput);
      };

      const retainableSections = !isVisualPreview ? sess.retainableReportSections() : null;
      const schema = presentResultSchemaForPhase(
          presentResultStage, sess.presentResultRepairFields, retainableSections !== null,
          previewNarrative?.blocks.length ?? 0, sess.presentResultRepairHighlightLabelIndexes ?? undefined,
          sess.presentResultRepairSectionLeaves ?? undefined,
        );
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
        const repaired = holdRejectedPresentResult(drafts, input, rejection.issuePaths ?? [], presentResultStage, retainableSections, false, rejection);
        const authorization = drafts.getAuthorization();
        const held = drafts.get();
        if (!repaired && held && authorization) {
          rejection.resend = [...authorization.fields];
          rejection.resendRules = presentResultResendRules(authorization.fields, (held.sections?.length ?? 0) > 0, authorization.highlightLabelIndexes, authorization.sectionLeaves);
        }
        return reject(rejection);
      }
      input = bindPresentationReferences(parsed.data as PresentResultInput | PresentResultRepairPatch, model);

      const heldDraft = drafts.get();
      const held = heldDraft ? bindPresentationReferences(heldDraft, model) : heldDraft;
      const authorization = drafts.getAuthorization();
      let presentInput: PresentResultInput;
      if (held && authorization) {
        const patch = input as PresentResultRepairPatch;
        const textless = authorization.sectionLeaves
          ? []
          : findTextlessNewSections(
            held.sections,
            (patch.sections ?? []) as Parameters<typeof findTextlessNewSections>[1],
          );
        if (textless.length > 0) {
          const body = isVisualPreview ? 'start' : 'text';
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            errors: at('missing', textless.map(index => `sections.${index}.${body}`)),
            issuePaths: ['sections'],
            resend: [...authorization.fields],
            resendRules: presentResultResendRules(authorization.fields, (held.sections?.length ?? 0) > 0, authorization.highlightLabelIndexes),
          }));
        }
        presentInput = mergePresentResultRepairPatch(held, patch, authorization, model.identifierCaseSensitive);
        const mergedSchema = mergedSectionsSchemaForPhase(presentResultStage, previewNarrative?.blocks.length ?? 0);
        const merged = presentInput.sections === undefined && retainableSections
          ? { success: true as const }
          : mergedSchema.safeParse({ sections: presentInput.sections });
        if (!merged.success) {
          const paths = [...merged.error.issues.map(issue => issue.path.join('.')),
            ...authorization.fields.filter(field => presentInput[field] === undefined)];
          const rejection = rejectionFromZodError(merged.error, {
            code: REJECTION_CODES.validation, input: { sections: presentInput.sections }, schema: mergedSchema,
          });
          if (!holdRejectedPresentResult(drafts, presentInput, paths, presentResultStage, retainableSections, true, rejection)) {
            rejection.resend = [...authorization.fields];
            rejection.resendRules = presentResultResendRules(authorization.fields, (held.sections?.length ?? 0) > 0, authorization.highlightLabelIndexes, authorization.sectionLeaves);
          }
          return reject(rejection);
        }
      } else {
        presentInput = input as PresentResultInput;
      }
      if (isVisualPreview) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
          ? sess.discoveryScopeArtifact
          : null;
        if (!previewNarrative?.summary || !scope) {
          return reject(makeRejection({ code: REJECTION_CODES.previewSourceUnavailable, errors: at('no_result_source') }));
        }
        presentInput = { ...presentInput, summary: previewNarrative.summary, title: previewNarrative.title };
      }

      const rejectGraphEdit = (field: 'add_node_ids' | 'prune_node_ids', rejection: ToolRejection): string => {
        if (!held) return reject(rejection);
        drafts.hold(presentInput, { fields: [field] });
        return reject({ ...rejection, resend: [field] });
      };

      if (previewNarrative) {
        const partition = findStartOrderIssues(presentInput.sections ?? []);
        if (partition.length > 0) {
          const paths = partition.map(index => `sections.${index}.start`);
          const rejection = makeRejection({ code: REJECTION_CODES.validation, reason: START_ORDER_FAULT, errors: at('start_order', paths), resend: ['sections'], resendRules: ['sections'] });
          holdRejectedPresentResult(drafts, presentInput, paths, presentResultStage, null, true, rejection);
          return reject(rejection);
        }
      }

      // A completed run accepts graph edits; a preview or synthesis render does not.
      const graphEditable = presentResultStage === 'completed';
      const isAmendment = graphEditable && presentInput.is_update === true;

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
      if (!resultGraph) return reject(makeRejection({ code: REJECTION_CODES.missingResultGraph, errors: at('no_result_source') }));

      let resolvedNodeIds: string[] = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      const modelNodeMap = getModelNodeMap(model);
      // A graph edit changes the rendered view, so its ids and edges commit with it.
      let graphEdited = false;

      if (graphEditable && presentInput.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const addResolution = resolveModelNodeIds(presentInput.add_node_ids, modelNodeMap, model.identifierCaseSensitive);
        if (addResolution.unresolved.length > 0) {
          return rejectGraphEdit('add_node_ids', idFaults('add_node_ids', presentInput.add_node_ids, addResolution.unresolved, 'not_found'));
        }
        const toAdd = addResolution.resolved.filter(id => !currentSet.has(id));
        const scopeSnapshot = sess.stateMachine?.toJSON() ?? null;
        const outOfScope = scopeSnapshot
          ? toAdd.filter(id => !scopeSnapshot.scopeNodeIds.includes(id))
          : [];
        if (outOfScope.length > 0) {
          return rejectGraphEdit('add_node_ids', idFaults('add_node_ids', presentInput.add_node_ids,
            presentInput.add_node_ids.filter(raw => outOfScope.includes(resolveModelNodeId(raw, modelNodeMap, model.identifierCaseSensitive) ?? raw)), 'out_of_scope'));
        }
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type, modelNodeMap.get(e.source)?.type ?? '')] as [string, string, string]);
        graphEdited = true;
      }

      if (graphEditable && presentInput.prune_node_ids?.length) {
        const pruneResolution = resolveModelNodeIds(presentInput.prune_node_ids, modelNodeMap, model.identifierCaseSensitive);
        if (pruneResolution.unresolved.length > 0) {
          return rejectGraphEdit('prune_node_ids', idFaults('prune_node_ids', presentInput.prune_node_ids, pruneResolution.unresolved, 'not_found'));
        }
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, pruneResolution.resolved);
        resolvedNodeIds = pruned.nodeIds;
        resolvedEdges = pruned.edges;
        graphEdited = true;
      }

      if (resultGraph.originNodeId) {
        if (!resolvedNodeIds.includes(resultGraph.originNodeId)) {
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: 'The view must keep the origin node, and prune_node_ids prunes it.',
            errors: at('prunes_origin', ['prune_node_ids']),
          }));
        }
        const disconnected = findDisconnectedViewNodes(resolvedNodeIds, resolvedEdges, resultGraph.originNodeId);
        if (disconnected.length > 0) {
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: `${disconnected.length} view node(s) would be disconnected from the origin node.`,
            errors: at('disconnects_view'),
          }));
        }
      }

      if (retainableSections) {
        const retained = resolveRetainedSections(presentInput.sections, retainableSections, new Set(resolvedNodeIds));
        if (retained.unknownIndexes.length > 0) {
          const labels = retainableSections.map(sec => sec.label);
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            errors: presentInput.sections?.length ? at('uncommitted_label', retained.unknownIndexes.map(index => `sections.${index}.label`), labels) : at('missing', ['sections']),
            issuePaths: ['sections'],
            resend: ['sections'],
          }));
        }
        const keptCount = retained.sections.length - (presentInput.sections ?? []).filter(sec => typeof sec.text === 'string').length;
        if (keptCount > 0) {
          s.logger.debug(`[Presentation] ${keptCount} of ${retained.sections.length} section(s) kept from the committed report — run=${sess.explorationRunId ?? '(none)'}`);
        }
        presentInput.sections = retained.sections;
      }

      if (isAmendment) {
        presentInput.notes = mergeAmendedNotes(resultGraph.notes, presentInput.notes ?? [], resolvedNodeIds)
          .map(note => ({ node_id: note.nodeId, caption: note.text }));
      }

      const evidenceViolations: PresentResultViolation[] = [];
      let renderInput: PresentResultInput = isVisualPreview && presentInput.sections
        ? { ...presentInput, sections: assemblePreviewSections(previewNarrative?.blocks ?? [], presentInput.sections) }
        : presentInput;
      if (!isVisualPreview && presentInput.sections?.length) {
        // Validate SQL fences and expand references to captured evidence.
        // Number fences over the slots the completion envelope served: the render bound stored with the result.
        const servedIds = new Set(sess.resultGraph?.evidenceNodeIds ?? []);
        const evidenceBlocks = assignEvidenceIds(sess.memory.getResult().detail_slots.filter(slot => servedIds.has(slot.nodeId))).blocks;
        const expand = (text: string, fieldLabel: string, fieldPath = fieldLabel): string => {
          const expanded = expandEvidenceRefs(text, evidenceBlocks);
          const field = fieldPath.startsWith('sections.') ? 'sections' : fieldPath as 'title' | 'intro' | 'closing';
          if (expanded.unknownIds.length > 0) {
            evidenceViolations.push({
              errors: at('unknown_evidence_id', [fieldPath]),
              repairFields: [field],
              paths: [fieldPath],
            });
          }
          if (expanded.malformedRefs.length > 0) {
            evidenceViolations.push({
              errors: at('unclosed_fence', [fieldPath]),
              repairFields: [field],
              paths: [fieldPath],
            });
          }
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
          sections: presentInput.sections.map((sec, index) => {
            const expanded = expand(sec.text, `section "${trunc(sec.label, 60)}"`, `sections.${index}.text`);
            return expanded === sec.text ? sec : { ...sec, text: expanded };
          }),
        };
        const slotChars = sess.memory.getResult().detail_slots
          .reduce((total, slot) => total + slot.sections.reduce((sum, section) => sum + section.text.length, 0), 0);
        const coverage = evidenceCoverage(evidenceBlocks, [renderInput.title, renderInput.intro, renderInput.closing, ...(renderInput.sections ?? []).map(sec => sec.text)].filter((text): text is string => text !== undefined));
        s.logger.debug(
          `[Presentation] retention — slotChars=${slotChars} sectionChars=${presentInput.sections.reduce((sum, sec) => sum + sec.text.length, 0)} ` +
          `sections(nodes:chars)=[${presentInput.sections.map(sec => `${sec.node_ids?.length ?? 0}:${sec.text.length}`).join(', ')}] ` +
          `fences served=${coverage.served} shown=${coverage.served - coverage.unusedIds.length} unused=[${coverage.unusedIds.join(', ')}]`,
        );
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
          ? buildColumnChainPreface(resultGraph.columnAspect.edges, resultGraph.columnAspect.requested, model.identifierCaseSensitive)
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
        `[Presentation] Output assembled — sections=${presentInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount} slotsUnrendered=${unrenderedSlotIds.length}`
      );
      s.logger.debug(`[Presentation] Output assembled title="${trunc(presentInput.title ?? '(none)', 60)}"`);

      const externalViolations: PresentResultViolation[] = [...evidenceViolations];
      if (unrenderedSlotIds.length > 0) {
        externalViolations.push({
          missingContent: true,
          errors: at('slot_unplaced', ['sections.*.node_ids'], unrenderedSlotIds),
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: unrenderedSlotIds,
        });
      }

      let smSnapshot: SmState | null | undefined;
      const nodeIdState: PresentNodeIdStateLookup = (nodeId): PresentNodeIdState => {
        if (!modelNodeMap.has(nodeId)) return 'not_in_model';

        if (smSnapshot === undefined) smSnapshot = sess.stateMachine?.toJSON() ?? null;
        if (!smSnapshot) return 'out_of_scope';
        if (smSnapshot.removedSet.includes(nodeId)) return 'pruned';
        if (smSnapshot.scopeNodeIds.includes(nodeId)) return 'in_scope_undispositioned';
        return 'out_of_scope';
      };
      const validation = validatePresentResult(renderInput, resolvedNodeIds, assembledBadges, assembledDescription, externalViolations, presentResultStage, nodeIdState);

      if (!validation.success) {
        if (validation.repairable) {
          if (!holdRejectedPresentResult(drafts, presentInput, validation.rejection.issuePaths ?? [], presentResultStage, retainableSections, true, validation.rejection)) {
            drafts.hold(presentInput, { fields: validation.repairFields });
          }
        }
        return reject(validation.rejection);
      }

      // A rendered result belongs to its run.
      const runId = sess.explorationRunId ?? sess.id;
      const renderedNotes = validation.notes.map(n => ({ nodeId: n.node_id, text: n.caption }));
      const aiMetadata: PresentationArtifact['aiMetadata'] = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName ?? 'unknown',
        ...(runId ? { runId } : {}),
        highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
        badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
        notes: renderedNotes,
        layoutDirection: validation.layout_direction,
        ...(resultGraph.columnAspect ? {
          columnAspect: {
            ...(resultGraph.columnAspect.requested ? { requested: {
              node: resultGraph.columnAspect.requested.node, columns: [...resultGraph.columnAspect.requested.columns],
            } } : {}),
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
          nodeVerdicts: buildColumnAspectNodeVerdicts(validation.node_ids, resultGraph.columnAspect, resultGraph.node_states, model.identifierCaseSensitive),
        } : {}),
      };
      let autoDispatched = false;
      let previewFailure: 'preview_post_failed' | 'preview_dispatch' | null = null;
      s.signal?.throwIfAborted();
      try {
        const delivery = await s.deliverPreview(
          { type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata },
        );
        autoDispatched = delivery === 'delivered';
        // A cancel ends the turn, but a preview the canvas already shows is committed first so the
        // session matches the screen; an undrawn preview is dropped.
        if (!autoDispatched) s.signal?.throwIfAborted();
        if (delivery === 'post_failed') {
          s.logger.warn('AI preview post failed');
          previewFailure = 'preview_post_failed';
        }
      } catch (error) {
        if (isCancellationOutcome(error, s.signal)) throw error;
        s.logger.warn(`AI preview dispatch failed: ${error instanceof Error ? error.name : 'Error'}`);
        previewFailure = 'preview_dispatch';
      }

      /** Writes the accepted render into the graph it was drawn from. */
      const commitToGraph = (): void => {
        if (isAmendment || graphEdited) {
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
      };

      const checkpoint = captureCheckpoint(sess, s.logger);
      const artifact: PresentationArtifact = {
        name: validation.name,
        nodeIds: [...validation.node_ids],
        aiMetadata,
        ...(checkpoint ? { runId, checkpoint } : {}),
      };
      const repeatedSuccess = sess.presentResultCalledThisTurn;
      const successWrite = sess.commitPresentResultSuccess(turnEpoch, artifact, autoDispatched);
      if (successWrite.kind !== 'accepted') {
        return s.logAndReturn('lineage_present_result', makeRejection({
          code: REJECTION_CODES.staleTurn,
          reason: 'The turn no longer owns this session; the result was not committed.',
          errors: at('backend_fault'),
        }), rawInput);
      }
      // The delivery outcome is recorded only once the turn still owns the session, and the latest present decides it.
      if (previewFailure) sess.markSynthesisRenderDegraded(previewFailure);
      else sess.clearPreviewDeliveryDegraded();
      commitToGraph();
      if (previewGraph) sess.resultGraph = resultGraph;
      s.signal?.throwIfAborted();
      if (repeatedSuccess) {
        s.logger.debug(`[Presentation] repeated present_result in one turn (success #${sess.presentResultAttemptCountThisTurn}) — single-shot guard may have regressed`);
      }

      s.logger.debug(`AI view name="${trunc(validation.name, 60)}"`);
      s.logger.info(`AI view displayed — nodes=${validation.node_ids.length} sections=${presentInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} badges=${validation.badges.length} classification=${sess.classification ?? '(none)'} attempts=${sess.presentResultAttemptCountThisTurn} failures=${sess.presentResultFailureCountThisTurn}`);
      return s.logAndReturn('lineage_present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, rawInput);
    } catch (err) {
      if (isCancellationOutcome(err, s.signal)) throw err;
      return s.toolError('present_result', err);
    }
}
