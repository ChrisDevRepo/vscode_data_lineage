import type { ObjectType, ColumnDef } from '../engine/types';

/** Node fields required by catalog, DDL, and column search. */
export interface SearchableNode {
  /** Unique identifier of the node (schema.object). */
  id: string;
  /** Name of the database object. */
  name: string;
  /** Schema name the object belongs to. */
  schema: string;
  /** The type of database object (e.g., Table, View). */
  type: ObjectType;
  /** Optional secondary type for external references. */
  externalType?: string;
  /** The raw SQL definition or body script of the object. */
  bodyScript?: string;
  /** The collection of columns belonging to the object. */
  columns?: ColumnDef[];
}

/**
 * Represents a match found within a DDL body script or column list.
 */
interface DdlMatch {
  /** The node that contains the match. */
  node: SearchableNode;
  /** A formatted snippet showing the context of the match. */
  snippet: string;
}

/**
 * One match inside a body script, in the shape a grep-style tool reports.
 *
 * @remarks
 * `line` and `text` carry the location and the matched line itself; `snippet` adds the surrounding
 * context lines. A body with several matches produces one entry per match, never one per object.
 */
export interface BodyMatch extends DdlMatch {
  /** 1-based line number of the match within the body script. */
  line: number;
  /** The matching line, right-trimmed. */
  text: string;
  /**
   * Present, and always `true`, when the match itself sits inside a SQL comment.
   *
   * @remarks
   * Omitted when the match is executable, so a live hit's reported shape is unchanged. The flag is
   * a structural fact about the text — a block comment, or `--` to end of line — and never a
   * filter: a comment can carry the answer (a renamed column, a documented formula), so a
   * commented match is reported like any other and the reading is left to the consumer.
   */
  commented?: true;
}

/** Context lines placed around a match by {@link searchBodyScripts} — the one governor; both callers take it. */
const DEFAULT_SNIPPET_CONTEXT_LINES = 2;

/** Width, in characters, the detail sidebar can render on one line before a match needs a window. */
const SIDEBAR_LINE_CAP = 50;

/**
 * Prefix a snippet line carries when every non-whitespace character on it sits inside a comment.
 *
 * @remarks
 * The reported `commented` flag answers for the matched line only, and a snippet is a few lines
 * wide, so a dead line of context arrives byte-indistinguishable from live code — same indentation,
 * same SQL shape, and the comment's own delimiters outside the window. This states it per line, in
 * the language the text is already written in.
 */
const DEAD_LINE_PREFIX = '--';

/** Heuristic ReDoS guard budget, in milliseconds, applied by {@link compileSearchRegex}. */
const REDOS_BUDGET_MS = 5;

/**
 * Bounded probe inputs for the ReDoS guard.
 *
 * @remarks
 * Catastrophic backtracking is triggered by the character class the nested quantifier consumes,
 * so a single letter run passes patterns such as `(\s+)+$` or `(\[+)+\]` that blow up on the
 * whitespace- and bracket-heavy SQL they are then run over. Each sample covers one class that is
 * dense in DDL bodies.
 */
const REDOS_SAMPLES: readonly string[] = [
  'a'.repeat(200),
  ' \t'.repeat(100),
  '['.repeat(200),
  'a,'.repeat(100),
  'a]'.repeat(100),
];

/**
 * Runs `regex` against each bounded sample and reports whether any run exceeded the ReDoS guard
 * budget.
 *
 * @remarks
 * Uses `performance.now()` (sub-ms precision) instead of `Date.now()` (1ms / 15ms on Windows).
 */
function exceedsRedosBudget(regex: RegExp): boolean {
  for (const sample of REDOS_SAMPLES) {
    const start = performance.now();
    regex.test(sample);
    if (performance.now() - start > REDOS_BUDGET_MS) return true;
  }
  return false;
}

/**
 * Outcome of compiling a search pattern: the regex, or the reason it was refused.
 *
 * @remarks
 * The reason travels with the rejection so the hint is derived from the measurement that actually
 * happened. A `redos` verdict is a wall-clock heuristic, and re-running it can disagree with itself.
 */
type SearchRegexResult =
  /** The pattern compiled and stayed inside the ReDoS budget. */
  | { ok: true; regex: RegExp }
  /** The pattern is not valid JavaScript regex syntax; `error` is what V8 raised. */
  | { ok: false; reason: 'syntax'; error: SyntaxError }
  /** The pattern compiled but exceeded the ReDoS budget on the bounded sample. */
  | { ok: false; reason: 'redos' };

/** Flags every search regex compiles with: grep's contract — case-insensitive, `^`/`$` per line. */
const SEARCH_REGEX_FLAGS = 'im';

/**
 * Strips a leading inline-flag group whose flags are a subset of {@link SEARCH_REGEX_FLAGS}.
 *
 * @param pattern - The raw regex string as received.
 * @returns The pattern with the redundant group removed, or `null` when there is nothing to strip.
 *
 * @remarks
 * `compileSearchRegex` always compiles with `i` and `m`, so a leading `(?i)`, `(?m)` or `(?im)`
 * asks for exactly the behavior already in force — a no-op, so stripping it is lossless. Any other
 * flag letter (`(?s)`, `(?x)`, ...) changes matching semantics the engine does not otherwise apply,
 * so those groups are left untouched and still fail to compile. The scoped form `(?i:...)` is a
 * different construct — it is not a simple prefix, and rewriting it would require re-deriving the
 * subgroup boundary — so it is left untouched too, and still fails to compile like any other
 * unsupported inline-flag syntax.
 *
 * When the group is the entire pattern, stripping it would leave an empty pattern, and an empty
 * regex matches every string — trading a refused search for a silent match-everything. That case is
 * left unstripped on purpose, so it still falls through to the normal syntax rejection below.
 */
function stripRedundantInlineFlags(pattern: string): string | null {
  const match = /^\(\?([im]+)\)/.exec(pattern);
  if (!match) return null;
  const rest = pattern.slice(match[0].length);
  return rest.length > 0 ? rest : null;
}

/**
 * Compiles a search pattern into a safe regular expression with grep's flags ({@link SEARCH_REGEX_FLAGS}).
 *
 * @param pattern - The raw regex string to compile.
 * @param onNormalize - Optional sink for a debug line when a redundant flag group is stripped.
 * @returns The compiled regex, or the rejection reason {@link regexRejectHint} turns into advice.
 *
 * @remarks
 * Rejects patterns that fail to execute against a bounded sample within the guard budget. A
 * redundant leading `(?i)`/`(?m)`/`(?im)` is normalized away before compiling rather than rejected —
 * see {@link stripRedundantInlineFlags} for what qualifies and why.
 */
export function compileSearchRegex(pattern: string, onNormalize?: (msg: string) => void): SearchRegexResult {
  const stripped = stripRedundantInlineFlags(pattern);
  const effectivePattern = stripped ?? pattern;
  if (stripped !== null) {
    onNormalize?.(`compileSearchRegex: stripped redundant inline flag group (flags "${SEARCH_REGEX_FLAGS}" are already in force) — pattern="${pattern}" -> "${stripped}"`);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(effectivePattern, SEARCH_REGEX_FLAGS);
  } catch (err) {
    return { ok: false, reason: 'syntax', error: err instanceof SyntaxError ? err : new SyntaxError(String(err)) };
  }
  // Heuristic ReDoS guard: reject patterns that take too long on a 200-char string.
  if (exceedsRedosBudget(regex)) return { ok: false, reason: 'redos' };
  return { ok: true, regex };
}

/**
 * Names the edit that fixes a pattern {@link compileSearchRegex} refused.
 *
 * @param pattern - The raw regex string that was refused.
 * @param rejection - The refusal, carrying the reason and — for a syntax failure — V8's `SyntaxError`.
 * @returns A hint describing the concrete repair.
 *
 * @remarks
 * The repair is read off the rejection rather than re-derived, so the advice always describes the
 * measurement that rejected the pattern. Every search regex compiles with {@link SEARCH_REGEX_FLAGS},
 * so patterns never need — and JavaScript regular expressions never support — an inline flag group.
 * A redundant `(?i)`/`(?m)`/`(?im)` never reaches this function: `compileSearchRegex` strips it
 * before compiling, so what lands here asks for semantics (`(?s)`, a scoped `(?i:...)`, ...) the
 * engine does not otherwise apply.
 */
export function regexRejectHint(pattern: string, rejection: Extract<SearchRegexResult, { ok: false }>): string {
  if (rejection.reason === 'syntax') {
    const message = rejection.error.message;
    if (/\(\?P</.test(pattern) && message.includes('Invalid group')) {
      return 'Rename the named group from "(?P<name>...)" to "(?<name>...)" — that is the JavaScript syntax.';
    }
    if (/\(\?#/.test(pattern) && message.includes('Invalid group')) {
      return 'Remove the "(?#...)" comment group — JavaScript regular expressions do not support inline comments.';
    }
    if (/\(\?[a-zA-Z-]+[):]/.test(pattern) && message.includes('Invalid group')) {
      return 'Remove the inline flag group (e.g. "(?s)") — matching is already case-insensitive with ^ and $ per line, and JavaScript regular expressions do not support inline flags.';
    }
    if (message.includes('Invalid group')) {
      return 'Remove or correct the unsupported "(?...)" group syntax — JavaScript does not recognize it.';
    }
    if (message.includes('Unterminated group')) {
      return 'Add the missing closing ")" — a "(" (or "(?<name>") was opened but never closed.';
    }
    if (message.includes("Unmatched ')'")) {
      return 'Remove the extra ")" or add the "(" it is meant to close.';
    }
    if (message.includes('Unterminated character class')) {
      return 'Add the missing closing "]" to the character class.';
    }
    if (message.includes('Range out of order in character class')) {
      return 'Reorder the character class range so the lower bound comes first (e.g. "[a-z]", not "[z-a]").';
    }
    if (message.includes('Duplicate capture group name')) {
      return 'Rename one of the duplicate "(?<name>...)" groups — each group name must be unique.';
    }
    if (message.includes('numbers out of order in {} quantifier')) {
      return 'Reorder the quantifier bounds so the minimum comes first (e.g. "{1,2}", not "{2,1}").';
    }
    if (message.includes('Nothing to repeat')) {
      return 'Remove or reposition the quantifier (*, +, ?, or {}) — it has nothing before it to repeat.';
    }
    if (message.includes('at end of pattern')) {
      return 'Remove the trailing "\\" or complete the escape sequence it starts.';
    }
    return `Fix the pattern: ${message.replace(/^Invalid regular expression: .*?: /, '')}.`;
  }

  return 'Simplify the pattern — avoid nested quantifiers (e.g. "(a+)+") that can backtrack catastrophically.';
}

/**
 * Searches the flat node catalog by object name with ranking and filtering.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The search query string.
 * @param types - Optional set of allowed object types.
 * @param schemas - Optional set of allowed schema names.
 * @param limit - Maximum number of results to return (default: 20).
 * @param mode - Search mode: 'substring' (default) or 'regex'.
 *
 * @returns A ranked and filtered array of matching nodes.
 *
 * @remarks
 * In substring mode, results are ranked such that objects whose names
 * START with the query appear before objects that merely contain the query.
 */
export function searchCatalog(
  nodes: SearchableNode[],
  query: string,
  types?: Set<ObjectType>,
  schemas?: Set<string>,
  limit = 20,
  mode: 'substring' | 'regex' = 'substring',
): SearchableNode[] {
  if (query.length < 1) return [];
  let filtered = nodes;
  if (types && types.size > 0) filtered = filtered.filter(n => types.has(n.type));
  if (schemas && schemas.size > 0) filtered = filtered.filter(n => schemas.has(n.schema));

  // Regex mode: match against name or schema.name
  if (mode === 'regex') {
    const compiled = compileSearchRegex(query);
    if (!compiled.ok) return [];
    const re = compiled.regex;
    return filtered
      .filter(n => re.test(n.name) || re.test(`${n.schema}.${n.name}`))
      .slice(0, limit);
  }

  // Substring mode (default): case-insensitive, starts-with ranked first
  const lower = query.toLowerCase();
  const matches = filtered
    .map(n => ({ node: n, nameLower: n.name.toLowerCase(), idLower: n.id.toLowerCase() }))
    .filter(m => m.nameLower.includes(lower) || m.idLower.includes(lower));

  matches.sort((a, b) => {
    const aStarts = a.nameLower.startsWith(lower) || a.idLower.startsWith(lower);
    const bStarts = b.nameLower.startsWith(lower) || b.idLower.startsWith(lower);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return a.node.name.localeCompare(b.node.name);
  });

  return matches.slice(0, limit).map(m => m.node);
}

/**
 * Searches the SQL DDL body scripts for a specific term.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The term to search for (minimum 2 chars), or a compiled pattern.
 * @param types - Optional set of allowed object types.
 * @param contextLines - Number of context lines to include in the snippet.
 * @param limit - Maximum number of matches to return; omitted means unbounded.
 *
 * @returns An array of matches, each carrying its node, 1-based line, matched line and context.
 *
 * @remarks
 * The two query forms are two callers with two contracts. A string is the detail sidebar's
 * case-insensitive substring: one match per object, the panel's line width applied, and its own
 * display cap. A RegExp is the pattern `compileSearchRegex` accepted for `lineage_search_ddl`,
 * whose contract is grep's: every match in every body, with its line number, and no truncation —
 * neither a per-line window nor a result cap.
 */
export function searchBodyScripts(
  nodes: SearchableNode[],
  query: string | RegExp,
  types?: Set<ObjectType>,
  contextLines = DEFAULT_SNIPPET_CONTEXT_LINES,
  limit?: number,
): BodyMatch[] {
  const regex = typeof query === 'string' ? null : query;
  if (typeof query === 'string' && query.length < 2) return [];
  const lower = typeof query === 'string' ? query.toLowerCase() : '';
  const lineCap = regex === null ? SIDEBAR_LINE_CAP : Number.POSITIVE_INFINITY;
  const cap = limit ?? Number.POSITIVE_INFINITY;
  let filtered = nodes;
  if (types && types.size > 0) filtered = filtered.filter(n => n.bodyScript && types.has(n.type));

  // One allocation for the whole sweep, not one per node: `compileSearchRegex` fixes the flags, and
  // walking every match in a body needs the `g` flag's `lastIndex` cursor.
  const scanner = regex === null ? null : regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);

  const matches: BodyMatch[] = [];
  for (const node of filtered) {
    const body = node.bodyScript;
    if (!body) continue;
    const lines = body.split('\n');
    const lineStarts = buildLineStarts(lines);
    // One pass per body, and only once a match exists: a body nobody hits is never scanned.
    let commentMask: Uint8Array | null = null;
    const comments = (): Uint8Array => (commentMask ??= scanComments(lines, lineStarts, body.length));
    let deadMask: Uint8Array | null = null;
    const deadLines = (): Uint8Array => (deadMask ??= markDeadLines(lines, lineStarts, comments()));

    if (scanner === null) {
      const idx = body.toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      matches.push(makeMatch(node, lines, lineStarts, idx, query as string, contextLines, lineCap, comments(), deadLines()));
      if (matches.length >= cap) break;
      continue;
    }

    scanner.lastIndex = 0;
    let hit: RegExpExecArray | null;
    let capped = false;
    while ((hit = scanner.exec(body)) !== null) {
      // A zero-length match (`x*`, `^`) advances nothing on its own: skip the position rather than
      // the node, or the first empty match hides every real match later in the same body.
      if (hit[0].length === 0) { scanner.lastIndex++; continue; }
      matches.push(makeMatch(node, lines, lineStarts, hit.index, hit[0], contextLines, lineCap, comments(), deadLines()));
      if (matches.length >= cap) { capped = true; break; }
    }
    if (capped) break;
  }
  return matches;
}

/** Start offset of every line, so a match index resolves to its line without rescanning the body. */
function buildLineStarts(lines: string[]): number[] {
  const starts = new Array<number>(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  return starts;
}

/** Zero-based index of the line containing `index`. */
function lineIndexAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid; else high = mid - 1;
  }
  return low;
}

/** Assembles one reported match from its position in the body. */
function makeMatch(
  node: SearchableNode,
  lines: string[],
  lineStarts: number[],
  index: number,
  matchText: string,
  contextLines: number,
  lineCap: number,
  commentMask: Uint8Array,
  deadLine: Uint8Array,
): BodyMatch {
  const matchLine = lineIndexAt(lineStarts, index);
  const match: BodyMatch = {
    node,
    line:    matchLine + 1,
    text:    lines[matchLine].trimEnd(),
    snippet: buildSnippet(lines, matchLine, matchText, contextLines, lineCap, deadLine),
  };
  // Set only when true: an executable match keeps the shape it has always had.
  if (commentMask[index] === 1) match.commented = true;
  return match;
}

/**
 * Marks every character of a body that lies inside a SQL comment.
 *
 * @param lines - The body split on newlines, as {@link searchBodyScripts} already holds it.
 * @param lineStarts - Start offset of each line, so a flag lands at the body offset a match uses.
 * @param length - Length of the body the offsets index into.
 * @returns One byte per body character: `1` inside a comment, `0` outside.
 *
 * @remarks
 * The context window a match is reported with is a few lines wide, so a match deep inside a long
 * comment block arrives indistinguishable from live code — the whole comment structure sits outside
 * the window. This pass restores that one bit, per character rather than per line, so a match after
 * a trailing `--` is marked while live code on the same line is not.
 *
 * Enough T-SQL to be right about where a comment starts and ends: block comments nest, a `--` runs
 * to end of line, and a string literal or a bracketed identifier hides both delimiters. Doubled
 * `''` and `]]` escapes need no case of their own — closing and immediately reopening leaves the
 * same state with nothing between. Quoted `"` identifiers are not tracked: both readings of `"` are
 * delimiters, but a lone `"` is the more common typo and tracking it would swallow the rest of a
 * body. An unterminated block comment marks the remainder, which is how a reader takes it too.
 */
function scanComments(lines: string[], lineStarts: number[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  /** `/*` nesting depth; T-SQL nests block comments and requires them balanced. */
  let depth = 0;
  /** The character that closes the open literal or identifier, or `''` when none is open. */
  let closer = '';
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const base = lineStarts[l];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (depth > 0) {
        mask[base + i] = 1;
        if (ch === '/' && next === '*') { depth++; mask[base + ++i] = 1; }
        else if (ch === '*' && next === '/') { depth--; mask[base + ++i] = 1; }
        continue;
      }
      if (closer !== '') {
        if (ch === closer) closer = '';
        continue;
      }
      if (ch === '-' && next === '-') {
        mask.fill(1, base + i, base + line.length);
        break;
      }
      if (ch === '/' && next === '*') {
        depth = 1;
        mask[base + i] = 1;
        mask[base + ++i] = 1;
        continue;
      }
      if (ch === '\'') closer = '\'';
      else if (ch === '[') closer = ']';
    }
  }
  return mask;
}

/**
 * Searches for nodes by matching column names.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The column name term to search for.
 * @param limit - Maximum number of results to return.
 *
 * @returns An array of matches containing the node and a list of matching columns.
 */
export function searchColumns(
  nodes: SearchableNode[],
  query: string,
  limit = 100,
): DdlMatch[] {
  if (query.length < 2) return [];
  const lower = query.toLowerCase();
  const matches: DdlMatch[] = [];
  for (const node of nodes) {
    if (node.type !== 'table' && node.type !== 'external') continue;
    if (!node.columns?.length) continue;
    const matching = node.columns.filter(c => c.name.toLowerCase().includes(lower));
    if (matching.length === 0) continue;
    const snippet = matching.slice(0, 3).map(c => `${c.name} (${c.type})`).join(', ');
    matches.push({ node, snippet });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Characters of lead-in kept before the match when a line is windowed to {@link SIDEBAR_LINE_CAP}. */
const SIDEBAR_WINDOW_LEAD = 10;

/**
 * Builds a formatted context snippet for a match found in a body script.
 *
 * @param lines - The body split on newlines.
 * @param matchLine - Zero-based index of the line holding the match.
 * @param matchText - The text that matched, used to place the window on an over-wide line.
 * @param contextLines - The number of lines around the match to include.
 * @param lineCap - Width at which a line is windowed around the match; `Infinity` never windows.
 * @returns A multi-line string containing the match context.
 */
function buildSnippet(
  lines: string[],
  matchLine: number,
  matchText: string,
  contextLines: number,
  lineCap: number,
  deadLine: Uint8Array,
): string {
  const start = Math.max(0, matchLine - (contextLines - 1));
  const end = Math.min(lines.length, matchLine + contextLines);
  const termLower = matchText.toLowerCase();
  // Applied at every return, after the window is chosen: the prefix states the line's status and
  // must not enter the cap arithmetic that decides what of the line is shown.
  const mark = (lineIndex: number, rendered: string): string =>
    deadLine[lineIndex] === 1 ? `${DEAD_LINE_PREFIX}${rendered}` : rendered;
  return lines.slice(start, end).map((l, offset) => {
    const lineIndex = start + offset;
    const trimmed = l.trimEnd();
    if (trimmed.length <= lineCap) return mark(lineIndex, trimmed);
    const matchPos = termLower.length > 0 ? trimmed.toLowerCase().indexOf(termLower) : -1;
    if (matchPos < 0) return mark(lineIndex, trimmed);
    // Trim long lines so the match stays within the visible panel width.
    const windowStart = Math.max(0, matchPos - SIDEBAR_WINDOW_LEAD);
    const windowEnd = Math.min(trimmed.length, windowStart + lineCap);
    return mark(lineIndex, (windowStart > 0 ? '\u2026' : '') +
      trimmed.slice(windowStart, windowEnd) +
      (windowEnd < trimmed.length ? '\u2026' : ''));
  }).join('\n');
}

/**
 * Projects the per-character comment mask onto whole lines.
 *
 * @param lines - The body split on newlines.
 * @param lineStarts - Start offset of each line, as {@link buildLineStarts} computes it.
 * @param commentMask - The per-character mask {@link scanComments} already produced for this body.
 * @returns One byte per line: `1` when the line carries content and every non-whitespace character
 *   of it lies inside a comment, `0` otherwise.
 *
 * @remarks
 * Reads a mask it does not create — there is no character classification here and no second view of
 * T-SQL. A line mixing live code with a trailing `--` is NOT dead: part of it executes, and calling
 * it dead would hide that. A blank line is not dead either; it carries nothing to mislabel.
 */
function markDeadLines(lines: string[], lineStarts: number[], commentMask: Uint8Array): Uint8Array {
  const dead = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const base = lineStarts[i];
    let content = false;
    let allInComment = true;
    for (let c = 0; c < line.length; c++) {
      const ch = line.charCodeAt(c);
      if (ch === 32 || ch === 9 || ch === 13) continue;
      content = true;
      if (commentMask[base + c] !== 1) { allInComment = false; break; }
    }
    dead[i] = content && allInComment ? 1 : 0;
  }
  return dead;
}
