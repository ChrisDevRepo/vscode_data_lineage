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

  /** Node classification — shared concept across all SM types */
  verdictCategories:
    'NODE CLASSIFICATION (three categories):\n' +
    '- relevant (BB) / trace (CT): node has business logic, transforms, or answers the question → full analysis + badge_label\n' +
    '- pass: node is in the path but no transforms (SELECT *, staging, identity view) → summary only, no badge_label\n' +
    '- irrelevant (BB) / prune (CT): node has no connection to the question → removed from graph',

  /** Step 2 — record detailed findings (→ detail memory slot) */
  writeFindings:
    'Write findings to detail memory — depth depends on classification:\n' +
    '- relevant/trace → full analysis (300-1500 chars, hard limit 5000). Self-contained, usable at synthesis.\n' +
    '  Extract by aspect (include only those present):\n' +
    '  COLUMNS: key column names and roles (verbatim from DDL)\n' +
    '  TRANSFORMS: expressions, CASE/COALESCE, computed columns (quote the SQL fragment)\n' +
    '  JOINS: join conditions (table.col = table.col)\n' +
    '  FILTERS: WHERE/HAVING business rules\n' +
    '  DATA FLOW: how data enters and leaves this node (INSERT/SELECT/MERGE/EXEC/dynamic SQL)\n' +
    '  QUESTION RELEVANCE: how this node answers the user question\n' +
    '  Quote SQL verbatim — paraphrases lose grounding.\n' +
    '- pass → summary only (~100-200 chars): what passes through, from where to where.\n' +
    '- irrelevant/prune → brief summary only.',

  /** Step 3 — semantic badge + note caption (also used for short memory) */
  badgeAndNote:
    'badge_label (2-4 words): semantic ROLE label, e.g. "Source", "Transform", "Staging", "Output", "Validation", "Aggregation".\n' +
    'SELECTIVITY: Only assign badge_label to nodes with distinct functional roles. ' +
    'Passthrough nodes (SELECT *, simple staging, lookup joins) — skip badge_label, they will be mentioned in section text.\n' +
    'GROUPING: Nodes that serve the same role should get the same badge_label (e.g. two source tables → both "Source").\n' +
    'note_caption (~100-200 chars): stored in short memory, visible every future hop. ' +
    'The SM auto-adds which neighbors you traced/pruned — do not repeat that. ' +
    'Write your REASONING: what you learned, what it means for the question, what is still open.',

  /** Self-ask — answer your own question from the previous hop */
  selfAsk:
    'The sub_question/current_task field contains your own question from a previous hop — answer it.',

  /** Verdict neighbors — shared by CT and CT_DEP */
  verdictNeighbors:
    'Verdict each neighbor: trace (has logic, follow with columns), pass (no transforms, revisited as lightweight hop), prune (irrelevant, cut).\n' +
    'Pass nodes appear as focus hops — verdict their neighbors to control which paths continue.\n' +
    'Submit a verdict for every neighbor — skipped neighbors are silently lost.',

  /** Column tracking — CT only */
  columnTracking:
    'COLUMN TRACKING: columns in verdicts must be the names AS THEY APPEAR in the neighbor, not the output alias in the current node.\n' +
    'Read the current node DDL to find the source column reference: SELECT neighbor.SourceCol AS OutputAlias → trace SourceCol into that neighbor.\n' +
    'Track renames across hops — each hop may use a different name for the same data.\n' +
    'SELECTIVITY: Trace only columns relevant to the question. Prune unrelated branches.\n' +
    'When uncertain whether a column carries value to the target: trace. When a column only controls selection: prune.',

  /** Column lineage rule — CT column mode only */
  columnLineageRule:
    'COLUMN LINEAGE RULE: Read the SELECT expression that produces the target column in the DDL. ' +
    'Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. ' +
    'Prune columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. ' +
    'Multi-input formulas: trace ALL inputs — omitting one branch produces incomplete lineage. ' +
    'Classify each column reference: does it contribute VALUE to the output, or does it only control SELECTION ' +
    '(which row, which branch, whether NULL)? Trace value contributors. Prune selection-only references. ' +
    'When ALL output branches for a condition produce only literals (constants, not column references), ' +
    'the condition column is selection-only — do not trace it upstream for value lineage.',

  /** Table node guidance — CT (column + dep) */
  tableNodes:
    'TABLE NODES: Tables store data, not transform it — verdict the table itself as pass (no badge). Trace ALL upstream neighbors to find the writers.',

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
    'After each submit_findings call, emit ONE line: "Hop N · [node_name] → verdict (visited X of S)".',

  /** Early completion — BB only */
  earlyComplete:
    'Set complete:true when you can answer the question. Visit all relevant nodes — do not skip nodes to finish faster.',

  /** Working memory usage — BB only */
  workingMemory:
    'Your working memory shows ALL summaries and ALL pending questions — use them to stay on track.\n' +
    'INVALID NODES: working_memory.invalid_nodes lists rejected node IDs. ' +
    'Never ask questions about not_in_model nodes. For out_of_scope nodes, use get_object_detail instead.',

  /** Detail memory at synthesis — grounding contract */
  detailMemory:
    'SYNTHESIS GROUNDING CONTRACT:\n' +
    'At completion, your detail memory slots are returned — one per visited node, always at full fidelity.\n' +
    'These are your ONLY evidence for writing enrich_view. Raw DDL is NOT re-delivered.\n' +
    'Rules:\n' +
    '- Every claim must cite a detail slot (node name + quoted SQL evidence from your findings)\n' +
    '- If a slot lacks evidence for a claim, omit the claim — do not invent\n' +
    '- Group nodes by role in answering the question, not by schema\n' +
    '- If detail memory is insufficient for a node, use get_object_detail to re-read its DDL\n' +
    'suggested_sections groups your badge_labels into sections ordered by dependency depth.\n' +
    'Use suggested_sections as your section skeleton for enrich_view: keep the grouping and order, ' +
    'adjust labels if needed, and write text per section from your detail memory findings.',
} as const;

// ─── Mode Prompts (composed from blocks) ────────────────────────────────────

/** BB — free exploration with agenda */
export function buildBbPrompt(): string {
  return [
    'EXPLORATION MODE: The state machine presents nodes one at a time with full DDL and metadata.',
    '',
    BLOCK.verdictCategories,
    '',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    `4. Generate sub-questions for neighbors you want to investigate (boosts their priority).`,
    `5. prune_ids: remove from agenda (scope=in_scope only). add_ids: add to agenda (scope=available).`,
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
    '',
    BLOCK.verdictCategories,
    '',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    `4. ${BLOCK.verdictNeighbors}`,
    '',
    BLOCK.columnTracking,
    BLOCK.columnLineageRule,
    BLOCK.tableNodes,
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
    '',
    BLOCK.verdictCategories,
    '',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    `4. ${BLOCK.verdictNeighbors}`,
    '',
    BLOCK.tableNodes,
    BLOCK.revisit,
    BLOCK.fieldMapping,
    BLOCK.selfAsk,
    BLOCK.detailMemory,
  ].join('\n');
}
