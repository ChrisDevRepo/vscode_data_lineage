/** Deterministic slash-command routing for the entry detector. */
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
/** One contiguous dot-joined bracket chain of 3+ parts, e.g. `[schema].[table].[column]`. */
const BRACKET_CHAIN_RE = /(?:\[[^\]]+\]\.){2,}\[[^\]]+\]/g;

/** Pins an entry route for a leading `/trace` or `/search` command, skipping the entry-detector model call. */
export function detectSlashRoute(prompt: string): SlashRoute | null {
  const match = SLASH_RE.exec(prompt);
  if (!match) return null;
  if (match[1].toLowerCase() === 'search') {
    return { entry: 'discovery', trigger: 'free_text', targetColumns: null };
  }
  const columns = parseTraceColumns(prompt.slice(match[0].length));
  return { entry: columns ? 'column_trace' : 'discovery', trigger: 'slash_trace', targetColumns: columns };
}

/** Extracts column names from `/trace` text: each contiguous dot-joined bracket chain of 3+ parts (e.g. `[schema].[table].[column]`) contributes its last token as the column. A 2-part `[schema].[object]` is a node id, and a bare `[X]` is an object — neither is a column, and two such ids named separately in the same sentence never combine into a fabricated chain. */
function parseTraceColumns(text: string): string[] | null {
  const columns = [...text.matchAll(BRACKET_CHAIN_RE)].map((chainMatch) => {
    const tokens = [...chainMatch[0].matchAll(BRACKET_TOKEN_RE)].map(m => m[1].trim());
    return tokens[tokens.length - 1];
  });
  return columns.length > 0 ? columns : null;
}

