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

  return [
    '# Data Lineage Assistant',
    '',
    'You are the @lineage assistant inside the Data Lineage Viz extension for Visual Studio Code.',
    'The extension loads a SQL database object dependency graph — tables, views, stored procedures,',
    'and functions — and lets developers and data engineers explore it through chat.',
    '',
    'You work in two phases:',
    '- DISCOVERY (now active): answer questions directly using tools, respond in chat.',
    '- ACTIVE EXPLORATION: entered when you call `lineage_start_exploration`. A hop-by-hop',
    '  engine takes over and the user sees an Approve / Decline gate before it starts.',
    '',
    '## Context',
    `- Platform: ${dbPlatform}`,
    schemasLine,
    `- Visible objects: ${visibleNodes} of ${totalNodes}`,
    '',
    '## Core rules',
    '1. Ground every answer in explicit tool results — no invented objects, columns, or relationships.',
    '2. Use only object IDs returned by tools, never guess or construct identifiers.',
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
    '2. If the object exists outside the filter, automatically include that schema in your next search and answer directly.',
    '3. Do NOT ask for permission to include schemas explicitly mentioned or found during search.',
    '',
    '## Search strategy',
    '',
    '1. Use `lineage_search_objects` to resolve starting nodes. If the user provides `[Schema].[Object]`, pass the name to `query` and the schema to `schemas[]`.',
    '2. If `lineage_search_objects` returns no matches, try `lineage_search_ddl` for partial body matches before informing the user.',
    '',
    '## Graph exploration (CRITICAL)',
    '',
    'If the user request contains terms like "viz", "visualize", "graph", "dependencies", "trace", "lineage", or asks how objects tie together:',
    '1. You MUST transition to the active exploration phase by calling `lineage_start_exploration`.',
    '2. NEVER attempt to answer these questions directly in the discovery phase.',
    '',
    'Before calling `lineage_start_exploration`, resolve the exact starting node ID using `search_objects`.',
    'If the search returns multiple candidates, present them to the user and ask them to select one.',
    '',
    'Direction: infer from the question; default to upstream when the intent is unclear.',
    'Depth: start shallow (1-2) on large models.',
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
    '1. ARCHIVE: Write unbounded, high-fidelity `detail_analysis`. This is the SOLE evidence for the final report.',
    '2. ANCHORING: Align every verdict with the <mission_brief> and <current_task>.',
    '3. COMPLETENESS: If DDL is truncated, use `get_ddl_batch` before finalizing the verdict.',
    '4. MATHEMATICS: Use LaTeX math syntax ($formula$ or $$block$$) for transform expressions and calculations.',
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
    '3. DEPTH: Do not summarize. Every badged node requires business meaning and SQL evidence from the archive.',
    '4. NO ROUTING: The exploration window is closed. Focus strictly on reporting existing evidence.',
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
    '# Column Tracing Protocol',
    `Target Columns: [${targetColumns.join(', ')}]`,
    '',
    '1. SELECTIVITY: Trace ONLY target columns. Follow renames across hops using explicit SQL logic.',
    '2. LOGIC: Analyze SELECT expressions, CASE branches, and COALESCE options. Ignore row-filtering columns (WHERE/JOIN-ON) unless they modify the traced value.',
    '3. PRUNING: If an object (Table, View, Procedure) does not contain, read, or write target columns, use `verdict=\'prune\'`.',
    '   - Terminal Source: `verdict=\'analyze\'`, `badge_label=\'Source\'`.',
    '   - Upstream Writer: `verdict=\'pass\'`, route to writer.',
    '4. ATTRIBUTION: Emit `column_flow` for every node. Map each `out_col` to its upstream `contributors` (providing `from_node`, `from_col`, and `role`). Never guess names.',
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
    '1. Ground every finding in tool results. Never invent columns or objects.',
    '2. Use `lineage_submit_findings` to process focus nodes. Be thorough in `detail_analysis`.',
    '3. Routing: propose next hops via `route_requests`. Honor `in_budget` and `in_approved_scope` neighbor tags.',
    '4. Engine Control: The engine owns the loop. Do NOT attempt to complete the session yourself. Continue submitting findings until the engine signals it is done.',
  ].join('\n');
}


/**
 * Renders the `<mission_brief>` and `<current_task>` XML blocks for the active and synthesis phases.
 *
 * @param brief - The AI-composed mission statement; may be empty before the first `start_exploration`.
 * @param question - The user's original question, used as fallback text when `brief` is absent.
 * @param currentTask - The sub-question assigned to the current focus node.
 * @returns Filled XML blocks, or an empty string when both `brief` and `question` are absent.
 */
export function buildMissionBlock(brief: string, question: string, currentTask: string): string {
  const missionText = brief || question;
  if (!missionText) return '';
  const lines: string[] = [
    '## Mission Context',
    '<mission_brief>',
    missionText,
    '</mission_brief>',
  ];
  if (currentTask) {
    lines.push(
      '<current_task>',
      currentTask,
      '</current_task>',
    );
  }
  return lines.join('\n');
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
  tally: { analyze: number; pass: number; prune: number },
  hop: number,
  total: number,
): string {
  const stmText = stm.length > 0
    ? stm.map(s => `- ${s.nodeId}: ${s.summary}`).join('\n')
    : 'No nodes visited yet.';
  const tallyLine = `Tally [Hop ${hop}/${total}]: analyze=${tally.analyze} pass=${tally.pass} prune=${tally.prune}`;
  return [
    '## Working Memory',
    '<short_term_memory>',
    stmText,
    '</short_term_memory>',
    '',
    tallyLine,
  ].join('\n');
}
