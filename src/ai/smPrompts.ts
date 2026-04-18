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
    'Write `detail_analysis` for the focus node. The archive preserves your analysis verbatim — no upper bound; synthesis uses this as sole evidence. Let the node\'s complexity dictate depth: a trivial passthrough is a few sentences; a non-trivial object is a full breakdown of every part present — each INSERT/UPDATE/MERGE/DELETE statement, each CTE, each BEGIN/COMMIT transaction, each IF/CASE branch, each JOIN condition, each filter, each computed expression. Quote SQL verbatim and explain in business terms. A thin slot produces a thin final answer.\n' +
    'Cover each aspect present:\n' +
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

  /** Self-ask — answer your own question from the previous hop. */
  selfAsk:
    'The `current_task` field contains the sub-question for this hop. Answer every part of it in the analysis — if the task is multi-part, address each part explicitly. Half-answered questions leave synthesis with gaps.',

  /** Route grounding — shared. */
  routing:
    'ROUTING: every entry in `route_requests` carries a focused sub-question — anything from a single yes/no ("Does this procedure apply the rule the parent referenced?") to a multi-part investigation ("Which columns X, Y, Z flow through this procedure, how are they transformed, and what conditions filter them?"). Frame the sub-question at the depth the next hop needs to make progress — do not truncate a multi-part investigation into a thin single question. Read neighbor metadata and justify each choice; blind routing is a reasoning failure.\n' +
    'DEPTH BUDGET (only when `working_memory.depth_budget` is present): the user expressed a scope in their question. Neighbors tagged `in_budget: false` are beyond that scope. If `depth_enforcement: "strict"` the engine rejects out-of-budget routes — stay within. If `depth_enforcement: "soft"` you may route beyond when the analysis genuinely requires it (expansions are tracked in `working_memory.budget_expansions`); prefer staying within the budget. If no `depth_budget` is in working_memory, route freely — the engine is auto-expanding the scope silently.',

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

  /** Completion contract — applies to every mode. */
  completionContract:
    'COMPLETION: Every hop call `submit_findings` for the presented focus node. When every direct neighbor of the origin has been analyzed, set `complete: true` on your final submit. The engine verifies — if any direct neighbor of the origin is still unvisited it returns `complete_rejected` with the list (`unvisited_direct_neighbors`, `names`) and promotes them to priority 3 so they are served next; analyze those then retry `complete: true`. Produce the final answer, chat prose wrap-up, or `lineage_enrich_view` only after the loop drains — a silent no-tool-call mid-loop truncates the investigation.\n' +
    'Utility / logging / helper nodes (generic math helpers, log writers, identity UDFs): submit with `verdict: "irrelevant"` — do not skip the submit. Irrelevant cascade-prunes the node and advances the agenda. Skipping leaves the engine waiting for findings and ends the investigation early.',
} as const;


/**
 * Builds the mode-scoped navigation prompt delivered at the active-phase start.
 *
 * @remarks
 * Replaces the MemGPT-style "autonomous agent" framing with 0.9.8's task framing:
 * the engine presents nodes, the model analyzes them, the engine advances the agenda.
 *
 * @param mode - The exploration mode (`blackboard`, `column_trace`, or `dependency`).
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

  if (mode === 'dependency') {
    return [
      'DEPENDENCY TRACE MODE: the state machine presents nodes one at a time. Analyze each node for its role in the dependency chain.',
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
      BLOCK.tableNodes,
      BLOCK.selfAsk,
      BLOCK.routing,
    ].join('\n');
  }

  // blackboard (default)
  return [
    'EXPLORATION MODE: the engine presents nodes one at a time. Use `working_memory.all_summaries` to carry cross-hop reasoning forward — this persistence is what distinguishes exploration from CT/dependency modes.',
    '',
    BLOCK.completionContract,
    '',
    BLOCK.verdictCategories,
    '',
    'For each node:',
    `1. ${BLOCK.readDdl}`,
    `2. ${BLOCK.writeFindings}`,
    `3. ${BLOCK.badgeAndNote}`,
    '4. Add neighbors to `route_requests` with a specific sub-question when you want to investigate them.',
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
  ].join('\n');
}
