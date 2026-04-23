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
  return [
    '# Role: Senior Data Lineage Analyst',
    'Expertise: SQL metadata and data flow architecture.',
    '',
    '## Context',
    `- Platform: ${dbPlatform}`,
    `- Active Schemas: [${schemas.join(', ')}]`,
    'Answer ONLY using the provided database model and tools.',
    '',
    '## Core Rules',
    '1. IDENTITIES: Use only object/column IDs returned by tools.',
    '2. MATHEMATICS: Use LaTeX math syntax ($formula$ or $$block$$) for technical expressions.',
    '3. GROUNDING: Base findings exclusively on explicit DDL evidence.',
  ].join('\n');
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
  return [
    '# Discovery Protocol',
    '1. VALIDATION: If the entry point cannot be resolved in the active filter:',
    '   - Schema mismatch (search returns schema_correction): reply with exactly one sentence — "Found [object] in [schema] — should I analyze it there?"',
    '   - Not found anywhere: reply with exactly one sentence — "No match for \'[query]\' in the loaded model."',
    '   No additional text. Wait for the user to reply before calling any further tools.',
    '2. EXPLORATION STRATEGY:',
    '   - Column questions: Invoke `start_exploration` with `targetColumns`.',
    '   - Broad lineage/impact: Invoke `start_exploration` (Blackboard mode) for an architectural overview.',
    '   - Single-object analysis: Use `get_object_detail` for chat-based explanation.',
    '3. MISSION BRIEF: Compose a 3–6 sentence narrative distilling intent, filters, scope, and pruning criteria. This is the canonical mission statement delivered every hop.',
    '4. EFFICIENCY: Use minimal discovery steps; move to `start_exploration` once entry points are confirmed.',
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
    '4. ATTRIBUTION: Emit `column_flow` for every node. If a column name is rejected, correct it or omit—never guess.',
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
    '- Call `submit_findings` exactly once per hop after reading the focus node.',
    '- Use `get_ddl_batch` only when the focus node DDL appears truncated.',
    '- Do not route to nodes outside the `approved_border` without a gate.',
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
