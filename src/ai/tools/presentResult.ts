/**
 * AI `present_result` contract: input/output types, validation, and the deterministic
 * markdown assembly. Extracted from `tools.ts` so the (large) presentation/validation
 * surface lives apart from the retrieval operations. Zero VS Code imports — pure functions
 * consumed directly by `toolProvider.ts` and the present-result unit tests.
 */
import type { DatabaseModel } from '../../engine/types';
import { z } from 'zod';

/** Char cap on the AI-supplied `name` field in `present_result` — guards against pathological prompt injection or runaway labels. */
const PRESENT_RESULT_NAME_MAX_LENGTH = 200;
/** Char cap on the AI-supplied `summary` field in `present_result` — keeps the badge readable in the chat stream. */
const PRESENT_RESULT_SUMMARY_HARD_LIMIT = 300;
const SECTION_NODE_ID_HINT = 'Use node IDs from the current result graph. Case and bracket differences are normalized automatically; if still unresolved, resolve canonical IDs with lineage_search_objects.';

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
export type AIHighlightRole = 'source' | 'transform' | 'target' | 'good' | 'warn' | 'fail';

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
 * There is intentionally NO `description` field on this input — that field is
 * engine output, not AI input. If a future change wants to re-add it, fix the
 * template that instructs the AI to write a blob instead.
 */
export type PresentResultInput = {
  name: string;
  summary: string;
  title?: string;       // doc heading (≤80 chars) — names pipeline + key formula
  intro?: string;       // 2–4 sentence paragraph before the numbered sections
  closing?: string;     // 1–2 sentence cross-cutting risk/note after the sections
  prune_node_ids?: string[];
  add_node_ids?: string[];
  is_update?: boolean;
  layout_direction?: 'LR' | 'TB';
  highlight_groups?: Array<{
    label: string;
    color: AIHighlightRole;
    node_ids: string[];
  }>;
  sections?: Array<{
    label: string;       // AI-owned final section/badge label — unique, short graph pointer
    node_ids?: string[]; // optional AI-owned node links; nodes omitted here get no badge
    text: string;        // mandatory detail body for this exact label (1:1 with label)
  }>;
  notes?: Array<{
    node_id: string;
    text: string;
  }>;
};

const PresentHighlightGroupSchema = z.object({
  label: z.string(),
  color: z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']),
  node_ids: z.array(z.string()),
}).strict();

const PresentSectionSchema = z.object({
  label: z.string(),
  node_ids: z.array(z.string()).optional(),
  text: z.string(),
}).strict();

const PresentNoteSchema = z.object({
  node_id: z.string(),
  text: z.string(),
}).strict();

/** Strict runtime boundary for untrusted `present_result` input. */
export const PresentResultBoundarySchema = z.object({
  name: z.string(),
  summary: z.string(),
  title: z.string().optional(),
  intro: z.string().optional(),
  closing: z.string().optional(),
  prune_node_ids: z.array(z.string()).optional(),
  add_node_ids: z.array(z.string()).optional(),
  is_update: z.boolean().optional(),
  layout_direction: z.enum(['LR', 'TB']).optional(),
  highlight_groups: z.array(PresentHighlightGroupSchema).optional(),
  sections: z.array(PresentSectionSchema).optional(),
  notes: z.array(PresentNoteSchema).optional(),
}).strict() satisfies z.ZodType<PresentResultInput>;

export const PRESENT_RESULT_REPAIR_FIELDS = [
  'name',
  'summary',
  'title',
  'intro',
  'closing',
  'layout_direction',
  'highlight_groups',
  'sections',
  'notes',
] as const;

export type PresentResultRepairField = typeof PRESENT_RESULT_REPAIR_FIELDS[number];

const PresentResultRepairPatchBaseSchema = PresentResultBoundarySchema
  .pick(Object.fromEntries(PRESENT_RESULT_REPAIR_FIELDS.map(field => [field, true])) as Record<PresentResultRepairField, true>)
  .partial()
  .extend({ repair: z.literal(true) })
  .strict();

/** Builds a strict patch schema exposing only fields authorized by the rejection. */
export function presentResultRepairPatchSchemaForFields(fields: readonly PresentResultRepairField[]) {
  const mask = Object.fromEntries([...new Set(fields)].map(field => [field, true]));
  return PresentResultRepairPatchBaseSchema.pick({
    ...mask,
    repair: true,
  } as Partial<Record<keyof typeof PresentResultRepairPatchBaseSchema.shape, true>>).strict();
}

/** Converts Zod issue paths into unique top-level repairable fields. */
export function presentResultRepairFieldsFromPaths(paths: readonly PropertyKey[][]): PresentResultRepairField[] {
  const allowed = new Set<string>(PRESENT_RESULT_REPAIR_FIELDS);
  return [...new Set(paths
    .map(path => String(path[0] ?? ''))
    .filter((field): field is PresentResultRepairField => allowed.has(field)))];
}

/**
 * The validated, engine-assembled result ready for the UI.
 *
 * @remarks
 * `description` here is the full markdown document built by {@link orderAndAssemble}
 * from the AI's input parts (title + intro + sections[] + closing). It is NOT a
 * passthrough of any AI-supplied field — the AI does not write the assembled
 * document.
 */
export type PresentResultRequest = {
  success: true;
  name: string;
  node_ids: string[];
  summary: string;
  description?: string;
  layout_direction: 'LR' | 'TB';
  highlight_groups: Array<{ label: string; color: AIHighlightRole; node_ids: string[] }>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; text: string }>;
};

export type PresentResultError = {
  success: false;
  errors: string[];
  hint: string;
  repair_fields?: PresentResultRepairField[];
  issue_paths?: string[];
};

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
export function normalizePresentSectionLabel(label: string): string {
  return (label ?? '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Counts visible words in a final section label for graph-badge UX limits. */
function countPresentSectionLabelWords(label: string): number {
  const normalized = (label ?? '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.split(/\s+/).length : 0;
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
  const stripLeadingNumber = (s: string) => (s ?? '').replace(/^\d+[\.]?\s+/, '').trim();

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
        .map(node => `[${node.name}](#focus-node:${node.id})`);
      if (links.length > 0) objectHeadings = `### Objects ${links.join(', ')}\n\n`;
    }
    parts.push(`## ${n} ${label}\n\n${objectHeadings}${text}`);
  }
  if (opts?.closing) parts.push(`---\n\n${opts.closing}`);

  return { badges: numberedBadges, description: parts.join('\n\n') };
}

/**
 * Normalizes and "auto-fixes" common AI output artifacts in the final presentation input.
 *
 * @remarks
 * LLMs often produce slightly malformed outputs such as double-escaped newlines
 * or excessive title lengths. This function applies surgical corrections to ensure
 * the final UI renders correctly while preserving authored markdown content.
 *
 * @param model - The database model.
 * @param input - The raw input from the AI.
 * @param resolvedNodeIds - The canonical set of node IDs in the current session.
 * @returns The fixed input object and a list of applied fixes for logging.
 */
export function autoFixPresentResult(
  model: DatabaseModel,
  input: PresentResultInput,
  resolvedNodeIds?: string[],
): { input: PresentResultInput; fixes: string[] } {
  const fixes: string[] = [];
  let fixed = { ...input };

  // 0. Unescape literal \n sequences (AI double-escapes newlines in JSON tool args),
  //    but never inside LaTeX math spans ($$…$$ / $…$): there a "\n…" is a control
  //    word (\not, \ne, \neq, \nabla, \ni, \nu, …) that must survive verbatim — a blind
  //    replace would collapse it to a newline and corrupt the formula.
  const MATH_SPAN = /\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g;
  const unescapeNewlines = (s: string): string => {
    let out = '';
    let last = 0;
    for (const m of s.matchAll(MATH_SPAN)) {
      const idx = m.index ?? 0;
      out += s.slice(last, idx).replace(/\\n/g, '\n'); // outside math → unescape
      out += m[0];                                     // inside math → verbatim
      last = idx + m[0].length;
    }
    return out + s.slice(last).replace(/\\n/g, '\n');
  };
  if (fixed.intro)    fixed = { ...fixed, intro:    unescapeNewlines(fixed.intro) };
  if (fixed.closing)  fixed = { ...fixed, closing:  unescapeNewlines(fixed.closing) };
  if (fixed.summary)  fixed = { ...fixed, summary:  unescapeNewlines(fixed.summary) };
  if (fixed.sections) fixed = { ...fixed, sections: fixed.sections.map(s => ({ ...s, text: s.text ? unescapeNewlines(s.text) : s.text })) };

  // 1. Auto-truncate name at word boundary if too long
  if (fixed.name && fixed.name.length > PRESENT_RESULT_NAME_MAX_LENGTH) {
    const truncated = fixed.name.slice(0, PRESENT_RESULT_NAME_MAX_LENGTH).replace(/\s+\S*$/, '').trimEnd();
    fixed = { ...fixed, name: truncated || fixed.name.slice(0, PRESENT_RESULT_NAME_MAX_LENGTH) };
    fixes.push(`Truncated name to ${PRESENT_RESULT_NAME_MAX_LENGTH} chars`);
  }

  // 2. Auto-truncate title at word boundary if too long
  if (fixed.title && fixed.title.trim().length > 80) {
    const truncated = fixed.title.slice(0, 80).replace(/\s+\S*$/, '').trimEnd();
    fixed = { ...fixed, title: truncated || fixed.title.slice(0, 80) };
    fixes.push('Truncated title to 80 chars');
  }

  // 3. Auto-truncate summary at sentence boundary if too long
  if (fixed.summary && fixed.summary.length > PRESENT_RESULT_SUMMARY_HARD_LIMIT) {
    const truncated = fixed.summary.slice(0, PRESENT_RESULT_SUMMARY_HARD_LIMIT);
    const lastPeriod = truncated.lastIndexOf('.');
    fixed = { ...fixed, summary: lastPeriod > 80 ? truncated.slice(0, lastPeriod + 1) : truncated.trimEnd() };
    fixes.push(`Truncated summary to ${PRESENT_RESULT_SUMMARY_HARD_LIMIT} chars`);
  }

  const nodeIdSet = new Set(resolvedNodeIds ?? []);

  // 5. Drop empty notes & notes for nodes not in the resolved set
  if (fixed.notes) {
    const before = fixed.notes.length;
    const filtered = fixed.notes.filter(n => nodeIdSet.has(n.node_id) && n.text && n.text.trim().length > 0);
    fixed = { ...fixed, notes: filtered };
    const dropped = before - filtered.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} empty or orphaned note(s)`);
  }

  // 6. Prune highlight_groups referencing nodes not in the resolved set
  if (fixed.highlight_groups) {
    const before = fixed.highlight_groups.length;
    const pruned = fixed.highlight_groups
      .map(g => ({ ...g, node_ids: g.node_ids.filter(id => nodeIdSet.has(id)) }))
      .filter(g => g.node_ids.length > 0);
    fixed = { ...fixed, highlight_groups: pruned };
    const dropped = before - pruned.length;
    if (dropped > 0) fixes.push(`Dropped ${dropped} orphaned highlight group(s)`);
  }

  return { input: fixed, fixes };
}

/**
 * Validates markdown structural integrity.
 *
 * @remarks
 * This function performs a pass to ensure that markdown elements (specifically code fences)
 * are properly closed. It prevents the UI from crashing or entering a broken state due to
 * malformed markdown generated by the AI.
 *
 * @param md - The markdown string to validate.
 * @returns A list of error strings, or an empty array if valid.
 */
export function validateMarkdownFormat(md: string): string[] {
  const errors: string[] = [];

  // Reject unclosed fenced blocks (walk lines, track open/close state)
  let insideFence = false;
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!insideFence && trimmed.startsWith('```')) {
      insideFence = true;
    } else if (insideFence && trimmed === '```') {
      insideFence = false;
    }
  }
  if (insideFence) {
    errors.push(
      'unclosed fenced block detected — a section body or assembled output is missing a closing ```',
    );
  }

  return errors;
}

/**
 * Validates the full `present_result` input against mechanical contracts only.
 *
 * @remarks
 * Enforces naming length, summary length, sections[] presence, node-id resolution,
 * final section label/text cardinality, and markdown-fence closure on the
 * engine-assembled description.
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
 * @param input - The (possibly auto-fixed) AI input.
 * @param resolvedNodeIds - The canonical set of node IDs.
 * @param assembledBadges - Pre-assembled numbered badges for consistency.
 * @param assembledDescription - Engine-built markdown blob from {@link orderAndAssemble}.
 * @returns A successful request object or a structured error with correction hints.
 */
export function validatePresentResult(
  input: PresentResultInput,
  resolvedNodeIds: string[],
  assembledBadges?: Array<{ node_id: string; text: string }>,
  assembledDescription?: string,
): PresentResultRequest | PresentResultError {
  const errors: string[] = [];

  // Name validation
  if (!input.name || input.name.trim().length === 0) errors.push('name is required');
  else if (input.name.length > PRESENT_RESULT_NAME_MAX_LENGTH) errors.push(`name exceeds ${PRESENT_RESULT_NAME_MAX_LENGTH} characters`);

  // Node set must be non-empty (after resolve + prune)
  if (resolvedNodeIds.length === 0) {
    errors.push('No nodes in view — the result graph is empty or all nodes were pruned');
  }

  if (input.title && input.title.trim().length > 80) errors.push('title exceeds 80 characters');

  // summary required + length
  if (!input.summary || input.summary.trim().length === 0) {
    errors.push(`summary is required — one-line graph purpose (~120 chars, max ${PRESENT_RESULT_SUMMARY_HARD_LIMIT})`);
  } else if (input.summary.length > PRESENT_RESULT_SUMMARY_HARD_LIMIT) {
    errors.push(`summary exceeds hard limit (${PRESENT_RESULT_SUMMARY_HARD_LIMIT} chars) — aim for ~120 chars`);
  }

  const hasSections = !!(input.sections && input.sections.length > 0);
  const hasAssembled = !!(assembledDescription && assembledDescription.trim().length > 0);

  // Either AI submitted sections[] (which the engine assembles into a description before
  // validation) OR an engine-assembled description is supplied. Without one, there's no body.
  if (!hasSections && !hasAssembled) {
    errors.push('sections[] is required — provide at least one section with label and text; node_ids[] is optional.');
  }

  // Mechanical fence-closure check on the engine-assembled blob (catches cases where
  // a slot body had an unclosed ``` that survived the autoFix pass).
  if (hasAssembled) {
    errors.push(...validateMarkdownFormat(assembledDescription!));
  }

  // Sections validation — final labels/text are 1:1 and mandatory; node links are optional.
  if (hasSections) {
    const resolvedSet = new Set(resolvedNodeIds);
    const labels = new Set<string>();
    const nodeToSectionLabel = new Map<string, string>();
    for (const sec of input.sections!) {
      const label = (sec.label ?? '').replace(/^\d+[\.]?\s+/, '').replace(/\s+/g, ' ').trim();
      const normalizedLabel = normalizePresentSectionLabel(sec.label);
      if (!label) {
        errors.push('Section label is required — provide a short final label for this detail section');
      } else {
        const labelWords = countPresentSectionLabelWords(label);
        if (labelWords > 3) {
          errors.push(`Section "${label}" label exceeds 3 words — use a short graph pointer`);
        }
        if (labels.has(normalizedLabel)) {
          errors.push(`Duplicate section label "${label}" — each final label must map to exactly one section text`);
        }
        labels.add(normalizedLabel);
      }
      if (sec.node_ids?.length) {
        const unknownIds = sec.node_ids.filter(id => !resolvedSet.has(id));
        if (unknownIds.length > 0) {
          errors.push(`Section "${sec.label}" node_ids contains unknown IDs: ${unknownIds.slice(0, 3).join(', ')}${unknownIds.length > 3 ? ' ...' : ''} — ${SECTION_NODE_ID_HINT}`);
        }
        for (const nodeId of sec.node_ids.filter(id => resolvedSet.has(id))) {
          const existingLabel = nodeToSectionLabel.get(nodeId);
          if (existingLabel && existingLabel !== normalizedLabel) {
            errors.push(`Node "${nodeId}" is linked to multiple section labels — each node may point to at most one final section`);
            continue;
          }
          nodeToSectionLabel.set(nodeId, normalizedLabel);
        }
      }
      if (!sec.text || sec.text.trim().length === 0) {
        errors.push(`Section "${sec.label}" is missing text — every final section label requires one detail body`);
      }
      if (sec.text) errors.push(...validateMarkdownFormat(sec.text).map(e => `Section "${sec.label}": ${e}`));
    }
  }

  // Notes validation
  if (input.notes?.length) {
    for (const note of input.notes) {
      if (!note.text || note.text.trim().length === 0) {
        errors.push(`Note for "${note.node_id}" is missing text`);
      }
    }
  }

  // highlight_groups validation — required for new renders; optional for is_update text edits
  if (!input.highlight_groups || input.highlight_groups.length === 0) {
    if (!input.is_update) {
      errors.push('highlight_groups[] is required — provide at least 1 group using the Lineage palette (source / transform / target)');
    }
  } else {
    if (input.highlight_groups.length > 5) errors.push('highlight_groups exceeds maximum of 5');
    for (const g of input.highlight_groups) {
      if (!g.label) errors.push('Group label is required');
      if (!AI_HIGHLIGHT_ROLES.has(g.color)) errors.push(`Group "${g.label}" has invalid role "${g.color}"`);
    }
  }

  if (errors.length > 0) {
    // Identify which fields failed so the hint tells the AI exactly what to fix
    const failedFields = new Set<string>();
    for (const e of errors) {
      if (e.startsWith('name ') || e.startsWith('name exceeds')) failedFields.add('name');
      else if (e.startsWith('title ')) failedFields.add('title');
      else if (e.startsWith('closing ')) failedFields.add('closing');
      else if (e.includes('summary')) failedFields.add('summary');
      else if (e.includes('section') || e.startsWith('Section ') || e.startsWith('Duplicate section')) failedFields.add('sections');
      else if (e.startsWith('Note for ')) failedFields.add('notes');
      else if (e.includes('highlight_groups') || e.startsWith('Group ')) failedFields.add('highlight_groups');
      else if (e.includes('No nodes')) failedFields.add('nodes');
    }
    const fieldList = [...failedFields];
    let hint = fieldList.length === 1
      ? `Fix ${fieldList[0]} only. Keep all other fields (notes, summary, highlight_groups) exactly as submitted.`
      : `Fix these fields: ${fieldList.join(', ')}. Keep all other fields exactly as submitted.`;
    if (failedFields.has('sections')) {
      hint = `${hint} ${SECTION_NODE_ID_HINT}`;
    }
    return { success: false, errors, hint, repair_fields: fieldList.filter((field): field is PresentResultRepairField => PRESENT_RESULT_REPAIR_FIELDS.includes(field as PresentResultRepairField)) };
  }

  return {
    success: true,
    name: input.name.trim(),
    node_ids: resolvedNodeIds,
    summary: input.summary,
    description: assembledDescription,
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

/**
 * Structural summary of the final presentation result.
 */
export interface PresentResultResult {
  /** True when the request passed validation and was posted to the webview. */
  success: boolean;
  /** Display name of the rendered AI view (≤200 chars after auto-fix). */
  name: string;
  /** One-line graph-card summary (≤300 chars) shown beside the view. */
  summary: string;
  /** Engine-assembled markdown blob from `orderAndAssemble`; absent when the AI submitted no `sections[]`. */
  description?: string;
  /** Count of nodes included in the rendered view after add/prune resolution. */
  node_count: number;
}
