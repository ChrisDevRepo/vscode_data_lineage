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
    'Write `detail_analysis` for the focus node — document it comprehensively:\n' +
    '- relevant/trace → full analysis (hard limit 8000 chars). Use the budget: simple passthrough ~300 chars, moderate transform ~1000-2000 chars, complex multi-CTE SP ~3000-6000 chars. Self-contained — written as if documenting this node for a technical reference.\n' +
    '  Include each aspect present:\n' +
    '  COLUMNS: key column names, types, constraints (PK/FK/nullable).\n' +
    '  TRANSFORMS: expressions, CASE/COALESCE, computed columns — quote the SQL fragment.\n' +
    '  JOINS: join conditions (table.col = table.col).\n' +
    '  FILTERS: WHERE/HAVING business rules.\n' +
    '  DATA FLOW: how data enters and leaves (INSERT/SELECT/MERGE/EXEC). Note the loading pattern: full (TRUNCATE+INSERT), incremental, SCD2, MERGE upsert.\n' +
    '  QUESTION RELEVANCE: how this node answers the user question.\n' +
    '  OBSERVATIONS: DDL comments, version annotations, performance risks, anti-patterns.\n' +
    '  Quote SQL verbatim — ground truth for synthesis. Then explain what each expression means in business terms.\n' +
    '- pass → `summary` only (~100-200 chars): what passes through, from where to where.\n' +
    '- irrelevant → brief `summary` only.\n' +
    'Write a one-line `summary` for every hop — it is echoed in future hops via working_memory.all_summaries.',

  /** Badge + note metadata drive the graph UI. */
  badgeAndNote:
    'badge_label (2-4 words): semantic ROLE tag — e.g. "Source", "Transform", "Staging", "Output", "Validation", "Aggregation".\n' +
    'SELECTIVITY: only assign badge_label to nodes with distinct functional roles. Passthrough nodes skip it.\n' +
    'GROUPING: nodes that serve the same role should get the same badge_label (e.g. two source tables → both "Source").\n' +
    'note_caption (~100-200 chars): one-line what-this-does. Write the REASONING — what you learned, what it means for the question, what is still open.',

  /** Self-ask — answer your own question from the previous hop. */
  selfAsk:
    'The `current_task` field contains the sub-question for this hop — answer it in the analysis.',

  /** Route grounding — shared. */
  routing:
    'ROUTING: every entry in `route_requests` needs a specific sub-question ("Does this proc apply the 10% VAT rate?"). Read neighbor metadata and justify each choice — blind routing is a reasoning failure.',

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
    'COMPLETION: Every hop call `submit_findings` for the presented focus node. When you have analyzed every direct neighbor of the origin (the user asked about the origin and its neighbors), set `complete: true` on your final submit. The engine verifies — if any direct neighbor of the origin is still unvisited it returns `complete_rejected` with the list (`unvisited_direct_neighbors`, `names`) and promotes them to priority 3 so they are served next; analyze those then retry `complete: true`. Never produce a final answer, chat prose wrap-up, or `lineage_enrich_view` while the loop is still draining — a silent no-tool-call mid-loop truncates the investigation and produces a partial result.\n' +
    '`start_exploration` is a ONE-SHOT discover→active transition: call it exactly once per turn, never in parallel, never again after the first return. All subsequent hops use `submit_findings`. After `complete_rejected`, the unvisited neighbors are already queued at priority 3 — the next `submit_findings` will present one of them. Calling `start_exploration` again wipes all prior findings and restarts from hop 1.\n' +
    'Utility / logging / helper nodes (`LogMessage`, `udf*`, `spLog*`, generic math helpers): submit with `verdict: "irrelevant"` — do NOT skip the submit. Irrelevant cascade-prunes the node and advances the agenda. Skipping leaves the engine waiting for findings and ends the investigation early.',
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
    'EXPLORATION MODE: the state machine presents nodes one at a time with full DDL and metadata.',
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
