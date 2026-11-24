/** AI `present_result` contract: types, validation, deterministic markdown; no VS Code imports. */
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
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { FOCUS_NODE_HREF_PREFIX, isIndirectEdge, type AIViewMetadata, type ColumnTransformClass } from '../../engine/shared/bridgeContract';
import type { DetailSlot } from '../session/memoryManager';
import type { z } from 'zod';
import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';

/**
 * Input field a validation error is attributed to, declared structurally at each `addError`
 * site so the repair hint can never desync from a reworded error message.
 */
type PresentResultFailedField = 'name' | 'summary' | 'title' | 'intro' | 'closing' | 'sections' | 'notes' | 'highlight_groups';

/**
 * Stage `lineage_present_result` is called from, as classified by the caller. Drives stage-aware
 * wording in {@link PRESENT_REAL_ID_ROUTE}: `synthesis` never has `lineage_search_objects` on its
 * tool policy (`toolPolicy.ts`), so a hint naming it there is a guaranteed off-policy retry; only
 * `completed` exposes it.
 */
export type PresentResultStage = 'synthesis' | 'completed';

/**
 * The state the engine records for a node id the current result graph cannot link. The dispatcher
 * already resolved every `node_ids` entry against the whole model, so exactly one member of this
 * union is a hallucination; the rest are real objects the render does not carry, and calling those
 * "unknown" would make the model invent a replacement instead of moving the fact into prose. Only
 * the session holds the engine snapshot, so the caller supplies the classification as
 * {@link PresentNodeIdStateLookup}.
 */
export type PresentNodeIdState =
  | 'not_in_model'
  | 'pruned'
  | 'render_dropped'
  | 'in_scope_undispositioned'
  | 'out_of_scope';

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
};

/**
 * Classifies one unlinkable node id against the engine state the session holds.
 *
 * @remarks
 * Invoked only for ids the result graph rejects, so a passing call pays nothing for it. A caller
 * that holds no engine state omits it and every offender is reported as `not_in_model`.
 */
export type PresentNodeIdStateLookup = (nodeId: string) => PresentNodeIdState;

/** What `add_node_ids` reveals; the follow-up instruction and unknown-id route state it alike. */
export const ADD_NODE_IDS_REVEALS = 'reveals any object in the approved exploration scope';

/**
 * Route back for a real id the render does not carry, per stage, limited to what the tool accepts.
 * `notes[].node_id` is absent on purpose: it is validated against the same result-graph set, so
 * offering it repeats the rejection. `add_node_ids` is accepted in Completed Phase only; every
 * other stage is left with prose.
 */
const PRESENT_REAL_ID_ROUTE: Readonly<Record<PresentResultStage, string>> = {
  completed: `A real id outside the result graph can be brought into the view with add_node_ids, which ${ADD_NODE_IDS_REVEALS}.`,
  synthesis: 'The result graph is locked this stage.',
};

/**
 * Unknown-node-id repair hint: the actions every calling stage accepts. The route only one stage
 * offers (`add_node_ids`) rides on {@link PRESENT_REAL_ID_ROUTE}.
 */
const PRESENT_NODE_ID_HINT = 'Use the accepted canonical ids with their exact catalog casing. Remove the named ids from node_ids, or state the fact in sections[].text.';

/**
 * The AI's submission to `lineage_present_result`. The AI writes structured parts (summary, title,
 * intro, sections[], closing, notes[], highlight_groups[]); the engine builds the rendered document
 * ({@link orderAndAssemble}): the assembled markdown, section numbering, badge chips and object
 * links. The dispatcher normalizes and validates only; it never synthesizes labels, node links,
 * captions or section text.
 *
 * Final `sections[]` is the authoritative graph/detail link surface: a label maps to exactly one
 * text body, and its required `node_ids[]` link zero or more graph nodes to that badge. A node in
 * no `node_ids[]` intentionally has no final section badge. `description` is absent because it is
 * engine output.
 */
export type PresentResultInput = z.infer<typeof PresentResultModelSchema>;
type PresentResultBaseRepairPatch = z.infer<typeof PresentResultAuthorizableRepairSchema>;

/** One repair-only replacement for a held highlight label. */
interface PresentResultHighlightLabelPatch {
  readonly index: number;
  readonly label: string;
}

/** Repair-only text leaves for one held section. */
interface PresentResultSectionTextPatch {
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
  /**
   * Zero-based highlight entries whose overlong labels may be replaced without resending the list.
   */
  readonly highlightLabelIndexes?: readonly number[];
  /** Zero-based held sections and their text leaves authorized for replacement. */
  readonly sectionTextLeaves?: readonly {
    readonly index: number;
    readonly fields: readonly ('label' | 'text')[];
  }[];
  /**
   * Section keys of the rejected call in authored order, when only some of its sections are held:
   * the repair puts a resent section back in its place.
   */
  readonly sectionOrder?: readonly string[];
}

type PresentSection = NonNullable<PresentResultInput['sections']>[number];
type PresentSectionPatch = NonNullable<PresentResultBaseRepairPatch['sections']>[number];

/**
 * The validated, engine-assembled result ready for the UI. `description` is the markdown document
 * {@link orderAndAssemble} builds from the AI's parts (title + intro + sections[] + closing); it is
 * never an AI-supplied field.
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
 * draft. `repairable` is set structurally where each error is added in
 * {@link validatePresentResult}, never inferred from message text. `reason` is one line per error;
 * `issuePaths` and `entryIds` name every offender; `detail.paths` carries per-path offending ids
 * with their recorded state plus the uncapped accepted set (the message states both, capped, so
 * they survive the rejection replay).
 */
export type PresentResultFailure = {
  success: false;
  rejection: ToolRejection;
  repairable: boolean;
  repairFields: PresentResultRepairField[];
};

/**
 * A defect found outside {@link validatePresentResult} but reported through its accumulator.
 *
 * @remarks
 * Checks that need context the validator does not hold — the captured evidence, the result
 * graph — are passed in instead, so every rule reports through one accumulator and one rejection.
 */
export interface PresentResultViolation {
  readonly field: PresentResultFailedField;
  readonly messages: readonly string[];
  /** Fields this violation authorizes for a repair resend. */
  readonly repairFields: readonly PresentResultRepairField[];
  /** Exact offending entry paths, empty when the violation is about the payload as a whole. */
  readonly paths: readonly string[];
  /**
   * Offending entries this violation names (e.g. an uncovered detail-slot or CT-chain node id) when
   * the offender is an id rather than a field path. `paths` is a fixed structural root (e.g.
   * `sections`) shared by all offenders and never shrinks as the model repairs entries, so
   * cross-attempt comparison needs these ids. Carried into `detail` only (the `messages` and `hint`
   * already state them, capped) for comparing a later rejection with this one; never read by the
   * model or repair machinery.
   */
  readonly entryIds?: readonly string[];
}

/** Identity of a held section: its normalized label. */
const sectionKey = (section: { label?: string }): string => normalizePresentSectionLabel(section.label ?? '');

/**
 * Labels in a resent `sections` patch that match no held section and carry no text. Nothing is
 * inherited for them on the retry; the handler rejects them with the draft still held
 * rather than let the non-repairable "missing text" error discard the draft over a mistyped label.
 */
export function findTextlessNewSectionLabels(
  held: readonly PresentSection[] | undefined,
  resent: readonly PresentSectionPatch[],
): string[] {
  const heldKeys = new Set((held ?? []).map(sectionKey));
  return resent
    .filter(section => !('remove' in section && section.remove) && !heldKeys.has(sectionKey(section)) && !('text' in section && section.text?.trim()))
    .map(section => section.label);
}

/**
 * The held sections a repair may key on, as the model-facing view: the label only. The model's own
 * rejected call already carries every body.
 */
export function heldSectionsForRepair(sections: PresentResultInput['sections']): Array<{ label: string }> {
  return (sections ?? []).map(({ label }) => ({ label }));
}

/**
 * The repair-call sentence a repairable rejection carries, stated once here for every failure: the
 * fields to resend and, when `sections` is among them, how the resend merges under each section's
 * `text` — or, when the held draft has no section, that every section is resent.
 */
export function presentResultRepairInstruction(
  resendList: readonly PresentResultRepairField[],
  sectionsHeld = true,
  highlightLabelIndexes?: readonly number[],
  sectionTextLeaves?: PresentResultRepairAuthorization['sectionTextLeaves'],
): string {
  const wholeFields = resendList.filter(field => field === 'highlight_groups' && !highlightLabelIndexes);
  return [
    `You may repair the held draft by calling lineage_present_result with only these corrected fields: ${resendList.join(', ')}.`,
    resendList.includes('sections') && !sectionTextLeaves
      ? (sectionsHeld ? keyedResendRule('sections', 'label', ['text', 'node_ids']) : 'No section is held: resend every section.')
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
 * Holds the valid fields of a `lineage_present_result` call its stage schema rejected in the
 * handler, so the retry resends only the failed field(s) and {@link mergePresentResultRepairPatch}
 * restores the rest. A top-level key the tool does not define is reported by the rejection and left
 * out; it does not stop valid fields being held. Failed `sections` entries alone are not held when
 * every section fault sits inside a sections entry; the retry keys a resent entry on its label.
 *
 * @param committed - Sections of the committed report an update call may keep text for, or `null`.
 *   A keep-text section (label, no text) whose label has no committed body is invalid, so
 *   `sections` is not held.
 * @returns The repair sentence naming the fields to resend; `null` when nothing was held: a draft
 *   is already held, the payload is not an object, a failed path names a defined field no repair
 *   may send, or only undefined keys failed.
 */
export function holdRejectedPresentResult(
  store: RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>,
  input: unknown,
  failedPaths: readonly string[],
  committed: ReadonlyArray<{ label: string; text?: string }> | null = null,
): string | null {
  if (store.get() || typeof input !== 'object' || input === null || Array.isArray(input) || failedPaths.length === 0) return null;
  const repairable = new Set<string>(PRESENT_RESULT_REPAIR_FIELDS);
  const failedKeys = [...new Set(failedPaths.map(path => path.split('.')[0]))];
  const undefinedKeys = new Set(failedKeys.filter(key => !PRESENT_RESULT_DEFINED_FIELDS.has(key)));
  const failed = failedKeys.filter(key => !undefinedKeys.has(key));
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
  // A section that fails outside its label and text leaves fails alone; the sections that passed
  // are held and a resend keys on their labels.
  const failedSections = new Set(sectionPaths.map(path => Number(path.split('.')[1])));
  const passedSections = failed.includes('sections') && !hasLeafRepair && unkept.length === 0
    && Array.isArray(rawSections) && sectionPaths.every(path => /^sections\.\d+(\.|$)/.test(path))
    ? rawSections.filter((_, index) => !failedSections.has(index))
    : [];
  const kept = hasLeafRepair
    ? Object.fromEntries(Object.entries(input).filter(([key]) => !undefinedKeys.has(key) && (
      (key === 'highlight_groups' && highlightLabelIndexes)
      || (key === 'sections' && sectionTextLeaves)
      || !failed.includes(key)
    )))
    : {
      ...Object.fromEntries(Object.entries(input).filter(([key]) => !undefinedKeys.has(key) && !failed.includes(key))),
      ...(passedSections.length > 0 ? { sections: passedSections } : {}),
    };
  if (Object.keys(kept).length === 0) return null;
  const fields = failed as PresentResultRepairField[];
  store.hold(kept as PresentResultInput, {
    fields,
    ...(highlightLabelIndexes ? { highlightLabelIndexes } : {}),
    ...(sectionTextLeaves ? { sectionTextLeaves } : {}),
    ...(passedSections.length > 0
      ? { sectionOrder: (rawSections as PresentSectionPatch[]).flatMap(sec => (typeof sec?.label === 'string' ? [sectionKey(sec)] : [])) }
      : {}),
  });
  const heldDescription = hasLeafRepair
    ? 'Held from this call: every valid report field and the complete affected lists; only the offending text is replaceable.'
    : `Held from this call: every field except ${fields.map(field => (field === 'sections' && passedSections.length > 0 ? 'the failed sections' : field)).join(', ')}.`;
  const unheld = unkept.length > 0 && !hasLeafRepair
    ? ` sections for ${quoteIds(unkept)} were not held: the committed report has no body for them. Its sections are ${quoteIds((committed ?? []).map(sec => sec.label))}; omit sections to keep the committed report.`
    : '';
  return `${heldDescription}${unheld} ${presentResultRepairInstruction(fields, passedSections.length > 0, highlightLabelIndexes, sectionTextLeaves)}`;
}

type PresentNote = NonNullable<PresentResultInput['notes']>[number];
type PresentNotePatch = Partial<PresentNote> & { remove?: boolean };

/**
 * A note's merge key: its node id without brackets, case-folded unless the model's identifiers are
 * case-sensitive, so a bare and a bracketed id name one note.
 */
function noteKey(note: Partial<PresentNote>, identifierCaseSensitive: boolean): string {
  const bare = (note.node_id ?? '').replace(/[[\]]/g, '').trim();
  return identifierCaseSensitive ? bare : bare.toLowerCase();
}

/**
 * Merges a strict repair patch into a held full `present_result` draft. `sections` merge by label
 * ({@link RepairDraftStore.mergeByKey}). `notes` merge by node id, so one missing caption is one
 * resent entry; an ordinary `highlight_groups` repair replaces its list whole. A rejection confined
 * to overlong highlight labels authorizes `{index, label}` leaves; one confined to a section's
 * `label` or `text` authorizes only those indexed leaves. Narrow merges preserve the rest of the
 * held list, and normal validation checks the restored draft. A presentation field the rejection
 * did not name is accepted and replaces the held value, so a field the draft never had (`notes`,
 * `closing`) is merged, not refused.
 *
 * @param identifierCaseSensitive - Whether the loaded model distinguishes identifiers by case;
 *   decides which note ids name one note.
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
      const rank = (section: PresentSection): number => {
        const index = authorization.sectionOrder?.indexOf(sectionKey(section)) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      const merged = RepairDraftStore.mergeByKey<PresentSection>(draft.sections ?? [], value as PresentSectionPatch[], sectionKey)
        .map(section => ({ ...section, node_ids: section.node_ids ?? [] }))
        .sort((a, b) => rank(a) - rank(b));
      updates.sections = merged;
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
 * Encodes a node id for the `#focus-node:` destination of an engine-assembled object link. A
 * bracketed SQL identifier may contain characters that break the link: raw `%` makes the overlay's
 * `decodeURIComponent` throw (`Discount%`) or resolve to another id (`Rate%20Card`), so
 * `encodeURIComponent` is used; it leaves `(` and `)` alone, so those are escaped after it because
 * an unbalanced `)` ends a markdown link destination. Both are ordinary percent sequences, reversed
 * by the overlay's single `decodeURIComponent`.
 */
function encodeFocusNodeId(id: string): string {
  return encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * The \`\`\`sql fence opening at `openIndex`, tolerant of a one-line fence and of a closing
 * marker sharing a line with the last line of code. `undefined` when no marker opens there or it
 * never closes.
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
  readonly nodeId: string;
  /**
   * The captured \`\`\`sql fence closed on a line of its own: body de-indented out of its list
   * or block-quote container, `sql S7` annotation excluded; rendered verbatim.
   */
  readonly raw: string;
}

/**
 * Reports which captured SQL blocks the rendered report shows, by whitespace-insensitive match of
 * the block body, so a block expanded from its id and one the author wrote out both count.
 *
 * @returns `served`: captured block count; `unusedIds`: ids of blocks no field shows, in id order.
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

/** One \`\`\`sql fence located by the {@link sqlFenceAt} rule. */
interface LocatedSqlFence {
  /** Offset of the \`\`\`sql marker. */
  readonly start: number;
  /** Offset just past the closing marker. */
  readonly end: number;
  /** Text after \`\`\`sql on the opening line; for a one-line fence, all between the markers. */
  readonly info: string;
  /** Code lines, de-indented out of the opening line's container; empty for a one-line fence. */
  readonly lines: readonly string[];
  /** Container prefix of the opening line. */
  readonly container: string;
}

/**
 * Every \`\`\`sql fence in `text`, in order, by the {@link sqlFenceAt} rule: the marker may open
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
 * Assigns one deterministic citation id to every captured \`\`\`sql fence with a body, numbered
 * by detail-slot then block order, carried as an addition to the fence's info string
 * (\`\`\`sql S7), never an inline marker (a bracketed marker collides with T-SQL brackets
 * and Markdown links). Fences come from {@link locateSqlFences}, so a mid-line opener still carries
 * its id. Pure and dependent only on `detailSlots` content, so the envelope builder and the
 * `present_result` handler agree on every id without shared state. `EvidenceBlock.raw` is the
 * unannotated block; the id exists only in the copy the model reads.
 *
 * @returns `slots`: the slots with ids in the fence info strings (new array; input unchanged);
 *   `blocks`: the id to block lookup {@link expandEvidenceRefs} resolves.
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

/** Where a fence stands on its line, widened over a parenthesis pair that wraps only the fence. */
interface FenceExtent {
  readonly lineStart: number;
  /** Offset of the line's newline, or `text.length` on the last line. */
  readonly lineEnd: number;
  /** Start of the fence, or of the `(` that wraps it. */
  readonly from: number;
  /** End of the fence, or just past the `)` that wraps it. */
  readonly to: number;
}

/** Locates `fence` on its line; a `(` before and `)` after it, nothing between, join the extent. */
function fenceExtent(text: string, fence: LocatedSqlFence): FenceExtent {
  const lineStart = text.lastIndexOf('\n', fence.start - 1) + 1;
  const newline = text.indexOf('\n', fence.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const open = /[ \t]*\([ \t]*$/.exec(text.slice(lineStart + fence.container.length, fence.start));
  const close = /^[ \t]*\)/.exec(text.slice(fence.end, lineEnd));
  const wrapped = open !== null && close !== null;
  const from = wrapped ? fence.start - open[0].length : fence.start;
  const to = wrapped ? fence.end + close[0].length : fence.end;
  return { lineStart, lineEnd, from, to };
}

/**
 * Renders `blockLines` where `fence` stands as a block that starts on its own line and ends before
 * a line break, indented to the fence's container so a list item or block quote keeps it. Prose
 * before the fence stays before it; prose after continues on a new line.
 *
 * @returns `out`: text from `cursor` through the block; `cursor`: where the caller resumes copying
 *   `text`.
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
 * Expands evidence references in one rendered text field: a \`\`\`sql fence whose info string
 * ends in a served id (closed with no body, or the one-line form) is replaced by the captured
 * block.
 *
 * CommonMark opens a fenced block only at a line start, so the expanded block starts on its own
 * line with a line break after its closing fence, every line indented to the content column of the
 * enclosing list item or block quote; prose before the reference stays before it, prose after
 * continues on a new line at the same indent. A `( )` pair wrapping only the reference is dropped
 * with it. A reference already on its own line expands byte for byte.
 *
 * A reference is optional shorthand; the model may write SQL itself. Fences are located by the rule
 * {@link assignEvidenceIds} numbers with, so a mid-line fence never pairs with a later reference.
 * A fence that carries its own SQL stays as written, id included, and a reference expands even
 * when the section already shows that SQL.
 * An id naming no captured block is returned in `unknownIds` and the fence is left as written for
 * the caller to reject. Unclosed blocks go to `malformedRefs`; their text is never consumed as
 * another block, and an unclosed opener citing an unknown id is also in `unknownIds`, so one
 * rejection names both faults. Only a rendering copy is expanded: the held repair draft keeps short references.
 *
 * The caller runs this over every field {@link orderAndAssemble} renders verbatim (`title`,
 * `intro`, `closing`, section text), so an id cited outside a section expands or rejects like one
 * inside.
 *
 * @param text - One authored text field.
 * @param blocks - The id to block lookup from {@link assignEvidenceIds}.
 */
export function expandEvidenceRefs(
  text: string,
  blocks: ReadonlyMap<string, EvidenceBlock>,
): { text: string; unknownIds: string[]; malformedRefs: string[] } {
  const fences = [...locateSqlFences(text)];
  const byStart = new Map(fences.map(fence => [fence.start, fence]));
  const malformedRefs: string[] = [];
  const unknownIds: string[] = [];
  let coveredUntil = 0;
  for (const marker of text.matchAll(/```sql([^\n`]*)/gi)) {
    if (marker.index < coveredUntil) continue;
    const valid = byStart.get(marker.index);
    if (valid) {
      coveredUntil = valid.end;
      continue;
    }
    const id = EVIDENCE_ID_INFO.exec(marker[1])?.[1];
    malformedRefs.push(id ?? 'unlabelled SQL');
    if (id && !blocks.has(id)) unknownIds.push(id);
  }
  let out = '';
  let cursor = 0;
  for (const fence of fences) {
    const id = EVIDENCE_ID_INFO.exec(fence.info)?.[1];
    if (!id || fence.lines.length > 0) continue;
    const block = blocks.get(id);
    if (!block) {
      unknownIds.push(id);
      continue;
    }
    const placed = placeFenceBlock(text, cursor, fence, fenceExtent(text, fence), block.raw.split('\n'));
    out += placed.out;
    cursor = placed.cursor;
  }
  return { text: out + text.slice(cursor), unknownIds, malformedRefs };
}

/**
 * Builds the rendered description markdown from the AI's structured parts. The sole path producing
 * the blob shown in `AiDescriptionOverlay`; section numbering (`## N {label}`), badge chips and the
 * `### Objects [name](#focus-node:id)` footnote are engine-owned.
 *
 * Numbered badges are emitted only for `sections[].node_ids[]`, in narrative order, so chips align
 * with `## N` headings. A node linked from several sections is normalized, not rejected: the first
 * section wins the badge and object link, later links are returned in `droppedSectionLinks` for
 * logging, and no text changes. Object links render as a footnote at the end of each section body,
 * which the renderer restyles into a small muted paragraph rather than a competing heading.
 *
 * `title`, `intro`, `closing` and section text arrive with evidence references already expanded
 * ({@link expandEvidenceRefs}), so none reaches the document as an unresolved fence.
 *
 * @param sections - AI-authored sections (unique labels) with node associations and text.
 * @param opts - Optional wrapper blocks for the final document.
 * @returns The numbered badges, the assembled markdown description, and the first-wins dropped
 *   duplicate section links.
 */
export function orderAndAssemble(
  sections: Array<{ label: string; node_ids?: string[]; text?: string }>,
  opts?: {
    title?: string;
    intro?: string;
    /** Engine-owned block (e.g. the CT column chain) inserted between intro and first section. */
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
 * The `aiMetadata` of an `ai-view-preview`, built once for the panel's final presentation and the
 * MCP graph preview from the validated view fields and {@link orderAndAssemble}'s badges and
 * description. Column-trace data is the caller's to add.
 */
export function buildPreviewMetadata<S extends string | undefined, D extends string | undefined>(
  view: {
    summary: S;
    description: D;
    layout_direction?: 'LR' | 'TB';
    highlight_groups: NonNullable<PresentResultInput['highlight_groups']>;
    badges: Array<{ node_id: string; text: string }>;
    notes: Array<{ nodeId: string; text: string }>;
  },
  origin: { modelName: string; runId?: string },
): AIViewMetadata & { summary: S; description: D } {
  return {
    summary: view.summary,
    description: view.description,
    createdAt: new Date().toISOString(),
    modelName: origin.modelName,
    runId: origin.runId,
    highlightGroups: view.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
    badges: view.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
    notes: view.notes,
    layoutDirection: view.layout_direction,
  };
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
  /** Set when the engine placed a value edge on the indirect side. */
  indirect?: true;
};

/**
 * Builds the engine-owned "Column Chain" preface of a CT result from the validated direct
 * column-flow edges (an indirect fact is not a chain step), as one deterministic
 * Output | Source | Role table, so it cannot drift from the recorded edges.
 * Rows are grouped by output in first-capture order, then by hop; each output is named on its
 * first row only. The hop index is not shown: it identifies evidence capture, not a storage step.
 * The unnumbered `## Column Chain` heading takes no section number or navigation chip; the
 * renderer collapses it into supporting evidence.
 *
 * @param nodeMap - Catalog nodes by id; a known node is shown by its source-case `fullName`.
 * @returns The preface markdown, or `undefined` when no direct edge was recorded.
 */
export function buildColumnChainPreface(
  edges: readonly ColumnChainEdge[],
  nodeMap?: ReadonlyMap<string, { fullName: string }>,
): string | undefined {
  const direct = edges.filter(edge => !isIndirectEdge(edge));
  if (direct.length === 0) return undefined;
  const outputs = new Map<string, ColumnChainEdge[]>();
  for (const edge of [...direct].sort((a, b) => a.hop - b.hop)) {
    const key = JSON.stringify([edge.to_node, edge.to_col]);
    const group = outputs.get(key);
    if (group) group.push(edge);
    else outputs.set(key, [edge]);
  }
  const column = (node: string, col: string) => columnChainCode(`${nodeMap?.get(node)?.fullName ?? node}.${col}`);
  const rows = [...outputs.values()].flatMap(group => group.map((edge, i) =>
    `| ${i === 0 ? column(edge.to_node, edge.to_col) : ''} | ${column(edge.from_node, edge.from_col)} | ${edge.transforms?.map(role => columnChainCode(role)).join(', ') ?? ''} |`));
  return ['## Column Chain', ['| Output | Source | Role |', '| --- | --- | --- |', ...rows].join('\n')].join('\n\n');
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
 * Reports non-pruned nodes the AI left unlinked in both badge-producing surfaces
 * (`sections[].node_ids` and `highlight_groups[].node_ids`): an observation for the log, never a
 * payload mutation. The `notes` schema requires a caption for every kept node without a detail
 * slot, so a flagged node is either covered by a `notes[]` entry this function does not inspect or
 * a gap that contract should close. The engine has no authority to re-link it: a tool boundary
 * accepts, rejects with a structural hint, or normalizes with a log, never silently rewrites a
 * presentation decision. Only `prune` removes a node from the view; an unlinked node still renders
 * via `resolvedNodeIds`, without badge or highlight color.
 *
 * @param input - The (already auto-fixed) present payload. Read-only.
 * @returns The non-pruned resolved ids linked in neither surface (empty when there are no authored
 *   sections, as in update-style calls).
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
 * Detail-slot node ids a present call must link from `sections[].node_ids[]`: slots whose node is
 * in the rendered set. The synthesis envelope lists this set and
 * {@link findUnrenderedDetailSlotIds} enforces it, so the served list and the check share one
 * source.
 */
export function requiredDetailSlotIds(
  slotNodeIds: readonly string[],
  renderedNodeIds: ReadonlySet<string>,
): string[] {
  return slotNodeIds.filter(id => renderedNodeIds.has(id));
}

/**
 * Column-chain node ids a present call must cover with a section link or a note: nodes of the
 * direct and indirect column edges the render keeps that have no detail slot and are not pruned.
 * The synthesis envelope lists this set and the present handler enforces it (one source for list
 * and check).
 *
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
 * Reports which delivered `detail_slots[]` reached no rendered section. Stricter than
 * {@link findBareNonPrunedNodes}, which accepts `sections[].node_ids[]` or
 * `highlight_groups[].node_ids[]` because a highlight is a legitimate place for a passthrough node.
 * A detail slot is the model's own captured technical findings, and only a `sections[].node_ids[]`
 * link places that prose in the walkthrough; a `notes[]` caption is a one-line chip and a highlight
 * carries no findings. Accepting notes as coverage let a CT render park every formula-bearing hop
 * on a caption and ship a chain table in place of the BB walkthrough, so this stays a second,
 * narrower check. The caller (`executePresentResult`) reports each id as a
 * {@link PresentResultViolation} whose `repairFields`/`paths` name `sections` only.
 *
 * @param slotNodeIds - Delivered `detail_slots[].nodeId` values for nodes in the current result
 *   graph (a slot whose node the render dropped cannot be linked, so requiring it would contradict
 *   the node-id check).
 * @returns Slot ids absent from every `sections[].node_ids[]`, in `slotNodeIds` order; empty
 *   without authored sections or when all are linked.
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
 * Validates the full `present_result` input against contracts a schema cannot express. `input`
 * already passed the served stage schema in the handler (shape, required and blank fields, length
 * caps, unique labels, at least one highlight group); this enforces node-id resolution against the
 * result graph and highlight/section/note coverage. Markdown/KaTeX formatting is deliberately
 * unvalidated: it can never reject a call. A node linked from several sections keeps its first link
 * ({@link orderAndAssemble} drops and logs the rest). `assembledDescription` is engine-built and
 * never read from `input`.
 *
 * @param externalViolations - Findings from checks needing context this function lacks (the
 *   captured evidence, the result graph), reported alongside the structural rules
 *   ({@link PresentResultViolation}).
 * @param stage - The engine-derived calling stage, keeping the unknown-node-id route
 *   caller-possible ({@link PRESENT_REAL_ID_ROUTE}). Defaults to `'completed'`, the only stage
 *   whose tool policy includes `lineage_search_objects`.
 * @param nodeIdState - Classifies an id the result graph cannot link
 *   ({@link PresentNodeIdStateLookup}). Omitted, every offender is `not_in_model`.
 * @returns A request object, or a structured error with correction hints.
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

  // A state fault: no field of this call fixes an empty view, so it names none and is not repairable.
  if (resolvedNodeIds.length === 0) {
    errors.push('No nodes in view — the result graph is empty');
    allRepairable = false;
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
  /**
   * `add_node_ids` accepts any id inside the approved scope — pruned, render-dropped or
   * undispositioned — so only those offenders earn its route.
   */
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
  /** The valid set and the route back, stated once at the first offending site. */
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
    const fieldFault = failedFields.size > 0;
    const hint = [
      repairInstructed || !fieldFault ? undefined : `Fix ${[...failedFields].join(', ')}.`,
      nodeIdHintNeeded ? PRESENT_NODE_ID_HINT : undefined,
      repairInstructed ? presentResultRepairInstruction(resendList) : undefined,
    ].filter(Boolean).join(' ') || undefined;
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
 * Nodes disconnected from the origin inside a result view, using undirected connectivity to match
 * the SM's lineage-closure semantics.
 *
 * @returns Sorted disconnected node ids; empty when closed.
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
