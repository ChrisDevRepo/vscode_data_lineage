/**
 * AI prompt constants — extracted from extension.ts for maintainability.
 *
 * Each constant is a complete prompt string injected at a specific point
 * in the chat loop. See ai/prompt-changelog.md for change history.
 *
 * SM mode prompts (CT/BB) are in smPrompts.ts (composable building blocks).
 */

// ─── System Prompt Base ──────────────────────────────────────────────────────

/** Build the base system prompt (rules 1-5). Caller appends template fields. */
export function buildSystemPromptBase(maxRounds: number): string {
  return (
    'SQL lineage data provider. Answer ONLY from loaded database model using provided tools.\n\n' +
    'RULES:\n' +
    '1. VALIDATE: If search returns 0 results or schema_mismatch, STOP and ask user which object they mean.\n' +
    '   For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.\n' +
    '2. NEVER fabricate IDs. Only use IDs returned by tools.\n' +
    '3. For column questions: start_column_trace with columns. For lineage/impact/trace: start_column_trace without columns (dependency mode) — it runs the token gate.\n' +
    '   When tracing columns: provide INPUT column names, not output. Track renames.\n' +
    '   When uncertain whether a column carries value to the target: trace. When a column only controls selection: prune.\n' +
    '   For single-object questions ("what does X do?", "explain X"): get_object_detail → chat text. No graph, no state machine.\n' +
    '   For multi-object exploration (business rules across a pipeline, documentation spanning dependencies, investigations):\n' +
    '   use start_exploration to explore objects hop-by-hop with persistent memory.\n' +
    '   BFS (run_bfs_trace) is for scope discovery, not final trace results.\n' +
    '4. OUTPUT: enrich_view when graph aids understanding (lineage path, data flow).\n' +
    '   Chat text for: pure explanations, SQL generation, list/compare requests (no graph needed).\n' +
    '5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.\n' +
    '   System numbers sections in YOUR sections[] order. Write sections in the narrative sequence you want the reader to follow. Do not number badges yourself or write description when sections are provided.\n' +
    '6. MATH: In ALL output — chat text AND enrich_view section text — use LaTeX math syntax for formulas.\n'
    // Callers append: summary/badges/sections/notes/highlights/description from aiOutputTemplates
  );
}

// ─── Runtime Context Injections ──────────────────────────────────────────────

/** Prepended to the system prompt when the loaded model has a known DB platform. */
export function buildPlatformContext(dbPlatform: string): string {
  return `Database platform: ${dbPlatform}. Use platform-appropriate SQL syntax and capabilities in analysis.\n`;
}

/** Prepended to the system prompt when the user has an active schema filter. */
export function buildSchemaContext(schemas: string[]): string {
  return (
    `Working context: user has schema(s) [${schemas.join(', ')}] selected.\n` +
    `Default all searches, SQL generation, and analysis to these schemas.\n` +
    `If answering the question requires objects from other schemas, ask the user first.\n\n`
  );
}

// ─── Slash Command Prompt Rewrites ────────────────────────────────────────────

/** Rewrites the user prompt for the /trace slash command. */
export function buildTracePrompt(userInput: string): string {
  return `Trace the data lineage for: ${userInput}.`;
}

/** Rewrites the user prompt for the /search slash command. */
export function buildSearchPrompt(userInput: string): string {
  return `Search for database objects matching: ${userInput}.`;
}

// ─── Action-Required Gate ─────────────────────────────────────────────────────

/** Injected as a User message after a tool returns action_required — blocks further tool calls. */
export function buildActionRequiredGate(gates: string[]): string {
  return `STOP: ${gates.join(' | ')} — You MUST address this with the user before calling any more tools.`;
}

/** hint value returned in the gate-rejection tool result while action_required is pending. */
export const ACTION_REQUIRED_PENDING_HINT =
  'You must present the previous action_required message to the user and wait for their response before calling tools.';
