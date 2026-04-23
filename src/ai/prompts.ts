/**
 * AI prompt constants — extracted from extension.ts for maintainability.
 *
 * Each constant is a complete prompt string injected at a specific point
 * in the chat loop. See ai/prompt-changelog.md for change history.
 *
 * Navigation Mode prompts are in smPrompts.ts (Universal Markdown blocks).
 */


/**
 * Constructs the base system prompt used to govern AI behavior across all phases.
 *
 * @remarks
 * Contains the role definition, injected app context (platform, schemas, node counts),
 * and core grounding rules. LaTeX is intentionally absent — it is only relevant during
 * active exploration where math expressions appear in SQL transform analysis.
 *
 * @param dbPlatform - Human-readable database platform string from the loaded model.
 * @param filterSchemas - Schema names currently active in the user's filter.
 * @param totalSchemaCount - Total number of schemas in the loaded model.
 * @param visibleNodes - Number of nodes visible under the active filter.
 * @param totalNodes - Total number of nodes in the loaded model.
 * @returns The assembled base system prompt string.
 */
export function buildGeneralSystemPrompt(
  phase: 'discover' | 'active' | 'synthesis',
  dbPlatform: string,
  filterSchemas: string[],
  totalSchemaCount: number,
  visibleNodes: number,
  totalNodes: number,
): string {
  const isFiltered = filterSchemas.length > 0 && filterSchemas.length < totalSchemaCount;
  const schemasLine = isFiltered
    ? `- Schemas: ${filterSchemas.join(', ')} (${filterSchemas.length} of ${totalSchemaCount} schemas)`
    : `- Schemas: All (${totalSchemaCount} schemas)`;
  const phaseLabel = { discover: 'DISCOVERY', active: 'ACTIVE EXPLORATION', synthesis: 'SYNTHESIS' }[phase];

  return [
    '# Data Lineage Assistant',
    '',
    'You are the @lineage assistant inside the Data Lineage Viz extension for Visual Studio Code.',
    'The extension loads a SQL database object dependency graph — tables, views, stored procedures,',
    'and functions — and lets developers and data engineers explore it through chat.',
    '',
    `Current phase: ${phaseLabel}.`,
    '',
    '**Grounding rule:** Use only object IDs, columns, and relationships returned by tool calls. Never infer, construct, or invent identifiers.',
    '',
    '## Context',
    `- Platform: ${dbPlatform}`,
    schemasLine,
    `- Visible objects: ${visibleNodes} of ${totalNodes}`,
  ].join('\n');
}


/**
 * Constructs the prompt for the Discovery/Idle phase.
 *
 * @remarks
 * Covers filter-scope rules, not-found response patterns, graph exploration gate
 * (direction, depth, scope preview), column tracing routing, exclusion handling,
 * slash command mapping, and response format constraints.
 * Tool parameter routing is owned by each tool's modelDescription — not repeated here.
 *
 * @returns The assembled discovery-phase prompt string.
 */
export function buildDiscoveryPrompt(): string {
  return [
    '## Filter scope',
    '',
    'The graph shows objects in the active filter schemas. When a search returns 0 results inside the filter:',
    '1. Check the `in_user_filter: false` field in the tool result hint.',
    '2. If the object exists outside the filter, include that schema in your next search automatically and answer directly. (No permission prompt needed — the filter is a display preference, not a boundary.)',
    '',
    '## Search strategy',
    '',
    '1. Use `lineage_search_objects` to resolve starting nodes. If the user provides `[Schema].[Object]`, pass the name to `query` and the schema to `schemas[]`.',
    '2. If `lineage_search_objects` returns no matches, try `lineage_search_ddl` for partial body matches before informing the user.',
    '',
    '## Graph exploration',
    '',
    'For any question about graph structure, lineage, dependencies, tracing, or how objects tie together (terms like "viz", "visualize", "graph", "dependencies", "trace", "lineage"), call `lineage_start_exploration`. The hop-by-hop engine produces these reports; answering directly from discovery would invent paths.',
    '',
    'Before calling `lineage_start_exploration`, resolve the exact starting node ID using `search_objects`.',
    'If the search returns multiple candidates, present them to the user and ask them to select one.',
    '',
    'Direction: infer from the question; default to upstream when the intent is unclear.',
    'Depth: start shallow (1-2) on large models.',
    '',
    '## Mission classification',
    '',
    'When you call `lineage_start_exploration`, set `classification` based on the user request:',
    '- `business` (default) — the user asks about data meaning, lineage, dependencies, what columns mean, or what data feeds what. Use this unless the user clearly signals otherwise.',
    '- `technical` — the user explicitly asks for SQL, implementation, code, expressions, joins, or "how is this computed".',
    '- `both` — the user explicitly asks for both business and technical angles.',
    '',
    '## Slash commands',
    '',
    '`/trace [object]` — resolve the starting node, infer direction and depth, then call `lineage_start_exploration`.',
    '',
    '`/search [term]` — call `search_objects` scoped to the active filter schemas and present results as a table.',
    '',
    '## Response format',
    '',
    'Markdown only. Match response length to the question.',
  ].join('\n');
}


/**
 * Constructs the prompt for the Active (Hop-by-Hop or Full Run) phase.
 * 
 * @remarks
 * Dynamically switches instructions based on whether the engine is in True Inline mode
 * or Sliding Memory mode, while sharing the core heuristic rules for node analysis.
 *
 * @param isInline - Whether the engine is delivering the entire graph context at once.
 * @returns A formatted system instruction for the active phase.
 */
export function buildActivePhasePrompt(isInline: boolean): string {
  const mode = isInline 
    ? 'TRUE INLINE: Analyze all nodes holistically in a single turn.' 
    : 'SLIDING MEMORY: Analyze nodes sequentially as presented.';

  return [
    '# Active Exploration Protocol',
    `Mode: ${mode}`,
    '',
    '**Grounding rule:** Use only object IDs, columns, and relationships returned by tool calls. Never infer, construct, or invent identifiers.',
    '',
    '1. ARCHIVE → DEPTH: Your `detail_analysis` is the sole input to the final report. Write at full depth because there is no follow-up pass.',
    '2. ANCHORING: Align every verdict with the <mission_brief> and <current_task>.',
    '3. COMPLETENESS: If DDL is truncated, use `get_ddl_batch` before finalizing the verdict.',
    '4. MATHEMATICS: Use LaTeX math syntax ($formula$ or $$block$$) for transform expressions and calculations.',
    '5. ROUTE OUTCOMES: Each `submit_findings` tool result carries `route_outcomes[]`. Reference only nodes with `accepted: true` in your detail_analysis. Nodes with `deferred: true` are available as post-synthesis follow-up offers — mention each at most once as "available for follow-up", do not analyze their internals.',
  ].join('\n');
}


/**
 * Constructs the prompt for the Synthesis (Reporting) phase.
 * 
 * @remarks
 * Hyper-focused on generating the high-quality final report using the detail archive.
 * 
 * @returns A string containing synthesis-phase rules.
 */
export function buildSynthesisPrompt(): string {
  return [
    '# Synthesis Protocol (Reporting)',
    'The exploration is complete. Generate the final report using the Detail Archive.',
    '1. OUTPUT: Use `present_result` for data flow and lineage graphs. Use chat text for narratives and SQL.',
    '2. STRUCTURE: Follow the `sections[]` contract in `present_result`. Sequence findings narratively.',
    '3. DEPTH: Write full-depth analysis for every badged node — business meaning and SQL evidence lifted from the archive.',
    '4. REPORTING SCOPE: The exploration window is closed. Focus strictly on reporting existing evidence; routing is no longer available.',
  ].join('\n');
}


/** 
 * Transforms raw user input into a structured lineage tracing request.
 * 
 * @param userInput - The entity or relationship the user wants to trace.
 * @returns A formatted prompt for the `/trace` command.
 */
export function buildTracePrompt(userInput: string): string {
  return `Trace the data lineage for: ${userInput}.`;
}

/** 
 * Transforms raw user input into a structured model search request.
 * 
 * @param userInput - The search term or regex provided by the user.
 * @returns A formatted prompt for the `/search` command.
 */
export function buildSearchPrompt(userInput: string): string {
  return `Search for database objects matching: ${userInput}.`;
}


/** 
 * Constructs a "Stop Gate" message when an AI action requires explicit user confirmation.
 * 
 * @remarks
 * Injected as a User message to pause the autonomous tool loop when a `action_required` 
 * state is detected by the extension host.
 * 
 * @param gates - List of reasons/conditions that blocked the execution.
 * @returns A strict instruction string for the AI to cease tool calls.
 */
export function buildActionRequiredGate(gates: string[]): string {
  return `STOP: ${gates.join(' | ')} — Address this with the user before proceeding with further tool calls.`;
}

/** 
 * Error hint provided to the AI if it attempts to call tools while a gate is pending.
 */
export const ACTION_REQUIRED_PENDING_HINT =
  'Present the previous action_required message to the user and wait for their response before calling tools.';


/**
 * Constructs the system instructions for the Column Trace aspect.
 *
 * @remarks
 * Injected into the active phase when `targetColumns` are provided. Focuses strictly on
 * routing mechanics, rename tracking, and structured metadata emission.
 *
 * @param targetColumns - The initial set of columns requested by the user.
 * @returns A formatted string containing column-specific system rules.
 */
export function buildColumnAspectPrompt(targetColumns: string[]): string {
  return [
    '# Column Trace Protocol',
    `Target columns: [${targetColumns.join(', ')}]`,
    '',
    '## Layered pruning',
    'When Column Trace is active, two filters apply in order:',
    '1. **Mechanical column filter (first):** if a node does not contain, read, or write any target column, prune it. This is a structural check, not a judgment call.',
    '2. **Mission filter (second, for nodes that pass the column filter):** apply the standard mission-relevance pruning rules.',
    '',
    '## Tracing rules',
    '- Trace only the listed target columns. Follow renames across hops using SQL evidence.',
    '- Analyze transform logic (SELECT expressions, CASE, COALESCE). Ignore row-filtering (WHERE / JOIN-ON) unless it modifies the traced value.',
    '- Terminal source (column originates here, no upstream writer): `verdict=analyze`, `badge_label=Source`.',
    '- Upstream writer exists but not yet visited: `verdict=pass`, route to the writer.',
    '',
    '## Attribution',
    'For every node with `verdict=analyze`, emit `column_flow`. Map each `out_col` to its upstream `contributors` with `from_node`, `from_col`, `role`. Use only column names present in the node DDL.',
  ].join('\n');
}


/**
 * Constructs the Tool Usage block for the active phase.
 *
 * @returns A string containing the mechanical `submit_findings` and `get_ddl_batch` constraints.
 */
export function buildToolUsageBlock(): string {
  return [
    '## Tool Constraints',
    '',
    '**Grounding rule:** Use only object IDs, columns, and relationships returned by tool calls. Never infer, construct, or invent identifiers.',
    '',
    '1. Use `lineage_submit_findings` to process focus nodes. Write full-depth `detail_analysis` per the required-section template in the stage rules.',
    '2. Routing: propose next hops via `route_requests`. Honor `in_budget` and `in_approved_scope` neighbor tags. Inspect `route_outcomes[]` in each tool result to see which routes were accepted vs deferred.',
    '3. Routing out-of-scope neighbors is encouraged when mission-relevant — they become post-synthesis follow-up offers to the user.',
  ].join('\n');
}


/**
 * Renders the `<mission_brief>` XML block — **session-stable** content.
 *
 * @remarks
 * Mission brief is set once at `start_exploration` and never changes during a
 * session. Placing it in the stable prefix lets the service-side prompt cache
 * cover it across every hop of the active/synthesis phase.
 *
 * @param brief - The AI-composed mission statement; may be empty before the first `start_exploration`.
 * @param question - The user's original question, used as fallback text when `brief` is absent.
 * @returns Filled mission-brief XML block, or an empty string when both `brief` and `question` are absent.
 */
export function buildMissionBriefBlock(brief: string, question: string): string {
  const missionText = brief || question;
  if (!missionText) return '';
  return [
    '## Mission Context',
    '<mission_brief>',
    missionText,
    '</mission_brief>',
  ].join('\n');
}

/**
 * Renders the `<current_task>` XML block — **per-hop dynamic** content.
 *
 * @remarks
 * Current task is the sub-question assigned to the focus node of the present
 * hop. It changes every hop in SM mode, so it lives in the dynamic suffix of
 * the system prompt, not in the cacheable stable prefix.
 *
 * @param currentTask - The sub-question assigned to the current focus node.
 * @returns The `<current_task>` XML block, or an empty string if `currentTask` is absent.
 */
export function buildCurrentTaskBlock(currentTask: string): string {
  if (!currentTask) return '';
  return [
    '<current_task>',
    currentTask,
    '</current_task>',
  ].join('\n');
}


/**
 * Renders the `<short_term_memory>` XML block and the tally line for SM active hops.
 *
 * @param stm - Sliding window of the last 3 node summaries.
 * @param tally - Running verdict counts for the session.
 * @param hop - Current 1-based hop index.
 * @param total - Total nodes in scope.
 * @returns A string containing the memory block and tally line.
 */
export function buildMemoryBlock(
  stm: Array<{ nodeId: string; summary: string }>,
  _tally: { analyze: number; pass: number; prune: number },
  hop: number,
  total: number,
): string {
  const stmText = stm.length > 0
    ? stm.map(s => `- ${s.nodeId}: ${s.summary}`).join('\n')
    : 'No nodes visited yet.';
  return [
    '## Working Memory',
    `Hop ${hop} of ${total} scope nodes.`,
    '',
    '<short_term_memory>',
    stmText,
    '</short_term_memory>',
  ].join('\n');
}
