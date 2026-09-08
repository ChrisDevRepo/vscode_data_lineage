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
  /**
   * The innermost `IF` / `WHILE` condition that governs the matched line, whitespace-normalized.
   *
   * @remarks
   * Omitted when the line is unconditional, when the match is itself dead, and whenever the block
   * structure around it does not resolve with certainty — a wrong condition welded onto a
   * statement is the defect this field exists to remove, so absent is the only other answer it
   * gives. An `ELSE` branch reports `NOT (<condition>)`, which is what governs it.
   *
   * Same reason as {@link commented}: the few context lines a hit ships with cannot show the block
   * it sits in, so a gated statement and an ungated one arrive identical and the reader attaches
   * whichever condition the payload happens to contain.
   */
  enclosingPredicate?: string;
}

/** Context lines placed around a match by {@link searchBodyScripts} — the one governor; both callers take it. */
const DEFAULT_SNIPPET_CONTEXT_LINES = 2;

/**
 * Longest condition reported as {@link BodyMatch.enclosingPredicate}; past it the field is omitted.
 *
 * @remarks
 * A truncated condition is a wrong condition — `@a = 1 AND @b = 0` cut to `@a = 1` inverts what the
 * reader concludes — so an over-long one is dropped whole rather than shortened.
 */
const PREDICATE_MAX_CHARS = 200;

/** Width, in characters, the detail sidebar can render on one line before a match needs a window. */
const SIDEBAR_LINE_CAP = 50;

/** Heuristic ReDoS guard budget, in milliseconds, applied by {@link compileSearchRegex}. */
const REDOS_BUDGET_MS = 5;

/**
 * Runs `regex` against a bounded sample and reports whether it exceeded the ReDoS guard budget.
 *
 * @remarks
 * Uses `performance.now()` (sub-ms precision) instead of `Date.now()` (1ms / 15ms on Windows).
 */
function exceedsRedosBudget(regex: RegExp): boolean {
  const sample = 'a'.repeat(200);
  const start = performance.now();
  regex.test(sample);
  return performance.now() - start > REDOS_BUDGET_MS;
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
  onDebug?: (msg: string) => void,
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
  const scanner = regex === null ? null : new RegExp(regex.source, `${regex.flags}g`);

  const matches: BodyMatch[] = [];
  for (const node of filtered) {
    const body = node.bodyScript;
    if (!body) continue;
    const lines = body.split('\n');
    const lineStarts = buildLineStarts(lines);
    // One pass per body, and only once a match exists: a body nobody hits is never scanned.
    let scanned: BodyStructure | null = null;
    const structure = (): BodyStructure => (scanned ??= readStructure(node, lines, lineStarts, body, onDebug));

    if (scanner === null) {
      const idx = body.toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      matches.push(makeMatch(node, lines, lineStarts, idx, query as string, contextLines, lineCap, structure()));
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
      matches.push(makeMatch(node, lines, lineStarts, hit.index, hit[0], contextLines, lineCap, structure()));
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

/**
 * Reads one body's structural facts, naming the object in whatever the derivation could not resolve.
 *
 * @param node - The object whose body is being read, so a skip line says which one it was.
 * @param lines - The body split on newlines.
 * @param lineStarts - Start offset of each line.
 * @param body - The body script itself.
 * @param onDebug - Optional sink; every unresolved region is stated, never silently dropped.
 * @returns The comment mask and the per-line governing conditions.
 */
function readStructure(
  node: SearchableNode,
  lines: string[],
  lineStarts: number[],
  body: string,
  onDebug?: (msg: string) => void,
): BodyStructure {
  const scan = scanBody(lines, lineStarts, body.length);
  const say = (reason: string): void => { onDebug?.(`searchBodyScripts: ${node.id} — ${reason}`); };
  const predicateOfLine = derivePredicates(body, scan, lineStarts, lines.length, say);
  if (scan.unterminatedAtLine >= 0) {
    say(`block comment opened on line ${scan.unterminatedAtLine + 1} is never closed — every line from there on is reported as commented`);
  }
  return { mask: scan.mask, predicateOfLine, deadLine: markDeadLines(lines, lineStarts, scan.mask) };
}

/**
 * Projects the per-character comment mask onto whole lines.
 *
 * @param lines - The body split on newlines.
 * @param lineStarts - Start offset of each line.
 * @param mask - The per-character comment mask {@link scanBody} produced for that same body.
 * @returns One byte per line: `1` when the line carries code and none of it executes.
 *
 * @remarks
 * The one direction that must never be wrong is marking live code dead: that deletes real lineage,
 * and losing a statement costs more than leaving one unexplained. So a line is dead only when every
 * one of its non-whitespace characters is masked — a live statement with a trailing `--` note keeps
 * the live reading, and a whitespace-only line inside a block claims nothing either way, since a
 * blank line reads as a separator rather than as behaviour.
 *
 * No second scanner: this reads the mask {@link scanBody} already produced over exactly this text,
 * which is the only place in this module that knows where a comment, a string literal and a
 * bracketed identifier begin and end.
 */
function markDeadLines(lines: string[], lineStarts: number[], mask: Uint8Array): Uint8Array {
  const dead = new Uint8Array(lines.length);
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const base = lineStarts[l];
    let sawCode = false;
    let allMasked = true;
    for (let i = 0; i < line.length && allMasked; i++) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t' || ch === '\r') continue;
      sawCode = true;
      if (mask[base + i] !== 1) allMasked = false;
    }
    if (sawCode && allMasked) dead[l] = 1;
  }
  return dead;
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
  structure: BodyStructure,
): BodyMatch {
  const matchLine = lineIndexAt(lineStarts, index);
  const match: BodyMatch = {
    node,
    line:    matchLine + 1,
    text:    lines[matchLine].trimEnd(),
    snippet: buildSnippet(lines, matchLine, matchText, contextLines, lineCap, structure.deadLine),
  };
  // Set only when true: an executable match keeps the shape it has always had.
  if (structure.mask[index] === 1) {
    match.commented = true;
    // A dead line has no governing condition: the flag is the whole story, and naming the live
    // block a comment happens to sit in would read as the comment being gated by it.
    return match;
  }
  const predicate = structure.predicateOfLine[matchLine];
  if (predicate !== null) match.enclosingPredicate = predicate;
  return match;
}

/** A structural keyword or punctuation mark the body scan reports, in body order. */
type StructuralWord =
  'IF' | 'ELSE' | 'WHILE' | 'BEGIN' | 'END' | 'CASE' | 'TRY' | 'CATCH' | 'TRANSACTION' | 'TRAN';

/** What {@link scanBody} emits: a structural word, or one of the three punctuation marks. */
type StructuralToken = StructuralWord | '(' | ')' | ';';

/** Live occurrence of a structural token: its kind, and the body offsets it spans. */
interface TokenHit {
  /** The token kind. */
  kw: StructuralToken;
  /** Body offset of the token's first character. */
  start: number;
  /** Body offset one past the token's last character. */
  end: number;
}

/** The words {@link scanBody} reports; every other identifier is skipped. */
const STRUCTURAL_WORDS = new Set<string>(
  ['IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'CASE', 'TRY', 'CATCH', 'TRANSACTION', 'TRAN'],
);

/** Body characters that continue a T-SQL identifier, so `@IF` and `IIF` are not the keyword `IF`. */
function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
    ch === '_' || ch === '@' || ch === '#' || ch === '$';
}

/** One pass over a body: which characters are dead, and where the live block keywords are. */
interface BodyScan {
  /** One byte per body character: `1` inside a comment, `0` outside. */
  mask: Uint8Array;
  /** Every live structural token, in body order; nothing inside a comment or a literal appears. */
  tokens: TokenHit[];
  /** Zero-based line of a block comment the body never closes, or `-1` when every block closes. */
  unterminatedAtLine: number;
}

/**
 * Reads a body once: marks every character inside a SQL comment, and collects the live block
 * keywords the same walk already has the state to recognise.
 *
 * @param lines - The body split on newlines, as {@link searchBodyScripts} already holds it.
 * @param lineStarts - Start offset of each line, so a flag lands at the body offset a match uses.
 * @param length - Length of the body the offsets index into.
 * @returns The comment mask and the live structural tokens.
 *
 * @remarks
 * The context window a match is reported with is a few lines wide, so a match deep inside a long
 * comment block arrives indistinguishable from live code — the whole comment structure sits outside
 * the window. This pass restores that one bit, per character rather than per line, so a match after
 * a trailing `--` is marked while live code on the same line is not. The same sentence is true of
 * control flow, and the same walk answers it: knowing where a comment, a string literal and a
 * bracketed identifier begin and end is exactly what it takes to know which `IF` and which `BEGIN`
 * are real, so the keywords are collected here rather than by a second scanner that would have to
 * rediscover all of it.
 *
 * Enough T-SQL to be right about where a comment starts and ends: block comments nest, a `--` runs
 * to end of line, and a string literal or a bracketed identifier hides both delimiters. Doubled
 * `''` and `]]` escapes need no case of their own — closing and immediately reopening leaves the
 * same state with nothing between. Quoted `"` identifiers are not tracked: both readings of `"` are
 * delimiters, but a lone `"` is the more common typo and tracking it would swallow the rest of a
 * body. An unterminated block comment marks the remainder, which is how a reader takes it too.
 */
function scanBody(lines: string[], lineStarts: number[], length: number): BodyScan {
  const mask = new Uint8Array(length);
  const tokens: TokenHit[] = [];
  /** `/*` nesting depth; T-SQL nests block comments and requires them balanced. */
  let depth = 0;
  /** The character that closes the open literal or identifier, or `''` when none is open. */
  let closer = '';
  /** Zero-based line the outermost still-open block comment was opened on, or `-1` when none is. */
  let openedAt = -1;
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const base = lineStarts[l];
    /** Index in `line` where the identifier being read began, or `-1` between identifiers. */
    let wordStart = -1;
    const endWord = (at: number): void => {
      if (wordStart < 0) return;
      const word = line.slice(wordStart, at).toUpperCase();
      if (STRUCTURAL_WORDS.has(word)) {
        tokens.push({ kw: word as StructuralWord, start: base + wordStart, end: base + at });
      }
      wordStart = -1;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (depth > 0) {
        mask[base + i] = 1;
        if (ch === '/' && next === '*') { depth++; mask[base + ++i] = 1; }
        else if (ch === '*' && next === '/') { if (--depth === 0) openedAt = -1; mask[base + ++i] = 1; }
        continue;
      }
      if (closer !== '') {
        if (ch === closer) closer = '';
        continue;
      }
      if (ch === '-' && next === '-') {
        endWord(i);
        mask.fill(1, base + i, base + line.length);
        break;
      }
      if (ch === '/' && next === '*') {
        endWord(i);
        depth = 1;
        openedAt = l;
        mask[base + i] = 1;
        mask[base + ++i] = 1;
        continue;
      }
      if (isWordChar(ch)) {
        if (wordStart < 0) wordStart = i;
        continue;
      }
      endWord(i);
      if (ch === '\'') closer = '\'';
      else if (ch === '[') closer = ']';
      else if (ch === '(' || ch === ')' || ch === ';') {
        tokens.push({ kw: ch, start: base + i, end: base + i + 1 });
      }
    }
    endWord(line.length);
  }
  return { mask, tokens, unterminatedAtLine: depth > 0 ? openedAt : -1 };
}

/** A body's structural facts, in the shape {@link makeMatch} reads them. */
interface BodyStructure {
  /** One byte per body character: `1` inside a comment, `0` outside. */
  mask: Uint8Array;
  /** Per zero-based line: the innermost governing condition, or `null` when there is none to state. */
  predicateOfLine: (string | null)[];
  /** Per zero-based line: `1` when the line carries code but none of it executes, `0` otherwise. */
  deadLine: Uint8Array;
}

/** An open `BEGIN…END`, `BEGIN TRY/CATCH` or `CASE…END` while the token walk is inside it. */
interface OpenBlock {
  /** `case` and `try` frames only keep the stack honest; `block` is the one that can govern lines. */
  kind: 'block' | 'case' | 'try';
  /** The condition governing this block, or `null` when the block is not conditional. */
  predicate: string | null;
  /** Zero-based line the block's governing keyword sits on — the `IF`, `WHILE` or `ELSE`. */
  startLine: number;
  /** Set when the block is governed by a condition that did not resolve, so its lines stay silent. */
  suppress: boolean;
}

/** Where a lookahead from `IF` / `WHILE` / `ELSE` landed: the block it opens, or nothing it can claim. */
type BlockLookahead =
  /** The keyword governs the `BEGIN…END` block whose `BEGIN` is `tokens[beginIndex]`. */
  | { ok: true; beginIndex: number }
  /** Nothing resolved; `throughToken` is the token the search stopped on, or `tokens.length`. */
  | { ok: false; throughToken: number };

/**
 * Reports whether `next` is the very next word after `at`, with only whitespace between them.
 *
 * @param body - The body script the offsets index into.
 * @param at - The earlier token.
 * @param next - The token that may complete it.
 * @returns `true` when the two are one construct, such as `BEGIN TRY` or `END CATCH`.
 *
 * @remarks
 * Adjacency is the whole test. `BEGIN` followed somewhere later by a `ROLLBACK TRANSACTION` is a
 * block whose first statement happens to name a transaction, not `BEGIN TRANSACTION`, and reading
 * it as the latter loses an opening the matching `END` still closes.
 */
function isAdjacent(body: string, at: TokenHit, next: TokenHit | undefined): boolean {
  return next !== undefined && body.slice(at.end, next.start).trim() === '';
}

/** The words that, immediately after `BEGIN`, mean it does not open a `BEGIN…END` block of its own. */
function opensNamedConstruct(body: string, tokens: TokenHit[], beginIndex: number): 'try' | 'transaction' | null {
  const after = tokens[beginIndex + 1];
  if (!isAdjacent(body, tokens[beginIndex], after)) return null;
  if (after!.kw === 'TRY' || after!.kw === 'CATCH') return 'try';
  if (after!.kw === 'TRANSACTION' || after!.kw === 'TRAN') return 'transaction';
  return null;
}

/**
 * Finds the `BEGIN…END` block an `IF`, `WHILE` or `ELSE` at `from` governs.
 *
 * @param body - The body script the offsets index into.
 * @param tokens - The live structural tokens of the body.
 * @param from - Index of the governing keyword.
 * @returns The index of the `BEGIN` it governs, or the refusal and where it stopped.
 *
 * @remarks
 * Only the block form resolves. A single-statement `IF` governs a region whose end is a guess, and
 * `BEGIN TRANSACTION` / `BEGIN TRY` are not blocks this keyword owns, so both stop the search
 * rather than producing a condition that would be attached to the wrong lines. Parenthesised text
 * is skipped wholesale: a condition is free to contain `(SELECT …)` and its keywords are not the
 * statement's structure.
 */
function findGovernedBlock(body: string, tokens: TokenHit[], from: number): BlockLookahead {
  let parens = 0;
  for (let k = from + 1; k < tokens.length; k++) {
    const kw = tokens[k].kw;
    if (kw === '(') { parens++; continue; }
    if (kw === ')') { parens--; continue; }
    if (parens > 0) continue;
    if (kw !== 'BEGIN') return { ok: false, throughToken: k };
    // `BEGIN TRY` and `BEGIN TRANSACTION` are not the block this keyword governs.
    if (opensNamedConstruct(body, tokens, k) !== null) return { ok: false, throughToken: k };
    return { ok: true, beginIndex: k };
  }
  return { ok: false, throughToken: tokens.length };
}

/**
 * Derives, per line, the innermost condition governing it.
 *
 * @param body - The body script the offsets index into.
 * @param scan - The single-pass comment mask and structural tokens for that body.
 * @param lineStarts - Start offset of each line.
 * @param lineCount - Number of lines in the body.
 * @param onSkip - Sink for what was not resolved; called at most once per body.
 * @returns The per-line conditions, all `null` when the body's blocks do not balance.
 *
 * @remarks
 * Right or absent, never a guess. `BEGIN…END` blocks are matched on a stack that `CASE…END`,
 * `BEGIN TRY` / `END TRY` and `BEGIN TRANSACTION` all keep honest; an `END` with nothing open, or
 * an unclosed block at the body's end, means the reading is wrong somewhere earlier, so the whole
 * body reports nothing and says so. A construct that resolves to no block — a single-statement
 * `IF`, an over-long condition — suppresses the lines it might govern instead of handing them the
 * enclosing block's condition, which would read as the innermost one.
 *
 * The governed region runs from the governing keyword's own line through the closing `END`, so a
 * hit on the `IF` line, on its `BEGIN`, or anywhere between reports the same condition.
 */
function derivePredicates(
  body: string,
  scan: BodyScan,
  lineStarts: number[],
  lineCount: number,
  onSkip: (reason: string) => void,
): (string | null)[] {
  const { tokens, mask } = scan;
  const predicateOfLine: (string | null)[] = new Array<string | null>(lineCount).fill(null);
  if (tokens.length === 0) return predicateOfLine;

  const lineOf = (offset: number): number => lineIndexAt(lineStarts, offset);
  /** The live text between two offsets, comments removed and whitespace collapsed. */
  const conditionText = (start: number, end: number): string => {
    let out = '';
    for (let i = start; i < end; i++) if (mask[i] === 0) out += body[i];
    return out.replace(/\s+/g, ' ').trim();
  };

  const stack: OpenBlock[] = [];
  /** Blocks already closed, with the condition to write over their line range and their nesting. */
  const closed: { startLine: number; endLine: number; predicate: string; depth: number }[] = [];
  /** Line ranges whose innermost governing condition is not known, so nothing is reported there. */
  const suppressed: { from: number; to: number }[] = [];
  /** Condition to hand to the `BEGIN` at this token index, filled by the keyword that governs it. */
  const pending = new Map<number, { predicate: string | null; startLine: number }>();
  /** The condition of the `IF` block that just closed, while an `ELSE` could still follow it. */
  let closedIf: string | null = null;
  let skipped = 0;

  /**
   * Claims the block a governing keyword owns. `predicate` is `null` when the condition itself did
   * not resolve, and then the block's lines are silenced rather than handed the enclosing block's
   * condition, which a reader would take for the innermost one.
   */
  const govern = (index: number, predicate: string | null): void => {
    const found = findGovernedBlock(body, tokens, index);
    const startLine = lineOf(tokens[index].start);
    if (found.ok) {
      const usable = predicate !== null && predicate.length > 0 && predicate.length <= PREDICATE_MAX_CHARS;
      if (!usable) skipped++;
      pending.set(found.beginIndex, { predicate: usable ? predicate : null, startLine });
      return;
    }
    // No block: the governed region is one statement whose end is a guess, so silence the span up
    // to whatever stopped the search — through it when that is the statement terminator itself.
    const boundary = tokens[found.throughToken];
    const endLine = boundary === undefined
      ? lineCount - 1
      : boundary.kw === ';' ? lineOf(boundary.start) : Math.max(startLine, lineOf(boundary.start) - 1);
    suppressed.push({ from: startLine, to: endLine });
    skipped++;
  };

  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];
    const kw = token.kw;
    // `closedIf` survives only the statement terminator between an `END` and its `ELSE`.
    const carriesElse = kw === 'ELSE' || kw === ';';

    if (kw === 'CASE') {
      stack.push({ kind: 'case', predicate: null, startLine: lineOf(token.start), suppress: false });
    } else if (kw === 'IF' || kw === 'WHILE') {
      const found = findGovernedBlock(body, tokens, j);
      govern(j, found.ok ? conditionText(token.end, tokens[found.beginIndex].start) : null);
    } else if (kw === 'ELSE') {
      // An `ELSE` inside a `CASE` expression is part of the expression, not a branch of a statement.
      if (stack[stack.length - 1]?.kind !== 'case') {
        govern(j, closedIf === null ? null : `NOT (${closedIf})`);
      }
    } else if (kw === 'BEGIN') {
      const named = opensNamedConstruct(body, tokens, j);
      if (named === 'try') {
        stack.push({ kind: 'try', predicate: null, startLine: lineOf(token.start), suppress: false });
        j++;
      } else if (named === 'transaction') {
        j++; // Not a block: no `END` will close it.
      } else {
        const owner = pending.get(j);
        stack.push({
          kind:      'block',
          predicate: owner?.predicate ?? null,
          startLine: owner?.startLine ?? lineOf(token.start),
          suppress:  owner !== undefined && owner.predicate === null,
        });
      }
    } else if (kw === 'END') {
      const after = tokens[j + 1];
      const closesTry = isAdjacent(body, token, after) && (after!.kw === 'TRY' || after!.kw === 'CATCH');
      const frame = stack.pop();
      if (frame === undefined || (closesTry && frame.kind !== 'try')) {
        onSkip(`block structure does not balance at line ${lineOf(token.start) + 1} — no condition reported for this body`);
        return predicateOfLine;
      }
      if (closesTry) j++;
      const endLine = lineOf(token.start);
      if (frame.suppress) suppressed.push({ from: frame.startLine, to: endLine });
      else if (frame.kind === 'block' && frame.predicate !== null) {
        closed.push({ startLine: frame.startLine, endLine, predicate: frame.predicate, depth: stack.length });
      }
      closedIf = frame.kind === 'block' ? frame.predicate : null;
      continue;
    }
    if (!carriesElse) closedIf = null;
  }

  if (stack.length > 0) {
    onSkip(`${stack.length} unclosed block(s) at the end of the body — no condition reported for this body`);
    return new Array<string | null>(lineCount).fill(null);
  }

  // Shallowest first, so a nested block writes last and the innermost condition is the one left;
  // between siblings the later one wins the line their `END` and `ELSE BEGIN` may share.
  closed.sort((a, b) => a.depth - b.depth || a.startLine - b.startLine);
  for (const region of closed) {
    for (let l = region.startLine; l <= region.endLine && l < lineCount; l++) predicateOfLine[l] = region.predicate;
  }
  for (const region of suppressed) {
    for (let l = region.from; l <= region.to && l < lineCount; l++) predicateOfLine[l] = null;
  }
  if (skipped > 0) onSkip(`${skipped} conditional region(s) without a resolvable block — no condition reported for those lines`);
  return predicateOfLine;
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
 * Prefix placed on a context line that carries no executable code.
 *
 * @remarks
 * T-SQL's own "this does not run" marker, so the snippet states the fact in the language it is
 * already written in and needs no legend to be read. The alternative shapes were a word marker,
 * which a reader can take for a bracketed identifier or an annotation to be trusted or not, and a
 * separate line-number field, which leaves the reader to line ranges up against a window that
 * carries no line numbers.
 */
const DEAD_LINE_PREFIX = '--';

/**
 * Builds a formatted context snippet for a match found in a body script.
 *
 * @param lines - The body split on newlines.
 * @param matchLine - Zero-based index of the line holding the match.
 * @param matchText - The text that matched, used to place the window on an over-wide line.
 * @param contextLines - The number of lines around the match to include.
 * @param lineCap - Width at which a line is windowed around the match; `Infinity` never windows.
 * @param deadLine - Per-line liveness from {@link markDeadLines}; a dead line is prefixed.
 * @returns A multi-line string containing the match context.
 *
 * @remarks
 * `commented` answers for the matched line only, and the window is wider than the match: an
 * abandoned block reached the wire as bare SQL because the one line that produced a hit was flagged
 * while the statement it belonged to \u2014 `DELETE d1` a line above, which matched nothing itself \u2014 was
 * served identically to the live code two hundred lines up (IB4-T3: the procedure was answered as
 * mutating a table it only reads). Per-line knowledge is what the window needs, and the mask
 * {@link scanBody} already computed over this body is where it comes from.
 *
 * The prefix goes on after windowing, so it is never the part that gets elided, and only where the
 * whole line is dead \u2014 marking live code would delete real lineage, which is the expensive
 * direction.
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
  return lines.slice(start, end).map((l, i) => {
    const trimmed = l.trimEnd();
    const mark = (text: string): string => (deadLine[start + i] === 1 ? DEAD_LINE_PREFIX + text : text);
    if (trimmed.length <= lineCap) return mark(trimmed);
    const matchPos = termLower.length > 0 ? trimmed.toLowerCase().indexOf(termLower) : -1;
    if (matchPos < 0) return mark(trimmed);
    // Trim long lines so the match stays within the visible panel width.
    const windowStart = Math.max(0, matchPos - SIDEBAR_WINDOW_LEAD);
    const windowEnd = Math.min(trimmed.length, windowStart + lineCap);
    return mark((windowStart > 0 ? '\u2026' : '') +
      trimmed.slice(windowStart, windowEnd) +
      (windowEnd < trimmed.length ? '\u2026' : ''));
  }).join('\n');
}
