/**
 * AI `present_result` contract: input/output types, validation, and the deterministic
 * markdown assembly. Extracted from `tools.ts` so the (large) presentation/validation
 * surface lives apart from the retrieval operations. Zero VS Code imports — pure functions
 * consumed directly by `toolProvider.ts` and the present-result unit tests.
 */
import {
  PresentResultModelSchema,
  PresentResultRepairPatchSchema,
  PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX,
  PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
  PRESENT_RESULT_NAME_MAX,
  PRESENT_RESULT_REPAIR_FIELDS,
  PRESENT_RESULT_SECTION_LABEL_MAX,
  PRESENT_RESULT_TITLE_MAX,
  type PresentResultRepairField,
} from './toolSchemas';
import { getAllowedLmToolNames } from './toolPolicy';
import { quoteIds } from '../support/text';
import { FOCUS_NODE_HREF_PREFIX } from '../../engine/shared/bridgeContract';
import type { DetailSlot } from '../session/memoryManager';
import type { z } from 'zod';

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
 * there is a guaranteed off-policy retry. Only `completed` exposes that tool.
 */
export type PresentResultStage = 'visual_preview' | 'synthesis' | 'completed';

/** Offenders named inline in a node-id rejection; the complete list rides in `detail`. */
const NODE_ID_OFFENDERS_SHOWN = 3;

/** Accepted result-graph ids named inline in a node-id rejection; the complete set rides in `detail`. */
const NODE_ID_ACCEPTED_SHOWN = 5;

/**
 * The state the engine already records for a node id the current result graph cannot link.
 *
 * @remarks
 * The id check runs over the whole loaded model before this contract sees it (the dispatcher
 * normalizes every `node_ids` entry with `resolveModelNodeId`), so exactly one member of this union
 * is a hallucination and the rest are real objects the render does not carry. A real object rejected
 * as "unknown" tells the model to invent a replacement instead of moving the fact into prose, which
 * is what has run a synthesis into the semantic-failure breaker. The classification itself belongs
 * to the caller — only the session holds the engine snapshot — so it arrives as
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
export const PRESENT_NODE_ID_STATE_TEXT: Readonly<Record<PresentNodeIdState, string>> = {
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
 * that holds no engine state omits it and every offender is reported as `not_in_model` — the
 * pre-existing behaviour.
 */
export type PresentNodeIdStateLookup = (nodeId: string) => PresentNodeIdState;

/**
 * The route back for a real id the render does not carry, per stage — only what the tool accepts.
 *
 * @remarks
 * `notes[].node_id` is deliberately absent: it is validated against the same result-graph set, so
 * offering it would send the model into an identical rejection. `add_node_ids` is accepted in
 * Completed Phase only (the dispatcher forbids it during a preview or a synthesis render), so every
 * other stage is left with prose.
 */
const PRESENT_REAL_ID_ROUTE: Readonly<Record<PresentResultStage, string>> = {
  completed: 'A real id outside the result graph can be brought into the view with add_node_ids; otherwise state it in sections[].text.',
  synthesis: 'The result graph is locked this stage — state a real id it does not carry in sections[].text.',
  visual_preview: 'The result graph is locked this stage — state a real id it does not carry in sections[].text.',
};

/**
 * Builds the unknown-node-id repair hint for the calling stage.
 *
 * @remarks
 * Derived from {@link getAllowedLmToolNames} rather than hardcoded per stage: `completed` is
 * currently the only stage whose tool policy includes `lineage_search_objects` (see
 * `toolPolicy.ts`'s `COMPLETED_TOOLS`), but reading the policy directly means this hint can never
 * drift from it if a stage's tool set changes. `visual_preview` and `synthesis` expose
 * `lineage_present_result` only, so naming `lineage_search_objects` there hands the model a
 * caller-impossible instruction — it retries the off-policy call, burns a turn, and fails again.
 * Stages without the tool fall back to the same instruction: state the unmatched fact in prose
 * instead of linking a node.
 */
function presentNodeIdHint(stage: PresentResultStage): string {
  const hasSearchObjects = getAllowedLmToolNames({ kind: stage }).has('lineage_search_objects');
  return hasSearchObjects
    ? 'Use node IDs from the current result graph. Case and bracket differences are normalized automatically; if still unresolved, resolve canonical IDs with lineage_search_objects. If no loaded node matches the fact, state it in sections[].text rather than a node_ids field.'
    : 'Use node IDs from the current result graph. Case and bracket differences are normalized automatically. If a fact has no matching loaded node, state it in sections[].text instead of a node_ids field — no other tool is available this stage.';
}

/**
 * Semantic role tag for one of the (≤5) `highlight_groups` the AI may attach
 * to a `present_result` view. Drives the colour swatch on the graph chip.
 *
 * @remarks
 * Two consistent palettes — `source` / `transform` / `target` (lineage) or
 * `good` / `warn` / `fail` (diagnostic). The synthesis prompt instructs the
 * AI to pick one palette per result and not mix them. Validated by
 * `AI_HIGHLIGHT_ROLES` in `validatePresentResult`.
 */
type AIHighlightRole = 'source' | 'transform' | 'target' | 'good' | 'warn' | 'fail';

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
 * section label maps to exactly one section text body; its optional `node_ids[]`
 * links zero or more graph nodes to that section badge. Nodes omitted from
 * `node_ids[]` intentionally have no final section badge.
 *
 * `description` is intentionally absent because it is engine output, not AI input.
 */
export type PresentResultInput = z.infer<typeof PresentResultModelSchema>;
/**
 * A validated `present_result` repair patch — the single source of truth, inferred from
 * {@link PresentResultRepairPatchSchema} (itself `.pick().partial()`-derived from the model schema)
 * so it can never hand-drift out of sync with the fields a full author may emit.
 */
export type PresentResultRepairPatch = z.infer<typeof PresentResultRepairPatchSchema>;

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
  highlight_groups: Array<{ label: string; color: AIHighlightRole; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; text: string }>;
};

/**
 * Error shape returned when presenting the result fails.
 *
 * @remarks
 * `repairable` is set structurally where each error is added inside
 * {@link validatePresentResult}; downstream code never infers it from message text.
 */
export type PresentResultError = {
  success: false;
  errors: string[];
  hint: string;
  repairable: boolean;
  repairFields: PresentResultRepairField[];
  /**
   * Offending field paths, as `{ path }` entries the shared correction reader understands.
   *
   * @remarks
   * A rejection that names a rule but not the offender costs a whole repair round to locate — the
   * model has to guess which of N captions or sections failed. `rejectionIssuePaths` already mines
   * this exact shape out of any tool's `detail`, so emitting it here reaches both the model's
   * correction envelope and the diagnostic trace without a second channel.
   *
   * A node-id entry additionally carries every offending id at that path with its recorded state,
   * and the first such entry carries the uncapped accepted set — the message states both, capped, so
   * they survive the rejection replay; `detail` is where the full lists live.
   */
  detail?: ReadonlyArray<{
    readonly path: string;
    /** Offending ids at this path, each with its {@link PRESENT_NODE_ID_STATE_TEXT} wording. */
    readonly unlinkable_node_ids?: ReadonlyArray<{ readonly node_id: string; readonly state: string }>;
    /** The complete current result-graph id set, stated once per rejection. */
    readonly accepted_node_ids?: readonly string[];
    /** See {@link PresentResultViolation.entryIds} — carried through verbatim, id offenders only. */
    readonly entry_ids?: readonly string[];
    /** Measured character length of a label over its hard cap; present with `limit`, length offenders only. */
    readonly length?: number;
    /** The hard cap `length` exceeds; present with `length`, length offenders only. */
    readonly limit?: number;
  }>;
};

/**
 * Splits the cached discovery answer into engine-owned title/summary and verbatim section source.
 *
 * @param answer - The cached discovery chat answer (Markdown), title already inline if present.
 * @returns The split-off `title` (absent when the answer has no leading heading), the remaining
 *   `body`, and a one-line `summary` derived from the title or first non-empty body line.
 */
export function discoveryPreviewNarrative(answer: string): {
  title?: string;
  body: string;
  summary: string;
} {
  const normalized = answer.replace(/\r\n?/g, '\n').trim();
  const titleMatch = /^#\s+(.+?)\s*(?:\n|$)/.exec(normalized);
  const title = titleMatch?.[1]?.trim();
  const body = titleMatch ? normalized.slice(titleMatch[0].length).trim() : normalized;
  const summary = body.split('\n')
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .find(Boolean) ?? title ?? 'Lineage graph preview';
  return { ...(title ? { title } : {}), body, summary };
}

/**
 * A defect found outside {@link validatePresentResult} but reported through its accumulator.
 *
 * @remarks
 * Checks that need context the validator does not hold — the cached discovery answer, the result
 * graph — used to reject on their own and return before the structural rules ever ran. A payload
 * carrying one of those defects *and* a structural one therefore reported only the first, and the
 * second stayed latent until a later round, costing one semantic-failure charge per masked defect.
 * Passing findings in instead keeps every rule on one accumulator and one rejection.
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
  /**
   * Replaces the generic field-list hint when this is the only reported failure.
   *
   * @remarks
   * Same precedent as the unexplained-highlight gap below: a class whose repair is not "resend this
   * field" needs its own wording, but only while nothing else is wrong — a mixed batch keeps the
   * generic hint so no single class can misdescribe the others.
   */
  readonly soleHint?: string;
}

/**
 * Finds every way preview prose departs from the cached discovery answer.
 *
 * @remarks
 * Returns findings rather than a finished rejection so {@link validatePresentResult} can report
 * them through the same accumulator as every structural rule. Reporting reuse separately — and
 * returning early on it — hid whatever structural defect the same submission also carried until a
 * later round, spending one semantic-failure charge per masked defect.
 *
 * Notes are matched as a **contiguous** span of the whitespace-compacted answer: a caption stitched
 * from separated fragments is a new claim about adjacency, which is exactly what verbatim reuse
 * exists to prevent. Each failing caption is reported by index so the repair does not have to
 * re-derive which one it was.
 *
 * @param sourceBody - The cached discovery answer body, title already split off.
 * @param input - The sections and notes as submitted.
 * @returns One violation per departing field; empty when the payload is a faithful regrouping.
 */
export function findDiscoveryPreviewReuseViolations(
  sourceBody: string,
  input: Pick<PresentResultInput, 'sections' | 'notes'>,
): PresentResultViolation[] {
  const compact = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const source = compact(sourceBody);
  const sectionText = compact((input.sections ?? []).map(section => section.text).join('\n\n'));
  const badNoteIndexes = (input.notes ?? []).flatMap(
    (note, index) => (source.includes(compact(note.text)) ? [] : [index]),
  );
  const violations: PresentResultViolation[] = [];
  if (!source || sectionText !== source) {
    violations.push({
      field: 'sections',
      messages: ['sections[].text must partition the complete cached discovery answer verbatim, in order.'],
      repairFields: ['sections'],
      paths: [],
    });
  }
  if (badNoteIndexes.length > 0) {
    violations.push({
      field: 'notes',
      messages: [`notes[].text must each be one unbroken span copied verbatim from the cached discovery answer. Offending entries: ${badNoteIndexes.map(index => `notes[${index}]`).join(', ')}. For each listed note, replace its text with one continuous verbatim passage from the answer, or remove the note.`],
      repairFields: ['notes'],
      paths: badNoteIndexes.map(index => `notes.${index}`),
    });
  }
  return violations;
}

/**
 * Determines whether a failed `present_result` can safely hold its full draft for patch repair.
 *
 * @remarks
 * Reads the structural flag {@link validatePresentResult} computed while building the failure —
 * true only when every accumulated error was itself marked repairable at its `addError` call site.
 * Covers structural presentation gaps where the authored prose is otherwise valuable and the repair
 * can add or relink sections/notes/highlights without changing the locked graph. Shape errors, graph
 * edits, disconnected views, duplicate labels, and missing required body fields remain full
 * rejections and clear any held draft.
 */
export function isRepairablePresentResultFailure(failure: PresentResultError): boolean {
  return failure.repairable;
}

/**
 * Merges a strict repair patch into a held full `present_result` draft.
 *
 * @remarks
 * Patch fields replace whole presentation collections by design. The model does not send partial
 * array operations; it sends the corrected sections/notes/highlight_groups collection, and the
 * normal validation/assembly path checks the merged full draft.
 *
 * @param draft - The held full `present_result` draft the patch amends.
 * @param patch - The repair patch fields sent by the model.
 * @param allowedFields - The fields this rejection authorized for repair.
 * @returns The draft with `allowedFields` keys from `patch` merged in.
 * @throws When `patch` names a key outside `allowedFields`.
 */
export function mergePresentResultRepairPatch(
  draft: PresentResultInput,
  patch: PresentResultRepairPatch,
  allowedFields: readonly PresentResultRepairField[],
): PresentResultInput {
  const allowed = new Set<string>(allowedFields);
  const updates: Partial<PresentResultInput> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'is_update') continue;
    if (!allowed.has(key)) throw new Error(`Unauthorized present_result repair field: ${key}`);
    Object.assign(updates, { [key]: value });
  }
  return {
    ...draft,
    ...updates,
    is_update: draft.is_update,
  };
}

/** Structural (not textual) deep-equality: key order, whitespace, and number literal form never matter. */
function deepValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => deepValueEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aEntries = Object.entries(a as Record<string, unknown>);
    const bMap = b as Record<string, unknown>;
    return aEntries.length === Object.keys(bMap).length
      && aEntries.every(([key, value]) => deepValueEqual(value, bMap[key]));
  }
  return false;
}

/**
 * Pre-Zod L1 normalization for a `present_result` repair-turn payload: drops an unauthorized
 * envelope key (a {@link PRESENT_RESULT_REPAIR_FIELDS} member outside this turn's `allowedFields`,
 * e.g. `title`/`intro`/`closing`/`summary`) ONLY when the resent value is structurally identical to
 * the held draft's current value for that key.
 *
 * @remarks
 * A repair-turn model that cannot see its own held draft tends to blindly re-author the FULL prior
 * envelope rather than a scoped patch (the "blind regeneration" trap) — the resent value is usually
 * unchanged, and the strict repair-patch schema would otherwise hard-reject the whole call for
 * touching a field this turn was never authorized to change. Stripping only an unchanged value keeps
 * the reject meaningful: a value that structurally DIFFERS from the held draft is left in place so
 * the Zod boundary still rejects it — the model is not authorized to change that field this turn, and
 * silently accepting a changed-but-unauthorized value would be exactly the silent-overwrite class the
 * middleware contract forbids.
 *
 * @param rawInput - The model's raw repair-turn payload, not yet Zod-parsed.
 * @param heldDraft - The full draft currently on hold for this session.
 * @param allowedFields - The exact fields this repair turn is authorized to change.
 * @returns The (possibly narrowed) input and the list of keys stripped as unchanged.
 */
export function stripUnchangedRepairEnvelopeKeys(
  rawInput: Record<string, unknown>,
  heldDraft: PresentResultInput,
  allowedFields: readonly PresentResultRepairField[],
): { input: Record<string, unknown>; stripped: PresentResultRepairField[] } {
  const allowed = new Set<string>(allowedFields);
  const stripped: PresentResultRepairField[] = [];
  const next: Record<string, unknown> = { ...rawInput };
  for (const key of PRESENT_RESULT_REPAIR_FIELDS) {
    if (allowed.has(key) || !Object.prototype.hasOwnProperty.call(next, key)) continue;
    if (deepValueEqual(next[key], (heldDraft as Record<string, unknown>)[key])) {
      delete next[key];
      stripped.push(key);
    }
  }
  return { input: next, stripped };
}

const AI_HIGHLIGHT_ROLES = new Set<string>(['source', 'transform', 'target', 'good', 'warn', 'fail']);

/**
 * Normalizes AI-authored final section labels for uniqueness checks and assembly.
 *
 * @remarks
 * Final `present_result.sections[].label` is the authoritative graph/detail
 * pointer: the same string becomes the detail heading and the badge shown on
 * every node listed in that section's `node_ids[]`. The normalizer strips only
 * engine numbering artifacts and whitespace/case differences; it does not
 * rewrite semantics or synthesize labels.
 */
function normalizePresentSectionLabel(label: string): string {
  return (typeof label === 'string' ? label : '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
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

/** Minimum normalized length for a backtick-quoted fragment to fingerprint a captured callout. */
const DETAIL_CALLOUT_FINGERPRINT_MIN = 8;

/**
 * Normalizes text for captured-item presence matching: case, quote/emphasis markers, and
 * whitespace — including spacing around operators and punctuation — never distinguish two
 * renderings of the same captured statement or formula.
 */
function normalizeCalloutFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/⚠️/g, '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([=(),<>+\-\/|])\s*/g, '$1')
    .trim();
}

/**
 * A ```sql fence at the start of the matched text: closed on its own opening line, or else on a
 * later line — where the closing marker may share a line with the last line of code.
 */
const SQL_FENCE_AT_START = /^```sql(?:[^\n]*?```|[^\n]*\n[\s\S]*?```)/i;

/**
 * Returns the ```sql fence opening at `openIndex`, tolerant of a one-line fence and of its closing
 * marker sharing a line with the last line of code rather than starting one of its own.
 *
 * @param text - Full captured `DetailSlot` section body.
 * @param openIndex - Offset where the fence's own ```sql marker begins.
 * @returns The fence, closed; `undefined` when no ```sql marker opens there or it never closes.
 */
function sqlFenceAt(text: string, openIndex: number): string | undefined {
  return SQL_FENCE_AT_START.exec(text.slice(openIndex))?.[0];
}

/**
 * Returns the ```sql fence that opens at the start of the line right after `lineEnd`, if any.
 *
 * @param text - One captured `DetailSlot` section body.
 * @param lineEnd - Offset of the newline ending the line the fence must follow, or -1.
 * @returns The fence, closed; `undefined` when none follows.
 */
function sqlFenceAfter(text: string, lineEnd: number): string | undefined {
  if (lineEnd === -1) return undefined;
  const rest = text.slice(lineEnd + 1);
  const indent = /^[ \t]*/.exec(rest)?.[0] ?? '';
  if (!rest.startsWith('```sql', indent.length)) return undefined;
  return sqlFenceAt(text, lineEnd + 1 + indent.length);
}

/** A line opening a new block: list item, heading, fence, or another callout. */
const BLOCK_START_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|#|```|⚠️)/;

/**
 * Extracts the ⚠️ callouts from captured section text, each in its full extent.
 *
 * @remarks
 * A callout that opens its own line runs from that line, stripped of any list marker, through
 * every following line that continues it — a line inside a backtick span the callout opened, or a
 * non-blank line indented deeper than the callout's own line that opens no new block — and then
 * takes the ```sql fence that immediately follows, by the same boundary rule a formula uses. A ⚠️
 * that opens mid-sentence, inside a line some other text already opened, runs instead from that
 * marker through the next ⚠️ on the same line or the line's end, whichever comes first; only the
 * last such callout on its line takes a fence — one whose ```sql marker opens later on that same
 * line, by the rule a formula uses, or else one opening the next line.
 *
 * @param text - One captured `DetailSlot` section body.
 * @returns Per callout, the prose (fence excluded, for fingerprints) and the verbatim block, in authored order.
 */
function extractCapturedCallouts(text: string): Array<{ line: string; block: string }> {
  const callouts: Array<{ line: string; block: string }> = [];
  const lines = text.split('\n');
  const indentOf = (line: string) => line.length - line.trimStart().length;
  let lineEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    lineEnd += lines[i].length + 1;
    const rawLine = lines[i];
    const head = rawLine.trim().replace(/^[-*]\s+/, '');
    if (head.startsWith('⚠️')) {
      const indent = indentOf(rawLine);
      const extent = [head];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const spanOpen = (extent.join('\n').match(/`/g)?.length ?? 0) % 2 === 1;
        const continues = next.trim() !== '' && (spanOpen || (indentOf(next) > indent && !BLOCK_START_LINE.test(next)));
        if (!continues) break;
        extent.push(next.trim());
        i++;
        lineEnd += next.length + 1;
      }
      const line = extent.join('\n');
      const fence = sqlFenceAfter(text, lineEnd < text.length ? lineEnd : -1);
      callouts.push({ line, block: fence ? `${line}\n${fence}` : line });
      continue;
    }
    const lineStart = lineEnd - rawLine.length;
    const markers = [...rawLine.matchAll(/⚠️/g)].map(marker => marker.index ?? -1);
    for (let k = 0; k < markers.length; k++) {
      const isLast = k === markers.length - 1;
      const segmentEnd = isLast ? rawLine.length : markers[k + 1];
      const openInSegment = isLast ? rawLine.slice(markers[k], segmentEnd).search(/```sql/i) : -1;
      const prose = rawLine.slice(markers[k], openInSegment === -1 ? segmentEnd : markers[k] + openInSegment).trim();
      if (prose.length === 0) continue;
      let fence: string | undefined;
      if (openInSegment !== -1) fence = sqlFenceAt(text, lineStart + markers[k] + openInSegment);
      else if (isLast) fence = sqlFenceAfter(text, lineEnd < text.length ? lineEnd : -1);
      callouts.push({ line: prose, block: fence ? `${prose}\n${fence}` : prose });
    }
  }
  return callouts;
}

/** Display-math span as the capture templates author a formula. */
const DISPLAY_MATH_SPAN = /\$\$([^$]+?)\$\$/g;

/**
 * Extracts the display-math formulas from captured section text, each with the SQL fence that
 * immediately follows its line, if any.
 *
 * @remarks
 * The fence is attached only to the last formula on its line, so a line listing several formulas
 * never repeats one fence under each. The fence's own ```sql marker may open on the formula's own
 * line, after its description, or at the start of the line right after — both count as
 * "immediately follows".
 *
 * @param text - One captured `DetailSlot` section body.
 * @returns Normalized formula bodies with their restorable block (`$$ … $$` plus fence), in order.
 */
function extractCapturedFormulas(text: string): Array<{ body: string; block: string }> {
  const formulas: Array<{ body: string; block: string }> = [];
  for (const match of text.matchAll(DISPLAY_MATH_SPAN)) {
    const body = match[1].trim();
    if (body.length === 0) continue;
    const spanEnd = (match.index ?? 0) + match[0].length;
    const lineEnd = text.indexOf('\n', spanEnd);
    const restOfLine = lineEnd === -1 ? text.slice(spanEnd) : text.slice(spanEnd, lineEnd);
    let fence: string | undefined;
    if (!restOfLine.includes('$$')) {
      const openInLine = restOfLine.search(/```sql/i);
      fence = openInLine !== -1 ? sqlFenceAt(text, spanEnd + openInLine) : sqlFenceAfter(text, lineEnd);
    }
    const formula = `$$ ${body} $$`;
    formulas.push({ body, block: fence ? `${formula}\n${fence}` : formula });
  }
  return formulas;
}

/**
 * Derives presence fingerprints for one captured callout.
 *
 * @remarks
 * The capture contract quotes the row-losing statement in backticks, so each quoted fragment long
 * enough to be distinctive is a fingerprint: a section that re-quotes every quoted statement counts
 * as carrying the callout even when the surrounding prose is reworded. A callout with no usable
 * quote falls back to its own normalized line.
 *
 * @param callout - One ⚠️ callout's prose from {@link extractCapturedCallouts}, fence excluded.
 * @returns Normalized fingerprints; empty only when the line carries no matchable text.
 */
function calloutFingerprints(callout: string): string[] {
  const quoted: string[] = [];
  for (const match of callout.matchAll(/`([^`]+)`/g)) {
    const fingerprint = normalizeCalloutFingerprint(match[1]);
    if (fingerprint.length >= DETAIL_CALLOUT_FINGERPRINT_MIN) quoted.push(fingerprint);
  }
  if (quoted.length > 0) return quoted;
  const whole = normalizeCalloutFingerprint(callout);
  return whole.length > 0 ? [whole] : [];
}

/** Kind of captured detail content the assembler guarantees a place in the preview. */
export type CapturedDetailKind = 'callout' | 'formula';

/** One captured item restored into a section because the authored text omitted it. */
export type RestoredDetailItem = {
  /** Rendered section label the item was appended to. */
  label: string;
  /** Captured content kind. */
  kind: CapturedDetailKind;
  /** Verbatim restored text: the ⚠️ callout in its full extent or the `$$ … $$` formula, each with its SQL fence. */
  text: string;
};

/**
 * Lists the restorable captured items of one section body with their presence fingerprints.
 *
 * @param text - One captured `DetailSlot` section body.
 * @returns Callouts and formulas, each with its dedup key and the fingerprints that prove presence.
 */
function extractCapturedDetailItems(
  text: string,
): Array<{ kind: CapturedDetailKind; text: string; key: string; fingerprints: string[] }> {
  const callouts = extractCapturedCallouts(text).map(({ line, block }) => ({
    kind: 'callout' as const,
    text: block,
    key: normalizeCalloutFingerprint(line),
    fingerprints: calloutFingerprints(line),
  }));
  const formulas = extractCapturedFormulas(text).map(({ body, block }) => {
    const fingerprint = normalizeCalloutFingerprint(body);
    return {
      kind: 'formula' as const,
      text: block,
      key: fingerprint,
      fingerprints: fingerprint.length > 0 ? [fingerprint] : [],
    };
  });
  return [...callouts, ...formulas];
}

/**
 * Lists captured ⚠️ callouts and `$$ … $$` formulas absent from the assembled text, per owning
 * section.
 *
 * @remarks
 * Presence is tested against the whole document, not just the owning section: synthesis may
 * legitimately group sibling findings across nodes, and an item discussed under another section
 * is delivered, not dropped. A callout counts as present when every quoted statement is present;
 * a formula when its body is present in any normalized form. An absent item is restored,
 * verbatim, to its own node's section — a formula together with the SQL fence that followed it.
 * A paraphrase that never re-quotes the captured statement is restored alongside
 * it — completeness over brevity, since the engine cannot prove the paraphrase covers the quoted
 * statement and the no-drop ruling collapses only true duplication. Slots with no linked section
 * are ignored: the caller's unlinked-slot rejection owns that case.
 *
 * @param labelToNodeIds - Section-linked node ids per rendered label, first-wins as for badges.
 * @param haystack - Normalized full-document text used for presence matching.
 * @param detailSlots - Captured slots for the rendered nodes, if any.
 * @returns Missing items in capture order; empty when everything is already present.
 */
function findMissingDetailItems(
  labelToNodeIds: ReadonlyMap<string, readonly string[]>,
  haystack: string,
  detailSlots: readonly DetailSlot[] | undefined,
): RestoredDetailItem[] {
  const missing: RestoredDetailItem[] = [];
  if (!detailSlots || detailSlots.length === 0) return missing;
  const nodeToLabel = new Map<string, string>();
  for (const [label, ids] of labelToNodeIds) {
    for (const id of ids) {
      const key = id.toLowerCase();
      if (!nodeToLabel.has(key)) nodeToLabel.set(key, label);
    }
  }
  const seen = new Set<string>();
  for (const slot of detailSlots) {
    const label = nodeToLabel.get(slot.nodeId.toLowerCase());
    if (label === undefined) continue;
    for (const section of slot.sections ?? []) {
      for (const item of extractCapturedDetailItems(section.text)) {
        if (item.fingerprints.length === 0) continue;
        if (item.fingerprints.every(fingerprint => haystack.includes(fingerprint))) continue;
        const dedupKey = `${label}\n${item.kind}\n${item.key}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        missing.push({ label, kind: item.kind, text: item.text });
      }
    }
  }
  return missing;
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
 * description. Nodes not linked by the AI get no badge. Leading numbers in
 * AI-supplied labels are stripped to keep numbering deterministic.
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
 * Captured detail-slot callouts and formulas (`opts.detailSlots`) are delivered here for the same
 * reason badges and numbering are engine-owned: the node-level link check accepts a section that
 * names the node while omitting individual captured findings, so the assembler restores every
 * absent ⚠️ callout and `$$ … $$` formula (with its SQL fence) verbatim into its node's section.
 * The rendered preview then drops no captured information regardless of how the model phrased
 * the section.
 *
 * @param sections - AI-authored sections containing labels, node associations, and text.
 * @param opts - Optional wrapper blocks for the final document.
 * @returns The numbered badges for the graph, the fully assembled markdown description, any
 *   duplicate section links first-wins dropped while assembling them, and every captured callout
 *   or formula restored into a section.
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
    /**
     * Captured detail slots for the rendered nodes. Every ⚠️ callout and `$$ … $$` formula a
     * section-linked slot carries is guaranteed a place in the assembled description: items
     * already present are left alone, the rest are appended verbatim to the owning section under
     * a `Captured callouts` / `Captured formulas` marker. Slots with no linked section are
     * ignored here — the caller's unlinked-slot rejection owns that case.
     */
    detailSlots?: readonly DetailSlot[];
  },
): {
  badges: Array<{ node_id: string; text: string }>;
  description: string;
  droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }>;
  restoredDetailItems: RestoredDetailItem[];
} {
  const stripLeadingNumber = (s: string) => (typeof s === 'string' ? s : '').replace(/^\d+[\.]?\s+/, '').trim();

  const labelToAiIndex = new Map<string, number>();
  sections.forEach((sec, i) => {
    const norm = stripLeadingNumber(sec.label);
    if (!labelToAiIndex.has(norm)) labelToAiIndex.set(norm, i);
  });

  const uniqueLabels = [...new Set(sections.map(s => stripLeadingNumber(s.label)))];
  uniqueLabels.sort((a, b) => (labelToAiIndex.get(a) ?? 0) - (labelToAiIndex.get(b) ?? 0));

  const labelToNumber = new Map<string, number>();
  uniqueLabels.forEach((label, i) => labelToNumber.set(label, i + 1));

  const nodeToLabel = new Map<string, string>();
  const labelToNodeIds = new Map<string, string[]>();
  const droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }> = [];
  for (const sec of sections) {
    const label = stripLeadingNumber(sec.label);
    let kept = labelToNodeIds.get(label);
    if (!kept) { kept = []; labelToNodeIds.set(label, kept); }
    for (const id of sec.node_ids ?? []) {
      const owner = nodeToLabel.get(id);
      if (owner !== undefined) {
        if (owner !== label) droppedSectionLinks.push({ node_id: id, dropped_from: label, kept_in: owner });
        continue;
      }
      nodeToLabel.set(id, label);
      kept.push(id);
    }
  }

  const numberedBadges = [...nodeToLabel.entries()]
    .map(([node_id, label]) => {
      const n = labelToNumber.get(label);
      return n !== undefined ? { node_id, text: `${n} ${label}`, _n: n } : null;
    })
    .filter((b): b is { node_id: string; text: string; _n: number } => b !== null)
    .sort((a, b) => a._n - b._n)
    .map(({ node_id, text }) => ({ node_id, text }));

  const sectionMap = new Map(sections.map(s => [stripLeadingNumber(s.label), s.text]));

  const detailHaystack = normalizeCalloutFingerprint(
    [opts?.title, opts?.intro, opts?.preface, ...sectionMap.values(), opts?.closing]
      .filter((part): part is string => typeof part === 'string')
      .join('\n'),
  );
  const restoredDetailItems = findMissingDetailItems(labelToNodeIds, detailHaystack, opts?.detailSlots);
  for (const label of new Set(restoredDetailItems.map(item => item.label))) {
    const ofLabel = (kind: CapturedDetailKind) =>
      restoredDetailItems.filter(item => item.label === label && item.kind === kind).map(item => item.text);
    const callouts = ofLabel('callout');
    const formulas = ofLabel('formula');
    let body = sectionMap.get(label) ?? '';
    if (callouts.length > 0) body += `\n\n**Captured callouts:**\n${callouts.map(block => `- ${block.replace(/\n/g, '\n  ')}`).join('\n')}`;
    if (formulas.length > 0) body += `\n\n**Captured formulas:**\n${formulas.join('\n')}`;
    sectionMap.set(label, body);
  }

  const parts: string[] = [];
  if (opts?.title)        parts.push(`# ${opts.title}`);
  if (opts?.intro)        parts.push(opts.intro);
  if (opts?.preface)      parts.push(opts.preface);
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

  return { badges: numberedBadges, description: parts.join('\n\n'), droppedSectionLinks, restoredDetailItems };
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
};

/**
 * Builds the engine-owned "Column Chain" preface for a CT result from validated column-flow edges.
 *
 * @remarks
 * CT answers differ from BB by a proven column chain, and that chain already exists in validated
 * form (`column_flow` per hop) — this renders it as a deterministic table at the top of the
 * document instead of leaving the distinction to prose. Like badges and section numbering, the
 * table is engine output: the model never writes it, so it can never drift from the recorded
 * edges. Rows are ordered by hop; the unnumbered `## Column Chain` heading is deliberately not a
 * `## N` section, so it takes no section number and no navigation chip.
 *
 * @param edges - Validated column-flow edges accumulated by the engine.
 * @returns The preface markdown, or `undefined` when no edge was recorded (nothing to show).
 */
export function buildColumnChainPreface(edges: readonly ColumnChainEdge[]): string | undefined {
  if (edges.length === 0) return undefined;
  const rows = [...edges]
    .sort((a, b) => a.hop - b.hop)
    .map(e => `| ${e.hop} | \`${e.to_node}\` | \`${e.to_col}\` | \`${e.from_node}.${e.from_col}\` |`);
  return [
    '## Column Chain',
    '',
    '| Hop | Produces | Column | Reads from |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
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
 * Validates the full `present_result` input against mechanical contracts only.
 *
 * @remarks
 * Enforces naming length, summary length, sections[] presence, node-id resolution,
 * and final section label/text cardinality. Markdown/KaTeX formatting is deliberately
 * not validated: formatting can never reject a call (the renderer degrades gracefully).
 *
 * Content quality remains prompt-owned, but structural invariants are enforced
 * here: each final section label is non-empty, short, unique, and has exactly
 * one text body; `node_ids[]` is optional, but a node may not be linked to
 * multiple final sections.
 *
 * The `description` returned in {@link PresentResultRequest} is the engine-assembled
 * markdown blob built by {@link orderAndAssemble} — passed in as `assembledDescription`,
 * never read from `input`. The AI does not write the assembled document.
 *
 * @param input - The raw AI input.
 * @param resolvedNodeIds - The canonical set of node IDs.
 * @param assembledBadges - Pre-assembled numbered badges for consistency.
 * @param assembledDescription - Engine-built markdown blob from {@link orderAndAssemble}.
 * @param isAmendment - Engine-derived: this render updates an existing committed presentation in
 *   Completed Phase, so `highlight_groups` may be inherited from that prior render. A held synthesis
 *   draft is not an amendment and must still pass the complete new-render contract. Computed by the
 *   dispatcher — never the model's raw `is_update` flag.
 * @param externalViolations - Findings from checks that need context this function does not hold
 *   (the cached discovery answer, the result graph), reported through this accumulator alongside the
 *   structural rules below — see {@link PresentResultViolation}.
 * @param stage - The calling stage (engine-derived), used to keep the unknown-node-id repair hint
 *   caller-possible — see {@link presentNodeIdHint}. Defaults to `'completed'`, the only stage whose
 *   tool policy includes `lineage_search_objects`, so existing callers that do not pass a stage keep
 *   today's hint wording unchanged.
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
  isAmendment = false,
  externalViolations: readonly PresentResultViolation[] = [],
  stage: PresentResultStage = 'completed',
  nodeIdState?: PresentNodeIdStateLookup,
): PresentResultRequest | PresentResultError {
  const errors: string[] = [];
  let allRepairable = true;
  const repairFields = new Set<PresentResultRepairField>();
  const failedFields = new Set<PresentResultFailedField>();
  const issuePaths = new Set<string>();
  const pathUnlinkableIds = new Map<string, readonly string[]>();
  const pathEntryIds = new Map<string, readonly string[]>();
  const pathLengthOverruns = new Map<string, { readonly length: number; readonly limit: number }>();
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
  let hasUnexplainedHighlightGap = false;

  const soleHints = externalViolations.flatMap(violation => violation.soleHint ?? []);
  for (const violation of externalViolations) {
    for (const message of violation.messages) {
      addError(violation.field, message, violation.repairFields, violation.paths, [], violation.entryIds);
    }
  }
  const externalErrorCount = errors.length;

  /**
   * Reports one GUI label over its hard cap.
   *
   * @remarks
   * The caps are validator-owned rather than Zod-owned at the boundary (see
   * `PresentResultBoundarySchema`): a Zod reject fails the whole call with a field path and no held
   * draft, so an overrun costs a full resend of an answer that was otherwise correct. Reported here
   * the overrun is repairable, authorizes only its own field, and names the exact entry. The
   * measured length is stated because a model cannot count characters — the same fact
   * `describeSizeIssue` (`toolErrorEnvelope.ts`) states for a Zod size issue, in the same wording.
   * `summary`, `intro` and `closing` are prose, never a rejection axis, and have no cap to check.
   */
  const addLengthError = (
    field: PresentResultFailedField & PresentResultRepairField,
    path: string,
    value: string,
    limit: number,
  ): void => {
    if (value.length <= limit) return;
    addError(field, `${path} is over its length limit: ${value.length} chars, limit ${limit}. Shorten it — the engine never truncates authored text.`, [field], [path]);
    pathLengthOverruns.set(path, { length: value.length, limit });
  };

  if (!input.name || input.name.trim().length === 0) addError('name', 'name is required');
  else addLengthError('name', 'name', input.name, PRESENT_RESULT_NAME_MAX);
  if (typeof input.title === 'string') addLengthError('title', 'title', input.title, PRESENT_RESULT_TITLE_MAX);

  if (resolvedNodeIds.length === 0) {
    addError('nodes', 'No nodes in view — the result graph is empty or all nodes were pruned');
  }

  if (!input.summary || input.summary.trim().length === 0) {
    addError('summary', 'summary is required — one-line graph purpose (~120 chars)');
  }

  const hasSections = !!(input.sections && input.sections.length > 0);
  const hasAssembled = !!(assembledDescription && assembledDescription.trim().length > 0);
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
  const nodeIdNoun = allHallucinated
    ? 'contains unknown IDs'
    : 'names IDs the result graph cannot link';
  const renderNodeIdStates = (ids: readonly string[]): string =>
    ids.slice(0, NODE_ID_OFFENDERS_SHOWN)
      .map(id => `\`${id}\` — ${PRESENT_NODE_ID_STATE_TEXT[stateOf(id)]}`)
      .join('; ')
    + (ids.length > NODE_ID_OFFENDERS_SHOWN ? ' ...' : '');
  /**
   * Offenders elsewhere in the call, the accepted set, and the route back — appended to each site,
   * in that order: the rejection replay hard-slices this string, so the least recoverable fact (which
   * id failed and why) is stated before the ones the completion envelope also carries.
   */
  const nodeIdRejectionTail = (idsAtThisPath: readonly string[]): string => {
    const elsewhere = unlinkableNodeIds.filter(id => !idsAtThisPath.includes(id));
    return (elsewhere.length > 0 ? ` Also unlinkable here: ${renderNodeIdStates(elsewhere)}.` : '')
      + ` Accepted ids (current result graph): ${quoteIds(resolvedNodeIds, NODE_ID_ACCEPTED_SHOWN)}.`
      + (allHallucinated ? '' : ` ${PRESENT_REAL_ID_ROUTE[stage]}`)
      + ` ${presentNodeIdHint(stage)}`;
  };

  if (!hasSections && !hasAssembled) {
    addError('sections', 'sections[] is required — provide at least one section with label and text; node_ids[] is optional.');
  }


  if (hasSections) {
    const labels = new Set<string>();
    for (const [sectionIndex, sec] of input.sections.entries()) {
      const label = (sec.label ?? '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim();
      const normalizedLabel = normalizePresentSectionLabel(sec.label);
      if (!label) {
        addError('sections', 'Section label is required — provide a short final label for this detail section');
      } else {
        addLengthError('sections', `sections.${sectionIndex}.label`, sec.label, PRESENT_RESULT_SECTION_LABEL_MAX);
        if (labels.has(normalizedLabel)) {
          addError('sections', `Duplicate section label "${label}" — each final label must map to exactly one section text`);
        }
        labels.add(normalizedLabel);
      }
      if (sec.node_ids?.length) {
        const unknownIds = sec.node_ids.filter(id => !resolvedSet.has(id));
        if (unknownIds.length > 0) {
          addError('sections', `Section "${sec.label}" node_ids ${nodeIdNoun}: ${renderNodeIdStates(unknownIds)}.${nodeIdRejectionTail(unknownIds)}`, ['sections'], [`sections.${sectionIndex}`], unknownIds);
        }
        for (const nodeId of sec.node_ids.filter(id => resolvedSet.has(id))) {
          sectionLinkedNodeIds.add(nodeId);
        }
      }
      if (typeof sec.text !== 'string' || sec.text.trim().length === 0) {
        addError('sections', `Section "${sec.label}" is missing text — every final section label requires one detail body`);
      }
    }
  }

  const noteNodeIds = new Set<string>();
  if (input.notes?.length) {
    for (const [noteIndex, note] of input.notes.entries()) {
      if (resolvedSet.has(note.node_id)) {
        noteNodeIds.add(note.node_id);
      } else {
        addError('notes', `notes[].node_id ${nodeIdNoun}: ${renderNodeIdStates([note.node_id])}.${nodeIdRejectionTail([note.node_id])}`, ['notes'], [`notes.${noteIndex}`], [note.node_id]);
      }
      if (typeof note.text !== 'string' || note.text.trim().length === 0) {
        addError('notes', `Note for "${note.node_id}" is missing text`);
      }
    }
  }

  const highlightedNodeIds = new Set<string>();
  if (!input.highlight_groups || input.highlight_groups.length === 0) {
    if (!isAmendment) {
      addError('highlight_groups', 'highlight_groups[] is required — provide at least 1 group using the Lineage palette (source / transform / target)');
    }
  } else {
    if (input.highlight_groups.length > PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX) {
      addError('highlight_groups', `highlight_groups exceeds maximum of ${PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX}`, ['highlight_groups']);
    }
    for (const [groupIndex, g] of input.highlight_groups.entries()) {
      if (!g.label) addError('highlight_groups', 'Group label is required');
      else addLengthError('highlight_groups', `highlight_groups.${groupIndex}.label`, g.label, PRESENT_RESULT_HIGHLIGHT_LABEL_MAX);
      if (!AI_HIGHLIGHT_ROLES.has(g.color)) addError('highlight_groups', `Group "${g.label}" has invalid role "${g.color}" — use one of: ${[...AI_HIGHLIGHT_ROLES].join(', ')}`);
      const unknownIds = (g.node_ids ?? []).filter(nodeId => !resolvedSet.has(nodeId));
      if (unknownIds.length > 0) {
        addError('highlight_groups', `highlight_groups "${g.label}" node_ids ${nodeIdNoun}: ${renderNodeIdStates(unknownIds)}.${nodeIdRejectionTail(unknownIds)}`, ['highlight_groups'], [`highlight_groups.${groupIndex}`], unknownIds);
      }
      for (const nodeId of g.node_ids ?? []) {
        if (resolvedSet.has(nodeId)) highlightedNodeIds.add(nodeId);
      }
    }
  }

  const unexplainedHighlightNodeIds = [...highlightedNodeIds].filter(id => !sectionLinkedNodeIds.has(id) && !noteNodeIds.has(id));
  if (unexplainedHighlightNodeIds.length > 0) {
    hasUnexplainedHighlightGap = true;
    addError(
      'highlight_groups',
      `highlight_groups node_ids must be explained by sections[].node_ids or notes[]: ${unexplainedHighlightNodeIds.slice(0, 5).join(', ')}${unexplainedHighlightNodeIds.length > 5 ? ' ...' : ''}. For each listed node, add it to a section's node_ids[] or add a note naming it — or drop it from highlight_groups[] if it is uncolored plumbing.`,
      ['sections', 'notes', 'highlight_groups'],
    );
  }

  const buildRejectionDetail = (): PresentResultError['detail'] => {
    let acceptedStated = false;
    return [...issuePaths].map(path => {
      const ids = pathUnlinkableIds.get(path);
      const entryIds = pathEntryIds.get(path);
      const overrun = pathLengthOverruns.get(path);
      if (!ids && !entryIds && !overrun) return { path };
      const entry = {
        path,
        ...(ids ? { unlinkable_node_ids: ids.map(id => ({ node_id: id, state: PRESENT_NODE_ID_STATE_TEXT[stateOf(id)] })) } : {}),
        ...(ids && !acceptedStated ? { accepted_node_ids: [...resolvedNodeIds] } : {}),
        ...(entryIds ? { entry_ids: entryIds } : {}),
        ...(overrun ?? {}),
      };
      if (ids) acceptedStated = true;
      return entry;
    });
  };

  if (errors.length > 0) {
    const fieldList = [...failedFields];
    const resendList = [...repairFields];
    let hint = fieldList.length === 1
      ? `Fix ${fieldList[0]} only.${resendList.length > 0 ? ` Resend only these fields: ${resendList.join(', ')}.` : ''}`
      : `Fix these fields: ${fieldList.join(', ')}.${resendList.length > 0 ? ` Resend only these fields: ${resendList.join(', ')}.` : ''}`;
    if (failedFields.has('sections')) {
      hint = `${hint} ${presentNodeIdHint(stage)}`;
    }
    if (hasUnexplainedHighlightGap && errors.length === 1) {
      hint = "Fix sections, notes, or highlight_groups. For each node named in the error, add it to a section's node_ids[], add a note naming it, or drop it from highlight_groups[] if it is uncolored plumbing.";
    }
    if (soleHints.length === 1 && errors.length === externalErrorCount) {
      hint = soleHints[0];
    }
    return {
      success: false,
      errors,
      hint,
      repairable: allRepairable,
      repairFields: [...repairFields],
      ...(issuePaths.size > 0 ? { detail: buildRejectionDetail() } : {}),
    };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: resolvedNodeIds,
    summary: input.summary,
    description: assembledDescription!,
    layout_direction: input.layout_direction,
    highlight_groups: input.highlight_groups ?? [],
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
  const nodeSet = new Set(nodeIds);
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set<string>());
  for (const [src, tgt] of edges) {
    if (!nodeSet.has(src) || !nodeSet.has(tgt)) continue;
    adj.get(src)!.add(tgt);
    adj.get(tgt)!.add(src);
  }
  const seen = new Set<string>([originNodeId]);
  const queue: string[] = [originNodeId];
  let idx = 0;
  while (idx < queue.length) {
    const id = queue[idx++];
    for (const nid of adj.get(id) ?? []) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      queue.push(nid);
    }
  }
  return nodeIds.filter(id => !seen.has(id)).sort();
}
