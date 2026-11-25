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
  /** Object ids named by a `/trace` request, as typed and unresolved; `null` when none. */
  readonly objectIds: string[] | null;
}

const SLASH_RE = /^\s*\/(trace|search)\b[ \t]*/i;
/** One bracketed identifier; `]]` inside is an escaped `]`. */
const BRACKET_IDENTIFIER = String.raw`\[(?:[^\]]|\]\])+\]`;
const BRACKET_TOKEN_RE = new RegExp(BRACKET_IDENTIFIER, 'g');
/** One contiguous dot-joined bracket chain of 2+ parts, e.g. `[schema].[table].[column]`. */
const BRACKET_CHAIN_RE = new RegExp(`(?:${BRACKET_IDENTIFIER}\\.)+${BRACKET_IDENTIFIER}`, 'g');

/**
 * Pins an entry route for a leading `/trace` or `/search` command, skipping the entry-detector
 * model call. `/search` stays in discovery. `/trace` sets the explicit SM trigger and carries a
 * `column_trace` route only when the text names a fully-qualified column; otherwise the neutral
 * discovery verdict, so the command trigger, not a fabricated visual verdict, opens BB SM. It also
 * keeps each named object id for the host to resolve.
 *
 * @param prompt - The raw user prompt (the participant prepends `/<command> ` for chat commands).
 * @returns The pinned route, or `null` when no recognized command leads the prompt (the caller then
 *   runs the LLM entry detector).
 */
export function detectSlashRoute(prompt: string): SlashRoute | null {
  const match = SLASH_RE.exec(prompt);
  if (!match) return null;
  if (match[1].toLowerCase() === 'search') {
    return { entry: 'discovery', trigger: 'free_text', targetColumns: null, objectIds: null };
  }
  const { columns, objectIds } = parseTraceTargets(prompt.slice(match[0].length));
  return { entry: columns ? 'column_trace' : 'discovery', trigger: 'slash_trace', targetColumns: columns, objectIds };
}

/**
 * Extracts columns and object ids from `/trace` text, per contiguous dot-joined bracket chain: a
 * chain of 3+ parts (`[schema].[table].[column]`) contributes its last token as a column and the
 * rest as an object id; a 2-part `[schema].[object]` is an object id whole. A bare `[X]` is
 * neither, and two ids named separately in one sentence never combine into a fabricated chain.
 * Each list is `null` when none were named.
 */
function parseTraceTargets(text: string): { columns: string[] | null; objectIds: string[] | null } {
  const columns: string[] = [];
  const objectIds: string[] = [];
  for (const chainMatch of text.matchAll(BRACKET_CHAIN_RE)) {
    const tokens = [...chainMatch[0].matchAll(BRACKET_TOKEN_RE)].map(m => m[0]);
    if (tokens.length === 2) {
      objectIds.push(chainMatch[0]);
      continue;
    }
    columns.push(stripBrackets(tokens[tokens.length - 1]).trim());
    objectIds.push(tokens.slice(0, -1).join('.'));
  }
  return { columns: columns.length > 0 ? columns : null, objectIds: objectIds.length > 0 ? objectIds : null };
}
