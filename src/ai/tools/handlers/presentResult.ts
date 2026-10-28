/** Executes validation, assembly, and persistence for `lineage_present_result`. */
import { type AiSession } from '../../session/session';
import { trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import {
  validatePresentResult, orderAndAssemble, findDisconnectedViewNodes,
  findBareNonPrunedNodes, findUnrenderedDetailSlotIds, requiredDetailSlotIds, buildColumnChainPreface,
  discoveryPreviewNarrative,
  findStartOrderIssues,
  START_ORDER_FAULT,
  assemblePreviewSections,
  assignEvidenceIds,
  expandEvidenceRefs,
  evidenceCoverage,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultStage,
  type PresentNodeIdState,
  type PresentNodeIdStateLookup,
} from '../../tools/presentResult';
import { normalizePresentSectionLabel, presentResultSchemaForPhase } from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { resolveModelNodeId, resolveModelNodeIds } from '../../support/modelReferences';
import { at, combineToolRejections, makeRejection, rejectionFromZodError, type IssueCode, type ToolRejection } from '../../support/toolErrorEnvelope';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { isCancellationOutcome } from '../../support/cancellation';

/** Binds only declared report-reference fields; raw arguments and authored text remain intact. */
function bindPresentationReferences<T extends PresentResultInput>(input: T, model: NonNullable<AiSession['model']>): T {
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
  known: (path: string) => boolean = () => true,
): { sections: Array<{ label: string; node_ids: string[]; text: string }>; unknownIndexes: number[] } {
  const byLabel = new Map(committed.map(sec => [normalizePresentSectionLabel(sec.label), sec]));
  const source: ReadonlyArray<{ label: string; node_ids?: string[]; text?: string }> = supplied?.length
    ? supplied
    : committed.map(sec => ({ label: sec.label }));
  const sections: Array<{ label: string; node_ids: string[]; text: string }> = [];
  const unknownIndexes: number[] = [];
  for (const [index, sec] of source.entries()) {
    if (!sec || typeof sec !== 'object' || typeof sec.label !== 'string' || !known(`sections.${index}.label`) || !known(`sections.${index}.text`)) continue;
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

      const retainableSections = !isVisualPreview ? sess.retainableReportSections() : null;
      const schema = presentResultSchemaForPhase(presentResultStage, retainableSections !== null, previewNarrative?.blocks.length ?? 0);
      const candidate = drafts.apply(`${turnEpoch}:${presentResultStage}`, input, schema);
      if (drafts.unchanged) s.logger.debug('[Hold] identical resend no-op tool=lineage_present_result');
      const reject = (rejection: ToolRejection): string => {
        const paths = [...new Set(rejection.errors.map(error => error.path))];
        const overwritten = drafts.retain(candidate, paths, schema);
        const resend = [...new Set([...(rejection.resend ?? []), ...paths.map(path => path.split('.')[0]).filter(Boolean)])];
        sess.recordPresentResultFailure(turnEpoch);
        return s.logAndReturn('lineage_present_result', { ...rejection, resend,
          errors: [...rejection.errors, ...at('not_overwritten', overwritten)] }, rawInput);
      };
      const parsed = schema.safeParse(candidate);
      const schemaProblem = parsed.success ? undefined : rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input: candidate, schema });
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return reject(schemaProblem!);
      const rejections: ToolRejection[] = schemaProblem ? [schemaProblem] : [];
      const known = (path: string): boolean => !schemaProblem?.errors.some(error => error.code !== 'unknown_key'
        && (error.path === '' || error.path === path || path.startsWith(`${error.path}.`)));
      let presentInput = bindPresentationReferences((parsed.success ? parsed.data : candidate) as PresentResultInput, model);
      if (isVisualPreview) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
          ? sess.discoveryScopeArtifact
          : null;
        if (!previewNarrative?.summary || !scope) {
          return reject(combineToolRejections([...rejections, makeRejection({ code: REJECTION_CODES.previewSourceUnavailable, errors: at('no_result_source') })]));
        }
        presentInput = { ...presentInput, summary: previewNarrative.summary, title: previewNarrative.title };
      }

      if (previewNarrative && Array.isArray(presentInput.sections) && known('sections')) {
        const partition = findStartOrderIssues(presentInput.sections, known);
        if (partition.length > 0) {
          const paths = partition.map(index => `sections.${index}.start`);
          const rejection = makeRejection({ code: REJECTION_CODES.validation, reason: START_ORDER_FAULT, errors: at('start_order', paths), resend: ['sections'] });
          rejections.push(rejection);
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
      if (!resultGraph) return reject(combineToolRejections([...rejections, makeRejection({ code: REJECTION_CODES.missingResultGraph, errors: at('no_result_source') })]));

      let resolvedNodeIds: string[] = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      const modelNodeMap = getModelNodeMap(model);
      // A graph edit changes the rendered view, so its ids and edges commit with it.
      let graphEdited = false;

      let viewKnown = !graphEditable || (['add_node_ids', 'prune_node_ids'] as const).every(field => known(field)
        && (presentInput[field] === undefined || (Array.isArray(presentInput[field]) && presentInput[field]!.every((_id, index) => known(`${field}.${index}`)))));
      let toAdd: string[] = [], toPrune: string[] = [];
      for (const field of ['add_node_ids', 'prune_node_ids'] as const) {
        const sent = presentInput[field];
        if (!graphEditable || !Array.isArray(sent) || !known(field)) continue;
        const identifiers = sent.filter((id, index) => known(`${field}.${index}`) && typeof id === 'string');
        const resolution = resolveModelNodeIds(identifiers, modelNodeMap, model.identifierCaseSensitive);
        if (resolution.unresolved.length) { rejections.push(idFaults(field, sent, resolution.unresolved, 'not_found')); viewKnown = false; }
        if (field === 'prune_node_ids') toPrune = resolution.resolved;
        else {
          const scope = sess.stateMachine?.toJSON();
          const outside = scope ? resolution.resolved.filter(id => !resolvedNodeIds.includes(id) && !scope.scopeNodeIds.includes(id)) : [];
          if (outside.length) { rejections.push(idFaults(field, sent, outside, 'out_of_scope')); viewKnown = false; }
          toAdd = resolution.resolved.filter(id => !resolvedNodeIds.includes(id));
        }
      }
      if (viewKnown && toAdd.length) {
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges.filter(edge => newSet.has(edge.source) && newSet.has(edge.target))
          .map(edge => [edge.source, edge.target, edgeApiType(edge.type, modelNodeMap.get(edge.source)?.type ?? '')] as [string, string, string]);
        graphEdited = true;
      }
      if (viewKnown && toPrune.length) {
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, toPrune);
        resolvedNodeIds = pruned.nodeIds; resolvedEdges = pruned.edges; graphEdited = true;
      }
      if (resultGraph.originNodeId) {
        if ((viewKnown && !resolvedNodeIds.includes(resultGraph.originNodeId)) || (!viewKnown && toPrune.includes(resultGraph.originNodeId))) {
          rejections.push(makeRejection({ code: REJECTION_CODES.validation, reason: 'The view must keep the origin node, and prune_node_ids prunes it.', errors: at('prunes_origin', ['prune_node_ids']) }));
        }
        if (viewKnown) {
          const disconnected = findDisconnectedViewNodes(resolvedNodeIds, resolvedEdges, resultGraph.originNodeId);
          if (disconnected.length) rejections.push(makeRejection({ code: REJECTION_CODES.validation, reason: `${disconnected.length} view node(s) would be disconnected from the origin node.`, errors: at('disconnects_view') }));
        }
      }

      if (retainableSections && (presentInput.sections === undefined || Array.isArray(presentInput.sections))) {
        const retained = resolveRetainedSections(presentInput.sections, retainableSections, new Set(resolvedNodeIds), known);
        if (retained.unknownIndexes.length > 0) {
          const labels = retainableSections.map(sec => sec.label);
          rejections.push(makeRejection({
            code: REJECTION_CODES.validation,
            errors: presentInput.sections?.length ? at('uncommitted_label', retained.unknownIndexes.map(index => `sections.${index}.label`), labels) : at('missing', ['sections']),
            issuePaths: ['sections'],
            resend: ['sections'],
          }));
        }
        const keptCount = parsed.success ? retained.sections.length - (presentInput.sections ?? []).filter(sec => typeof sec.text === 'string').length : 0;
        if (keptCount > 0) {
          s.logger.debug(`[Presentation] ${keptCount} of ${retained.sections.length} section(s) kept from the committed report — run=${sess.explorationRunId ?? '(none)'}`);
        }
        if (viewKnown && !retained.unknownIndexes.length && !schemaProblem?.errors.some(error => error.path === 'sections' || error.path.startsWith('sections.'))) presentInput.sections = retained.sections;
      }

      if (isAmendment && parsed.success) {
        presentInput.notes = mergeAmendedNotes(resultGraph.notes, presentInput.notes ?? [], resolvedNodeIds)
          .map(note => ({ node_id: note.nodeId, caption: note.text }));
      }

      const evidenceViolations: PresentResultViolation[] = [];
      let renderInput: PresentResultInput = isVisualPreview && parsed.success && !rejections.length && presentInput.sections
        ? { ...presentInput, sections: assemblePreviewSections(previewNarrative?.blocks ?? [], presentInput.sections) }
        : presentInput;
      if (!isVisualPreview) {
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
          text === undefined || !known(fieldLabel) || typeof text !== 'string' ? text : expand(text, fieldLabel);
        renderInput = {
          ...presentInput,
          title: expandOptional(presentInput.title, 'title'),
          intro: expandOptional(presentInput.intro, 'intro'),
          closing: expandOptional(presentInput.closing, 'closing'),
          ...(Array.isArray(presentInput.sections) && known('sections') ? { sections: presentInput.sections.map((sec, index) => {
            if (!sec || !known(`sections.${index}.text`) || typeof sec.text !== 'string') return sec;
            const expanded = expand(sec.text, `sections.${index}.text`);
            return expanded === sec.text ? sec : { ...sec, text: expanded };
          }) } : {}),
        };
        if (parsed.success && Array.isArray(presentInput.sections)) {
        const slotChars = sess.memory.getResult().detail_slots
          .reduce((total, slot) => total + slot.sections.reduce((sum, section) => sum + section.text.length, 0), 0);
        const coverage = evidenceCoverage(evidenceBlocks, [renderInput.title, renderInput.intro, renderInput.closing, ...(renderInput.sections ?? []).map(sec => sec.text)].filter((text): text is string => text !== undefined));
        s.logger.debug(
          `[Presentation] retention — slotChars=${slotChars} sectionChars=${presentInput.sections.reduce((sum, sec) => sum + sec.text.length, 0)} ` +
          `sections(nodes:chars)=[${presentInput.sections.map(sec => `${sec.node_ids?.length ?? 0}:${sec.text.length}`).join(', ')}] ` +
          `fences served=${coverage.served} shown=${coverage.served - coverage.unusedIds.length} unused=[${coverage.unusedIds.join(', ')}]`,
        );
        }
      }

      if (parsed.success) s.logger.debug(`presentResult section[0] preview: ${trunc(renderInput.sections?.[0]?.text ?? '(empty)', 200)}`);

      const bareNodeIds = parsed.success ? findBareNonPrunedNodes(resultGraph, renderInput, resolvedNodeIds) : [];
      if (bareNodeIds.length > 0) {
        s.logger.debug(`[Presentation] ${bareNodeIds.length} non-pruned node(s) left bare by the AI (rendered unlabeled/uncolored) — ${trunc(bareNodeIds.join(', '), 200)}`);
      }

      const renderedNodeIds = new Set(resolvedNodeIds);
      const unrenderedSlotIds = viewKnown ? findUnrenderedDetailSlotIds(
        requiredDetailSlotIds(sess.memory.notedNodeIds, renderedNodeIds),
        renderInput, known,
      ) : undefined;
      if (unrenderedSlotIds && unrenderedSlotIds.length > 0) {
        s.logger.debug(`[Presentation] ${unrenderedSlotIds.length} of ${sess.memory.slotCount} detail slot(s) reached no section — ${trunc(unrenderedSlotIds.join(', '), 200)}`);
      }

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (parsed.success && !rejections.length && !evidenceViolations.length && renderInput.sections?.length) {
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

      if (parsed.success) s.logger.info(
        `[Presentation] Output assembled — sections=${presentInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount} slotsUnrendered=${unrenderedSlotIds?.length ?? 'unknown'}`
      );
      if (parsed.success) s.logger.debug(`[Presentation] Output assembled title="${trunc(presentInput.title ?? '(none)', 60)}"`);

      const externalViolations: PresentResultViolation[] = [...evidenceViolations];
      if (unrenderedSlotIds?.length) {
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
      const validation = validatePresentResult(renderInput, resolvedNodeIds, assembledBadges, assembledDescription, externalViolations, presentResultStage, nodeIdState, known, viewKnown);

      if (!validation.success) return reject(combineToolRejections([...rejections, validation.rejection]));
      if (rejections.length) return reject(combineToolRejections(rejections));

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
