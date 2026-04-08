/**
 * AI prompt strings — shared between extension.ts and test-internal/ai-test-server.ts.
 *
 * Keep in sync with the system prompt surfaces documented in CLAUDE.md.
 * These are the static parts only. Dynamic parts (schema context injection,
 * aiOutputTemplates values) are assembled by the callers.
 */

/**
 * Base system prompt rules (static). Callers prepend schema context and append
 * aiOutputTemplates values.
 *
 * @param maxRounds - Round budget to inject into rule 1 (extension uses getConfiguration,
 *                    bridge server uses a fixed value).
 */
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
    '   Chat text for: pure explanations, SQL generation, list/compare requests (no graph needed).\n' +
    '5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.\n' +
    '   System numbers sections in YOUR sections[] order. Write sections in the narrative sequence you want the reader to follow. Do not number badges yourself or write description when sections are provided.\n' +
    'PROGRESS: After each hop verdict, emit ONE line: "Hop N · [node_name] → verdict · ~Y remaining".\n'
    // Callers append: summary/badges/sections/notes/highlights/description from aiOutputTemplates
  );
}

/**
 * CT mode prompt — shared between column trace (Type 3) and dependency trace (Type 2).
 * Injected once as a User message on ct_active transition.
 *
 * Structure:
 *   modeHead   — mode name + verdict syntax + mode-specific guidance (branches on hasColumns)
 *   shared     — revisit/sub_question, FIELD MAPPING, TABLE NODES, VERDICT ALL NEIGHBORS
 *   columnRule — COLUMN LINEAGE RULE (hasColumns only; empty string for dependency mode)
 *
 * Net text vs previous two constants:
 *   hasColumns=true  → identical output to old CT_MODE_PROMPT (zero change)
 *   hasColumns=false → old CT_DEP_MODE_PROMPT + FIELD MAPPING + TABLE NODES + VERDICT ALL NEIGHBORS
 */
export function buildCtModePrompt(hasColumns: boolean): string {
  const modeHead = hasColumns
    ? 'COLUMN TRACE MODE: For each hop, read the focus node DDL. ' +
      'Verdict each neighbor: trace (provide INPUT column names — track renames), prune, or pass. ' +
      'Write notes about what you found. Prefer trace over prune when uncertain. '
    : 'DEPENDENCY TRACE MODE: For each hop, read the focus node DDL. ' +
      'Verdict each neighbor: trace (follow this path), prune (cut), or pass (skip detail). ' +
      'Write notes about dependencies, business logic, or impact you observe. ';

  const columnRule = hasColumns
    ? 'COLUMN LINEAGE RULE: Read the SELECT expression that produces the target column in the DDL. ' +
      'Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. ' +
      'Prune columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. ' +
      'Multi-input formulas: trace ALL inputs — omitting one branch produces incomplete lineage. When uncertain whether a column computes the value or routes rows: trace.\n'
    : '';

  return (
    modeHead +
    'If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). ' +
    'The sub_question field contains your own question from the previous hop — answer it.\n' +
    'FIELD MAPPING: focus_node_id = focus_node.id from the hop context. neighbor_id = id field from each neighbor.\n' +
    columnRule +
    'TABLE NODES: Tables store data, not transform it. Trace ALL upstream neighbors of a table — they INSERT INTO it.\n' +
    'VERDICT ALL NEIGHBORS: Submit a verdict for every neighbor — skipped neighbors are silently lost.'
  );
}

/** Blackboard exploration mode prompt (Type 1). Injected once on bb_active transition. */
export const BB_MODE_PROMPT =
  'EXPLORATION MODE: The state machine presents nodes one at a time with full DDL and metadata.\n' +
  'For each node:\n' +
  '1. Read the DDL/columns carefully\n' +
  '2. Record detailed findings (what you discovered — business rules, transforms, patterns) (~500 chars)\n' +
  '3. Write a one-line summary (~100 chars) — shown in your working memory for ALL future hops\n' +
  '4. badge_label (2-4 words, no leading number) — semantic label for the enriched view, e.g. "Source", "ETL", "Staging"\n' +
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
  'INVALID NODES: working_memory.invalid_nodes lists rejected node IDs. ' +
  'Never ask questions about not_in_model nodes. For out_of_scope nodes, use get_object_detail instead.\n\n' +
  'EARLY COMPLETION: Set complete:true when you can answer the question. Visit all relevant nodes — do not skip nodes to finish faster.\n\n' +
  'Your working memory shows ALL summaries and ALL pending questions — use them to stay on track.\n' +
  'The current_task field contains your own question from a previous hop — answer it.';

/** Blackboard documentation mode prompt. Injected once on bb_active transition when _isDocMode is set.
 *  AI only analyzes DDL of SPs/Views/UDFs — tables and external tables are auto-noted by the SM.
 */
export const BB_DOC_MODE_PROMPT =
  'DOCUMENTATION MODE: Generate structured Data Object & Lineage documentation.\n' +
  'The state machine delivers one non-table object at a time with full DDL.\n' +
  'Tables and external tables are handled automatically — if any appear in the agenda, prune them.\n\n' +
  'For each node write your `findings` as markdown with these sections (adapt per type):\n\n' +
  'STORED PROCEDURE:\n' +
  '## Schema Layer\n' +
  '(Bronze — Raw / Silver — Cleansed / Gold — Aggregated, or custom layer name)\n' +
  '## Transformation & Loading\n' +
  '- **Load Pattern**: Full Reload / Insert-Truncate / Merge (Upsert) / SCD Type 2 / Append-Only\n' +
  '- **Watermark Logic**: exact WHERE condition or "None — full reload"\n' +
  '- **Side Effects**: temp tables dropped, external calls, downstream refreshes (or "None")\n' +
  '- **Determinism**: Yes / No + reason (e.g. "uses GETDATE()")\n' +
  '## Business Logic\n' +
  '(grain, key filters, calculated columns in plain English)\n' +
  '## Known Issues / Notices\n' +
  '**Short Summary**: 1–2 sentences\n\n' +
  'VIEW:\n' +
  '## Schema Layer\n' +
  '## Business Logic\n' +
  '- **Grain**: what constitutes one row\n' +
  '- **Filters**: key WHERE conditions in plain English\n' +
  '- **Calculated Columns**: Name = formula (plain English)\n' +
  '## Known Issues / Notices\n' +
  '**Short Summary**: 1–2 sentences\n\n' +
  'FUNCTION (UDF / TVF):\n' +
  '## Schema Layer\n' +
  '## Returns\n' +
  '## Business Logic\n' +
  '## Determinism\n' +
  '**Short Summary**: 1–2 sentences\n\n' +
  'badge_label = schema layer name (Bronze / Silver / Gold)\n' +
  'note_caption = one-line role description\n' +
  'verdict = relevant';
