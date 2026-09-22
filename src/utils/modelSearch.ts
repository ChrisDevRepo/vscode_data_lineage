import type { ObjectType, ColumnDef } from '../engine/types';
import { SQL_CODE, sqlCommentMask } from '../engine/shared/sqlSpans';

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
   * The innermost `IF`/`WHILE` condition whose `BEGIN…END` block contains the matched line, or the
   * single statement it governs when written without `BEGIN…END`. Omitted when the match is not
   * inside such a block.
   *
   * @remarks
   * The reported context is a few lines wide, so a hit's controlling condition sits outside the
   * window whenever it is more than a line or two away — the normal case in T-SQL. This restores
   * that one structural bit for `IF`/`WHILE`, the same way {@link sqlCommentMask} restores it for a
   * comment block; `CASE`, a `WHERE`-clause guard and `GOTO` flow are out of scope and stay
   * unexpressed.
   */
  enclosingPredicate?: string;
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
 * Repeating units the ReDoS guard builds its probe inputs from.
 *
 * @remarks
 * Catastrophic backtracking is triggered by the character class the nested quantifier consumes,
 * so a single letter run passes patterns such as `(\s+)+$` or `(\[+)+\]` that blow up on the
 * whitespace- and bracket-heavy SQL they are then run over. Each unit covers one class that is
 * dense in DDL bodies: letters, whitespace, brackets, separators, and digit runs.
 */
const REDOS_SAMPLE_UNITS: readonly string[] = ['a', ' \t', '[', 'a,', 'a]', '1'];

/** Longest probe input, in characters, the ReDoS guard runs a pattern against. */
const REDOS_SAMPLE_MAX_CHARS = 200;

/**
 * Growth step, in characters, between two probe inputs of the same unit.
 *
 * @remarks
 * An exponential pattern roughly doubles its cost per added character, so a single 200-character
 * probe never returns and hangs the extension host instead of measuring anything. Probing in
 * short steps stops at the first input over budget, which a four-character step bounds to about
 * sixteen times the budget.
 */
const REDOS_SAMPLE_STEP_CHARS = 4;

/** Whether one probe run of `regex` over `sample` exceeds the ReDoS guard budget. */
function probeExceedsBudget(regex: RegExp, sample: string): boolean {
  const start = performance.now();
  regex.test(sample);
  return performance.now() - start > REDOS_BUDGET_MS;
}

/** Whether `regex` exceeds the ReDoS guard budget on `sample` twice in a row, so one garbage-collection pause cannot refuse a benign pattern. */
function confirmedOverBudget(regex: RegExp, sample: string): boolean {
  return probeExceedsBudget(regex, sample) && probeExceedsBudget(regex, sample);
}

/**
 * Runs `regex` against growing probe inputs and reports whether any run exceeded the ReDoS guard
 * budget.
 *
 * @remarks
 * Uses `performance.now()` (sub-ms precision) instead of `Date.now()` (1ms / 15ms on Windows). An
 * over-budget run is confirmed by {@link confirmedOverBudget} before the pattern is refused.
 */
function exceedsRedosBudget(regex: RegExp): boolean {
  for (const unit of REDOS_SAMPLE_UNITS) {
    for (let chars = REDOS_SAMPLE_STEP_CHARS; chars <= REDOS_SAMPLE_MAX_CHARS; chars += REDOS_SAMPLE_STEP_CHARS) {
      const sample = unit.repeat(Math.ceil(chars / unit.length));
      if (confirmedOverBudget(regex, sample)) return true;
    }
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
 * so those groups are left untouched and fail to compile.
 *
 * The scoped form `(?i:...)` is a different construct — it is not a simple prefix, and rewriting it
 * would require re-deriving the subgroup boundary — so the pattern above requires the closing `)`
 * immediately after the flags and never matches it. The scoped form therefore reaches the engine
 * byte-for-byte, and what happens next is the engine's to decide, not this function's: a V8 with
 * ES2025 regexp modifiers compiles it, an older one raises a `SyntaxError` that
 * {@link regexRejectHint} turns into advice. Both outcomes are correct here; do not pin either.
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
  // Heuristic ReDoS guard: reject patterns that take too long on a bounded probe input.
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
 * so a pattern never needs an inline flag group. A redundant `(?i)`/`(?m)`/`(?im)` never reaches
 * this function: `compileSearchRegex` strips it before compiling, so what lands here asks for
 * semantics the engine does not otherwise apply (`(?s)`) or syntax it does not recognize at all.
 * Which forms those are is the engine's answer, not a fixed list: a V8 with ES2025 regexp modifiers
 * accepts the scoped `(?i:...)` and `(?-i:...)` forms, so on that host they compile instead of
 * arriving here. The advice below is keyed on V8's own message for exactly that reason.
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

  // One allocation for the whole sweep, not one per node.
  const scanner = regex === null ? null : globalScanner(regex);

  const matches: BodyMatch[] = [];
  for (const node of filtered) {
    const body = node.bodyScript;
    if (!body) continue;
    const matchAt = bodyMatcher(node, body, contextLines, lineCap);

    if (scanner === null) {
      const idx = body.toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      matches.push(matchAt(idx, query as string));
      if (matches.length >= cap) break;
      continue;
    }

    let capped = false;
    forEachNonEmptyMatch(scanner, body, hit => {
      matches.push(matchAt(hit.index, hit[0]));
      capped = matches.length >= cap;
      return !capped;
    });
    if (capped) break;
  }
  return matches;
}

/**
 * Sweeps a compiled pattern over every body once, building match rows only while their count
 * stays admissible and counting the rest.
 *
 * @param nodes - The catalog of nodes to search.
 * @param regex - A pattern {@link compileSearchRegex} accepted.
 * @param types - Optional set of allowed object types.
 * @param admits - Whether a given match count may still be built; once it returns `false` for a
 * count it must return `false` for every larger one.
 * @returns The rows, the total match count and how many objects produced at least one match.
 * `matches` holds every match exactly when `admits(total)` holds; otherwise it holds only the
 * rows built before the count first failed, which the caller must not serve.
 *
 * @remarks
 * Lets `lineage_search_ddl` answer an over-budget pattern from counts alone in the same regex pass
 * that builds a fitting result: a pattern that matches nearly every character would otherwise
 * allocate one row, snippet and mask set per character of every body, only for the budget check to
 * discard them all.
 */
export function scanBodyMatches(
  nodes: SearchableNode[],
  regex: RegExp,
  types: Set<ObjectType> | undefined,
  admits: (count: number) => boolean,
): { matches: BodyMatch[]; total: number; objects: number } {
  const scanner = globalScanner(regex);
  const matches: BodyMatch[] = [];
  let building = true;
  let total = 0;
  let objects = 0;
  for (const node of nodes) {
    const body = node.bodyScript;
    if (!body || (types && types.size > 0 && !types.has(node.type))) continue;
    const matchAt = bodyMatcher(node, body, DEFAULT_SNIPPET_CONTEXT_LINES, Number.POSITIVE_INFINITY);
    const before = total;
    forEachNonEmptyMatch(scanner, body, hit => {
      total++;
      building &&= admits(total);
      if (building) matches.push(matchAt(hit.index, hit[0]));
    });
    if (total > before) objects++;
  }
  return { matches, total, objects };
}

/**
 * Binds one body's line split, line offsets and comment, dead-line and predicate masks to a match
 * builder.
 *
 * @remarks
 * Every piece is built on the first match and reused by the rest: a body nobody hits is never split
 * or scanned.
 */
function bodyMatcher(
  node: SearchableNode,
  body: string,
  contextLines: number,
  lineCap: number,
): (index: number, matchText: string) => BodyMatch {
  let lines: string[] | null = null;
  let lineStarts: number[] = [];
  let commentMask: Uint8Array = new Uint8Array(0);
  let deadMask: Uint8Array = new Uint8Array(0);
  let predicateMask: (string | undefined)[] = [];
  return (index, matchText) => {
    if (lines === null) {
      lines = body.split('\n');
      lineStarts = buildLineStarts(lines);
      commentMask = sqlCommentMask(body);
      deadMask = markDeadLines(lines, lineStarts, commentMask);
      predicateMask = deriveEnclosingPredicates(lines, lineStarts, commentMask);
    }
    return makeMatch(node, lines, lineStarts, index, matchText, contextLines, lineCap, commentMask, deadMask, predicateMask);
  };
}

/** A `g`-flagged form of `regex`: walking every match in a body needs the `lastIndex` cursor. */
function globalScanner(regex: RegExp): RegExp {
  return regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
}

/**
 * Visits every non-empty match of a `g`-flagged `scanner` in `body`, in order, until `visit`
 * returns `false`.
 *
 * @remarks
 * A zero-length match (`x*`, `^`) advances nothing on its own: the position is skipped rather than
 * the body, or the first empty match would hide every real match later in the same body.
 */
function forEachNonEmptyMatch(scanner: RegExp, body: string, visit: (hit: RegExpExecArray) => boolean | void): void {
  scanner.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = scanner.exec(body)) !== null) {
    if (hit[0].length === 0) { scanner.lastIndex++; continue; }
    if (visit(hit) === false) return;
  }
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
  predicateAt: (string | undefined)[],
): BodyMatch {
  const matchLine = lineIndexAt(lineStarts, index);
  const match: BodyMatch = {
    node,
    line:    matchLine + 1,
    text:    lines[matchLine].trimEnd(),
    snippet: buildSnippet(lines, matchLine, matchText, contextLines, lineCap, deadLine),
  };
  // Set only when true/present: an executable, unconditional match keeps the shape it has always had.
  if (commentMask[index] !== SQL_CODE) match.commented = true;
  const predicate = predicateAt[matchLine];
  if (predicate !== undefined) match.enclosingPredicate = predicate;
  return match;
}

/** Matches an `IF`/`WHILE` keyword opening a line, capturing the rest of the line as its condition. */
const IF_WHILE_LINE_RE = /^(IF|WHILE)\b(.*)$/i;

/**
 * Every block-opening `BEGIN`, block-closing `END` or `CASE` keyword on a line, live-code only — see
 * {@link deriveEnclosingPredicates}. `BEGIN TRAN[SACTION]`, `BEGIN DISTRIBUTED TRANSACTION` and
 * `BEGIN DIALOG`/`CONVERSATION` start statements no `END` closes, and `END CONVERSATION` closes no
 * block, so none of them moves the frame stack.
 */
const BLOCK_KEYWORD_RE = /\b(BEGIN(?!\s+(?:TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b)|END(?!\s+CONVERSATION\b)|CASE)\b/gi;

/**
 * Derives, per line, the innermost `IF`/`WHILE` condition governing that line.
 *
 * @param lines - The body split on newlines, as {@link searchBodyScripts} already holds it.
 * @param lineStarts - Start offset of each line, as {@link buildLineStarts} computes it.
 * @param commentMask - The per-character mask {@link sqlCommentMask} already produced for this body.
 * @returns One entry per line: the text of the nearest enclosing `IF`/`WHILE`, or `undefined` when
 *   the line sits outside any such condition.
 *
 * @remarks
 * The same reasoning as {@link sqlCommentMask}, applied to control flow instead of comments: the
 * context window a match ships with is a few lines wide, so a hit's governing `IF`/`WHILE` sits
 * outside it whenever the condition is more than a line or two away — the ordinary case in T-SQL.
 *
 * A single pass tracks a stack of open blocks. `BEGIN` and `CASE` each open a frame (matching the
 * `END` that later closes it); only a `BEGIN` immediately preceded by an `IF`/`WHILE` carries that
 * condition as its frame's predicate — a bare `BEGIN` (a procedure body, `BEGIN TRY`/`BEGIN CATCH`,
 * an unconditional block) and a `CASE` frame carry none, so a predicate never leaks past the block
 * it actually governs. `CASE` is tracked only so its own `END` cannot be mistaken for closing an
 * outer `BEGIN`; a `CASE WHEN` condition is not itself reported — it guards one expression, not a
 * statement, which is a different fact than this one. An `IF`/`WHILE` written without `BEGIN…END`
 * governs exactly the next live line and is then spent, the same reading a T-SQL batch gives it.
 * Text inside a comment (per `commentMask`) or a string/bracketed literal is never scanned for a
 * keyword, so a comment or a literal containing the word "BEGIN" cannot open a block.
 */
function deriveEnclosingPredicates(
  lines: string[],
  lineStarts: number[],
  commentMask: Uint8Array,
): (string | undefined)[] {
  const result = new Array<string | undefined>(lines.length);
  /** One entry per open `BEGIN`/`CASE` frame; the predicate it carries, or `undefined`. */
  const stack: (string | undefined)[] = [];
  /** An `IF`/`WHILE` condition captured but not yet attached to a `BEGIN`, or spent on one line. */
  let pending: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const base = lineStarts[i];
    // The live-only view of the line: comment content replaced with spaces so a keyword inside a
    // comment can neither open a block nor be mistaken for the line's own condition.
    let live = '';
    for (let c = 0; c < line.length; c++) live += commentMask[base + c] !== SQL_CODE ? ' ' : line[c];
    const trimmed = live.trim();
    const isLive = trimmed.length > 0;

    const ifWhile = IF_WHILE_LINE_RE.exec(trimmed);
    const ownPredicate = ifWhile ? trimmed.replace(/\bBEGIN\b\s*$/i, '').trim() : undefined;
    let ownConsumed = false;
    let pendingConsumed = false;

    BLOCK_KEYWORD_RE.lastIndex = 0;
    let token: RegExpExecArray | null;
    while ((token = BLOCK_KEYWORD_RE.exec(live)) !== null) {
      const keyword = token[1].toUpperCase();
      if (keyword === 'CASE') {
        stack.push(undefined);
      } else if (keyword === 'BEGIN') {
        if (ownPredicate !== undefined && !ownConsumed) { stack.push(ownPredicate); ownConsumed = true; }
        else if (pending !== undefined && !pendingConsumed) { stack.push(pending); pendingConsumed = true; }
        else stack.push(undefined);
      } else if (stack.length > 0) {
        stack.pop();
      }
    }

    // A hit on this line is governed by the innermost open frame, or — when no frame is open and a
    // prior IF/WHILE is still pending a BEGIN that never came — the single live statement it governs.
    let applicable = stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (applicable === undefined && !ownPredicate && pending !== undefined && !pendingConsumed && isLive) {
      applicable = pending;
    }
    result[i] = applicable;

    if (ownPredicate !== undefined && !ownConsumed) {
      pending = ownPredicate; // awaits a BEGIN on a later line, or governs the next live line alone
    } else if (pendingConsumed) {
      pending = undefined;
    } else if (pending !== undefined && isLive) {
      pending = undefined; // spent on this line's single statement (or this line just opened its own IF)
    }
  }
  return result;
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
 * @param commentMask - The per-character mask {@link sqlCommentMask} already produced for this body.
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
      if (commentMask[base + c] === SQL_CODE) { allInComment = false; break; }
    }
    dead[i] = content && allInComment ? 1 : 0;
  }
  return dead;
}
