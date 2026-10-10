/**
 * AI `present_result` contract: input/output types, validation, and the deterministic
 * markdown assembly. Zero VS Code imports.
 */
import {
  PresentResultModelSchema,
  PresentResultAuthorizableRepairSchema,
  normalizePresentSectionLabel,
  PRESENT_RESULT_DEFINED_FIELDS,
  PRESENT_RESULT_REPAIR_FIELDS,
  type PresentResultRepairField,
} from './toolSchemas';
import { quoteIds } from '../support/text';
import { RepairDraftStore, keyedResendRule } from '../support/repairDraftStore';
import { INVALID_TOOL_INPUT_REPAIR_HINT, makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { FOCUS_NODE_HREF_PREFIX, type ColumnTransformClass } from '../../engine/shared/bridgeContract';
import type { DetailSlot } from '../session/memoryManager';
import type { z } from 'zod';
import { marked } from 'marked';
import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';

/**
 * Input field a validation error is attributed to, declared structurally at each `addError`
 * site so the repair hint can never desync from a reworded error message. `nodes` covers the
 * empty-result-graph class, which has no single patchable input field.
 */
type PresentResultFailedField = 'name' | 'summary' | 'title' | 'intro' | 'closing' | 'sections' | 'notes' | 'highlight_groups' | 'nodes';

/**
 * The stage `lineage_present_result` is being called from, as classified by the caller.
 *
 * @remarks
 * Drives stage-aware wording in {@link presentNodeIdHint}: `visual_preview` and `synthesis` never
 * have `lineage_search_objects` on their tool policy (see `toolPolicy.ts`), so a hint naming it
 * there is a guaranteed off-policy retry. `completed` and `external` (a caller without a chat turn)
 * expose that tool.
 */
export type PresentResultStage = 'visual_preview' | 'synthesis' | 'completed' | 'external';

/**
 * The state the engine already records for a node id the current result graph cannot link.
 *
 * @remarks
 * The id check runs over the whole loaded model before this contract sees it (the dispatcher
 * normalizes every `node_ids` entry with `resolveModelNodeId`), so exactly one member of this union
 * is a hallucination and the rest are real objects the render does not carry. A real object rejected
 * as "unknown" tells the model to invent a replacement instead of moving the fact into prose. The classification itself belongs
 * to the caller — only the session holds the engine snapshot — so it arrives as
 * {@link PresentNodeIdStateLookup}.
 */
export type PresentNodeIdState =
  | 'not_in_model'
  | 'pruned'
  | 'render_dropped'
  | 'in_scope_undispositioned'
  | 'out_of_scope'
  | 'outside_view';

/**
 * Wording per {@link PresentNodeIdState}, in the vocabulary the engine already rejects with
 * (`ROUTE_REJECTION_DIRECTIVE`, the `getResult` disposition lines) — no second dialect for the same
 * facts.
 */
const PRESENT_NODE_ID_STATE_TEXT: Readonly<Record<PresentNodeIdState, string>> = {
  not_in_model: 'not in the loaded model',
  pruned: 'already pruned on an earlier hop',
  render_dropped: 'in scope, dropped from the render',
  in_scope_undispositioned: 'in scope but never dispositioned',
  out_of_scope: 'outside the approved exploration scope',
  outside_view: 'in the loaded model but not in this view',
};

/**
 * Classifies one unlinkable node id against the engine state the session holds.
 *
 * @remarks
 * Invoked only for ids the result graph rejects, so a passing call pays nothing for it. A caller
 * that holds no engine state omits it and every offender is reported as `not_in_model`.
 */
export type PresentNodeIdStateLookup = (nodeId: string) => PresentNodeIdState;

/** What `add_node_ids` reveals; the follow-up instruction and the unknown-id route state it identically. */
export const ADD_NODE_IDS_REVEALS = 'reveals objects this exploration already analysed';

/**
 * The route back for a real id the render does not carry, per stage — only what the tool accepts.
 *
 * @remarks
 * `notes[].node_id` is deliberately absent: it is validated against the same result-graph set, so
 * offering it would send the model into an identical rejection. `add_node_ids` is accepted in the
 * Completed Phase and on an external view (the dispatcher forbids it during a preview or a synthesis
 * render), so those two stages name it and every other stage is left with prose.
 */
const PRESENT_REAL_ID_ROUTE: Readonly<Record<PresentResultStage, string>> = {
  completed: `A real id outside the result graph can be brought into the view with add_node_ids, which ${ADD_NODE_IDS_REVEALS}.`,
  synthesis: 'The result graph is locked this stage.',
  visual_preview: 'The result graph is locked this stage; the answer text is served as blocks.',
  external: 'A real id outside the view can be brought in with add_node_ids when it connects to the view.',
};

/**
 * The unknown-node-id repair hint for the calling stage: the one action the stage accepts for an
 * id the result graph does not carry.
 *
 * @remarks
 * The route that only one stage offers (`add_node_ids`, the locked graph) rides on
 * {@link PRESENT_REAL_ID_ROUTE}; this sentence states the action once.
 */
function presentNodeIdHint(stage: PresentResultStage): string {
  return stage === 'visual_preview'
    ? 'Use the accepted canonical ids with their exact catalog casing. Remove the named ids from node_ids.'
    : 'Use the accepted canonical ids with their exact catalog casing. Remove the named ids from node_ids, or state the fact in sections[].text.';
}

/**
 * The AI's submission to `lineage_present_result`.
 *
 * @remarks
 * Contract: the AI writes structured PARTS; the engine builds the rendered
 * document deterministically via {@link orderAndAssemble}. Specifically:
 *   - AI writes: summary, title, intro, sections[], closing, notes[], highlight_groups[]
 *   - Engine builds: the assembled markdown blob (returned as `description`
 *     on PresentResultRequest), section numbering, badge chips, object links.
 *   - Dispatcher normalizes and validates only; it does not synthesize missing
 *     labels, node links, captions, or section text.
 *
 * Final `sections[]` is the authoritative graph/detail link surface. A final
 * section label maps to exactly one section text body; its required `node_ids[]`
 * links zero or more graph nodes to that section badge. A node absent from every
 * `node_ids[]` (including an empty one) intentionally has no final section badge.
 *
 * `description` is intentionally absent because it is engine output, not AI input.
 */
export type PresentResultInput = z.infer<typeof PresentResultModelSchema>;
type PresentResultBaseRepairPatch = z.infer<typeof PresentResultAuthorizableRepairSchema>;

/** One repair-only replacement for a held highlight label. */
export interface PresentResultHighlightLabelPatch {
  readonly index: number;
  readonly label: string;
}

/** Repair-only text leaves for one held section. */
export interface PresentResultSectionTextPatch {
  readonly index: number;
  readonly label?: string;
  readonly text?: string;
}

/**
 * A validated `present_result` repair patch. Ordinary fields derive from
 * {@link PresentResultAuthorizableRepairSchema}; a label-only rejection narrows `highlight_groups`
 * to indexed label leaves through the dynamic schema served for that authorization.
 */
export type PresentResultRepairPatch = Omit<PresentResultBaseRepairPatch, 'highlight_groups' | 'sections'> & {
  readonly highlight_groups?: PresentResultBaseRepairPatch['highlight_groups'] | readonly PresentResultHighlightLabelPatch[];
  readonly sections?: PresentResultBaseRepairPatch['sections'] | readonly PresentResultSectionTextPatch[];
};

/** What a held-draft rejection authorized: the presentation fields a resend may patch. */
export interface PresentResultRepairAuthorization {
  readonly fields: readonly PresentResultRepairField[];
  /** Zero-based highlight entries whose overlong labels may be replaced without resending the list. */
  readonly highlightLabelIndexes?: readonly number[];
  /** Zero-based held sections and their text leaves authorized for replacement. */
  readonly sectionTextLeaves?: readonly {
    readonly index: number;
    readonly fields: readonly ('label' | 'text')[];
  }[];
}

/** A preview section carries the served block id it starts at instead of a body. */
type PresentSection = NonNullable<PresentResultInput['sections']>[number] & { start?: string };
type PresentSectionPatch = NonNullable<PresentResultBaseRepairPatch['sections']>[number] & { start?: string };

/**
 * The validated, engine-assembled result ready for the UI.
 *
 * @remarks
 * `description` here is the full markdown document built by {@link orderAndAssemble}
 * from the AI's input parts (title + intro + sections[] + closing). It is NOT a
 * passthrough of any AI-supplied field — the AI does not write the assembled
 * document.
 */
type PresentResultRequest = {
  success: true;
  name: string;
  node_ids: string[];
  summary: string;
  description: string;
  /** Absent when the model omitted it — the view then follows the user's configured direction. */
  layout_direction?: 'LR' | 'TB';
  highlight_groups: NonNullable<PresentResultInput['highlight_groups']>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; caption: string }>;
};

/**
 * A failed validation: the one rejection the model receives plus what the handler needs to hold the
 * draft.
 *
 * @remarks
 * `repairable` is set structurally where each error is added inside {@link validatePresentResult};
 * downstream code never infers it from message text. The rejection's `reason` is one line per error;
 * `issuePaths` and `entryIds` name every offender, and `detail.paths` carries per-path offending
 * node ids with their recorded state plus the uncapped accepted set — the message states both,
 * capped, so they survive the rejection replay.
 */
export type PresentResultFailure = {
  success: false;
  rejection: ToolRejection;
  repairable: boolean;
  repairFields: PresentResultRepairField[];
};

/** One numbered top-level block of the cached discovery answer, served to the preview stage as `answer_blocks`. */
export interface AnswerBlock {
  readonly id: string;
  readonly text: string;
}

/**
 * Splits the cached discovery answer into engine-owned title/summary and numbered source blocks.
 *
 * @param answer - The cached discovery chat answer (Markdown), title already inline if present.
 * @returns The split-off `title` (absent when the answer has no leading level-1 heading, ATX or
 *   Setext, closing `#`s stripped), the remaining body as `blocks` — one per top-level Markdown
 *   token (heading, paragraph, table, list, code), ids `B1`..`Bn` — and a one-line `summary`: the
 *   first line of the first non-code block's text (a list item, blockquote or task item without its
 *   `[ ]` marker), else the title. A fenced code block is never the summary; absent when neither
 *   exists — the caller degrades to a rejection, never invented prose.
 */
export function discoveryPreviewNarrative(answer: string): {
  title?: string;
  blocks: AnswerBlock[];
  summary?: string;
} {
  const normalized = answer.replace(/\r\n?/g, '\n').trim();
  const [lead] = marked.lexer(normalized);
  const heading = lead?.type === 'heading' && lead.depth === 1 ? lead : undefined;
  const title = heading?.text.trim();
  const body = heading ? normalized.slice(heading.raw.length).trim() : normalized;
  const tokens = marked.lexer(body);
  const first = tokens.find(token => token.type !== 'code' && token.type !== 'hr' && token.type !== 'space');
  const text: string | undefined = first?.type === 'list' ? first.items[0]?.text : first && 'text' in first ? first.text : first?.raw;
  const summary = text?.split('\n').find(line => line.trim())?.trim() || title;
  const texts: string[] = [];
  const leading: string[] = [];
  for (const token of tokens) {
    const raw = token.raw.trim();
    if (token.type === 'space') continue;
    if (token.type !== 'hr') texts.push([...leading.splice(0), raw].join('\n\n'));
    else if (texts.length > 0) texts[texts.length - 1] += `\n\n${raw}`;
    else leading.push(raw);
  }
  if (leading.length > 0) texts.push(leading.join('\n\n'));
  const blocks = texts.map((blockText, index) => ({ id: `B${index + 1}`, text: blockText }));
  return { ...(title ? { title } : {}), blocks, summary };
}

/**
 * Where preview `sections` do not start strictly after the section before them. The first section
 * always begins at B1; the served schema constrains the ids, and order depends on the whole
 * (merged) list, so it is checked here.
 *
 * @returns One entry per departure — the section it concerns and a message naming both sections.
 */
export function findStartOrderIssues(
  sections: ReadonlyArray<{ label: string; start?: string }>,
): Array<{ index: number; message: string }> {
  const issues: Array<{ index: number; message: string }> = [];
  for (const [index, { label, start }] of sections.entries()) {
    if (index === 0 || !start) continue;
    const before = startBlock(sections, index - 1);
    if (startBlock(sections, index) <= before) {
      issues.push({ index, message: `Section "${label}" starts at ${start}, not after "${sections[index - 1].label}" at B${before}; starts ascend strictly.` });
    }
  }
  return issues;
}

/** The 1-based block a preview section starts at; the first section always begins at B1. */
function startBlock(sections: ReadonlyArray<{ start?: string }>, index: number): number {
  return index === 0 ? 1 : Number((sections[index].start ?? 'B1').slice(1));
}

/**
 * Builds each preview section's `text` from the blocks between its start and the next section's
 * start (the first from B1, the last to the end), so the joined text is the cached answer in its
 * own words.
 */
export function assemblePreviewSections(
  blocks: readonly AnswerBlock[],
  sections: readonly PresentSection[],
): PresentSection[] {
  return sections.map(({ start, ...section }, index) => ({
    ...section,
    text: start
      ? blocks.slice(startBlock(sections, index) - 1, index + 1 < sections.length ? startBlock(sections, index + 1) - 1 : blocks.length).map(block => block.text).join('\n\n')
      : section.text,
  }));
}

/**
 * A defect found outside {@link validatePresentResult} but reported through its accumulator.
 *
 * @remarks
 * Checks that need context the validator does not hold — the cached discovery answer, the result
 * graph — are passed in instead, so every rule reports through one accumulator and one rejection.
 */
export interface PresentResultViolation {
  /** Input field the violation is attributed to. */
  readonly field: PresentResultFailedField;
  /** Rejection messages reported through the validator's accumulator. */
  readonly messages: readonly string[];
  /** Fields this violation authorizes for a repair resend. */
  readonly repairFields: readonly PresentResultRepairField[];
  /** Exact offending entry paths, empty when the violation is about the payload as a whole. */
  readonly paths: readonly string[];
  /**
   * The offending entries this violation names (e.g. an uncovered detail-slot or CT-chain node id),
   * when the violation's offender is an id rather than a field path.
   *
   * @remarks
   * `paths` here is a fixed structural root (e.g. `sections`) shared by every offender, so it never
   * shrinks as the model repairs individual entries — a cross-attempt comparison needs the entries
   * themselves. Carried into `detail` (never into `messages` or `hint`, which already state them,
   * capped) purely so a later attempt's rejection can be compared against this one's; never read by
   * the model or the repair-patch machinery.
   */
  readonly entryIds?: readonly string[];
}

/** Identity of a held section: its normalized label. */
const sectionKey = (section: { label?: string }): string => normalizePresentSectionLabel(section.label ?? '');

/**
 * Labels in a resent `sections` patch that match no held section and carry no text.
 *
 * @remarks
 * Such a section has nothing to inherit under {@link fillSectionPatch}; the handler rejects it with
 * the draft still held, rather than letting the validator's non-repairable "missing text" error
 * discard the whole draft over a label the model most likely mistyped.
 */
export function findTextlessNewSectionLabels(
  held: readonly PresentSection[] | undefined,
  resent: readonly PresentSectionPatch[],
): string[] {
  const heldKeys = new Set((held ?? []).map(sectionKey));
  return resent
    .filter(section => !('remove' in section && section.remove) && !heldKeys.has(sectionKey(section)) && !section.start && !('text' in section && section.text?.trim()))
    .map(section => section.label);
}

/** Held preview sections with each `start` replaced by the block it effectively starts at (the first always B1). */
function withEffectiveStarts(sections: readonly PresentSection[]): PresentSection[] {
  return sections.map((section, index) => (section.start ? { ...section, start: `B${startBlock(sections, index)}` } : section));
}

/**
 * The held sections a repair may key on, as the model-facing view: label and, for a preview
 * section, the block it effectively starts at (the first always B1). The model's own rejected call already carries every body.
 */
export function heldSectionsForRepair(sections: PresentResultInput['sections']): Array<{ label: string; start?: string }> {
  return withEffectiveStarts((sections ?? []) as PresentSection[]).map(({ label, start }) => ({ label, ...(start ? { start } : {}) }));
}

/**
 * The repair-call sentence a repairable rejection carries, stated once here for every failure: the
 * fields to resend and, when `sections` is among them, how the resend merges under the stage's own
 * section body field — or, when the held draft has no section, that every section is resent.
 */
export function presentResultRepairInstruction(
  resendList: readonly PresentResultRepairField[],
  stage: PresentResultStage,
  sectionsHeld = true,
  highlightLabelIndexes?: readonly number[],
  sectionTextLeaves?: PresentResultRepairAuthorization['sectionTextLeaves'],
): string {
  if (stage === 'external') return `Nothing from this call was kept: call lineage_present_result again with the whole payload, ${resendList.join(', ')} corrected.`;
  const wholeFields = resendList.filter(field => field === 'highlight_groups' && !highlightLabelIndexes);
  return [
    `You may repair the held draft by calling lineage_present_result with only these corrected fields: ${resendList.join(', ')}.`,
    resendList.includes('sections') && !sectionTextLeaves
      ? (sectionsHeld ? keyedResendRule('sections', 'label', [stage === 'visual_preview' ? 'start' : 'text', 'node_ids']) : 'No section is held: resend every section.')
      : '',
    highlightLabelIndexes
      ? `Repair only the overlong highlight label${highlightLabelIndexes.length === 1 ? '' : 's'}: highlight_groups accepts {index, label} for zero-based ${highlightLabelIndexes.join(', ')}. Replace each rejected label with only its short shared role or status, ending before any dash, colon, example or member list. Leave generous headroom below the served maxLength rather than trimming to its edge. Every color, node_ids list, other label and group position stays held.`
      : '',
    sectionTextLeaves
      ? `Repair only the rejected section text leaves: sections accepts one indexed object containing exactly the listed replacement field or fields for ${sectionTextLeaves.map(leaf => `zero-based ${leaf.index} (${leaf.fields.join(' + ')})`).join(', ')}. Every node_ids list, other section field and section position stays held.`
      : '',
    resendList.includes('notes') ? `${keyedResendRule('notes', 'node_id')} {node_id: …, remove: true} drops a held note.` : '',
    wholeFields.length > 0 ? `${wholeFields.join(', ')}: a resend replaces the held list whole, so send every entry, corrected.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * Holds the valid fields of a `lineage_present_result` call its stage schema rejected in the handler,
 * so the retry resends only the failed field(s) and {@link mergePresentResultRepairPatch} restores the rest.
 *
 * @param store - The session's held `present_result` draft.
 * @param input - The rejected payload as the model sent it.
 * @param failedPaths - Dotted Zod issue paths of the rejection.
 * @param stage - The stage the call was made in.
 * @param committed - Sections of the committed report an update call may keep text for, or `null`. A
 *   keep-text section (label, no text) whose label has no committed body is invalid, so `sections` is not held.
 * @remarks
 * Only top-level fields the tool defines are held; any other key, whether or not the rejection could
 * name it by path, is left out of the held draft and does not stop the call's valid fields from being held.
 *
 * @returns The repair sentence naming the failed fields to resend; `null` when nothing was held: a draft is
 *   already held, the payload is not an object, a failed path names a defined field no repair may
 *   send, or only undefined keys failed.
 */
export function holdRejectedPresentResult(
  store: RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>,
  input: unknown,
  failedPaths: readonly string[],
  stage: PresentResultStage,
  committed: ReadonlyArray<{ label: string; text?: string }> | null = null,
): string | null {
  if (store.get() || typeof input !== 'object' || input === null || Array.isArray(input) || failedPaths.length === 0) return null;
  const repairable = new Set<string>(PRESENT_RESULT_REPAIR_FIELDS);
  const failedKeys = [...new Set(failedPaths.map(path => path.split('.')[0]))];
  const failed = failedKeys.filter(key => PRESENT_RESULT_DEFINED_FIELDS.has(key));
  if (failed.length === 0 || !failed.every(field => repairable.has(field))) return null;
  const highlightGroupPaths = failedPaths.filter(path => path.startsWith('highlight_groups'));
  const highlightLabelPaths = highlightGroupPaths.filter(path => /^highlight_groups\.\d+\.label$/.test(path));
  const rawHighlightGroups = (input as Record<string, unknown>).highlight_groups;
  const highlightLabelIndexes = highlightLabelPaths.length > 0
    && highlightLabelPaths.length === highlightGroupPaths.length
    && Array.isArray(rawHighlightGroups)
    && highlightLabelPaths.every(path => Number(path.split('.')[1]) < rawHighlightGroups.length)
    ? [...new Set(highlightLabelPaths.map(path => Number(path.split('.')[1])))].sort((left, right) => left - right)
    : undefined;
  const sectionPaths = failedPaths.filter(path => path.startsWith('sections'));
  const sectionLeafPaths = sectionPaths.filter(path => /^sections\.\d+\.(label|text)$/.test(path));
  const rawSections = (input as Record<string, unknown>).sections;
  const sectionTextLeaves = sectionLeafPaths.length > 0
    && sectionLeafPaths.length === sectionPaths.length
    && Array.isArray(rawSections)
    && sectionLeafPaths.every(path => Number(path.split('.')[1]) < rawSections.length)
    ? [...new Set(sectionLeafPaths.map(path => Number(path.split('.')[1])))].sort((left, right) => left - right).map(index => ({
      index,
      fields: [...new Set(sectionLeafPaths.filter(path => Number(path.split('.')[1]) === index).map(path => path.split('.')[2] as 'label' | 'text'))].sort(),
    }))
    : undefined;
  const hasLeafRepair = highlightLabelIndexes || sectionTextLeaves;
  const bodies = new Set((committed ?? []).filter(sec => sec.text).map(sectionKey));
  const unkept = Array.isArray(rawSections) && committed
    ? (rawSections as PresentSectionPatch[]).filter(sec => !('text' in sec && sec.text?.trim()) && !bodies.has(sectionKey(sec))).map(sec => sec.label)
    : [];
  if (unkept.length > 0 && !hasLeafRepair && !failed.includes('sections')) failed.push('sections');
  // Only fields the tool defines are held: a key the schema does not know never rides the draft,
  // whether or not the rejection could name it by path.
  const kept = hasLeafRepair
    ? Object.fromEntries(Object.entries(input).filter(([key]) => PRESENT_RESULT_DEFINED_FIELDS.has(key) && (
      (key === 'highlight_groups' && highlightLabelIndexes)
      || (key === 'sections' && sectionTextLeaves)
      || !failed.includes(key)
    )))
    : Object.fromEntries(Object.entries(input).filter(([key]) => PRESENT_RESULT_DEFINED_FIELDS.has(key) && !failed.includes(key)));
  if (Object.keys(kept).length === 0) return null;
  const fields = failed as PresentResultRepairField[];
  store.hold(kept as PresentResultInput, {
    fields,
    ...(highlightLabelIndexes ? { highlightLabelIndexes } : {}),
    ...(sectionTextLeaves ? { sectionTextLeaves } : {}),
  });
  const heldDescription = hasLeafRepair
    ? 'Held from this call: every valid report field and the complete affected lists; only the offending text is replaceable.'
    : `Held from this call: every field except ${fields.join(', ')}.`;
  const unheld = unkept.length > 0 && !hasLeafRepair
    ? ` sections for ${quoteIds(unkept)} were not held: the committed report has no body for them. Its sections are ${quoteIds((committed ?? []).map(sec => sec.label))}; omit sections to keep the committed report.`
    : '';
  return `${heldDescription}${unheld} ${presentResultRepairInstruction(fields, stage, false, highlightLabelIndexes, sectionTextLeaves)}`;
}

type PresentNote = NonNullable<PresentResultInput['notes']>[number];
type PresentNotePatch = Partial<PresentNote> & { remove?: boolean };

/** A note's merge key: its node id without brackets, case-folded unless the model's identifiers are case-sensitive, so a bare and a bracketed id name one note. */
function noteKey(note: Partial<PresentNote>, identifierCaseSensitive: boolean): string {
  const bare = (note.node_id ?? '').replace(/[[\]]/g, '').trim();
  return identifierCaseSensitive ? bare : bare.toLowerCase();
}

/**
 * Merges a strict repair patch into a held full `present_result` draft.
 *
 * @remarks
 * `sections` merge by label ({@link RepairDraftStore.mergeByKey}); a preview list, whose sections
 * each carry a `start`, is then ordered by its effective start (the held first section at B1), so a new mid-answer section never trips the
 * ascending-starts check (two sections sharing a start still do). `notes` merge by node id, so one
 * missing caption is one resent entry; an ordinary `highlight_groups` repair replaces its list whole. A parse rejection confined to overlong
 * highlight labels instead authorizes `{index, label}` leaves. Likewise, a rejection confined to a
 * section's `label` or `text` authorizes only those indexed leaves. Each narrow merge preserves the
 * rest of the held list, and the normal validation/assembly path checks the restored full draft.
 * A presentation field the rejection did not name is accepted too and replaces the held value, so
 * a repair that also carries a field the draft never had (`notes`, `closing`) is merged, not refused.
 *
 * @param draft - The held full `present_result` draft the patch amends.
 * @param patch - The repair patch fields sent by the model.
 * @param authorization - What the rejection that held the draft authorized.
 * @param identifierCaseSensitive - Whether the loaded model distinguishes identifiers by case; decides which note ids name one note.
 * @returns The draft with the authorized keys from `patch` merged in.
 * @throws When `patch` names a graph-edit key the rejection did not authorize.
 */
export function mergePresentResultRepairPatch(
  draft: PresentResultInput,
  patch: PresentResultRepairPatch,
  authorization: PresentResultRepairAuthorization,
  identifierCaseSensitive = false,
): PresentResultInput {
  const allowed = new Set<string>([...PRESENT_RESULT_REPAIR_FIELDS, ...authorization.fields]);
  const updates: Partial<PresentResultInput> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'is_update') continue;
    if (!allowed.has(key)) throw new Error(`Unauthorized present_result repair field: ${key}`);
    if (key === 'highlight_groups' && authorization.highlightLabelIndexes && Array.isArray(value)) {
      const authorized = new Set(authorization.highlightLabelIndexes);
      const labels = new Map<number, string>();
      for (const entry of value as unknown as Array<{ index: number; label: string }>) {
        if (!authorized.has(entry.index)) throw new Error(`Unauthorized present_result highlight label index: ${entry.index}`);
        if (labels.has(entry.index)) throw new Error(`Duplicate present_result highlight label index: ${entry.index}`);
        labels.set(entry.index, entry.label);
      }
      if (labels.size !== authorized.size) throw new Error('Present_result highlight label repair omitted an authorized index.');
      updates.highlight_groups = (draft.highlight_groups ?? []).map((group, index) => (
        labels.has(index) ? { ...group, label: labels.get(index)! } : group
      ));
      continue;
    }
    if (key === 'sections' && authorization.sectionTextLeaves && Array.isArray(value)) {
      const authorized = new Map(authorization.sectionTextLeaves.map(leaf => [leaf.index, new Set(leaf.fields)]));
      const replacements = new Map<number, PresentResultSectionTextPatch>();
      for (const entry of value as unknown as readonly PresentResultSectionTextPatch[]) {
        const fields = authorized.get(entry.index);
        if (!fields) throw new Error(`Unauthorized present_result section text index: ${entry.index}`);
        if (replacements.has(entry.index)) throw new Error(`Duplicate present_result section text index: ${entry.index}`);
        for (const field of ['label', 'text'] as const) {
          if (entry[field] !== undefined && !fields.has(field)) throw new Error(`Unauthorized present_result section text leaf: ${entry.index}.${field}`);
        }
        if ([...fields].some(field => entry[field] === undefined)) throw new Error(`Present_result section text repair omitted an authorized leaf at index ${entry.index}.`);
        replacements.set(entry.index, entry);
      }
      if (replacements.size !== authorized.size) throw new Error('Present_result section text repair omitted an authorized index.');
      updates.sections = (draft.sections ?? []).map((section, index) => {
        const replacement = replacements.get(index);
        return replacement ? { ...section, ...(replacement.label !== undefined ? { label: replacement.label } : {}), ...(replacement.text !== undefined ? { text: replacement.text } : {}) } : section;
      });
      continue;
    }
    if (key === 'sections' && Array.isArray(value)) {
      const merged = RepairDraftStore.mergeByKey<PresentSection>(withEffectiveStarts(draft.sections ?? []), value as PresentSectionPatch[], sectionKey)
        .map(section => ({ ...section, node_ids: section.node_ids ?? [] }));
      updates.sections = merged.every(section => section.start)
        ? merged.sort((a, b) => Number(a.start!.slice(1)) - Number(b.start!.slice(1)))
        : merged;
      continue;
    }
    if (key === 'notes' && Array.isArray(value)) {
      updates.notes = RepairDraftStore.mergeByKey<PresentNote>(draft.notes ?? [], value as PresentNotePatch[], note => noteKey(note, identifierCaseSensitive));
      continue;
    }
    Object.assign(updates, { [key]: value });
  }
  return {
    ...draft,
    ...updates,
    is_update: draft.is_update,
  };
}

/**
 * Encodes a node id for the `#focus-node:` destination of an engine-assembled object link.
 *
 * @remarks
 * A bracketed SQL identifier may legally contain characters that break the link on either side of
 * the wire. `encodeURIComponent` covers `%`, which raw would make the overlay's `decodeURIComponent`
 * throw a `URIError` in the click handler (`Discount%`) or silently resolve to a different id
 * (`Rate%20Card`). It deliberately leaves `(` and `)` alone, so those are escaped after it: an
 * unbalanced `)` terminates a markdown link destination and truncates the href. Both escapes are
 * ordinary percent sequences, so the overlay's existing single `decodeURIComponent` reverses them.
 *
 * @param id - Canonical node id from the model.
 * @returns The id as a markdown-safe, `decodeURIComponent`-reversible link destination.
 */
function encodeFocusNodeId(id: string): string {
  return encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Returns the ```sql fence opening at `openIndex`, tolerant of a one-line fence and of its closing
 * marker sharing a line with the last line of code rather than starting one of its own.
 *
 * @param text - Full captured `DetailSlot` section body.
 * @param openIndex - Offset where the fence's own ```sql marker begins.
 * @returns The fence, closed; `undefined` when no ```sql marker opens there or it never closes.
 */
function sqlFenceAt(text: string, openIndex: number): string | undefined {
  const rest = text.slice(openIndex);
  if (!/^```sql/i.test(rest)) return undefined;
  const close = rest.indexOf('```', '```sql'.length);
  // A following language opener cannot close this SQL block or turn intervening prose into SQL.
  if (close === -1) return undefined;
  // A marker on the opening line closes it: a language opener starts a line of its own.
  if (!rest.slice(0, close).includes('\n')) return rest.slice(0, close + 3);
  const suffix = rest.slice(close + 3);
  const spacedOpener = /^[ \t]+[a-z][\w.+-]*(?:[ \t]+S\d+)?[ \t]*(?:\r?\n|$)/i.test(suffix);
  if (/^[a-z]/i.test(suffix) || spacedOpener) return undefined;
  return rest.slice(0, close + 3);
}

/** One fenced code block captured in a detail slot, addressable by a deterministic citation id. */
export interface EvidenceBlock {
  /** Citation id, e.g. `S7` — carried in the fence info string the envelope shows (`sql S7`). */
  readonly id: string;
  /** Owning node id. */
  readonly nodeId: string;
  /** The captured ```sql fence closed on a line of its own — body de-indented out of its list or block-quote container, `sql S7` annotation excluded — rendered verbatim. */
  readonly raw: string;
}

/**
 * Reports which captured SQL blocks the rendered report shows, by whitespace-insensitive match of
 * the block body — so a block expanded from its id and one the author wrote out both count.
 *
 * @param blocks - The id → block lookup from {@link assignEvidenceIds}.
 * @param renderedTexts - Report text fields after {@link expandEvidenceRefs}.
 * @returns `served` — captured block count; `unusedIds` — ids of blocks no field shows, in id order.
 */
export function evidenceCoverage(
  blocks: ReadonlyMap<string, EvidenceBlock>,
  renderedTexts: readonly string[],
): { readonly served: number; readonly unusedIds: string[] } {
  const squash = (text: string): string => text.replace(/\s+/g, '');
  const rendered = squash(renderedTexts.join('\n'));
  const unusedIds: string[] = [];
  for (const block of blocks.values()) {
    const body = squash(block.raw.split('\n').slice(1, -1).join('\n'));
    if (!rendered.includes(body)) unusedIds.push(block.id);
  }
  return { served: blocks.size, unusedIds };
}

/** Container prefix of a line: block-quote markers, indentation and a list marker. */
const CONTAINER_PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/;

/** Info string of an evidence reference: optional info words, then the id (group 1). */
const EVIDENCE_ID_INFO = /^[ \t]*(?:[^\s`]+[ \t]+)*?(S\d+)[ \t]*$/;

/** One ```sql fence located by the {@link sqlFenceAt} rule. */
interface LocatedSqlFence {
  /** Offset of the ```sql marker. */
  readonly start: number;
  /** Offset just past the closing marker. */
  readonly end: number;
  /** Text after ```sql on the opening line; for a one-line fence, everything between the markers. */
  readonly info: string;
  /** Code lines, de-indented out of the opening line's container; empty for a one-line or empty fence. */
  readonly lines: readonly string[];
  /** Container prefix of the opening line. */
  readonly container: string;
}

/**
 * Every ```sql fence in `text`, in order, by the {@link sqlFenceAt} rule: the marker may open
 * mid-line after prose or a formula, and the closing marker may share a line with code or with
 * prose after it. An unclosed marker yields nothing.
 */
function* locateSqlFences(text: string): Generator<LocatedSqlFence> {
  const opener = /```sql/gi;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const fence = sqlFenceAt(text, match.index);
    if (!fence) continue;
    const inner = fence.slice('```sql'.length, -'```'.length);
    const newline = inner.indexOf('\n');
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const container = CONTAINER_PREFIX.exec(text.slice(lineStart, match.index))?.[0] ?? '';
    const lines = newline === -1 ? [] : inner.slice(newline + 1).split('\n')
      .map(line => (container.includes('>') ? line.replace(/^(?:[ \t]*>)+[ \t]?/, '') : line));
    if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
    yield {
      start: match.index,
      end: match.index + fence.length,
      info: newline === -1 ? inner : inner.slice(0, newline),
      lines: lines.some(line => line.trim()) ? lines.map(line => line.slice(indent)) : [],
      container,
    };
    opener.lastIndex = match.index + fence.length;
  }
}

/**
 * Assigns one deterministic citation id to every captured ```sql fence with a body in detail-slot
 * text — numbered by detail-slot order, then block order — carried in the envelope as an addition
 * to the fence's own info string (```` ```sql S7 ````), never a separate inline marker (a bracketed
 * marker collides with T-SQL bracket identifiers and Markdown link syntax).
 *
 * @remarks
 * Fences are located by {@link locateSqlFences}, so a capture that opens its fence mid-line (`⚠️ ```sql`, `$$ … $$ ```sql`) still carries its id on the
 * opening marker and its block is that fence, closed. The function is pure and depends only on
 * `detailSlots` content, so the envelope builder (which needs the annotated slots) and the
 * `present_result` handler (which needs only the id lookup) each call it on the same archive and
 * agree on every id without sharing state. `EvidenceBlock.raw` is the block unannotated — the id
 * exists only in the copy delivered to the model.
 *
 * @param detailSlots - Captured archive to scan; returned slots are a new array, the input is
 * unchanged.
 * @returns `slots` — the detail slots with each fenced block's info string carrying its id, for the
 * envelope the model reads; `blocks` — the id → block lookup {@link expandEvidenceRefs} resolves.
 */
export function assignEvidenceIds(
  detailSlots: readonly DetailSlot[],
): { readonly slots: DetailSlot[]; readonly blocks: ReadonlyMap<string, EvidenceBlock> } {
  const blocks = new Map<string, EvidenceBlock>();
  let n = 0;
  const slots = detailSlots.map(slot => ({
    ...slot,
    sections: slot.sections.map(section => {
      let cursor = 0;
      let text = '';
      for (const fence of locateSqlFences(section.text)) {
        if (fence.lines.length === 0) continue;
        n += 1;
        const id = `S${n}`;
        const info = fence.info.trimEnd();
        blocks.set(id, { id, nodeId: slot.nodeId, raw: [`\`\`\`sql${info}`, ...fence.lines, '```'].join('\n') });
        const infoEnd = fence.start + '```sql'.length + info.length;
        text += `${section.text.slice(cursor, infoEnd)} ${id}`;
        cursor = infoEnd;
      }
      if (cursor === 0) return section;
      return { ...section, text: text + section.text.slice(cursor) };
    }),
  }));
  return { slots, blocks };
}

/** Exact fence-body identity; whitespace can change SQL literal and quoted-identifier values. */
function fenceBodyKey(lines: readonly string[]): string {
  return lines.join('\n');
}

/** Where a fence stands on its line, widened over a parenthesis pair that wraps only the fence. */
interface FenceExtent {
  readonly lineStart: number;
  /** Offset of the line's newline, or `text.length` on the last line. */
  readonly lineEnd: number;
  /** Start of the fence, or of the `(` that wraps it. */
  readonly from: number;
  /** End of the fence, or just past the `)` that wraps it. */
  readonly to: number;
  /** Nothing but the container prefix precedes `from` and nothing but whitespace follows `to` on the line. */
  readonly ownLine: boolean;
}

/** Locates `fence` on its line; a `(` before and a `)` after it with nothing else between are part of the extent. */
function fenceExtent(text: string, fence: LocatedSqlFence): FenceExtent {
  const lineStart = text.lastIndexOf('\n', fence.start - 1) + 1;
  const newline = text.indexOf('\n', fence.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const open = /[ \t]*\([ \t]*$/.exec(text.slice(lineStart + fence.container.length, fence.start));
  const close = /^[ \t]*\)/.exec(text.slice(fence.end, lineEnd));
  const wrapped = open !== null && close !== null;
  const from = wrapped ? fence.start - open[0].length : fence.start;
  const to = wrapped ? fence.end + close[0].length : fence.end;
  return { lineStart, lineEnd, from, to, ownLine: text.slice(lineStart, from) === fence.container && text.slice(to, lineEnd).trim() === '' };
}

/**
 * The span of the whole lines a fence occupies — container prefix and one newline included — when
 * nothing else shares them; otherwise the fence alone, with a wrapping `( )` pair.
 */
function fenceLineSpan(text: string, fence: LocatedSqlFence): [number, number] {
  const { lineStart, lineEnd, from, to, ownLine } = fenceExtent(text, fence);
  if (!ownLine) return [from, to];
  return lineEnd === text.length ? [Math.max(0, lineStart - 1), text.length] : [lineStart, lineEnd + 1];
}

/**
 * Renders `blockLines` where `fence` stands as a block that starts on its own line and ends before a
 * line break, every line indented to the fence's container so a list item or block quote keeps it.
 * Prose before the fence on its line stays before it; prose after it continues on a new line.
 *
 * @returns `out` — the text from `cursor` through the block (and the break before any continuation);
 * `cursor` — where the caller resumes copying `text`.
 */
function placeFenceBlock(
  text: string,
  cursor: number,
  fence: LocatedSqlFence,
  extent: FenceExtent,
  blockLines: readonly string[],
): { out: string; cursor: number } {
  const indent = fence.container.replace(/[^\s>]/g, ' ');
  const ownStart = text.slice(extent.lineStart, extent.from) === fence.container;
  const before = ownStart ? text.slice(cursor, extent.from) : `${text.slice(cursor, extent.from).trimEnd()}\n`;
  const block = blockLines.map((line, k) => (line && (k > 0 || !ownStart) ? indent + line : line)).join('\n');
  const after = text.slice(extent.to, extent.lineEnd);
  const rest = after.trimStart();
  if (rest === '') return { out: before + block, cursor: extent.to };
  return { out: `${before}${block}\n${indent}`, cursor: extent.to + after.length - rest.length };
}

/**
 * Expands evidence references in one rendered text field: a ```sql fence whose info string ends in
 * a served id (```` ```sql S7 ```` closed with no body, or the one-line ```` ```sql S7``` ````) is
 * replaced by the captured block.
 *
 * @remarks
 * The expanded block always starts on its own line and a line break follows its closing fence,
 * because CommonMark opens a fenced block only at the start of a line: every line of the block is
 * indented to the content column of the list item or block quote the reference stands in, prose
 * before the reference on its line stays before it, and prose after it continues on a new line at
 * the same indent. A `( )` pair that wrapped only the reference is dropped with it. A reference
 * already on a line of its own expands byte for byte as written, and a fence the model wrote with
 * its own SQL and an id is placed the same way when it shares its line with prose.
 *
 * A reference is an optional shorthand for writing the captured SQL out — the model may always
 * write SQL itself. Fences are located by the rule {@link assignEvidenceIds} numbers them with, so a
 * fence the model opens mid-line never pairs with a later reference's marker. Two cases are
 * normalized and reported in `normalized` for the caller's log: a fence that carries an id *and* a
 * body keeps the body the model wrote and only loses the id, so SQL is never shown twice for one
 * fence; a reference whose block the section already shows (a fence with the same body, or an
 * earlier reference to it) renders nothing. An id that names no captured block is returned in
 * `unknownIds` and the fence is left as written; the caller rejects it.
 *
 * The caller runs this over every field {@link orderAndAssemble} renders verbatim — `title`,
 * `intro`, `closing` and each section's text — so an id cited outside a section expands or rejects
 * exactly like one inside a section, never a silently unresolved fence. Unclosed SQL blocks are
 * returned in `malformedRefs` for structured repair; their text is never consumed as another block.
 * It expands a rendering copy only: the held repair draft keeps the unexpanded input, so a resent field still carries
 * short references.
 *
 * @param text - One authored text field (a section body, or `title` / `intro` / `closing`).
 * @param blocks - The id → block lookup from {@link assignEvidenceIds}.
 */
export function expandEvidenceRefs(
  text: string,
  blocks: ReadonlyMap<string, EvidenceBlock>,
): { text: string; unknownIds: string[]; normalized: string[]; malformedRefs: string[] } {
  const fences = [...locateSqlFences(text)];
  const byStart = new Map(fences.map(fence => [fence.start, fence]));
  const malformedRefs: string[] = [];
  let coveredUntil = 0;
  for (const marker of text.matchAll(/```sql([^\n`]*)/gi)) {
    if (marker.index < coveredUntil) continue;
    const valid = byStart.get(marker.index);
    if (valid) coveredUntil = valid.end;
    else malformedRefs.push(EVIDENCE_ID_INFO.exec(marker[1])?.[1] ?? 'unlabelled SQL');
  }
  const shown = new Set(fences.filter(fence => fence.lines.length > 0).map(fence => fenceBodyKey(fence.lines)));
  const unknownIds: string[] = [];
  const normalized: string[] = [];
  let out = '';
  let cursor = 0;
  for (const fence of fences) {
    const id = EVIDENCE_ID_INFO.exec(fence.info)?.[1];
    if (!id) continue;
    const block = blocks.get(id);
    if (fence.lines.length > 0) {
      const info = fence.info.slice(0, fence.info.lastIndexOf(id)).trimEnd();
      const extent = fenceExtent(text, fence);
      if (extent.ownLine) {
        const infoStart = fence.start + '```sql'.length;
        out += text.slice(cursor, infoStart) + info;
        cursor = infoStart + fence.info.length;
      } else {
        const placed = placeFenceBlock(text, cursor, fence, extent, [`\`\`\`sql${info}`, ...fence.lines, '```']);
        out += placed.out;
        cursor = placed.cursor;
      }
      normalized.push(`${id} dropped from a fence that carries its own SQL`);
    } else if (!block) {
      unknownIds.push(id);
    } else {
      const blockLines = block.raw.split('\n');
      const key = fenceBodyKey(blockLines.slice(1, -1));
      if (shown.has(key)) {
        const [from, to] = fenceLineSpan(text, fence);
        out += text.slice(cursor, Math.max(cursor, from));
        cursor = to;
        normalized.push(`${id} not rendered — the section already shows that SQL`);
        continue;
      }
      shown.add(key);
      const placed = placeFenceBlock(text, cursor, fence, fenceExtent(text, fence), blockLines);
      out += placed.out;
      cursor = placed.cursor;
    }
  }
  return { text: out + text.slice(cursor), unknownIds, normalized, malformedRefs };
}

/**
 * Builds the rendered description markdown from the AI's structured input parts.
 *
 * @remarks
 * This is the SOLE path that produces the description blob shown in
 * `AiDescriptionOverlay`. The AI never writes the blob directly — it writes the
 * parts (title, intro, sections[], closing) and the engine assembles them
 * deterministically here. Section numbering (`## N {label}`), badge chips, and
 * the `### Objects [name](#focus-node:id)` footnote are all engine-owned;
 * they are not AI-authored fields.
 *
 * Numbered badges are emitted only for AI-provided `sections[].node_ids[]`, in
 * narrative order, so chips on the graph align with `## N` headings in the
 * description. Nodes not linked by the AI get no badge.
 *
 * A node the AI links from more than one section is normalized here, not rejected: the first
 * section wins the badge and the object link, the later links are returned in
 * `droppedSectionLinks` for the caller to log, and no section text changes.
 *
 * The object links render as a footnote at the END of each section body, not a
 * heading under the section title: the renderer restyles the `### Objects`
 * transport line into a small muted paragraph, so the link list reads as a
 * side note at body-small size instead of competing with the section heading.
 *
 * `title`, `intro`, `closing` and every section's text arrive with evidence references already
 * expanded ({@link expandEvidenceRefs}) — every field this function renders verbatim shares that
 * one expansion, so none reaches the assembled document as an unresolved reference fence.
 *
 * @param sections - AI-authored sections containing labels, node associations, and text; labels are unique.
 * @param opts - Optional wrapper blocks for the final document.
 * @returns The numbered badges for the graph, the fully assembled markdown description, and any
 *   duplicate section links first-wins dropped while assembling them.
 */
export function orderAndAssemble(
  sections: Array<{ label: string; node_ids?: string[]; text?: string }>,
  opts?: {
    title?: string;
    intro?: string;
    /** Engine-owned block (e.g. the CT column chain) inserted between the intro and the first section. */
    preface?: string;
    closing?: string;
    /** Optional node lookup for injecting clickable object-link footnotes per section. */
    nodeMap?: Map<string, { id: string; name: string }>;
  },
): {
  badges: Array<{ node_id: string; text: string }>;
  description: string;
  droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }>;
} {
  const uniqueLabels = [...new Set(sections.map(sec => sec.label))];
  const labelToNumber = new Map(uniqueLabels.map((label, i) => [label, i + 1]));

  const nodeToLabel = new Map<string, string>();
  const labelToNodeIds = new Map<string, string[]>();
  const droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }> = [];
  for (const { label, node_ids } of sections) {
    let kept = labelToNodeIds.get(label);
    if (!kept) { kept = []; labelToNodeIds.set(label, kept); }
    for (const id of node_ids ?? []) {
      const owner = nodeToLabel.get(id);
      if (owner !== undefined) {
        if (owner !== label) droppedSectionLinks.push({ node_id: id, dropped_from: label, kept_in: owner });
        continue;
      }
      nodeToLabel.set(id, label);
      kept.push(id);
    }
  }

  const badges = [...nodeToLabel].map(([node_id, label]) => ({ node_id, text: `${labelToNumber.get(label)} ${label}` }));

  const parts: string[] = [];
  if (opts?.title)        parts.push(`# ${opts.title}`);
  if (opts?.intro)        parts.push(opts.intro);
  if (opts?.preface)      parts.push(opts.preface);
  const sectionMap = new Map(sections.map(sec => [sec.label, sec.text]));
  for (const label of uniqueLabels) {
    const n = labelToNumber.get(label)!;
    const text = sectionMap.get(label) ?? '';
    const nodeIds = labelToNodeIds.get(label) ?? [];
    let objectFootnote = '';
    if (opts?.nodeMap && nodeIds.length > 0) {
      const links = nodeIds
        .map(id => opts.nodeMap!.get(id))
        .filter((node): node is { id: string; name: string } => !!node)
        .map(node => `[${node.name}](${FOCUS_NODE_HREF_PREFIX}${encodeFocusNodeId(node.id)})`);
      if (links.length > 0) objectFootnote = `### Objects ${links.join(', ')}`;
    }
    let section = `## ${n} ${label}`;
    if (text)          section += `\n\n${text}`;
    if (objectFootnote) section += `\n\n${objectFootnote}`;
    parts.push(section);
  }
  if (opts?.closing) parts.push(`---\n\n${opts.closing}`);

  return { badges, description: parts.join('\n\n'), droppedSectionLinks };
}

/**
 * One validated CT column-flow edge, reduced to the structural fields the chain table reads.
 *
 * @remarks Structural on purpose: the sm-side `ColumnEdge` satisfies it without an import, so
 * this assembler stays a pure document builder with no dependency on navigation state.
 */
export type ColumnChainEdge = {
  /** 1-based hop index the edge was traced at. */
  hop: number;
  /** Source node id. */
  from_node: string;
  /** Source column name. */
  from_col: string;
  /** Destination node id. */
  to_node: string;
  /** Destination column name. */
  to_col: string;
  /** Recorded contributor roles; omitted when not established. */
  transforms?: readonly ColumnTransformClass[];
};

/**
 * Builds the engine-owned "Column Chain" preface for a CT result from validated column-flow edges.
 *
 * @remarks
 * CT answers differ from BB by a recorded column chain, and that chain already exists in validated
 * form (`column_flow` per hop) — this renders it as a deterministic table at the top of the
 * document instead of leaving the distinction to prose. Like badges and section numbering, the
 * table is engine output: the model never writes it, so it can never drift from the recorded
 * edges. Each output column is named once above its source table; outputs are ordered by first
 * capture and their rows by hop. Hop numbers identify evidence capture, not additional storage
 * steps. The unnumbered `## Column Chain` heading is deliberately not a
 * `## N` section, so it takes no section number and no navigation chip.
 *
 * @param edges - Validated column-flow edges accumulated by the engine.
 * @returns The preface markdown, or `undefined` when no edge was recorded (nothing to show).
 */
export function buildColumnChainPreface(edges: readonly ColumnChainEdge[]): string | undefined {
  if (edges.length === 0) return undefined;
  const outputs = new Map<string, ColumnChainEdge[]>();
  for (const edge of [...edges].sort((a, b) => a.hop - b.hop)) {
    const key = JSON.stringify([edge.to_node, edge.to_col]);
    const group = outputs.get(key);
    if (group) group.push(edge);
    else outputs.set(key, [edge]);
  }
  const parts = ['## Column Chain'];
  for (const group of outputs.values()) {
    const output = group[0]!;
    parts.push(
      `**Output:** ${columnChainCode(`${output.to_node}.${output.to_col}`)}`,
      [
        '| Source column | Captured at hop | Contributor roles |',
        '| --- | ---: | --- |',
        ...group.map(edge => `| ${columnChainCode(`${edge.from_node}.${edge.from_col}`)} | ${edge.hop} | ${edge.transforms?.map(role => columnChainCode(role)).join(', ') ?? ''} |`),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** Keeps quoted database identifiers inside one code span and one Markdown table cell. */
function columnChainCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const content = value.replace(/\|/g, '\\|');
  const padding = longestRun > 0 ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}

/**
 * Reports which non-pruned nodes the AI left unlinked in both badge-producing surfaces
 * (`sections[].node_ids` and `highlight_groups[].node_ids`) — an observation for the log,
 * never a payload mutation.
 *
 * @remarks
 * The `notes` schema requires a caption for every kept node the engine lists with no detail slot
 * (`toolSchemas.ts` notes description; the checklist is rendered by `smPrompts.ts`), so a node this
 * function flags is not a licensed "stays bare" outcome — it is either covered by a `notes[]` entry
 * this function does not inspect, or a gap that note-coverage contract was meant to close. Either
 * way the engine has no authority to re-link it: a tool boundary accepts, rejects with a structural
 * hint, or mechanically normalizes with a log — it never silently rewrites an AI presentation
 * decision. Only `prune` removes a node from the
 * view; an unlinked node still renders via `resolvedNodeIds`, just without a badge or highlight
 * color.
 *
 * @param resultGraph - The engine result carrying the locked `node_states` verdicts.
 * @param input - The (already auto-fixed) present payload. Read-only.
 * @param resolvedNodeIds - The canonical node-id set for the rendered view.
 * @returns The non-pruned resolved ids linked in neither `sections[].node_ids` nor
 * `highlight_groups[].node_ids` (empty when there are no authored sections — update-style calls).
 */
export function findBareNonPrunedNodes(
  resultGraph: {
    node_states?: Array<{ nodeId: string; action: string }>;
  } | null | undefined,
  input: PresentResultInput,
  resolvedNodeIds: string[],
): string[] {
  const sections = input.sections;
  if (!sections || sections.length === 0) return [];
  const resolvedSet = new Set(resolvedNodeIds);
  const prunedIds = new Set(
    (resultGraph?.node_states ?? []).filter(s => s.action === 'prune').map(s => s.nodeId),
  );
  const linked = new Set<string>();
  for (const sec of sections) for (const id of sec.node_ids ?? []) if (resolvedSet.has(id)) linked.add(id);
  for (const g of input.highlight_groups ?? []) for (const id of g.node_ids ?? []) if (resolvedSet.has(id)) linked.add(id);

  return resolvedNodeIds.filter(id => !prunedIds.has(id) && !linked.has(id));
}

/**
 * The detail-slot node ids a present call must link from `sections[].node_ids[]`: the slots whose
 * node is in the rendered set. The synthesis prompt states the rule, the envelope's `detail_slots`
 * carry exactly these nodes, and {@link findUnrenderedDetailSlotIds} enforces it.
 *
 * @param slotNodeIds - Node ids of every stored detail slot.
 * @param renderedNodeIds - Node ids the render keeps.
 */
export function requiredDetailSlotIds(
  slotNodeIds: readonly string[],
  renderedNodeIds: ReadonlySet<string>,
): string[] {
  return slotNodeIds.filter(id => renderedNodeIds.has(id));
}

/**
 * The column-chain node ids a present call must cover with a section link or a note: the chain
 * nodes the render keeps that carry no detail slot and are not pruned. The synthesis envelope lists
 * this set and the present handler enforces it, so the served list and the check share one source.
 *
 * @param edges - Validated column-flow edges of the result graph.
 * @param renderedNodeIds - Node ids the render keeps, in render order.
 * @param exemptNodeIds - Node ids with a detail slot or a prune state.
 * @param keyOf - Identifier key under the model's case sensitivity.
 */
export function requiredCtChainNodeIds(
  edges: ReadonlyArray<{ from_node: string; to_node: string; hop_node: string }>,
  renderedNodeIds: readonly string[],
  exemptNodeIds: readonly string[],
  keyOf: (id: string) => string,
): string[] {
  if (edges.length === 0) return [];
  const exempt = new Set(exemptNodeIds.map(keyOf));
  const chain = new Set(edges.flatMap(edge => [keyOf(edge.from_node), keyOf(edge.to_node), keyOf(edge.hop_node)]));
  return renderedNodeIds.filter(id => chain.has(keyOf(id)) && !exempt.has(keyOf(id)));
}

/**
 * Reports which delivered `detail_slots[]` reached no rendered section.
 *
 * @remarks
 * A different question from {@link findBareNonPrunedNodes}: that function walks every rendered
 * (non-pruned) node and accepts either badge-producing surface, `sections[].node_ids[]` OR
 * `highlight_groups[].node_ids[]`, because a highlight color is a legitimate way to place a
 * passthrough node that never had analyzed detail to begin with. A `detail_slots[]` entry is
 * different: it is the model's own captured technical findings for that node, the richest
 * material the synthesis call received. Only a `sections[].node_ids[]` link places that prose in
 * the walkthrough (`sections[].text`); a `notes[]` caption is a one-line orientation chip and a
 * highlight color carries no captured findings at all. Accepting notes as coverage is what let a
 * CT render park every formula-bearing hop on a caption and ship a chain table in place of the BB
 * walkthrough. Folding this into `findBareNonPrunedNodes`'s highlight-tolerant check would hide
 * exactly that loss, so it stays a second, narrower computation. The caller
 * (`executePresentResult`) reports every returned id as a {@link PresentResultViolation} whose
 * `repairFields`/`paths` name `sections` only — never `notes` or `highlight_groups`.
 *
 * @param slotNodeIds - Delivered `detail_slots[].nodeId` values — slots whose node is in the
 *   current result graph. The caller intersects `sess.memory.notedNodeIds` with the rendered id
 *   set; a slot whose node the render dropped cannot be linked, so requiring coverage of it
 *   contradicts the node-id check.
 * @param input - The (already auto-fixed) present payload. Read-only.
 * @returns The slot ids absent from every `sections[].node_ids[]`, in `slotNodeIds` order; empty
 *   when there are no authored sections (update-style calls) or every slot is section-linked.
 */
export function findUnrenderedDetailSlotIds(
  slotNodeIds: readonly string[],
  input: PresentResultInput,
): string[] {
  if (slotNodeIds.length === 0 || !input.sections || input.sections.length === 0) return [];
  const sectionNodeIds = new Set<string>();
  for (const sec of input.sections) for (const id of sec.node_ids ?? []) sectionNodeIds.add(id);
  return slotNodeIds.filter(id => !sectionNodeIds.has(id));
}

/**
 * Validates the full `present_result` input against the contracts a schema cannot express.
 *
 * @remarks
 * `input` has already passed the served stage schema in the `present_result` handler, which owns
 * shape, required and blank fields, length caps, unique section labels and the at-least-one
 * highlight group requirement. This function enforces node-id resolution against the result graph
 * and highlight/section/note coverage. Markdown/KaTeX formatting is deliberately
 * not validated: formatting can never reject a call (the renderer degrades gracefully).
 *
 * A node linked from more than one section keeps only its first link
 * ({@link orderAndAssemble} drops and logs the rest).
 *
 * The `description` returned in {@link PresentResultRequest} is the engine-assembled
 * markdown blob built by {@link orderAndAssemble} — passed in as `assembledDescription`,
 * never read from `input`. The AI does not write the assembled document.
 *
 * @param input - The raw AI input.
 * @param resolvedNodeIds - The canonical set of node IDs.
 * @param assembledBadges - Pre-assembled numbered badges for consistency.
 * @param assembledDescription - Engine-built markdown blob from {@link orderAndAssemble}.
 * @param externalViolations - Findings from checks that need context this function does not hold
 *   (the cached discovery answer, the result graph), reported through this accumulator alongside the
 *   structural rules below — see {@link PresentResultViolation}.
 * @param stage - The calling stage (engine-derived), used to keep the unknown-node-id repair hint
 *   caller-possible — see {@link presentNodeIdHint}. Defaults to `'completed'`, whose tool policy
 *   includes `lineage_search_objects` (as the `external` stage's does), so callers that do not pass a
 *   stage keep today's hint wording unchanged.
 * @param nodeIdState - Classifies an id the result graph cannot link against the engine state the
 *   caller holds — see {@link PresentNodeIdStateLookup}. Omitted, every offender is reported as
 *   `not_in_model`, which is the only classification a caller without engine state can make.
 * @returns A successful request object or a structured error with correction hints.
 */
export function validatePresentResult(
  input: PresentResultInput,
  resolvedNodeIds: string[],
  assembledBadges?: Array<{ node_id: string; text: string }>,
  assembledDescription?: string,
  externalViolations: readonly PresentResultViolation[] = [],
  stage: PresentResultStage = 'completed',
  nodeIdState?: PresentNodeIdStateLookup,
): PresentResultRequest | PresentResultFailure {
  const errors: string[] = [];
  let allRepairable = true;
  const repairFields = new Set<PresentResultRepairField>();
  const failedFields = new Set<PresentResultFailedField>();
  const issuePaths = new Set<string>();
  const pathUnlinkableIds = new Map<string, readonly string[]>();
  const pathEntryIds = new Map<string, readonly string[]>();
  const addError = (
    field: PresentResultFailedField,
    message: string,
    authorizedFields: readonly PresentResultRepairField[] = [],
    paths: readonly string[] = [],
    unlinkableIdsAtPath: readonly string[] = [],
    entryIds: readonly string[] = [],
  ): void => {
    errors.push(message);
    failedFields.add(field);
    if (authorizedFields.length === 0) allRepairable = false;
    for (const f of authorizedFields) repairFields.add(f);
    for (const path of paths) {
      issuePaths.add(path);
      if (unlinkableIdsAtPath.length > 0) pathUnlinkableIds.set(path, unlinkableIdsAtPath);
      if (entryIds.length > 0) pathEntryIds.set(path, entryIds);
    }
  };

  for (const violation of externalViolations) {
    for (const message of violation.messages) {
      addError(violation.field, message, violation.repairFields, violation.paths, [], violation.entryIds);
    }
  }

  if (resolvedNodeIds.length === 0) {
    addError('nodes', 'No nodes in view — the result graph is empty or all nodes were pruned');
  }

  const sectionLinkedNodeIds = new Set<string>();

  const resolvedSet = new Set(resolvedNodeIds);
  const nodeIdStateCache = new Map<string, PresentNodeIdState>();
  const stateOf = (nodeId: string): PresentNodeIdState => {
    let state = nodeIdStateCache.get(nodeId);
    if (state === undefined) {
      state = nodeIdState?.(nodeId) ?? 'not_in_model';
      nodeIdStateCache.set(nodeId, state);
    }
    return state;
  };
  const unlinkableNodeIds = [...new Set([
    ...(input.sections ?? []).flatMap(section => section.node_ids ?? []),
    ...(input.notes ?? []).map(note => note.node_id),
    ...(input.highlight_groups ?? []).flatMap(group => group.node_ids ?? []),
  ].filter(id => !resolvedSet.has(id)))];
  const allHallucinated = unlinkableNodeIds.every(id => stateOf(id) === 'not_in_model');
  /** `add_node_ids` accepts any id inside the approved scope — pruned, render-dropped or undispositioned — so only those offenders earn its route. */
  const addNodeIdsReveals = unlinkableNodeIds.some(id => stateOf(id) !== 'not_in_model' && stateOf(id) !== 'out_of_scope');
  const routeServed = stage === 'completed' ? addNodeIdsReveals : !allHallucinated;
  const nodeIdNoun = allHallucinated
    ? 'contains unknown IDs'
    : 'names IDs the result graph cannot link';
  const renderNodeIdStates = (ids: readonly string[]): string => {
    const byState = new Map<PresentNodeIdState, string[]>();
    for (const id of ids) byState.set(stateOf(id), [...(byState.get(stateOf(id)) ?? []), id]);
    return [...byState].map(([state, group]) => `${quoteIds(group)} — ${PRESENT_NODE_ID_STATE_TEXT[state]}`).join('; ');
  };
  /**
   * The valid set and the route back, stated once — on the first offending site — after every
   * offender in the call and its state.
   */
  let nodeIdHintNeeded = false;
  const nodeIdRejectionTail = (idsAtThisPath: readonly string[]): string => {
    if (nodeIdHintNeeded) return '';
    nodeIdHintNeeded = true;
    if (stage === 'completed' && routeServed) repairFields.add('add_node_ids');
    const elsewhere = unlinkableNodeIds.filter(id => !idsAtThisPath.includes(id));
    return (elsewhere.length > 0 ? ` Also unlinkable here: ${renderNodeIdStates(elsewhere)}.` : '')
      + ` Accepted ids (current result graph): ${quoteIds(resolvedNodeIds)}.`
      + (routeServed ? ` ${PRESENT_REAL_ID_ROUTE[stage]}` : '');
  };

  for (const [sectionIndex, sec] of (input.sections ?? []).entries()) {
    const unknownIds = (sec.node_ids ?? []).filter(id => !resolvedSet.has(id));
    if (unknownIds.length > 0) {
      addError('sections', `Section "${sec.label}" node_ids ${nodeIdNoun}: ${renderNodeIdStates(unknownIds)}.${nodeIdRejectionTail(unknownIds)}`, ['sections'], [`sections.${sectionIndex}`], unknownIds);
    }
    for (const nodeId of sec.node_ids ?? []) {
      if (resolvedSet.has(nodeId)) sectionLinkedNodeIds.add(nodeId);
    }
  }

  const noteNodeIds = new Set<string>();
  if (input.notes?.length) {
    for (const [noteIndex, note] of input.notes.entries()) {
      if (resolvedSet.has(note.node_id)) {
        noteNodeIds.add(note.node_id);
      } else {
        addError('notes', `notes[].node_id ${nodeIdNoun}: ${renderNodeIdStates([note.node_id])}.${nodeIdRejectionTail([note.node_id])}`, ['notes'], [`notes.${noteIndex}.node_id`], [note.node_id]);
      }
    }
  }

  const highlightedNodeIds = new Set<string>();
  // A repair patch can leave a held draft without the field: the schema that requires it never saw the merged draft.
  if (!input.highlight_groups) {
    addError('highlight_groups', 'highlight_groups[] is required — provide at least 1 group using the Lineage palette (source / transform / target)', ['highlight_groups'], ['highlight_groups']);
  }
  for (const [groupIndex, g] of (input.highlight_groups ?? []).entries()) {
    const unknownIds = (g.node_ids ?? []).filter(nodeId => !resolvedSet.has(nodeId));
    if (unknownIds.length > 0) {
      addError('highlight_groups', `highlight_groups "${g.label}" node_ids ${nodeIdNoun}: ${renderNodeIdStates(unknownIds)}.${nodeIdRejectionTail(unknownIds)}`, ['highlight_groups'], [`highlight_groups.${groupIndex}`], unknownIds);
    }
    for (const nodeId of g.node_ids ?? []) {
      if (resolvedSet.has(nodeId)) highlightedNodeIds.add(nodeId);
    }
  }

  // An id an external violation already asks to place in a section (or note) is not repeated with a second repair.
  const alreadyRepairedIds = new Set(externalViolations.flatMap(v => v.entryIds ?? []));
  const unexplainedHighlightNodeIds = [...highlightedNodeIds].filter(id => !sectionLinkedNodeIds.has(id) && !noteNodeIds.has(id) && !alreadyRepairedIds.has(id));
  if (unexplainedHighlightNodeIds.length > 0) {
    addError(
      'highlight_groups',
      `highlight_groups node_ids must be explained by sections[].node_ids or a notes caption: ${unexplainedHighlightNodeIds.join(', ')}. For each listed node, add it to a section's node_ids[] or add a notes entry for it — or drop it from highlight_groups[] if it is uncolored plumbing.`,
      ['sections', 'notes', 'highlight_groups'],
    );
  }

  if (errors.length > 0) {
    const resendList = [...repairFields];
    const repairInstructed = allRepairable && resendList.length > 0;
    const hint = [
      repairInstructed ? undefined : `Fix ${[...failedFields].join(', ')}.`,
      nodeIdHintNeeded ? presentNodeIdHint(stage) : undefined,
      repairInstructed ? presentResultRepairInstruction(resendList, stage) : INVALID_TOOL_INPUT_REPAIR_HINT,
    ].filter(Boolean).join(' ');
    const unlinkable = [...pathUnlinkableIds].map(([path, ids], index) => ({
      path,
      unlinkable_node_ids: ids.map(id => ({ node_id: id, state: PRESENT_NODE_ID_STATE_TEXT[stateOf(id)] })),
      ...(index === 0 ? { accepted_node_ids: [...resolvedNodeIds] } : {}),
    }));
    return {
      success: false,
      rejection: makeRejection({
        code: REJECTION_CODES.validation,
        reason: errors.join('\n'),
        hint,
        issuePaths: [...issuePaths],
        entryIds: [...new Set([...pathEntryIds.values()].flat())],
        ...(unlinkable.length > 0 ? { detail: { paths: unlinkable } } : {}),
      }),
      repairable: allRepairable,
      repairFields: resendList,
    };
  }

  return {
    success: true,
    name: input.name,
    node_ids: resolvedNodeIds,
    summary: input.summary,
    description: assembledDescription!,
    layout_direction: input.layout_direction,
    highlight_groups: input.highlight_groups,
    badges: assembledBadges ?? [],
    notes: input.notes ?? [],
  };
}

/**
 * Finds nodes that are disconnected from the given origin inside a result view.
 *
 * @remarks
 * Uses undirected connectivity to match lineage-closure semantics used by the SM.
 *
 * @param nodeIds - Nodes currently in the candidate result view.
 * @param edges - Edges currently in the candidate result view.
 * @param originNodeId - Origin node that must reach all nodes in the view.
 * @returns Sorted list of disconnected node ids. Empty when closed.
 */
export function findDisconnectedViewNodes(
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<[string, string, string]>,
  originNodeId: string,
): string[] {
  if (!originNodeId || !nodeIds.includes(originNodeId)) return [];
  const graph = new Graph({ type: 'undirected' });
  for (const id of nodeIds) graph.mergeNode(id);
  for (const [source, target] of edges) {
    if (graph.hasNode(source) && graph.hasNode(target)) graph.mergeEdge(source, target);
  }
  const reachable = new Set(connectedComponents(graph).find(component => component.includes(originNodeId)));
  return nodeIds.filter(id => !reachable.has(id)).sort();
}
