/** Executes validation, assembly, and persistence for `lineage_present_result`. */
import { type AiSession } from '../../session/session';
import { trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import {
  inspectPresentResult, completePresentResult, orderAndAssemble, findDisconnectedViewNodes,
  findBareNonPrunedNodes, unplacedDetailSlotIds, requiredDetailSlotIds, buildColumnChainPreface,
  discoveryPreviewNarrative,
  findStartOrderIssues,
  START_ORDER_FAULT,
  assemblePreviewSections,
  assignEvidenceIds,
  expandEvidenceRefs,
  evidenceCoverage,
  type PresentReference,
  type PresentResultViolation,
  type PresentResultInput,
  type PresentResultStage,
  type PresentNodeIdState,
  type PresentNodeIdStateLookup,
} from '../../tools/presentResult';
import { normalizePresentSectionLabel, presentResultSchemaForPhase, ReportFactSchemas } from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { resolveModelNodeId } from '../../support/modelReferences';
import { at, makeRejection, type IssueCode } from '../../support/toolErrorEnvelope';
import { type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { isCancellationOutcome } from '../../support/cancellation';
import { ingestToolInput } from '../../support/toolIngestion';
import { captureToolFact, type ToolFactContext } from '../../support/toolValidation';
import type { z } from 'zod';

/** Only independently admitted field values enter this partial record. */
type ReportFields = { [K in keyof typeof ReportFactSchemas.fields]?: z.output<typeof ReportFactSchemas.fields[K]> };
type ReportSection = z.output<typeof ReportFactSchemas.section>;

/** Resolves one original section position against an already committed report. */
function resolveRetainedSection(
  supplied: ReportSection, committed: NonNullable<ResultGraph['sections']>, rendered: ReadonlySet<string>,
): { label: string; node_ids: string[]; text: string } | undefined {
  const kept = committed.find(section => normalizePresentSectionLabel(section.label) === normalizePresentSectionLabel(supplied.label));
  const text = supplied.text ?? kept?.text;
  if (text === undefined) return undefined;
  return { label: supplied.label, node_ids: supplied.node_ids ?? kept?.node_ids?.filter(id => rendered.has(id)) ?? [], text };
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
      const fields: ReportFields = {};
      const supplied = new Set<string>();
      let objectKnown = false;
      const counts = new Map<string, number>();
      const sectionRows = new Map<number, ReportSection>();
      const sectionKeys = new Map<number, ReadonlySet<string>>();
      const labels = new Map<number, string>();
      const nodeLists = new Map<string, string[]>();
      const texts = new Map<string, string>();
      const starts = new Map<number, string>();
      const references: PresentReference[] = [];
      const editIds = new Map<string, string>();
      const modelNodeMap = getModelNodeMap(model);
      const bindings = new Map<string, string>();
      const bind = (id: string): string => {
        if (!bindings.has(id)) bindings.set(id, resolveModelNodeId(id, modelNodeMap, model.identifierCaseSensitive) ?? id);
        return bindings.get(id)!;
      };
      const dot = (path: string): string => path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');
      const validated = new Map<string, (value: unknown, path: string) => void>();
      for (const key of Object.keys(ReportFactSchemas.fields) as Array<keyof ReportFields>) {
        validated.set(`report.${key}`, captureToolFact(ReportFactSchemas.fields[key], value => { Object.assign(fields, { [key]: value }); }));
      }
      validated.set('report.section', captureToolFact(ReportFactSchemas.section, (value, path) => { sectionRows.set(Number(path.split('/')[2]), value); }));
      validated.set('report.label', captureToolFact(ReportFactSchemas.text, (value, path) => { labels.set(Number(path.split('/')[2]), value); }));
      validated.set('report.start', captureToolFact(ReportFactSchemas.start, (value, path) => { starts.set(Number(path.split('/')[2]), value); }));
      validated.set('report.text', captureToolFact(ReportFactSchemas.text, (value, path) => { texts.set(dot(path), value); }));
      validated.set('report.sectionNodes', captureToolFact(ReportFactSchemas.nodes, (value, path) => { nodeLists.set(dot(path), value.map(bind)); }));
      validated.set('report.node', captureToolFact(ReportFactSchemas.node, (value, path) => {
        const parts = dot(path).split('.'), nodeId = bind(value);
        if (parts[0] === 'add_node_ids' || parts[0] === 'prune_node_ids') editIds.set(parts.join('.'), nodeId);
        else if (parts[0] === 'sections' || parts[0] === 'highlight_groups' || parts[0] === 'notes') {
          references.push({ field: parts[0], heldPath: parts[0] === 'notes' ? parts.join('.') : parts.slice(0, 2).join('.'), path: parts.join('.'), nodeId });
        }
      }));
      const arrays: NonNullable<ToolFactContext['arrays']> = new Map(
        ['sections', 'notes'].map(role =>
          [`report.${role}`, (value: unknown[], context: { instancePath: string }) => { counts.set(dot(context.instancePath), value.length); }]),
      );
      const outcome = ingestToolInput({ input, schema, draft: drafts, context: `${turnEpoch}:${presentResultStage}`,
        facts: { validated, arrays, objects: new Map([
          ['report.input', value => { objectKnown = true; Object.keys(value).forEach(key => supplied.add(key)); }],
          ['report.sectionInput', (value, context) => { sectionKeys.set(Number(context.instancePath.split('/')[2]), new Set(Object.keys(value))); }],
        ]) },
        rejected: () => sess.recordPresentResultFailure(turnEpoch),
        log: line => s.logger.debug(`${line} tool=lineage_present_result`),
        committed: () => sess.presentResultCalledThisTurn,
        inspect: view => {
      const { parsed, problems: rejections } = view;
      if (!objectKnown) return undefined;
      if (isVisualPreview) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch ? sess.discoveryScopeArtifact : null;
        if (!previewNarrative?.summary || !scope) {
          view.add(makeRejection({ code: REJECTION_CODES.previewSourceUnavailable, errors: at('no_result_source') })); return undefined;
        }
        fields.summary = previewNarrative.summary; fields.title = previewNarrative.title;
        const partition = findStartOrderIssues(starts);
        if (partition.length) rejections.push(makeRejection({ code: REJECTION_CODES.validation, reason: START_ORDER_FAULT,
          errors: at('start_order', partition.map(index => `sections.${index}.start`)), resend: ['sections'] }));
      }
      const graphEditable = presentResultStage === 'completed';
      const isAmendment = graphEditable && fields.is_update === true;
      const previewScope = isVisualPreview && sess.discoveryScopeArtifact?.turnEpoch === turnEpoch ? sess.discoveryScopeArtifact : null;
      const previewGraph: ResultGraph | null = previewScope ? {
        nodeIds: [...previewScope.nodeIds], edges: [...previewScope.edges], source: 'discovery_preview', originNodeId: previewScope.origin,
      } : null;
      const resultGraph = previewGraph ?? sess.resultGraph;
      if (!resultGraph) { view.add(makeRejection({ code: REJECTION_CODES.missingResultGraph, errors: at('no_result_source') })); return undefined; }
      let resolvedNodeIds = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      let graphEdited = false;
      let viewKnown = !graphEditable || (['add_node_ids', 'prune_node_ids'] as const).every(key => !supplied.has(key) || fields[key] !== undefined);
      const toAdd: string[] = [], toPrune: string[] = [];
      const scope = graphEditable ? sess.stateMachine?.toJSON() : undefined;
      for (const [path, id] of editIds) {
        if (!graphEditable) continue;
        const key = path.split('.')[0];
        const issue: IssueCode | undefined = !modelNodeMap.has(id) ? 'not_found'
          : key === 'add_node_ids' && scope && !resolvedNodeIds.includes(id) && !scope.scopeNodeIds.includes(id) ? 'out_of_scope' : undefined;
        if (issue) {
          rejections.push(makeRejection({ code: REJECTION_CODES.validation, errors: at(issue, [path]), resend: [key] })); viewKnown = false;
        } else if (key === 'prune_node_ids') toPrune.push(id);
        else if (!resolvedNodeIds.includes(id)) toAdd.push(id);
      }
      if (viewKnown && toAdd.length) {
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges.filter(edge => newSet.has(edge.source) && newSet.has(edge.target))
          .map(edge => [edge.source, edge.target, edgeApiType(edge.type, modelNodeMap.get(edge.source)?.type ?? '')]);
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
      const rendered = new Set(resolvedNodeIds);
      const retainedRows = new Map<number, { label: string; node_ids: string[]; text: string }>();
      if (retainableSections) {
        const source = !supplied.has('sections') ? retainableSections.map(section => ({ label: section.label })) : undefined;
        for (const [index, row] of source?.entries() ?? sectionRows.entries()) {
          const retained = resolveRetainedSection(row, retainableSections, rendered);
          if (retained) retainedRows.set(index, retained);
        }
        // Link retention depends on the admitted label and omitted links, independently of authored text.
        for (const [index, label] of source ? source.map((row, index) => [index, row.label] as const) : labels) {
          const path = `sections.${index}.node_ids`;
          const kept = retainableSections.find(section => normalizePresentSectionLabel(section.label) === normalizePresentSectionLabel(label));
          if (!kept?.text && sectionKeys.get(index)?.has('text') === false) rejections.push(makeRejection({ code: REJECTION_CODES.validation,
            errors: at('uncommitted_label', [`sections.${index}.label`], retainableSections.map(section => section.label)), resend: ['sections'] }));
          if (source || sectionKeys.get(index)?.has('node_ids') === false) {
            if (kept) {
              const ids = (kept.node_ids ?? []).filter(id => rendered.has(id)); nodeLists.set(path, ids);
              ids.forEach((nodeId, idIndex) => references.push({ field: 'sections', heldPath: `sections.${index}`, path: `${path}.${idIndex}`, nodeId }));
            }
          }
        }
      }
      const sectionCount = counts.get('sections') ?? (!supplied.has('sections') && retainableSections ? retainableSections.length : undefined);
      const sectionCoverageKnown = sectionCount !== undefined && Array.from({ length: sectionCount }, (_, index) => nodeLists.has(`sections.${index}.node_ids`)).every(Boolean);
      const notesCount = counts.get('notes');
      const notesKnown = !supplied.has('notes') || (notesCount !== undefined && references.filter(ref => ref.field === 'notes').length === notesCount);
      if (isAmendment) for (const note of resultGraph.notes ?? []) if (rendered.has(note.nodeId) && note.summary) {
        references.push({ field: 'notes', heldPath: 'notes', path: 'notes', nodeId: note.nodeId });
      }
      const externalViolations: PresentResultViolation[] = [];
      const expandedTexts = new Map<string, string>();
      if (!isVisualPreview) {
        const servedIds = new Set(sess.resultGraph?.evidenceNodeIds ?? []);
        const evidenceBlocks = assignEvidenceIds(sess.memory.getResult().detail_slots.filter(slot => servedIds.has(slot.nodeId))).blocks;
        const expansionTexts = new Map(texts);
        for (const [index, row] of retainedRows) expansionTexts.set(`sections.${index}.text`, row.text);
        for (const [path, text] of expansionTexts) {
          const expanded = expandEvidenceRefs(text, evidenceBlocks);
          const repairField = path.startsWith('sections.') ? 'sections' : path as 'title' | 'intro' | 'closing';
          if (expanded.unknownIds.length) externalViolations.push({ errors: at('unknown_evidence_id', [path]), repairFields: [repairField], paths: [path] });
          if (expanded.malformedRefs.length) externalViolations.push({ errors: at('unclosed_fence', [path]), repairFields: [repairField], paths: [path] });
          for (const entry of expanded.normalized) s.logger.debug(`presentResult normalization: evidence reference ${entry} — ${path}`);
          expandedTexts.set(path, expanded.text);
        }
        const coverage = evidenceCoverage(evidenceBlocks, [...expandedTexts.values()]);
        s.logger.debug(`[Presentation] fences served=${coverage.served} shown=${coverage.served - coverage.unusedIds.length} unused=[${coverage.unusedIds.join(', ')}]`);
      }
      const linkedSections = new Set([...nodeLists.values()].flat());
      const unrenderedSlotIds = viewKnown && sectionCoverageKnown ? unplacedDetailSlotIds(requiredDetailSlotIds(sess.memory.notedNodeIds, rendered), linkedSections) : undefined;
      if (unrenderedSlotIds?.length) externalViolations.push({ missingContent: true,
        errors: at('slot_unplaced', ['sections.*.node_ids'], unrenderedSlotIds), repairFields: ['sections'], paths: ['sections'], entryIds: unrenderedSlotIds });
      let smSnapshot: SmState | null | undefined;
      const nodeIdState: PresentNodeIdStateLookup = (nodeId): PresentNodeIdState => {
        if (!modelNodeMap.has(nodeId)) return 'not_in_model';
        if (smSnapshot === undefined) smSnapshot = sess.stateMachine?.toJSON() ?? null;
        if (!smSnapshot) return 'out_of_scope';
        if (smSnapshot.removedSet.includes(nodeId)) return 'pruned';
        return smSnapshot.scopeNodeIds.includes(nodeId) ? 'in_scope_undispositioned' : 'out_of_scope';
      };
      const failure = inspectPresentResult({ references, coverageKnown: sectionCoverageKnown && notesKnown }, resolvedNodeIds,
        externalViolations, presentResultStage, nodeIdState, viewKnown);
      if (failure) view.add(failure.rejection);
      if (!parsed.success || rejections.length) return undefined;
      // Required fields here have passed the complete native phase schema; optional section bodies
      // come only from admitted rows, explicit cached preview blocks, or committed label retention.
      const completedSections = isVisualPreview
        ? assemblePreviewSections(previewNarrative!.blocks, fields.sections!.map(section => ({ label: section.label, node_ids: section.node_ids!.map(bind), start: section.start! })))
        : retainableSections ? [...retainedRows.values()] : fields.sections!.map(section => ({ label: section.label, node_ids: section.node_ids!.map(bind), text: section.text! }));
      let renderInput: PresentResultInput = {
        ...fields, name: fields.name!, summary: fields.summary!, highlight_groups: fields.highlight_groups!.map(group => ({ ...group, node_ids: group.node_ids.map(bind) })),
        sections: completedSections!,
        notes: fields.notes?.map(note => ({ ...note, node_id: bind(note.node_id) })),
      };
      if (isAmendment) renderInput.notes = mergeAmendedNotes(resultGraph.notes, renderInput.notes ?? [], resolvedNodeIds).map(note => ({ node_id: note.nodeId, caption: note.text }));
      if (!isVisualPreview) renderInput = { ...renderInput,
        title: expandedTexts.get('title') ?? renderInput.title, intro: expandedTexts.get('intro') ?? renderInput.intro, closing: expandedTexts.get('closing') ?? renderInput.closing,
        sections: renderInput.sections?.map((section, index) => ({ ...section, text: expandedTexts.get(`sections.${index}.text`) ?? section.text })),
      };
      const bareNodeIds = findBareNonPrunedNodes(resultGraph, renderInput, resolvedNodeIds);
      if (bareNodeIds.length) s.logger.debug(`[Presentation] ${bareNodeIds.length} non-pruned node(s) left bare by the AI — ${trunc(bareNodeIds.join(', '), 200)}`);
      const columnChainPreface = resultGraph.columnAspect ? buildColumnChainPreface(resultGraph.columnAspect.edges, resultGraph.columnAspect.requested, model.identifierCaseSensitive) : undefined;
      const assembled = renderInput.sections?.length ? orderAndAssemble(renderInput.sections, {
        title: renderInput.title, intro: renderInput.intro, closing: renderInput.closing, nodeMap: modelNodeMap,
        ...(columnChainPreface ? { preface: columnChainPreface } : {}),
      }) : undefined;
      const validation = completePresentResult(renderInput, resolvedNodeIds, assembled?.badges, assembled?.description);
      s.logger.info(`[Presentation] Output assembled — sections=${renderInput.sections?.length ?? 0} badges=${validation.badges.length} desc=${validation.description?.length ?? 0}chars slotsUnrendered=${unrenderedSlotIds?.length ?? 'unknown'}`);
      s.logger.debug(`[Presentation] Output assembled title="${trunc(renderInput.title ?? '(none)', 60)}"`);
      return async () => {

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
      s.logger.info(`AI view displayed — nodes=${validation.node_ids.length} sections=${renderInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} badges=${validation.badges.length} classification=${sess.classification ?? '(none)'} attempts=${sess.presentResultAttemptCountThisTurn} failures=${sess.presentResultFailureCountThisTurn}`);
      return s.logAndReturn('lineage_present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, rawInput);
      };
        },
      });
      return typeof outcome === 'object' && !(outcome instanceof Promise)
        ? s.logAndReturn('lineage_present_result', outcome, rawInput) : await outcome;
    } catch (err) {
      if (isCancellationOutcome(err, s.signal)) throw err;
      if (s.caller === 'turn') s.getSession().recordPresentResultFailure(s.turnEpoch(s.getSession()));
      return s.toolError('present_result', err);
    }
}
