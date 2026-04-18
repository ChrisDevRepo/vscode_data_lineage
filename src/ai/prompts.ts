/**
 * AI prompt constants — extracted from extension.ts for maintainability.
 *
 * Each constant is a complete prompt string injected at a specific point
 * in the chat loop. See ai/prompt-changelog.md for change history.
 *
 * Navigation Mode prompts are in smPrompts.ts (Universal Markdown blocks).
 */


/**
 * Constructs the base system prompt used to govern AI behavior across all exploration modes.
 *
 * @remarks
 * Restores the 0.9.8 rule set: terse ground rules covering validation, tool routing,
 * output shape, and LaTeX guidance. Callers append platform context, schema context, and
 * the `aiOutputTemplates.yaml` fields (summary/badges/sections/notes/highlights/description).
 *
 * @param maxRounds - The maximum number of tool execution rounds allowed before a hard stop.
 * @returns A string containing the foundational system rules for the SQL lineage assistant.
 */
export function buildSystemPromptBase(maxRounds: number): string {
  return (
    'SQL lineage data provider. Answer ONLY from loaded database model using provided tools.\n' +
    `Budget: ${maxRounds} rounds.\n\n` +
    'RULES:\n' +
    '1. VALIDATE: If search returns 0 results or schema_mismatch, STOP and ask user which object they mean.\n' +
    '   For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.\n' +
    '2. NEVER fabricate IDs. Only use IDs returned by tools.\n' +
    '3. For column questions: start_exploration with targetColumns. For lineage/impact/trace: start_exploration without targetColumns (dependency mode).\n' +
    '   When tracing columns: provide INPUT column names as they appear in the source, not output aliases. Track renames across hops.\n' +
    '   When uncertain whether a column carries value to the target: trace. When a column only controls selection: omit.\n' +
    '   For broad exploration (business rules, documentation, patterns, investigations): start_exploration explores objects hop-by-hop with persistent memory.\n' +
    '   start_exploration is one-shot per turn: call it exactly once, never in parallel, never as a retry. All subsequent hops use submit_findings.\n' +
    '   BFS (run_bfs_trace) is for scope discovery only — it cannot create an enrich_view.\n' +
    '   For single-object questions ("explain X"): get_object_detail → chat text.\n' +
    '4. OUTPUT: enrich_view when a graph aids understanding (lineage path, data flow). Chat text for pure explanations, SQL generation, list/compare requests.\n' +
    '5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.\n' +
    '   System numbers sections in YOUR sections[] order. Write sections in the narrative sequence you want the reader to follow. Do not number badges yourself or write description when sections are provided.\n' +
    '6. MATH: In chat text use ```math fenced blocks for display formulas. In enrich_view sections, use inline $…$ LaTeX. Never use $$ delimiters.\n'
    // Callers append: summary / badges / sections / notes / highlights / description from aiOutputTemplates
  );
}


/** 
 * Generates platform-specific context for the AI system prompt.
 * 
 * @param dbPlatform - The database engine identifier (e.g., 'SQL Server', 'Snowflake').
 * @returns A prompt fragment instructing the AI to use appropriate SQL dialects.
 */
export function buildPlatformContext(dbPlatform: string): string {
  return `Database platform: ${dbPlatform}. Use platform-appropriate SQL syntax and capabilities in analysis.\n`;
}

/** 
 * Generates schema-filtering context for the AI system prompt.
 * 
 * @remarks
 * Encourages the AI to prioritize the user's active schema selection during searches
 * and lineage investigations to reduce noise.
 * 
 * @param schemas - Array of schema names currently selected in the UI.
 * @returns A prompt fragment defining the current working schema context.
 */
export function buildSchemaContext(schemas: string[]): string {
  return (
    `Working context: user has schema(s) [${schemas.join(', ')}] selected.\n` +
    `Default all searches, SQL generation, and analysis to these schemas.\n` +
    `If answering the question requires objects from other schemas, ask the user first.\n\n`
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
