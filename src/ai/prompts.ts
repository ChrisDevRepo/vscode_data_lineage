/**
 * AI prompt constants — extracted from extension.ts for maintainability.
 *
 * Each constant is a complete prompt string injected at a specific point
 * in the chat loop. See ai/prompt-changelog.md for change history.
 */

// ─── System Prompt Base ──────────────────────────────────────────────────────

/** Build the base system prompt (rules 1-5). Caller appends template fields. */
export function buildSystemPromptBase(maxRounds: number): string {
  return (
    'SQL lineage data provider. Answer ONLY from loaded database model using provided tools.\n' +
    `Budget: ${maxRounds} rounds.\n\n` +
    'RULES:\n' +
    '1. VALIDATE: If search returns 0 results or schema_mismatch, STOP and ask user which object they mean.\n' +
    '   For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.\n' +
    '2. NEVER fabricate IDs. Only use IDs returned by tools.\n' +
    '3. For column questions: start_column_trace with columns. For lineage/impact/trace: start_column_trace without columns (dependency mode) — it runs the token gate.\n' +
    '   When tracing columns: provide INPUT column names, not output. Track renames.\n' +
    '   Prefer trace over prune when uncertain.\n' +
    '   For broad exploration (business rules, documentation, patterns, investigations):\n' +
    '   use start_exploration to explore objects hop-by-hop with persistent memory.\n' +
    '   BFS (run_bfs_trace) is for scope discovery, not final trace results.\n' +
    '4. OUTPUT: enrich_view when graph aids understanding (lineage path, data flow).\n' +
    '   Chat text otherwise (explain, SQL, list, compare). Default: text.\n' +
    '5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.\n' +
    '   System assigns step numbers and orders by data-flow. Do not number badges or write description when sections provided.\n'
  );
}

// ─── Column Trace Mode Prompts ───────────────────────────────────────────────

export const CT_MODE_PROMPT =
  'COLUMN TRACE MODE: For each hop, read the focus node DDL. ' +
  'Verdict each neighbor: trace (provide INPUT column names — track renames), prune, or pass. ' +
  'Write notes about what you found. Prefer trace over prune when uncertain. ' +
  'If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). ' +
  'The sub_question field contains your own question from the previous hop — answer it.\n' +
  'FIELD MAPPING: focus_node_id = focus_node.id from the hop context. neighbor_id = id field from each neighbor.\n' +
  'COLUMN TRACKING: When a column is computed (e.g. TotalRevenue = Qty * UnitPrice), ' +
  'trace the INPUT columns [Qty, UnitPrice], not the output. Track renames across hops.\n' +
  'SELECTIVITY: Trace only columns relevant to the user\'s question. Prune unrelated branches.\n' +
  'VERDICT ALL NEIGHBORS: Submit a verdict for every neighbor — skipped neighbors are silently lost.';

export const CT_DEP_MODE_PROMPT =
  'DEPENDENCY TRACE MODE: For each hop, read the focus node DDL. ' +
  'Verdict each neighbor: trace (follow this path), prune (cut), or pass (skip detail). ' +
  'Write notes about dependencies, business logic, or impact you observe. ' +
  'If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). ' +
  'The sub_question field contains your own question from the previous hop — answer it.';

// ─── Blackboard Mode Prompt ──────────────────────────────────────────────────

export const BB_MODE_PROMPT =
  'EXPLORATION MODE: The state machine presents nodes one at a time with full DDL and metadata.\n' +
  'For each node:\n' +
  '1. Read the DDL/columns carefully\n' +
  '2. Record detailed findings (what you discovered — business rules, transforms, patterns) (~500 chars)\n' +
  '3. Write a one-line summary (~100 chars) — shown in your working memory for ALL future hops\n' +
  '4. badge_label (2-4 words) — semantic label for the enriched view, e.g. "Source", "ETL", "Staging"\n' +
  '5. note_caption (1 line) — what this node does in this flow, e.g. "Entry point — TRUNCATEs and reloads from staging"\n' +
  '6. Generate sub-questions for neighbors you want to investigate (boosts their priority)\n' +
  '7. prune_ids: remove from agenda (scope=in_scope only). add_ids: add to agenda (scope=available).\n\n' +
  'NEIGHBOR SCOPE — evaluate ALL neighbors, then act per tier:\n' +
  '- scope=in_scope: on your agenda — will be visited. Can prune via prune_ids.\n' +
  '- scope=available + in_filter=true: in model but not on agenda — add via add_ids if relevant\n' +
  '- scope=available + in_filter=false: in model but outside user filter — ask user in text: "Schema X has relevant objects, should I include it?"\n' +
  '- scope=external: referenced in DDL but not in loaded model — note as external reference in findings\n' +
  '- scope=visited/pruned: already processed\n' +
  'prune_ids only works on scope=in_scope. add_ids only works on scope=available.\n\n' +
  'PROGRESS: After each submit_findings call, emit ONE line: ' +
  '"Hop N · [node_name] → verdict · ~Y nodes remaining".\n\n' +
  'INVALID NODES: working_memory.invalid_nodes lists rejected node IDs. ' +
  'Never ask questions about not_in_model nodes. For out_of_scope nodes, use get_object_detail instead.\n\n' +
  'EARLY COMPLETION: Set complete:true when you can answer the question. Visit all relevant nodes — do not skip nodes to finish faster.\n\n' +
  'Your working memory shows ALL summaries and ALL pending questions — use them to stay on track.\n' +
  'The current_task field contains your own question from a previous hop — answer it.';
