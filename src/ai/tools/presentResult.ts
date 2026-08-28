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
  PRESENT_RESULT_REPAIR_FIELDS,
  type PresentResultRepairField,
} from './toolSchemas';
import { getAllowedLmToolNames } from './toolPolicy';
import { quoteIds } from '../support/text';
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

/** Offender-list rendering for unknown-node-id rejections; see {@link quoteIds}. */
const renderUnknownNodeIds = (ids: readonly string[]): string => quoteIds(ids, 3);

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
  layout_direction: 'LR' | 'TB';
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
   */
  detail?: ReadonlyArray<{ readonly path: string }>;
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
  readonly field: PresentResultFailedField;
  readonly messages: readonly string[];
  readonly repairFields: readonly PresentResultRepairField[];
  /** Exact offending entry paths, empty when the violation is about the payload as a whole. */
  readonly paths: readonly string[];
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

/**
 * Builds the rendered description markdown from the AI's structured input parts.
 *
 * @remarks
 * This is the SOLE path that produces the description blob shown in
 * `AiDescriptionOverlay`. The AI never writes the blob directly — it writes the
 * parts (title, intro, sections[], closing) and the engine assembles them
 * deterministically here. Section numbering (`## N {label}`), badge chips, and
 * the `### Objects [name](#focus-node:id)` link header are all engine-owned;
 * they are not AI-authored fields.
 *
 * Numbered badges are emitted only for AI-provided `sections[].node_ids[]`, in
 * narrative order, so chips on the graph align with `## N` headings in the
 * description. Nodes not linked by the AI get no badge. Leading numbers in
 * AI-supplied labels are stripped to keep numbering deterministic.
 *
 * @param sections - AI-authored sections containing labels, node associations, and text.
 * @param opts - Optional wrapper blocks for the final document.
 * @returns A pair of numbered badges for the graph and the fully assembled markdown description.
 */
export function orderAndAssemble(
  sections: Array<{ label: string; node_ids?: string[]; text?: string }>,
  opts?: {
    title?: string;
    intro?: string;
    closing?: string;
    /** Optional node lookup for injecting clickable H3 object-name headings per section. */
    nodeMap?: Map<string, { id: string; name: string }>;
  },
): { badges: Array<{ node_id: string; text: string }>; description: string } {
  // Strip leading "N " or "N. " so AI numbers don't interfere with label matching.
  const stripLeadingNumber = (s: string) => (typeof s === 'string' ? s : '').replace(/^\d+[\.]?\s+/, '').trim();

  // First occurrence index per label — preserves AI's narrative order
  const labelToAiIndex = new Map<string, number>();
  sections.forEach((sec, i) => {
    const norm = stripLeadingNumber(sec.label);
    if (!labelToAiIndex.has(norm)) labelToAiIndex.set(norm, i);
  });

  // Unique labels in AI's sections[] order
  const uniqueLabels = [...new Set(sections.map(s => stripLeadingNumber(s.label)))];
  uniqueLabels.sort((a, b) => (labelToAiIndex.get(a) ?? 0) - (labelToAiIndex.get(b) ?? 0));

  // Assign step number N per unique label (1-based, in AI's narrative order)
  const labelToNumber = new Map<string, number>();
  uniqueLabels.forEach((label, i) => labelToNumber.set(label, i + 1));

  // Build (node_id → label) map from sections[].node_ids
  const nodeToLabel = new Map<string, string>();
  for (const sec of sections) {
    const label = stripLeadingNumber(sec.label);
    for (const id of sec.node_ids ?? []) nodeToLabel.set(id, label);
  }

  // Emit numbered badge chips, dropping any node whose label has no matching section.
  const numberedBadges = [...nodeToLabel.entries()]
    .map(([node_id, label]) => {
      const n = labelToNumber.get(label);
      return n !== undefined ? { node_id, text: `${n} ${label}`, _n: n } : null;
    })
    .filter((b): b is { node_id: string; text: string; _n: number } => b !== null)
    .sort((a, b) => a._n - b._n)
    .map(({ node_id, text }) => ({ node_id, text }));

  // Assemble markdown: title → intro → ## sections → closing
  const sectionMap = new Map(sections.map(s => [stripLeadingNumber(s.label), s.text]));
  // First-occurrence node_ids list per unique label (AI-authored order preserved).
  const labelToNodeIds = new Map<string, string[]>();
  for (const sec of sections) {
    const label = stripLeadingNumber(sec.label);
    if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, sec.node_ids ?? []);
  }

  const parts: string[] = [];
  if (opts?.title)        parts.push(`# ${opts.title}`);
  if (opts?.intro)        parts.push(opts.intro);
  for (const label of uniqueLabels) {
    const n = labelToNumber.get(label)!;
    const text = sectionMap.get(label) ?? '';
    const nodeIds = labelToNodeIds.get(label) ?? [];
    let objectHeadings = '';
    if (opts?.nodeMap && nodeIds.length > 0) {
      const links = nodeIds
        .map(id => opts.nodeMap!.get(id))
        .filter((node): node is { id: string; name: string } => !!node)
        .map(node => `[${node.name}](#focus-node:${encodeFocusNodeId(node.id)})`);
      if (links.length > 0) objectHeadings = `### Objects ${links.join(', ')}\n\n`;
    }
    parts.push(`## ${n} ${label}\n\n${objectHeadings}${text}`);
  }
  if (opts?.closing) parts.push(`---\n\n${opts.closing}`);

  return { badges: numberedBadges, description: parts.join('\n\n') };
}

/**
 * Reports which non-pruned nodes the AI left bare (linked in neither preview surface) — an
 * observation for the log, never a payload mutation.
 *
 * @remarks
 * The prompt contract permits bare nodes: "nodes left out of both preview surfaces stay bare" —
 * they still render in the graph via the engine-owned resolved scope, just without a badge or
 * color. The engine therefore has no authority to re-link them: a tool boundary accepts, rejects
 * with a structural hint, or mechanically normalizes with a log — it never silently rewrites an
 * AI presentation decision (the predecessor of this function injected bare nodes into
 * `sections[].node_ids`, which badge-labeled every non-pruned node in the rendered view).
 * Only `prune` removes a node from the view; bare-by-choice is a permitted verdict-respecting
 * outcome for `analyze`/`passthrough` nodes.
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
 * @returns A successful request object or a structured error with correction hints.
 */
export function validatePresentResult(
  input: PresentResultInput,
  resolvedNodeIds: string[],
  assembledBadges?: Array<{ node_id: string; text: string }>,
  assembledDescription?: string,
  isAmendment: boolean = false,
  externalViolations: readonly PresentResultViolation[] = [],
  stage: PresentResultStage = 'completed',
): PresentResultRequest | PresentResultError {
  const errors: string[] = [];
  // Structural classification — the failed field AND repairability are set once per addError call
  // at the exact site the error is known, never re-derived later by matching error TEXT
  // (see PresentResultError.repairable). A message rewording can therefore never desync the
  // repair-hint field list.
  let allRepairable = true;
  const repairFields = new Set<PresentResultRepairField>();
  const failedFields = new Set<PresentResultFailedField>();
  // Offending entry paths, collected at the same call sites for the same reason the field list is:
  // a rejection that names a rule but not the offender costs a repair round to locate.
  const issuePaths = new Set<string>();
  const addError = (
    field: PresentResultFailedField,
    message: string,
    authorizedFields: readonly PresentResultRepairField[] = [],
    paths: readonly string[] = [],
  ): void => {
    errors.push(message);
    failedFields.add(field);
    if (authorizedFields.length === 0) allRepairable = false;
    for (const f of authorizedFields) repairFields.add(f);
    for (const path of paths) issuePaths.add(path);
  };
  // Set only at the unexplained-highlight addError call below — drives a bespoke hint override
  // instead of the generic single-field template, which would misclassify/foreclose this 3-field class.
  let hasUnexplainedHighlightGap = false;

  // Findings computed by callers that hold context this function does not — the cached discovery
  // answer, the result graph. Reported first so their messages keep the priority they had when each
  // owned its own early return, but through this accumulator so a payload carrying one of them plus
  // a structural defect reports both in one round instead of one per round.
  const soleHints = externalViolations.flatMap(violation => violation.soleHint ?? []);
  for (const violation of externalViolations) {
    for (const message of violation.messages) {
      addError(violation.field, message, violation.repairFields, violation.paths);
    }
  }
  // How many of `errors` came from callers — lets a caller's own hint stand while it is the only
  // thing wrong, without assuming one violation means one message.
  const externalErrorCount = errors.length;

  // Presence only — length caps are Zod-owned at the boundary schema (name/title/summary), so no
  // hand-rolled length check here (it would duplicate Zod and, for summary, reject on prose length).
  if (!input.name || input.name.trim().length === 0) addError('name', 'name is required');

  // Node set must be non-empty (after resolve + prune)
  if (resolvedNodeIds.length === 0) {
    addError('nodes', 'No nodes in view — the result graph is empty or all nodes were pruned');
  }

  if (!input.summary || input.summary.trim().length === 0) {
    addError('summary', 'summary is required — one-line graph purpose (~120 chars)');
  }

  const hasSections = !!(input.sections && input.sections.length > 0);
  const hasAssembled = !!(assembledDescription && assembledDescription.trim().length > 0);
  const sectionLinkedNodeIds = new Set<string>();

  // Either AI submitted sections[] (which the engine assembles into a description before
  // validation) OR an engine-assembled description is supplied. Without one, there's no body.
  if (!hasSections && !hasAssembled) {
    addError('sections', 'sections[] is required — provide at least one section with label and text; node_ids[] is optional.');
  }

  // Markdown/KaTeX formatting is never validated here: a formatting flaw must not reject a call
  // or kill a session. The webview renderer degrades invalid math to its original source text
  // and formatting quality is checked by the offline test harness only.

  // Sections validation — final labels/text are 1:1 and mandatory; node links are optional.
  if (hasSections) {
    const resolvedSet = new Set(resolvedNodeIds);
    const labels = new Set<string>();
    const nodeToSectionLabel = new Map<string, string>();
    for (const [sectionIndex, sec] of input.sections!.entries()) {
      const label = (sec.label ?? '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim();
      const normalizedLabel = normalizePresentSectionLabel(sec.label);
      if (!label) {
        addError('sections', 'Section label is required — provide a short final label for this detail section');
      } else {
        // Label brevity is prompt-owned content quality; structural validity stays at this boundary.
        if (labels.has(normalizedLabel)) {
          addError('sections', `Duplicate section label "${label}" — each final label must map to exactly one section text`);
        }
        labels.add(normalizedLabel);
      }
      if (sec.node_ids?.length) {
        const unknownIds = sec.node_ids.filter(id => !resolvedSet.has(id));
        if (unknownIds.length > 0) {
          // Repair authorization deliberately left empty (unchanged): only the offending entry path
          // is added, so `rejectionCode` alone no longer has to identify which rule fired.
          addError('sections', `Section "${sec.label}" node_ids contains unknown IDs: ${renderUnknownNodeIds(unknownIds)} — ${presentNodeIdHint(stage)}`, [], [`sections.${sectionIndex}`]);
        }
        for (const nodeId of sec.node_ids.filter(id => resolvedSet.has(id))) {
          sectionLinkedNodeIds.add(nodeId);
          const existingLabel = nodeToSectionLabel.get(nodeId);
          if (existingLabel && existingLabel !== normalizedLabel) {
            addError('sections', `Node "${nodeId}" already appears in section "${existingLabel}" — remove it from section "${normalizedLabel}" (sections[${sectionIndex}].node_ids) and keep it only in "${existingLabel}".`, ['sections'], [`sections.${sectionIndex}`]);
          } else {
            nodeToSectionLabel.set(nodeId, normalizedLabel);
          }
        }
      }
      if (typeof sec.text !== 'string' || sec.text.trim().length === 0) {
        addError('sections', `Section "${sec.label}" is missing text — every final section label requires one detail body`);
      }
    }
  }

  const noteNodeIds = new Set<string>();
  if (input.notes?.length) {
    const resolvedSet = new Set(resolvedNodeIds);
    for (const [noteIndex, note] of input.notes.entries()) {
      if (resolvedSet.has(note.node_id)) {
        noteNodeIds.add(note.node_id);
      } else {
        addError('notes', `notes[].node_id contains unknown ID: ${renderUnknownNodeIds([note.node_id])} — ${presentNodeIdHint(stage)}`, [], [`notes.${noteIndex}`]);
      }
      if (typeof note.text !== 'string' || note.text.trim().length === 0) {
        addError('notes', `Note for "${note.node_id}" is missing text`);
      }
    }
  }

  // highlight_groups validation — required for new renders; inherited (optional) only when this render
  // amends an existing one (engine-derived isAmendment), never on the model's raw is_update flag.
  const highlightedNodeIds = new Set<string>();
  if (!input.highlight_groups || input.highlight_groups.length === 0) {
    if (!isAmendment) {
      addError('highlight_groups', 'highlight_groups[] is required — provide at least 1 group using the Lineage palette (source / transform / target)');
    }
  } else {
    if (input.highlight_groups.length > PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX) {
      addError('highlight_groups', `highlight_groups exceeds maximum of ${PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX}`, ['highlight_groups']);
    }
    const resolvedSet = new Set(resolvedNodeIds);
    for (const [groupIndex, g] of input.highlight_groups.entries()) {
      if (!g.label) addError('highlight_groups', 'Group label is required');
      if (!AI_HIGHLIGHT_ROLES.has(g.color)) addError('highlight_groups', `Group "${g.label}" has invalid role "${g.color}" — use one of: ${[...AI_HIGHLIGHT_ROLES].join(', ')}`);
      const unknownIds = (g.node_ids ?? []).filter(nodeId => !resolvedSet.has(nodeId));
      if (unknownIds.length > 0) {
        addError('highlight_groups', `highlight_groups "${g.label}" node_ids contains unknown IDs: ${renderUnknownNodeIds(unknownIds)} — ${presentNodeIdHint(stage)}`, [], [`highlight_groups.${groupIndex}`]);
      }
      for (const nodeId of g.node_ids ?? []) {
        if (resolvedSet.has(nodeId)) highlightedNodeIds.add(nodeId);
      }
    }
  }

  // Highlighted nodes require an explanation, but unhighlighted preview nodes do not require notes.
  // A repair may add or relink the missing explanation without modifying the locked graph.
  const unexplainedHighlightNodeIds = [...highlightedNodeIds].filter(id => !sectionLinkedNodeIds.has(id) && !noteNodeIds.has(id));
  if (unexplainedHighlightNodeIds.length > 0) {
    hasUnexplainedHighlightGap = true;
    addError(
      'highlight_groups',
      `highlight_groups node_ids must be explained by sections[].node_ids or notes[]: ${unexplainedHighlightNodeIds.slice(0, 5).join(', ')}${unexplainedHighlightNodeIds.length > 5 ? ' ...' : ''}. For each listed node, add it to a section's node_ids[] or add a note naming it — or drop it from highlight_groups[] if it is uncolored plumbing.`,
      ['sections', 'notes', 'highlight_groups'],
    );
  }

  if (errors.length > 0) {
    // The failed-field list was attached structurally at each addError site above.
    const fieldList = [...failedFields];
    // Derive the resend list from the same field set used to narrow the repair schema.
    const resendList = [...repairFields];
    let hint = fieldList.length === 1
      ? `Fix ${fieldList[0]} only.${resendList.length > 0 ? ` Resend only these fields: ${resendList.join(', ')}.` : ''}`
      : `Fix these fields: ${fieldList.join(', ')}.${resendList.length > 0 ? ` Resend only these fields: ${resendList.join(', ')}.` : ''}`;
    if (failedFields.has('sections')) {
      hint = `${hint} ${presentNodeIdHint(stage)}`;
    }
    // The unexplained-highlight-coverage gap authorizes three repair fields (sections, notes,
    // highlight_groups — see the addError call above), and its node ids are already resolved, so
    // both the generic single-field template ("keep highlight_groups exactly as submitted") and
    // the unknown-ID hint above misfire for this class. Override when it is the sole reported
    // failure; a mixed batch (e.g. alongside a non-repairable field) keeps the generic hint.
    if (hasUnexplainedHighlightGap && errors.length === 1) {
      hint = "Fix sections, notes, or highlight_groups. For each node named in the error, add it to a section's node_ids[], add a note naming it, or drop it from highlight_groups[] if it is uncolored plumbing.";
    }
    // Same rule for a caller-supplied class: its wording stands only while nothing else is wrong.
    if (soleHints.length === 1 && errors.length === externalErrorCount) {
      hint = soleHints[0];
    }
    return {
      success: false,
      errors,
      hint,
      repairable: allRepairable,
      repairFields: [...repairFields],
      ...(issuePaths.size > 0 ? { detail: [...issuePaths].map(path => ({ path })) } : {}),
    };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: resolvedNodeIds,
    summary: input.summary,
    description: assembledDescription!,
    layout_direction: input.layout_direction ?? 'TB',
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
