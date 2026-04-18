/**
 * Mode-scoped prompts for the navigation engine.
 *
 * @remarks
 * Composed from shared blocks so guidance that applies to every mode stays in one place.
 * Framing matches the VS Code chat-participant convention: the state machine is a tool the
 * model calls; the model is a domain responder, not a persistent agent. Keep the prompts
 * focused on the task (analyze the focus node, write the archive, route neighbors) — the
 * engine handles completion, cascade-prune, and memory delivery.
 */

import type { SmMode } from './smTypes';


const BLOCK = {
  /** Step 1 — every hop starts with DDL/column analysis. */
  readDdl:
    'Read the focus node DDL/columns carefully.',

  /** Node classification shared across all modes. */
  verdictCategories:
    'NODE CLASSIFICATION (three categories):\n' +
    '- relevant (BB) / trace (CT): node has business logic, transforms, or answers the question → full analysis + badge_label.\n' +
    '- pass: node is in the path but no transforms (SELECT *, staging, identity view, variant sibling of an archetype) → summary only, no badge_label.\n' +
    '- irrelevant (BB) / prune (CT): utility, logging, or helpers with no domain meaning → cascade-pruned from the graph.',

  /** Step 2 — write the detail archive for this node. */
  writeFindings:
    'Write `detail_analysis` for the focus node. The archive preserves your analysis verbatim — no upper bound; synthesis uses this as sole evidence. Self-contained — written to answer the user\'s question. Aim ≥ 800 chars per relevant node; a thin slot produces thin synthesis.\n' +
    'CLASSIFY the question — this drives findings depth:\n' +
    '  WHAT the data means → lead with business meaning: formulas in LaTeX math syntax, column renames as | From | To | Business meaning | table, what each value represents, which consumers are affected.\n' +
    '  HOW the pipeline runs → lead with execution: join strategies, loading patterns, constraints, rebuild order.\n' +
    '  For blended questions: combine both — business meaning first.\n' +
    'FORMAT to fit content:\n' +
    '  Column rename or mapping → | From | To | Notes | table.\n' +
    '  Formula → LaTeX math syntax.\n' +
    '  Multi-step logic → ordered 1. 2. 3. list.\n' +
    '  Risk or data quality → ⚠️ prefix.\n' +
    'Name every column and expression explicitly — never "various columns" or "certain conditions". Quote SQL verbatim and explain in business terms.\n' +
    'BAD: "COLUMNS: OrderID (int PK), Qty (decimal), UnitPrice (money)"\n' +
    'GOOD: "`spCalcRevenue` computes TotalRevenue = Qty × UnitPrice at INSERT. Reads Qty from staging (rename OrderQty → Qty), UnitPrice from price view (PriceMaster lookup).\\n| Source | Column | Transform | Output |\\n| FactOrders | OrderQty | rename | Qty |\\n| PriceMaster | ListPrice | markup formula | UnitPrice |"\n' +
    'When the question shape is unclear, fall back to covering each aspect present:\n' +
    '  COLUMNS: key column names, types, constraints (PK/FK/nullable).\n' +
    '  TRANSFORMS: expressions, CASE/COALESCE, computed columns — quote the SQL fragment.\n' +
    '  JOINS: join conditions (table.col = table.col).\n' +
    '  FILTERS: WHERE/HAVING business rules.\n' +
    '  DATA FLOW: how data enters and leaves (INSERT/UPDATE/MERGE/DELETE/EXEC). Note the loading pattern as present in the DDL (full refresh / incremental / merge / CDC / SCD, etc.).\n' +
    '  QUESTION RELEVANCE: how this node answers the user question.\n' +
    '  OBSERVATIONS: DDL comments, version annotations, performance risks, anti-patterns.\n' +
    '- pass → `summary` only: what passes through, from where to where.\n' +
    '- irrelevant → brief `summary` only.\n' +
    'Also write a specific one-line `summary` for this hop — it carries forward to future hops via working_memory.all_summaries. Specific > short.',

  /** Badge + note metadata drive the graph UI. */
  badgeAndNote:
    'badge_label (2-4 words): semantic ROLE tag — e.g. "Source", "Transform", "Staging", "Output", "Validation", "Aggregation".\n' +
    'SELECTIVITY: only assign badge_label to nodes with distinct functional roles. Passthrough nodes skip it.\n' +
    'GROUPING: nodes that serve the same role should get the same badge_label (e.g. two source tables → both "Source").\n' +
    'note_caption (~100-200 chars): one-line what-this-does. Write the REASONING — what you learned, what it means for the question, what is still open.',

  /** Self-ask — the sub-question is a lens; the main user question is the anchor. */
  selfAsk:
    'The `current_task` field narrows this hop\'s attention. Anchor every verdict and every detail slot on `working_memory.user_question` (the user\'s original request) — relevance is judged against the main question, not the sub-question. If answering the sub-question produces material that does not serve the main question, omit it.',

  /** Route grounding — shared. */
  routing:
    'ROUTING: every entry in `route_requests` carries a focused sub-question — anything from a single yes/no ("Does this procedure apply the rule the parent referenced?") to a multi-part investigation ("Which columns X, Y, Z flow through this procedure, how are they transformed, and what conditions filter them?"). Frame the sub-question at the depth the next hop needs to make progress — do not truncate a multi-part investigation into a thin single question. Read neighbor metadata and justify each choice; blind routing is a reasoning failure.\n' +
    'APPROVED SCOPE: `working_memory.approved_border` carries the schemas and depth cap locked at session start. Each neighbor is tagged `in_budget` and `in_approved_scope`. Prefer in-border routes. When a focus node references something out of the border that matters for the question, include it in `route_requests` with its sub-question — the engine defers it to a post-session review list so the user can approve scope extension as a single end-of-session decision. `working_memory.deferred_count` shows the running tally.\n' +
    'WORKING MEMORY SIGNALS: `depth_budget` is the user-declared depth; `depth_cap` is the engine ceiling (strict = budget, soft = budget+1, silent = budget+2, plus user-approved extensions). `verdict_counts` shows the running R/P/I tally — many relevants and zero irrelevants usually means genuine utility/helper nodes were missed (those take `irrelevant`). `recent_rejections` lists the last five deferred or blocked routes already surfaced by the engine.',

  /** Verdict a neighbor — CT modes. */
  verdictNeighbors:
    'Verdict neighbors via `route_requests` (adds to agenda) or leave unchanged (engine skips). Cascade-prune happens when you verdict a focus node as irrelevant.',

  /** Column tracking — CT only. */
  columnTracking:
    'COLUMN TRACKING: for each `route_requests` entry, `columns` must be the names AS THEY APPEAR in the neighbor, not the output alias in the current node.\n' +
    'Read the current node DDL to find the source column reference: `SELECT neighbor.SourceCol AS OutputAlias` → trace SourceCol into that neighbor.\n' +
    'Track renames across hops — each hop may use a different name for the same data.\n' +
    'SELECTIVITY: trace only columns relevant to the question. When uncertain whether a column carries value to the target: trace. When a column only controls selection: omit.',

  /** Column lineage rule — CT column mode. */
  columnLineageRule:
    'COLUMN LINEAGE RULE: read the SELECT expression that produces the target column in the DDL. Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. Omit columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. Multi-input formulas: trace ALL inputs.',

  /** Table node guidance — CT modes. */
  tableNodes:
    'TABLE NODES: tables store data, not transform it — verdict a table itself as `pass`. Use route_requests to follow upstream writers (INSERT/UPDATE/MERGE sources).',

  /** Working memory usage — BB. */
  workingMemory:
    'WORKING MEMORY: `working_memory.all_summaries` contains every prior hop\'s one-line summary; `working_memory.pending_questions` lists self-asks you have not yet answered. Read them every hop — they keep cross-hop reasoning grounded.',

  /** Loop contract — applies to every mode. */
  completionContract:
    'The engine drives the loop. Every hop, call `submit_findings` for the presented focus node with `verdict: relevant | pass | irrelevant`. The engine stops presenting when the agenda drains — you shape the agenda: `verdict: "irrelevant"` cascade-prunes the node and its unvisited descendants. Route only neighbors the main user question needs.\n' +
    'Utility / logging / helper nodes (generic math helpers, log writers, identity UDFs) take `verdict: "irrelevant"` — removes the subtree quickly.',
} as const;


/**
 * Builds the mode-scoped navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * Replaces the MemGPT-style "autonomous agent" framing with 0.9.8's task framing:
 * the engine presents nodes, the model analyzes them, the engine advances the agenda.
 *
 * @param mode - The exploration mode (`blackboard` or `column_trace`).
 * @returns A markdown string containing classification rules, per-hop workflow, and routing guidance.
 */
export function buildNavigationPrompt(mode: SmMode): string {
  if (mode === 'column_trace') {
    return [
      'COLUMN TRACE MODE: the state machine presents nodes one at a time. Analyze each node and trace specific columns across it.',
      '',
      BLOCK.completionContract,
      '',
      BLOCK.verdictCategories,
      '',
      'For each node:',
      `1. ${BLOCK.readDdl}`,
      `2. ${BLOCK.writeFindings}`,
      `3. ${BLOCK.badgeAndNote}`,
      `4. ${BLOCK.verdictNeighbors}`,
      '',
      BLOCK.columnTracking,
      BLOCK.columnLineageRule,
      BLOCK.tableNodes,
      BLOCK.selfAsk,
      BLOCK.routing,
    ].join('\n');
  }

  // blackboard (default)
  return [
    'EXPLORATION MODE: the engine presents nodes one at a time. Use `working_memory.all_summaries` to carry cross-hop reasoning forward — this persistence is what distinguishes exploration from CT.',
    '',
    BLOCK.completionContract,
    '',
    BLOCK.verdictCategories,
    '',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    '4. Add neighbors to `route_requests` with a specific sub-question when you want to investigate them. Cascade-prune happens when you verdict the focus node as `irrelevant` — use it deliberately for helpers and utilities only.',
    '',
    BLOCK.selfAsk,
    BLOCK.workingMemory,
    BLOCK.routing,
  ].join('\n');
}


/**
 * Builds the synthesis trigger prompt delivered once the agenda drains.
 *
 * @remarks
 * Concise contract: the detail archive is the only evidence, two deliverables are required
 * (chat prose + `enrich_view` sections, both at per-slot depth), and the model decides
 * section length per question shape. No character floors, no structural enforcement —
 * depth comes from the archive plus the model's judgment.
 *
 * @returns A markdown string marking the transition from exploration to synthesis.
 */
export function buildSynthesisPrompt(): string {
  return [
    '# SYNTHESIS',
    'The detail archive below is your only evidence. Raw DDL is gone.',
    'The archive is comprehensive by design — do not compress, do not summarize. Lift the per-node analyses into sections verbatim, expanding with interpretation as needed. Section text has no length limit; thin synthesis negates the exploration\'s effort.',
    '',
    'TWO DELIVERABLES — both required:',
    '  1. Chat prose — executive answer in 2-3 sentences, then one section per archived slot grouped by role in the answer. Write at the depth the question asks for (WHAT the data means, HOW the pipeline runs, or both).',
    '  2. enrich_view — sections[] one entry per archive slot: `label = slot.badge_label` (verbatim), `node_ids = [slot.nodeId]`, `text = the per-node content you wrote in the chat`. notes[] — one per node, `text = slot.note_caption`.',
    '',
    'RULES:',
    '- Cite only from archive slots. No new facts.',
    '- If a slot lacks evidence for a claim, omit the claim.',
    '- If a slot reads thin, call `lineage_get_object_detail` and expand from the DDL.',
    '- Preserve LaTeX formulas and markdown tables from slot analyses verbatim.',
    '- Variant siblings each get their own section — delta wording is fine ("Same skeleton as X; deltas: …").',
    '',
    'DEFERRED QUESTIONS: the evidence block may include a "DEFERRED QUESTIONS" section listing out-of-approved-scope references the engine deferred during exploration. If present, render those entries as a trailing "Unanswered (out of approved scope)" section in the chat prose — one line per entry, preserving the node id, the sub-question, and the referencing focus node. Do not fabricate answers for deferred entries; the user will be offered a one-click scope extension after the report.',
  ].join('\n');
}
