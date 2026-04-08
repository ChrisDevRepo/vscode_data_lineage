/**
 * Composable prompt building blocks for state-machine modes.
 *
 * Each SM type (BB, CT, CT_DEP) assembles its mode prompt from shared blocks.
 * Single source of truth — change a rule once, all modes inherit it.
 *
 * See ai/prompt-changelog.md for change history.
 */

// ─── Shared Building Blocks ─────────────────────────────────────────────────

const BLOCK = {
  /** Step 1 — every hop starts with DDL/column analysis */
  readDdl:
    'Read the focus node DDL/columns carefully.',

  /** Step 2 — record detailed findings (→ detail memory slot) */
  writeFindings:
    'Record detailed findings (~500 chars) — business rules, transforms, column mappings, patterns you discovered.' +
    ' These are stored in detail memory and available at synthesis.',

  /** Step 3 — one-line summary (→ short memory, visible every hop) */
  writeSummary:
    'Write a one-line summary (~100 chars) — shown in your short memory for ALL future hops.',

  /** Step 4 — semantic badge + note caption for enrich_view */
  badgeAndNote:
    'badge_label (2-4 words): semantic label for the view, e.g. "Source", "ETL", "Staging".\n' +
    'note_caption (1 line): what this node does in this flow, e.g. "Entry point — TRUNCATEs from staging".',

  /** Self-ask — answer your own question from the previous hop */
  selfAsk:
    'The sub_question/current_task field contains your own question from a previous hop — answer it.',

  /** Verdict neighbors — shared by CT and CT_DEP */
  verdictNeighbors:
    'Verdict each neighbor: trace (follow this path), prune (cut), or pass (skip detail).\n' +
    'Submit a verdict for every neighbor — skipped neighbors are silently lost.',

  /** Column tracking — CT only */
  columnTracking:
    'COLUMN TRACKING: trace INPUT column names, not output. Track renames across hops.\n' +
    'SELECTIVITY: Trace only columns relevant to the question. Prune unrelated branches.\n' +
    'Prefer trace over prune when uncertain.',

  /** Revisit — CT and CT_DEP */
  revisit:
    'If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3).',

  /** Field mapping — CT only */
  fieldMapping:
    'FIELD MAPPING: focus_node_id = focus_node.id from the hop context. neighbor_id = id field from each neighbor.',

  /** Scope tiers — BB only */
  scopeTiers:
    'NEIGHBOR SCOPE — evaluate ALL neighbors, then act per tier:\n' +
    '- scope=in_scope: on your agenda — will be visited. Can prune via prune_ids.\n' +
    '- scope=available + in_filter=true: in model but not on agenda — add via add_ids if relevant\n' +
    '- scope=available + in_filter=false: in model but outside user filter — ask user: "Schema X has relevant objects, should I include it?"\n' +
    '- scope=external: referenced in DDL but not in loaded model — note as external reference in findings\n' +
    '- scope=visited/pruned: already processed\n' +
    'prune_ids only works on scope=in_scope. add_ids only works on scope=available.',

  /** Progress line — BB only */
  progress:
    'After each submit_findings call, emit ONE line: "Hop N · [node_name] → verdict · ~Y nodes remaining".',

  /** Early completion — BB only */
  earlyComplete:
    'Set complete:true when you can answer the question. Visit all relevant nodes — do not skip nodes to finish faster.',

  /** Working memory usage — BB only */
  workingMemory:
    'Your working memory shows ALL summaries and ALL pending questions — use them to stay on track.\n' +
    'invalid_nodes: never ask about not_in_model nodes; use get_object_detail for out_of_scope.',

  /** Detail memory at synthesis */
  detailMemory:
    'At completion, your detail memory slots are returned with your findings per node.\n' +
    'Use these to write enrich_view sections — they replace raw DDL. Reference specific findings, not general impressions.',
} as const;

// ─── Mode Prompts (composed from blocks) ────────────────────────────────────

/** BB — free exploration with agenda */
export function buildBbPrompt(): string {
  return [
    'EXPLORATION MODE: The state machine presents nodes one at a time with full DDL and metadata.',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.writeSummary}`,
    `4. ${BLOCK.badgeAndNote}`,
    `5. Generate sub-questions for neighbors you want to investigate (boosts their priority).`,
    `6. prune_ids: remove from agenda (scope=in_scope only). add_ids: add to agenda (scope=available).`,
    '',
    BLOCK.scopeTiers,
    '',
    BLOCK.selfAsk,
    BLOCK.progress,
    BLOCK.earlyComplete,
    BLOCK.workingMemory,
    BLOCK.detailMemory,
  ].join('\n');
}

/** CT — column trace with frontier queue */
export function buildCtPrompt(): string {
  return [
    'COLUMN TRACE MODE: For each hop, analyze the focus node.',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.writeSummary}`,
    `4. ${BLOCK.badgeAndNote}`,
    `5. ${BLOCK.verdictNeighbors}`,
    '',
    BLOCK.columnTracking,
    BLOCK.revisit,
    BLOCK.fieldMapping,
    BLOCK.selfAsk,
    BLOCK.detailMemory,
  ].join('\n');
}

/** CT_DEP — dependency trace (no column tracking) */
export function buildCtDepPrompt(): string {
  return [
    'DEPENDENCY TRACE MODE: For each hop, analyze the focus node.',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.writeSummary}`,
    `4. ${BLOCK.badgeAndNote}`,
    `5. ${BLOCK.verdictNeighbors}`,
    '',
    BLOCK.revisit,
    BLOCK.selfAsk,
    BLOCK.detailMemory,
  ].join('\n');
}
