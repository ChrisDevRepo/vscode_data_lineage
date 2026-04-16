/**
 * AI prompt constants — extracted from extension.ts for maintainability.
 *
 * Each constant is a complete prompt string injected at a specific point
 * in the chat loop. See ai/prompt-changelog.md for change history.
 *
 * Navigation Mode prompts are in smPrompts.ts (Universal Markdown blocks).
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
    '3. For ALL lineage investigations (field-level tracking, business rules, multi-object documentation):\n' +
    '   use start_exploration. If tracing columns, provide them in targetColumns.\n' +
    '   BFS (run_bfs_trace) is for structural discovery only — it provides nodes/DDL but CANNOT create views.\n' +
    '   For single-object questions ("explain X"): get_object_detail → chat text.\n' +
    '4. OUTPUT: enrich_view ONLY after completing a start_exploration session.\n' +
    '   Chat text for: pure explanations, SQL generation, list/compare requests (no graph needed).\n' +
    '5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.\n' +
    '   System numbers sections in YOUR sections[] order. Write sections in the narrative sequence you want the reader to follow.\n' +
    '6. MATH: In ALL output — chat text AND enrich_view section text — use LaTeX math syntax for formulas.\n'
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
