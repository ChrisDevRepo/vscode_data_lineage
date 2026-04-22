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
 * Contains global invariants: platform rules, schema context, and basic tool constraints.
 * 
 * @returns A string containing the foundational system rules.
 */
export function buildGeneralSystemPrompt(dbPlatform: string, schemas: string[]): string {
  return (
    `Database platform: ${dbPlatform}. Use platform-appropriate SQL syntax and capabilities in analysis.\n` +
    `Working context: user has schema(s) [${schemas.join(', ')}] selected. Default all searches, SQL generation, and analysis to these schemas.\n` +
    'SQL lineage data provider. Answer ONLY from loaded database model using provided tools.\n\n' +
    'RULES:\n' +
    '1. Use only IDs returned by tools. Unknown IDs are rejected by the engine with route_validation_failed.\n' +
    '2. MATH: Use LaTeX math syntax for formulas in all output — chat text and present_result section text.\n'
  );
}


/**
 * Constructs the prompt for the Discovery/Idle phase.
 * 
 * @remarks
 * Used when the AI is searching for entry points or answering follow-up questions.
 * Includes routing rules for start_exploration.
 * 
 * @returns A string containing discovery-phase rules.
 */
export function buildDiscoveryPrompt(): string {
  return (
    'DISCOVERY RULES:\n' +
    '1. VALIDATE: If search returns 0 results or schema_mismatch, ask the user which object they mean before continuing. For all other decisions: self-decide and proceed.\n' +
    '2. ROUTING: For column questions: call start_exploration with targetColumns. For lineage/impact/trace and broad exploration: call start_exploration without targetColumns. If intent is broad or ambiguous, prefer calling without targetColumns (Blackboard mode) as it provides a better architectural overview. For single-object explanations: get_object_detail → chat text.\n' +
    '3. MISSION BRIEF: Before calling start_exploration, compose `mission_brief` — a 3–6 sentence narrative distilling (a) the user\'s intent, (b) any NL filters expressed ("ignore UDFs/views"), (c) the scope you chose. The brief is delivered to you verbatim every hop and survives memory wipes.\n' +
    '4. EFFICIENCY: Perform minimal object-drilldown during discovery; use `start_exploration` to begin deep analysis once the entry point is confirmed.\n'
  );
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
  const deliveryInstruct = isInline
    ? 'You have received the entire graph context at once. Analyze all presented nodes holistically and submit your findings in a single batch. You do not need to navigate hop-by-hop.'
    : 'You are currently analyzing nodes one by one in isolation. You do not have access to the full graph or the global BFS agenda.';

  return (
    'ACTIVE EXPLORATION RULES:\n' +
    `${deliveryInstruct}\n` +
    '1. DETAIL ARCHIVE IS UNBOUNDED. When writing submit_findings.detail_analysis, be thorough — the engine preserves every character verbatim for synthesis. Thin slots produce thin final answers.\n' +
    '2. Anchor every analysis on the `mission_brief` and the incoming `current_task` (if hop-by-hop) or global intent (if inline).\n' +
    '3. TRUNCATION: If any node DDL is truncated, you MUST call `lineage_get_ddl_batch` to retrieve the missing logic before committing your verdict.\n'
  );
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
  return (
    'SYNTHESIS RULES (Reporting):\n' +
    'You have completed the exploration. You now have access to the full, unbounded Detail Archive. What was not saved there cannot be generated now.\n' +
    '1. OUTPUT: Call present_result when a graph aids understanding (lineage path, data flow). Chat text for pure explanations, SQL generation, list/compare requests.\n' +
    '2. VIEW OUTPUT: the present_result tool description carries the sections[] contract. Write sections in the narrative sequence you want the reader to follow; the system numbers sections from your order.\n' +
    '3. Present at full depth — do not compress or re-summarize the detail archive. Every badged node needs 3+ sentences with business meaning + SQL evidence.\n' +
    '4. NO ROUTING: Your navigation window is closed. Synthesis is for reporting existing findings. If critical nodes are missing, mention them in the chat prose as areas for follow-up.\n'
  );
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
  return `STOP: ${gates.join(' | ')} — You MUST address this with the user before calling any more tools.`;
}

/** 
 * Error hint provided to the AI if it attempts to call tools while a gate is pending.
 */
export const ACTION_REQUIRED_PENDING_HINT =
  'You must present the previous action_required message to the user and wait for their response before calling tools.';


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
    'COLUMN ASPECT RULES (Grounded Tracing):',
    `Target columns: [${targetColumns.join(', ')}]`,
    '',
    '1. SELECTIVITY: trace ONLY the columns pertinent to the question. Track renames across hops — for each `route_requests` entry, `columns` must be the names AS THEY APPEAR in the neighbor, not the output alias in the current node.',
    '2. LINEAGE RULE: Read the SELECT expression producing each target column. Trace every operand, formula input, CASE branch, and COALESCE option. Omit columns that only appear in WHERE/JOIN-ON selection filters (row-level filters) unless they directly contribute to the value.',
    '3. TABLE NODES: Tables store but do not transform. For terminal physical sources (no upstream writer), verdict = analyze and badge_label = "Source". For intermediate tables with an in-DB writer (SP/View), verdict = pass and add the writer to `route_requests`.',
    '4. STRUCTURED ATTRIBUTION: You MUST emit the `column_flow` array in `submit_findings` for the focus node. Each entry must provide a machine-readable map of `out_col` to its upstream `contributors` (`from_node`, `from_col`, `role`).',
    '   RECOVERY: If the engine rejects a column name with `column_flow_validation_failed`, re-submit with the correction or OMIT the entry — do not hallucinate.',
  ].join('\n');
}
