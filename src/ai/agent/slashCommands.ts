/**
 * Deterministic slash-command routing for the entry detector.
 *
 * `/trace` and `/search` are the user *stating* intent — command parsing, not language guessing —
 * so the runtime routes them without a model classifier. Free-prose intent is exclusively the
 * structured entry detector's decision; regex or keyword matching over natural language never
 * selects a route.
 *
 * VS Code-free: imported only by the agent runtime.
 */
import type { AgentEntryRoute, AgentExecutionTrigger } from './state';

/** A pinned entry route for a recognized deterministic command/intent. */
interface SlashRoute {
  /** Entry route pinned by the command. */
  readonly entry: AgentEntryRoute;
  /** Mechanical command source; separate from the semantic route. */
  readonly trigger: AgentExecutionTrigger;
  /** Columns parsed from a `/trace [schema].[table].[column]` request; `null` when none were named. */
  readonly targetColumns: string[] | null;
}

const SLASH_RE = /^\s*\/(trace|search)\b[ \t]*/i;
const BRACKET_TOKEN_RE = /\[([^\]]+)\]/g;

/**
 * Pins an entry route for a leading `/trace` or `/search` command, skipping the entry-detector
 * model call.
 *
 * @param prompt - The raw user prompt (the participant prepends `/<command> ` for chat commands).
 * @returns The pinned route, or `null` when no recognized command leads the prompt — the caller
 *   then runs the LLM entry detector as usual.
 * @remarks `/search` stays in discovery. `/trace` sets the explicit SM trigger and carries a
 *   `column_trace` semantic route only when the text names a fully-qualified column. Otherwise it
 *   carries the neutral discovery verdict; the command trigger, not a fabricated visual verdict,
 *   opens BB SM.
 */
export function detectSlashRoute(prompt: string): SlashRoute | null {
  const match = SLASH_RE.exec(prompt);
  if (!match) return null;
  if (match[1].toLowerCase() === 'search') {
    return { entry: 'discovery', trigger: 'free_text', targetColumns: null };
  }
  const columns = parseTraceColumns(prompt.slice(match[0].length));
  return { entry: columns ? 'column_trace' : 'discovery', trigger: 'slash_trace', targetColumns: columns };
}

/**
 * Extracts column names from `/trace` text: per comma-separated segment, a fully-qualified
 * reference (≥3 bracketed tokens, e.g. `[schema].[table].[column]`) contributes its last token as
 * the column. A 2-part `[schema].[object]` is a node id, and a bare `[X]` is an object — neither is
 * a column.
 *
 * @returns The column names, or `null` when none were named.
 */
function parseTraceColumns(text: string): string[] | null {
  const columns: string[] = [];
  for (const segment of text.split(',')) {
    const tokens = [...segment.matchAll(BRACKET_TOKEN_RE)].map(m => m[1].trim()).filter(Boolean);
    if (tokens.length >= 3) columns.push(tokens[tokens.length - 1]);
  }
  return columns.length > 0 ? columns : null;
}
