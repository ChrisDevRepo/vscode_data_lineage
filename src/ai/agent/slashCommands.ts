/**
 * Deterministic slash-command routing for the entry detector. `/trace` and `/search` are the user
 * *stating* intent (command parsing, not language guessing), so the runtime routes them without a
 * model classifier; free-prose intent is exclusively the structured entry detector's decision and
 * regex or keyword matching over natural language never selects a route. VS Code-free; imported
 * only by the agent runtime.
 */
import { stripBrackets } from '../../utils/sql';
import type { AgentEntryRoute, AgentExecutionTrigger } from './state';

/** A pinned entry route for a recognized deterministic command/intent. */
interface SlashRoute {
  /** Entry route pinned by the command. */
  readonly entry: AgentEntryRoute;
  /** Mechanical command source; separate from the semantic route. */
  readonly trigger: AgentExecutionTrigger;
  /** Columns parsed from a `/trace [schema].[table].[column]` request; `null` when none. */
  readonly targetColumns: string[] | null;
}

const SLASH_RE = /^\s*\/(trace|search)\b[ \t]*/i;
/** `/clear` and its alias `/new`, as the whole message. */
const CLEAR_RE = /^\s*\/(?:clear|new)\s*$/i;
/** One bracketed identifier; `]]` inside is an escaped `]`. */
const BRACKET_IDENTIFIER = String.raw`\[(?:[^\]]|\]\])+\]`;
const BRACKET_TOKEN_RE = new RegExp(BRACKET_IDENTIFIER, 'g');
/** One contiguous dot-joined bracket chain of 3+ parts, e.g. `[schema].[table].[column]`. */
const BRACKET_CHAIN_RE = new RegExp(`(?:${BRACKET_IDENTIFIER}\\.){2,}${BRACKET_IDENTIFIER}`, 'g');

/**
 * Whether the message is the host command `/clear` (alias `/new`): the chat host starts a new chat
 * for it and makes no model call, so the command never reaches {@link detectSlashRoute}. Only the
 * whole message counts; `/clear` followed by text is a prompt.
 */
export function isClearCommand(prompt: string): boolean {
  return CLEAR_RE.test(prompt);
}

/**
 * Pins an entry route for a leading `/trace` or `/search` command, skipping the entry-detector
 * model call. `/search` stays in discovery. `/trace` sets the explicit SM trigger and carries a
 * `column_trace` route only when the text names a fully-qualified column; otherwise the neutral
 * discovery verdict, so the command trigger, not a fabricated visual verdict, opens BB SM.
 *
 * @param prompt - The raw user prompt (the chat host prepends `/<command> ` for chat commands).
 * @returns The pinned route, or `null` when no recognized command leads the prompt (the caller then
 *   runs the LLM entry detector).
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
 * Extracts column names from `/trace` text: each contiguous dot-joined bracket chain of 3+ parts
 * (`[schema].[table].[column]`) contributes its last token. A 2-part `[schema].[object]` is a node
 * id and a bare `[X]` an object, neither a column, and two ids named separately in one sentence
 * never combine into a fabricated chain. `null` when none were named.
 */
function parseTraceColumns(text: string): string[] | null {
  const columns = [...text.matchAll(BRACKET_CHAIN_RE)].map((chainMatch) => {
    const tokens = [...chainMatch[0].matchAll(BRACKET_TOKEN_RE)].map(m => m[0]);
    return stripBrackets(tokens[tokens.length - 1]).trim();
  });
  return columns.length > 0 ? columns : null;
}

