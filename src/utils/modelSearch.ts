import type { ObjectType, ColumnDef } from '../engine/types';
import { SQL_CODE, SQL_LITERAL, sqlCommentMask } from '../engine/shared/sqlSpans';

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

/** Represents a match found within a DDL body script or column list. */
interface DdlMatch {
  /** The node that contains the match. */
  node: SearchableNode;
  /** A formatted snippet showing the context of the match. */
  snippet: string;
}

/** One match inside a body script, in the shape a grep-style tool reports. */
export interface BodyMatch extends DdlMatch {
  /** 1-based line number of the match within the body script. */
  line: number;
  /** The matching line, right-trimmed. */
  text: string;
  /** Present, and always `true`, when the match itself sits inside a SQL comment. */
  commented?: true;
  /** The innermost `IF`/`WHILE` condition whose `BEGIN…END` block contains the matched line, or the single statement it governs when written without `BEGIN…END`. Omitted when the match is not inside such a block. */
  enclosingPredicate?: string;
}

/** Context lines placed around a match by {@link searchBodyScripts} — the one governor; both callers take it. */
const DEFAULT_SNIPPET_CONTEXT_LINES = 2;

/** Width, in characters, the detail sidebar can render on one line before a match needs a window. */
const SIDEBAR_LINE_CAP = 50;

/** Prefix a snippet line carries when every non-whitespace character on it sits inside a comment. */
const DEAD_LINE_PREFIX = '--';

/** Outcome of syntax compilation without executing the expression. */
type SearchRegexResult =
  /** The pattern compiled; execution must be isolated for untrusted input. */
  | { ok: true; regex: RegExp }
  /** The pattern is not valid JavaScript regex syntax; `error` is what V8 raised. */
  | { ok: false; reason: 'syntax'; error: SyntaxError };

/** Syntax refusal accepted by repair hints; execution deadlines belong to the search worker. */
type SearchRegexRejection = Extract<SearchRegexResult, { ok: false }>;

/** Longest body line, in characters, a search result serves as text. */
export const SEARCH_LINE_MAX_CHARS = 1000;

/** Locator for a matching body line longer than {@link SEARCH_LINE_MAX_CHARS}. */
interface OversizedLineHit {
  /** 1-based line number in the body. */
  readonly line: number;
  /** Length of the line in characters. */
  readonly length: number;
  /** 0-based offset of the first match within the line. */
  readonly match_offset: number;
}

/** Flags every search regex compiles with: grep's contract — case-insensitive, `^`/`$` per line. */
const SEARCH_REGEX_FLAGS = 'im';

/** Compiles the syntax of a search pattern into a regular expression with grep's flags ({@link SEARCH_REGEX_FLAGS}). */
export function compileSearchRegex(pattern: string): SearchRegexResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, SEARCH_REGEX_FLAGS);
  } catch (err) {
    return { ok: false, reason: 'syntax', error: err instanceof SyntaxError ? err : new SyntaxError(String(err)) };
  }
  return { ok: true, regex };
}

/** Names the edit that fixes a pattern {@link compileSearchRegex} refused. */
export function regexRejectHint(pattern: string, rejection: SearchRegexRejection): string {
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

/** Searches the flat node catalog by object name with ranking and filtering. */
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

  if (mode === 'regex') {
    const compiled = compileSearchRegex(query);
    if (!compiled.ok) return [];
    const re = compiled.regex;
    return filtered
      .filter(n => re.test(n.name) || re.test(`${n.schema}.${n.name}`))
      .slice(0, limit);
  }

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

/** Searches the SQL DDL body scripts for a specific term. */
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
    forEachLineMatch(scanner, body, (index, text) => {
      matches.push(matchAt(index, text));
      capped = matches.length >= cap;
      return !capped;
    });
    if (capped) break;
  }
  return matches;
}

/** Complete DDL search result, including whole-line locators and admission counts. */
export interface BodyScanResult {
  matches: BodyMatch[];
  total: number;
  objects: number;
  oversized: { node: SearchableNode; lines: OversizedLineHit[] }[];
}

/** Sweeps a compiled pattern over every body once, building match rows only while their count stays admissible and counting the rest. */
export function scanBodyMatches(
  nodes: SearchableNode[],
  regex: RegExp,
  types: Set<ObjectType> | undefined,
  admits: (count: number) => boolean,
): BodyScanResult {
  const scanner = globalScanner(regex);
  const matches: BodyMatch[] = [];
  const oversized: { node: SearchableNode; lines: OversizedLineHit[] }[] = [];
  let building = true;
  let total = 0;
  let objects = 0;
  for (const node of nodes) {
    const body = node.bodyScript;
    if (!body || (types && types.size > 0 && !types.has(node.type))) continue;
    const matchAt = bodyMatcher(node, body, DEFAULT_SNIPPET_CONTEXT_LINES, Number.POSITIVE_INFINITY);
    const before = total;
    const longLines: OversizedLineHit[] = [];
    forEachLineMatch(scanner, body, (index, text) => {
      total++;
      building &&= admits(total);
      if (building) matches.push(matchAt(index, text));
    }, hit => longLines.push(hit));
    if (total > before) objects++;
    if (longLines.length > 0) oversized.push({ node, lines: longLines });
  }
  return { matches, total, objects, oversized };
}

/** Binds one body's line split, line offsets and comment, dead-line and predicate masks to a match builder. */
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
      predicateMask = deriveEnclosingPredicates(lines, lineStarts, sqlCommentMask(body, { markLiterals: true }));
    }
    return makeMatch(node, lines, lineStarts, index, matchText, contextLines, lineCap, commentMask, deadMask, predicateMask);
  };
}

/** A `g`-flagged form of `regex`: walking every match in a body needs the `lastIndex` cursor. */
function globalScanner(regex: RegExp): RegExp {
  return regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
}

/** Visits every non-empty match of a `g`-flagged `scanner` in `body`, one line at a time and in order, until `visit` returns `false`. */
function forEachLineMatch(
  scanner: RegExp,
  body: string,
  visit: (index: number, text: string) => boolean | void,
  onOversized?: (hit: OversizedLineHit) => void,
): void {
  let lineStart = 0;
  for (let line = 1; ; line++) {
    const newline = body.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? body.length : newline;
    const length = lineEnd - lineStart;
    const oversized = length > SEARCH_LINE_MAX_CHARS;
    const segment = body.slice(lineStart, lineEnd);
    scanner.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = scanner.exec(segment)) !== null) {
      if (hit[0].length === 0) { scanner.lastIndex++; continue; }
      if (oversized) {
        onOversized?.({ line, length, match_offset: hit.index });
        break;
      }
      if (visit(lineStart + hit.index, hit[0]) === false) return;
    }
    if (newline < 0) return;
    lineStart = newline + 1;
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
  if (commentMask[index] !== SQL_CODE) match.commented = true;
  const predicate = predicateAt[matchLine];
  if (predicate !== undefined) match.enclosingPredicate = predicate;
  return match;
}

/** Matches an `IF`/`WHILE` keyword opening a line, capturing the rest of the line as its condition. */
const IF_WHILE_LINE_RE = /^(IF|WHILE)\b(.*)$/i;

/** Every block-opening `BEGIN`, block-closing `END` or `CASE` keyword on a line, live-code only — see {@link deriveEnclosingPredicates}. `BEGIN TRAN[SACTION]`, `BEGIN DISTRIBUTED TRANSACTION` and `BEGIN DIALOG`/`CONVERSATION` start statements no `END` closes, and `END CONVERSATION` closes no block, so none of them moves the frame stack. */
const BLOCK_KEYWORD_RE = /\b(BEGIN(?!\s+(?:TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b)|END(?!\s+CONVERSATION\b)|CASE)\b/gi;

/** Derives, per line, the innermost `IF`/`WHILE` condition governing that line. */
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
    let live = '';
    for (let c = 0; c < line.length; c++) live += commentMask[base + c] !== SQL_CODE ? ' ' : line[c];
    const trimmed = live.trim();
    const isLive = trimmed.length > 0;

    const ifWhile = IF_WHILE_LINE_RE.exec(trimmed);
    let ownPredicate: string | undefined;
    if (ifWhile) {
      const end = /\bBEGIN\b\s*$/i.exec(live)?.index ?? line.length;
      let sourcePredicate = '';
      for (let c = 0; c < end; c++) {
        const span = commentMask[base + c];
        sourcePredicate += span === SQL_CODE || span === SQL_LITERAL ? line[c] : ' ';
      }
      ownPredicate = sourcePredicate.trim();
    }
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

/** Storage objects whose columns the Detail Search sidebar groups (views are found there by body search). */
const STORAGE_COLUMN_OWNERS: ReadonlySet<ObjectType> = new Set<ObjectType>(['table', 'external']);
/** Every object type that owns columns in metadata: storage objects, views and table functions. */
export const ALL_COLUMN_OWNERS: ReadonlySet<ObjectType> = new Set<ObjectType>(['table', 'external', 'view', 'function']);

/** Searches for nodes by matching column names. */
export function searchColumns(
  nodes: SearchableNode[],
  query: string,
  limit = 100,
  ownerTypes: ReadonlySet<ObjectType> = STORAGE_COLUMN_OWNERS,
): DdlMatch[] {
  if (query.length < 2) return [];
  const lower = query.toLowerCase();
  const matches: DdlMatch[] = [];
  for (const node of nodes) {
    if (!ownerTypes.has(node.type)) continue;
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

/** Builds a formatted context snippet for a match found in a body script. */
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
  const mark = (lineIndex: number, rendered: string): string =>
    deadLine[lineIndex] === 1 ? `${DEAD_LINE_PREFIX}${rendered}` : rendered;
  return lines.slice(start, end).map((l, offset) => {
    const lineIndex = start + offset;
    const trimmed = l.trimEnd();
    if (trimmed.length <= lineCap) return mark(lineIndex, trimmed);
    const matchPos = termLower.length > 0 ? trimmed.toLowerCase().indexOf(termLower) : -1;
    if (matchPos < 0) return mark(lineIndex, trimmed);
    const windowStart = Math.max(0, matchPos - SIDEBAR_WINDOW_LEAD);
    const windowEnd = Math.min(trimmed.length, windowStart + lineCap);
    return mark(lineIndex, (windowStart > 0 ? '\u2026' : '') +
      trimmed.slice(windowStart, windowEnd) +
      (windowEnd < trimmed.length ? '\u2026' : ''));
  }).join('\n');
}

/** Projects the per-character comment mask onto whole lines. */
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
