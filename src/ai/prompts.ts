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
    '1. VALIDATE: If search returns 0 results or schema_mismatch, ask the user which object they mean before continuing. For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.\n' +
    '2. NEVER fabricate IDs. Only use IDs returned by tools.\n' +
    '3. For column questions: call start_exploration with targetColumns. For lineage/impact/trace and broad exploration: call start_exploration without targetColumns. For single-object explanations: get_object_detail → chat text. (Tool descriptions carry the full routing rules.)\n' +
    '4. OUTPUT: enrich_view when a graph aids understanding (lineage path, data flow). Chat text for pure explanations, SQL generation, list/compare requests.\n' +
    '5. VIEW OUTPUT: the enrich_view tool description carries the sections[] contract. Write sections in the narrative sequence you want the reader to follow; the system numbers sections from your order.\n' +
    '6. MATH: In chat text use ```math fenced blocks for display formulas. In enrich_view sections, use inline $…$ LaTeX. Never use $$ delimiters.\n' +
    '7. DETAIL ARCHIVE IS UNBOUNDED. When writing submit_findings.detail_analysis, be thorough — the engine preserves every character verbatim for synthesis. Thin slots produce thin final answers.\n'
    // Callers append: summary / sections / notes / highlights / description from aiOutputTemplates (stage-scoped; see lineageParticipant.ts buildStageSystemPrompt)
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
    `Routing to out-of-filter schemas is gated by the engine (schema_out_of_filter consent).\n\n`
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
