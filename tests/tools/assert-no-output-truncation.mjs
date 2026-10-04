#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root walked for `.ts`/`.tsx` sources. */
const SRC_ROOT = 'src';
/** Default known-offenders list; only ever shrinks. */
const DEFAULT_BASELINE = 'tests/tools/output-truncation-baseline.json';
/** Lines of continuation scanned after a cut call for an ellipsis in the same expression. */
const EXPRESSION_LOOKAHEAD = 2;

const CUT_CALL = /\.(?:slice|substring)\(\s*0\s*,|\.substr\(\s*0\s*,/;
const ELLIPSIS = /…|\\u2026|\.\.\.['"`]/;
const CUT_MARKERS = /truncated to|\[truncated|…\[\+|\\u2026 ?\[\+|\bcapRejectionText\b|\bcapUtf8Text\b|\bcapPreviewProse\b/;
const TRUNC_CALL = /\btrunc(?:AtWordBoundary)?\(/;
const TRUNC_DEFINITION = /\bfunction\s+trunc(?:AtWordBoundary)?\(/;
const LOG_CALL = /\.(?:debug|info|warn|error|trace|log)\(|\b(?:log|debugLog|onDebugLog|debugLogger)\??\(/;

/**
 * Visible elisions the PM ruled, plus the log helper file. One entry per line: file, a substring
 * that must appear in the offending line, and the reason. Never widened without a register row.
 */
export const ALLOWLIST = [
  { file: 'src/ai/prompting/scopeSummaryRenderer.ts', symbol: 'CARD_OBJECT_TYPE_LIMIT', reason: 'card-summary-view: visible "…" line, full list in the full view' },
  { file: 'src/ai/agent/graph.ts', symbol: "const display = truncAtWordBoundary(committedFinding.value.summary.replace(/\\s+/g, ' ').trim(), 135);", reason: 'chat-preview-display-exception: PM ruling; display only, complete summary stays in memory and model context' },
  { file: 'src/ai/support/text.ts', symbol: 'PROVIDER_ERROR_MAX', reason: 'provider error shown with visible "…", full text in the log' },
  { file: 'src/ai/support/text.ts', symbol: 'slice(0, max - 1)', reason: 'trunc definition; call sites are policed here' },
  { file: 'src/ai/support/text.ts', symbol: 'slice(0, max - 3)', reason: 'hop-thinking-trim: status preview reserves three visible ellipsis characters; call sites are policed here' },
  { file: 'src/ai/agent/graph.ts', symbol: 'rejectReason=${trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/model/vscodeModelPort.ts', symbol: 'tool-input-keys-dropped', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/model/vscodeModelPort.ts', symbol: 'tool-input-decoded', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/session/session.ts', symbol: 'const toolName = observation.toolName ? trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/session/session.ts', symbol: 'oldest evidence observation evicted', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/sm/smBase.ts', symbol: 'const excludeNodeIdsLine', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/tools/handlers/presentResult.ts', symbol: 'const expanded = expand(sec.text', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/tools/handlers/presentResult.ts', symbol: '[Presentation] Output assembled', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const preview = trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const inputJson = trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const hintPart = rejection.hint', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/bridge/debugDumpScreenState.ts', symbol: 'return trunc([...ids], cap);', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(sanitizeForLog(msg.componentStack)', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(sanitizeForLog(msg.stack)', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(JSON.stringify(e.context)', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/engine/modelBuilder.ts', symbol: 'const sqlPreview = trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/engine/renderConnectivity.ts', symbol: 'members.slice(0, MAX_MEMBERS_PER_COMPONENT)', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/utils/notifications.ts', symbol: 'return trunc(value.map(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/utils/notifications.ts', symbol: 'value instanceof Error) return trunc(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/utils/notifications.ts', symbol: 'return trunc(sanitizeForLog(String(value))', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/utils/notifications.ts', symbol: '${trunc(parts.join(', reason: 'log-only: value reaches a log line, trace or debug dump, never a user or model surface' },
  { file: 'src/utils/log.ts', symbol: '', reason: 'log helper: logs may truncate' },
];

/**
 * @param {string} dir - Directory to walk.
 * @returns {string[]} POSIX-style repo-relative `.ts`/`.tsx` paths.
 */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

/**
 * Finds cut sites in one source text.
 *
 * @param {string} file - Repo-relative path, used for the allowlist and the report.
 * @param {string} text - Source text.
 * @returns {{file: string, line: number, text: string}[]} Offending sites, allowlist applied.
 */
export function findSites(file, text) {
  if (file.startsWith('src/components/')) return [];
  const lines = text.split('\n');
  const sites = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
    let hit = CUT_MARKERS.test(line) && !/^(?:async\s+)?function\s/.test(line);
    if (!hit && CUT_CALL.test(line)) {
      const expr = lines.slice(i, i + 1 + EXPRESSION_LOOKAHEAD).join('\n').split(';')[0];
      hit = ELLIPSIS.test(expr);
    }
    if (!hit && TRUNC_CALL.test(line) && !TRUNC_DEFINITION.test(line) && !/^import\s/.test(line) && !LOG_CALL.test(line)) {
      hit = true;
    }
    if (!hit) return;
    if (ALLOWLIST.some((a) => a.file === file && raw.includes(a.symbol))) return;
    sites.push({ file, line: i + 1, text: line });
  });
  return sites;
}

/**
 * @param {{file: string, line: number, text: string}[]} sites - Sites found.
 * @param {{file: string, text: string}[]} baseline - Known offenders.
 * @returns {{fresh: {file: string, line: number, text: string}[], stale: {file: string, text: string}[]}} Sites absent from the baseline, and baseline entries no site matches.
 */
export function compare(sites, baseline) {
  const key = (e) => `${e.file}\u0000${e.text}`;
  const known = new Set(baseline.map(key));
  const seen = new Set(sites.map(key));
  return { fresh: sites.filter((s) => !known.has(key(s))), stale: baseline.filter((b) => !seen.has(key(b))) };
}

/** Scans the whole source tree. */
export function scanTree() {
  return listSourceFiles(SRC_ROOT).flatMap((f) => findSites(f, readFileSync(f, 'utf8')));
}

function main() {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--baseline');
  const baselinePath = bi >= 0 ? args[bi + 1] : DEFAULT_BASELINE;
  const sites = scanTree();
  if (args.includes('--write-baseline')) {
    const entries = [...new Map(sites.map((s) => [`${s.file}\u0000${s.text}`, { file: s.file, text: s.text }])).values()];
    writeFileSync(baselinePath, JSON.stringify(entries, null, 2) + '\n');
    console.log(`wrote ${entries.length} baseline entries to ${baselinePath}`);
    return;
  }
  const { fresh, stale } = compare(sites, JSON.parse(readFileSync(baselinePath, 'utf8')));
  for (const s of fresh) console.error(`FAIL  ${s.file}:${s.line}  new output truncation: ${s.text}`);
  for (const s of stale) console.error(`FAIL  ${s.file}  stale baseline entry, remove: ${s.text}`);
  if (fresh.length > 0 || stale.length > 0) process.exit(1);
  console.log(`PASS  no new user- or model-facing truncation in src/ (${sites.length} known offender site(s) in the baseline).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
