/**
 * Executes validation, assembly, and persistence for `lineage_present_result`.
 *
 * @remarks
 * Provider-neutral validation and assembly helpers remain in the sibling
 * `presentResult.ts`; this handler owns session persistence and the validated
 * webview effect. Raw arguments are admitted once against the same live stage/repair schema the
 * provider sees, before normalization or held-content merge. Turn-lease validation and effect
 * serialization remain in the registry wrapper.
 */
import { type AiSession } from '../../session/session';
import { trunc, sanitizeForLog } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import {
  validatePresentResult, orderAndAssemble, findDisconnectedViewNodes,
  findBareNonPrunedNodes, findUnrenderedDetailSlotIds, requiredDetailSlotIds, buildColumnChainPreface,
  discoveryPreviewNarrative,
  mergePresentResultRepairPatch,
  holdRejectedPresentResult,
  requiredCtChainNodeIds,
  findTextlessNewSectionLabels,
  findStartOrderIssues,
  presentResultRepairInstruction,
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
  type EvidenceBlock,
} from '../../tools/presentResult';
import { MergedSectionsSchema, PRESENT_RESULT_REPAIR_FIELDS, normalizePresentSectionLabel, presentResultSchemaForPhase, type PresentResultExternalInput } from '../../tools/toolSchemas';
import { edgeApiType } from '../../support/aiPresenter';
import { prunePreserveOnly } from '../../support/viewPrune';
import { resolveModelNodeId, resolveModelNodeIds } from '../../support/inputNormalization';
import { makeRejection, rejectionFromZodError, zodFieldRepairHint, type ToolRejection } from '../../support/toolErrorEnvelope';
import { quoteIds } from '../../support/text';
import { evaluateExternalRenderHandleRule, evaluatePresentResultPreconditionsRule, type ExternalRenderHandle } from '../../interaction/rules/presentResultRules';
import { type ToolCaller, type ToolServices, getModelNodeMap } from './toolServices';
import type { ResultGraph, PresentationArtifact } from '../../session/types';
import type { PreviewDelivery } from '../../support/chatAnswer';
import type { SmState } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { isCancellationOutcome } from '../../support/cancellation';

function findUncoveredCtChainNodes(
  resultGraph: AiSession['resultGraph'],
  input: PresentResultInput,
  resolvedNodeIds: string[],
  slottedNodeIds: readonly string[],
  identifierCaseSensitive = false,
): string[] {
  const lc = (id: string): string => schemaKey(id, identifierCaseSensitive);
  const pruned = (resultGraph?.node_states ?? []).filter(state => state.action === 'prune').map(state => state.nodeId);
  const required = requiredCtChainNodeIds(resultGraph?.columnAspect?.edges ?? [], resolvedNodeIds, [...slottedNodeIds, ...pruned], lc);
  if (required.length === 0) return [];

  const linked = new Set<string>();
  for (const sec of input.sections ?? []) {
    for (const id of sec.node_ids ?? []) linked.add(lc(id));
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

/** Model name shown on a view an external caller rendered; the caller's model is not known. */
const EXTERNAL_MODEL_NAME = 'External AI client';

/**
 * What one `present_result` call reads and writes, resolved once from its caller.
 *
 * @remarks
 * A chat call renders the turn's discovery scope or the exploration result under the run's memory:
 * held repair drafts, captured SQL evidence, detail-slot and column-chain coverage, the engine scope
 * and the per-turn bookkeeping. An external call (no chat turn) renders a kept scope walk or view by
 * handle and reads or writes none of that.
 */
interface PresentationTarget {
  /** Stage the call is validated and worded for. */
  readonly stage: PresentResultStage;
  /** The chat run's held repair drafts; `null` keeps nothing between calls. */
  readonly drafts: AiSession['presentResultRepairDraft'] | null;
  /** The chat run's memory constrains the render: captured evidence, slot and chain coverage, engine scope. */
  readonly runMemory: boolean;
  /** Per-turn attempt, failure and success bookkeeping is recorded. */
  readonly turnBookkeeping: boolean;
}

/** Resolves the {@link PresentationTarget} of one call. */
function presentationTarget(caller: ToolCaller, sess: AiSession): PresentationTarget {
  if (caller === 'external') return { stage: 'external', drafts: null, runMemory: false, turnBookkeeping: false };
  const stage: PresentResultStage = sess.activeLmStage?.kind === 'visual_preview'
    ? 'visual_preview'
    : sess.phase.kind === 'completed' ? 'completed' : 'synthesis';
  return { stage, drafts: sess.presentResultRepairDraft, runMemory: true, turnBookkeeping: true };
}

/** Builds and persists the final lineage presentation for the active turn. */
export async function executePresentResult(input: unknown, s: ToolServices): Promise<string> {
    try {
      const sess = s.getSession();
      const rawInput = input;
      const turnEpoch = s.turnEpoch(sess);
      const target = presentationTarget(s.caller, sess);
      const { drafts } = target;
      if (target.turnBookkeeping) {
        const attemptWrite = sess.beginPresentResultAttempt(turnEpoch);
        if (attemptWrite.kind !== 'accepted') {
          return s.logAndReturn('lineage_present_result', makeRejection({
            code: REJECTION_CODES.staleTurn,
            reason: 'The turn no longer owns this session; the result was not rendered.',
          }), rawInput);
        }
      }
      const model = s.requireModel();
      const isVisualPreview = target.stage === 'visual_preview';
      const previewNarrative = isVisualPreview && sess.lastDiscoveryAnswer
        ? discoveryPreviewNarrative(sess.lastDiscoveryAnswer)
        : null;

      const reject = (rejection: ToolRejection): string => {
        if (target.turnBookkeeping) sess.recordPresentResultFailure(turnEpoch);
        return s.logAndReturn('lineage_present_result', rejection, rawInput);
      };

      const presentResultStage = target.stage;
      const retainableSections = target.runMemory && !isVisualPreview ? sess.retainableReportSections() : null;
      const schema = drafts
        ? presentResultSchemaForPhase(
          presentResultStage, sess.presentResultRepairFields, retainableSections !== null,
          previewNarrative?.blocks.length ?? 0, sess.presentResultRepairHighlightLabelIndexes ?? undefined,
          sess.presentResultRepairSectionTextLeaves ?? undefined,
        )
        : presentResultSchemaForPhase(presentResultStage);
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
        const repair = isVisualPreview || !drafts ? null : holdRejectedPresentResult(drafts, input, rejection.issuePaths ?? [], presentResultStage, retainableSections);
        const authorization = drafts?.getAuthorization() ?? null;
        const held = drafts?.get() ?? null;
        if (held && authorization) rejection.hint = [
          zodFieldRepairHint(parsed.error, input, schema),
          repair ?? presentResultRepairInstruction(authorization.fields, presentResultStage,
            (held.sections?.length ?? 0) > 0, authorization.highlightLabelIndexes, authorization.sectionTextLeaves),
        ].filter(Boolean).join(' ');
        return reject(rejection);
      }
      // An external render names what it draws by handle; the rest is the shared render contract.
      let externalHandle: ExternalRenderHandle | null = null;
      if (presentResultStage === 'external') {
        const { scope_id: scopeId, view_id: viewId, ...render } = parsed.data as PresentResultExternalInput;
        externalHandle = { scopeId, viewId };
        input = render;
      } else {
        input = parsed.data;
      }

      const held = drafts?.get() ?? null;
      const authorization = drafts?.getAuthorization() ?? null;
      let presentInput: PresentResultInput;
      if (drafts && held && authorization) {
        const patch = input as PresentResultRepairPatch;
        const textlessNewLabels = authorization.sectionTextLeaves
          ? []
          : findTextlessNewSectionLabels(
            held.sections,
            (patch.sections ?? []) as Parameters<typeof findTextlessNewSectionLabels>[1],
          );
        if (textlessNewLabels.length > 0) {
          const body = isVisualPreview ? 'start' : 'text';
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: `sections[] names label(s) not on file with no ${body}: ${quoteIds(textlessNewLabels)}.`,
            hint: [
              `To fix: add ${body}: under the offending label, or move its node_ids into an exact held label. Nothing from the rejected call was stored.`,
              presentResultRepairInstruction(authorization.fields, presentResultStage,
                (held.sections?.length ?? 0) > 0, authorization.highlightLabelIndexes),
            ].join(' '),
            issuePaths: ['sections'],
          }));
        }
        presentInput = mergePresentResultRepairPatch(held, patch, authorization, model.identifierCaseSensitive);
        const merged = presentInput.sections === undefined && retainableSections
          ? { success: true as const }
          : MergedSectionsSchema.safeParse({ sections: presentInput.sections });
        if (!merged.success) {
          const owed = new Set<string>(['sections', ...authorization.fields.filter(field => presentInput[field] === undefined)]);
          const fields = PRESENT_RESULT_REPAIR_FIELDS.filter(field => owed.has(field));
          const sectionsHeld = (presentInput.sections?.length ?? 0) > 0;
          const sectionTextLeaves = sectionsHeld
            ? sectionTextLeavesFromIssues(merged.error.issues)
            : undefined;
          drafts.hold(presentInput, { fields, ...(sectionTextLeaves ? { sectionTextLeaves } : {}) });
          return reject(rejectionFromZodError(merged.error, {
            code: REJECTION_CODES.validation,
            hint: presentResultRepairInstruction(fields, presentResultStage, sectionsHeld, undefined, sectionTextLeaves),
          }));
        }
      } else if (isVisualPreview) {
        const scope = sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
          ? sess.discoveryScopeArtifact
          : null;
        if (!previewNarrative?.summary || !scope) {
          return reject(makeRejection({
            code: 'preview_source_unavailable',
            hint: 'Run the discovery question again, then request its graph preview.',
          }));
        }
        presentInput = { ...(input as PresentResultInput), summary: previewNarrative.summary, title: previewNarrative.title };
      } else {
        presentInput = input as PresentResultInput;
      }

      const rejectGraphEdit = (field: 'add_node_ids' | 'prune_node_ids', rejection: ToolRejection): string => {
        if (!drafts || !held) return reject(rejection);
        drafts.hold(presentInput, { fields: [field] });
        return reject({ ...rejection, hint: `${rejection.hint} ${presentResultRepairInstruction([field], presentResultStage)}` });
      };

      if (previewNarrative) {
        const partition = findStartOrderIssues(presentInput.sections ?? []);
        if (partition.length > 0) {
          drafts?.hold(presentInput, { fields: ['sections'] });
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: partition.map(issue => issue.message).join('\n'),
            hint: presentResultRepairInstruction(['sections'], 'visual_preview'),
            issuePaths: partition.map(issue => `sections.${issue.index}.start`),
          }));
        }
      }

      // A completed chat run and an external view accept graph edits; a preview or synthesis render does not.
      const graphEditable = presentResultStage === 'external' || presentResultStage === 'completed';
      const isAmendment = externalHandle
        ? externalHandle.viewId !== undefined
        : graphEditable && presentInput.is_update === true;

      const previewScope = isVisualPreview && sess.discoveryScopeArtifact?.turnEpoch === turnEpoch
        ? sess.discoveryScopeArtifact
        : null;
      const previewGraph: ResultGraph | null = previewScope ? {
        nodeIds: [...previewScope.nodeIds],
        edges: [...previewScope.edges],
        source: 'discovery_preview',
        originNodeId: previewScope.origin,
      } : null;
      let resultGraph: ResultGraph;
      if (externalHandle) {
        const scope = externalHandle.scopeId === undefined ? undefined : sess.externalScope(externalHandle.scopeId);
        const view = externalHandle.viewId === undefined ? undefined : sess.externalView(externalHandle.viewId);
        const violation = evaluateExternalRenderHandleRule(externalHandle, scope !== undefined, view !== undefined);
        if (violation) return reject(violation);
        // Copies: a rejected render leaves the kept scope and view untouched.
        resultGraph = view
          ? { ...view, nodeIds: [...view.nodeIds], edges: [...view.edges] }
          : { nodeIds: [...scope!.nodeIds], edges: [...scope!.edges], source: 'external_scope', originNodeId: scope!.origin };
      } else {
        const chatGraph = previewGraph ?? sess.resultGraph;
        if (!chatGraph) return reject(evaluatePresentResultPreconditionsRule(false)!);
        resultGraph = chatGraph;
      }

      let resolvedNodeIds: string[] = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      const modelNodeMap = getModelNodeMap(model);
      // A graph edit changes the rendered view, so its ids and edges commit with it.
      let graphEdited = false;

      const canonicalNodeId = (id: string, field: string): string => {
        const resolved = resolveModelNodeId(id, modelNodeMap, model.identifierCaseSensitive) ?? id;
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

      if (graphEditable && presentInput.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const addResolution = resolveModelNodeIds(presentInput.add_node_ids, modelNodeMap, model.identifierCaseSensitive);
        if (addResolution.unresolved.length > 0) {
          return rejectGraphEdit('add_node_ids', makeRejection({
            code: REJECTION_CODES.validation,
            reason: `Unknown add_node_ids after bracket/case normalization: ${quoteIds(addResolution.unresolved)}.`,
            hint: 'Use lineage_search_objects to resolve canonical IDs.',
            issuePaths: ['add_node_ids'],
          }));
        }
        const toAdd = addResolution.resolved.filter(id => !currentSet.has(id));
        const scopeSnapshot = target.runMemory ? sess.stateMachine?.toJSON() ?? null : null;
        const outOfScope = scopeSnapshot
          ? toAdd.filter(id => !scopeSnapshot.scopeNodeIds.includes(id))
          : [];
        if (outOfScope.length > 0) {
          return rejectGraphEdit('add_node_ids', makeRejection({
            code: REJECTION_CODES.validation,
            reason: `add_node_ids names objects this exploration has not analysed: ${quoteIds(outOfScope)}.`,
            hint: 'Rendering reveals analysed objects only. If the user asked to add these objects, call lineage_start_exploration {"supplement":{"nodeIds":[...]}} — that analyses them into this graph — then render. Otherwise do not render them: name them in your chat answer and ask which to add.',
            issuePaths: ['add_node_ids'],
          }));
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
          return rejectGraphEdit('prune_node_ids', makeRejection({
            code: REJECTION_CODES.validation,
            reason: `Unknown prune_node_ids after bracket/case normalization: ${quoteIds(pruneResolution.unresolved)}.`,
            hint: 'Use lineage_search_objects to resolve canonical IDs.',
            issuePaths: ['prune_node_ids'],
          }));
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
            reason: `Closed-graph invariant failed: origin \`${resultGraph.originNodeId}\` is missing from the result view.`,
            hint: 'Keep the starting node in the view; remove it from prune_node_ids.',
            issuePaths: ['prune_node_ids'],
          }));
        }
        const disconnected = findDisconnectedViewNodes(resolvedNodeIds, resolvedEdges, resultGraph.originNodeId);
        if (disconnected.length > 0) {
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: `Closed-graph invariant failed: ${quoteIds(disconnected)} ${disconnected.length === 1 ? 'is' : 'are'} disconnected from origin \`${resultGraph.originNodeId}\`.`,
            hint: 'Adjust add_node_ids / prune_node_ids so the view remains connected from the starting node.',
          }));
        }
      }

      if (retainableSections) {
        const retained = resolveRetainedSections(presentInput.sections, retainableSections, new Set(resolvedNodeIds));
        if (retained.unknownLabels.length > 0) {
          return reject(makeRejection({
            code: REJECTION_CODES.validation,
            reason: `sections[] asks to keep text for ${quoteIds(retained.unknownLabels)}, which the committed report has no body for.`,
            hint: `Send that section with its own text, or use a label from the committed report: ${quoteIds(retainableSections.map(sec => sec.label))}.`,
            issuePaths: ['sections'],
          }));
        }
        const keptCount = retained.sections.length - (presentInput.sections ?? []).filter(sec => typeof sec.text === 'string' && sec.text.trim().length > 0).length;
        if (keptCount > 0) {
          s.logger.debug(`[Presentation] ${keptCount} of ${retained.sections.length} section(s) kept from the committed report — run=${sess.explorationRunId ?? '(none)'}`);
        }
        presentInput.sections = retained.sections;
      }

      const unknownEvidenceIds: string[] = [];
      const malformedEvidence: PresentResultViolation[] = [];
      let renderInput: PresentResultInput = isVisualPreview && presentInput.sections
        ? { ...presentInput, sections: assemblePreviewSections(previewNarrative?.blocks ?? [], presentInput.sections) }
        : presentInput;
      if (!isVisualPreview && presentInput.sections?.length) {
        // Every caller's SQL fences are checked; only a chat run has captured evidence to expand.
        // Number fences over the slots the completion envelope served: the render bound stored with the result.
        const servedIds = new Set(sess.resultGraph?.evidenceNodeIds ?? []);
        const evidenceBlocks = target.runMemory
          ? assignEvidenceIds(sess.memory.getResult().detail_slots.filter(slot => servedIds.has(slot.nodeId))).blocks
          : new Map<string, EvidenceBlock>();
        const expand = (text: string, fieldLabel: string, fieldPath = fieldLabel): string => {
          const expanded = expandEvidenceRefs(text, evidenceBlocks);
          unknownEvidenceIds.push(...expanded.unknownIds);
          if (expanded.malformedRefs.length > 0) {
            malformedEvidence.push({
              field: fieldPath.startsWith('sections.') ? 'sections' : fieldPath as 'title' | 'intro' | 'closing',
              messages: [`Unclosed SQL fence(s) ${quoteIds(expanded.malformedRefs)} in ${fieldLabel}. A reused block is two lines, its opening line with the id and a bare triple-backtick line right after it; a block with written SQL closes with a bare triple-backtick line after the SQL. Another language opener is not a closing marker. Retain every surrounding business paragraph.`,],
              repairFields: [fieldPath.startsWith('sections.') ? 'sections' : fieldPath as 'title' | 'intro' | 'closing'],
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
        const slotChars = target.runMemory ? sess.memory.getResult().detail_slots
          .reduce((total, slot) => total + slot.sections.reduce((sum, section) => sum + section.text.length, 0), 0) : 0;
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
      const unrenderedSlotIds = !target.runMemory ? [] : findUnrenderedDetailSlotIds(
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
        `[Presentation] Output assembled — sections=${presentInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount} slotsUnrendered=${unrenderedSlotIds.length}`
      );
      s.logger.debug(`[Presentation] Output assembled title="${trunc(presentInput.title ?? '(none)', 60)}"`);

      const externalViolations: PresentResultViolation[] = [...malformedEvidence];
      const uncoveredCtNodes = !target.runMemory ? [] : findUncoveredCtChainNodes(resultGraph, renderInput, resolvedNodeIds, sess.memory.notedNodeIds, model.identifierCaseSensitive);
      if (uncoveredCtNodes.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `CT column-chain node(s) missing from final presentation: ${quoteIds(uncoveredCtNodes)}.`,
            'For each one: add its id to a sections[].node_ids, or give it one grounded notes[] entry. Tables carry the traced column even when they have no detail slot.',
          ],
          repairFields: ['sections', 'notes'],
          paths: ['sections', 'notes'],
          entryIds: uncoveredCtNodes,
        });
      }
      if (unrenderedSlotIds.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [
            `Detail slot(s) reached no section: ${quoteIds(unrenderedSlotIds)}.`,
            'Add each id to a section\'s node_ids and write that object\'s captured findings into the same section\'s text; a notes caption or a highlight color does not carry them.',
          ],
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: unrenderedSlotIds,
        });
      }
      if (unknownEvidenceIds.length > 0) {
        externalViolations.push({
          field: 'sections',
          messages: [target.runMemory
            ? `Evidence id(s) ${quoteIds([...new Set(unknownEvidenceIds)])} name no captured SQL block. `
              + 'Use an id shown on a ```sql fence line in detail_slots, or write the SQL inside that fence yourself.'
            : `SQL fence label(s) ${quoteIds([...new Set(unknownEvidenceIds)])} name no SQL block; write the SQL inside the fence.`,
          ],
          repairFields: ['sections'],
          paths: ['sections'],
          entryIds: [...new Set(unknownEvidenceIds)],
        });
      }

      let smSnapshot: SmState | null | undefined;
      const nodeIdState: PresentNodeIdStateLookup = (nodeId): PresentNodeIdState => {
        if (!modelNodeMap.has(nodeId)) return 'not_in_model';
        if (!target.runMemory) return 'outside_view';
        if (smSnapshot === undefined) smSnapshot = sess.stateMachine?.toJSON() ?? null;
        if (!smSnapshot) return 'out_of_scope';
        if (smSnapshot.removedSet.includes(nodeId)) return 'pruned';
        if ((smSnapshot.renderDroppedNodeIds ?? []).includes(nodeId)) return 'render_dropped';
        if (smSnapshot.scopeNodeIds.includes(nodeId)) return 'in_scope_undispositioned';
        return 'out_of_scope';
      };
      const validation = validatePresentResult(renderInput, resolvedNodeIds, assembledBadges, assembledDescription, externalViolations, presentResultStage, nodeIdState);

      if (!validation.success) {
        if (drafts && validation.repairable) {
          const scopedHint = malformedEvidence.length > 0
            ? holdRejectedPresentResult(drafts, presentInput, validation.rejection.issuePaths ?? [], presentResultStage)
            : null;
          if (scopedHint) validation.rejection.hint = scopedHint;
          else drafts.hold(presentInput, { fields: validation.repairFields });
        }
        return reject(validation.rejection);
      }

      // A chat render belongs to its run; an external view has no run record to pair with.
      const runId = target.runMemory ? sess.explorationRunId ?? sess.id : undefined;
      const renderedNotes = isAmendment
        ? mergeAmendedNotes(resultGraph.notes, validation.notes, validation.node_ids)
        : validation.notes.map(n => ({ nodeId: n.node_id, text: n.caption }));
      const aiMetadata: PresentationArtifact['aiMetadata'] = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: target.runMemory ? sess.modelName ?? 'unknown' : EXTERNAL_MODEL_NAME,
        ...(runId ? { runId } : {}),
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
          nodeVerdicts: buildColumnAspectNodeVerdicts(validation.node_ids, resultGraph.columnAspect, resultGraph.node_states, model.identifierCaseSensitive),
        } : {}),
      };
      let autoDispatched = false;
      let previewFailure: 'preview_post_failed' | 'preview_dispatch' | null = null;
      let delivery: PreviewDelivery | 'dispatch_failed' = 'dispatch_failed';
      s.signal?.throwIfAborted();
      try {
        delivery = await s.deliverPreview(
          { type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata },
        );
        s.signal?.throwIfAborted();
        autoDispatched = delivery === 'delivered';
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
            resultGraph.sectionsRunId = target.runMemory ? sess.explorationRunId ?? undefined : undefined;
          }
        }
      };

      if (externalHandle) {
        commitToGraph();
        const viewId = sess.commitExternalView(resultGraph, externalHandle.viewId);
        s.logger.info(`AI view rendered for an external caller — nodes=${validation.node_ids.length} sections=${presentInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} delivery=${delivery}`);
        return s.logAndReturn('lineage_present_result', { success: true, view_id: viewId, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource, delivery }, rawInput);
      }

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
        }), rawInput);
      }
      // The delivery outcome is recorded only once the turn still owns the session, and the latest present decides it.
      if (previewFailure) sess.markSynthesisRenderDegraded(previewFailure);
      else sess.clearPreviewDeliveryDegraded();
      commitToGraph();
      if (previewGraph) sess.resultGraph = resultGraph;
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

/**
 * Maps merged-sections validation issues to the indexed `label`/`text` leaves a repair may replace.
 *
 * @remarks
 * Only issues under `sections[<number>]` qualify; the leaf is `text` when the issue path names it,
 * otherwise `label` (the only other leaf the merged schema validates). Leaves are deduped per index.
 *
 * @returns The leaves, or `undefined` when no issue addresses an indexed section, so the caller
 * holds a fields-only repair instead of an indexless/NaN leaf.
 */
function sectionTextLeavesFromIssues(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): Array<{ index: number; fields: Array<'label' | 'text'> }> | undefined {
  const byIndex = new Map<number, Set<'label' | 'text'>>();
  for (const { path } of issues) {
    const index = path[1];
    if (path[0] !== 'sections' || typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    const field = path[2] === 'text' ? 'text' : 'label';
    const fields = byIndex.get(index) ?? new Set();
    fields.add(field);
    byIndex.set(index, fields);
  }
  if (byIndex.size === 0) return undefined;
  return [...byIndex].sort(([a], [b]) => a - b).map(([index, fields]) => ({ index, fields: [...fields].sort() }));
}
