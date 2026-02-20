/**
 * TSQL Complex Test Suite — Wave 0 RL Baseline
 *
 * Loads all .sql files from:
 *   test/sql/targeted/   — hand-crafted pattern tests WITH -- EXPECT annotations
 *   test/sql/real/       — real-world SQL files (stability-only, no oracle)
 *   test/sql/generated/  — synthetic SPs WITH -- EXPECT annotations (created in later waves)
 *
 * For files WITH -- EXPECT annotation:
 *   • expected.sources  ⊆ actual.sources   (no false negatives)
 *   • expected.targets  ⊆ actual.targets
 *   • expected.exec     ⊆ actual.execCalls
 *   • expected.absent   ∩ (sources ∪ targets ∪ execCalls) = ∅
 *
 * For files WITHOUT -- EXPECT (real-world, stability-only):
 *   • parseSqlBody() must not throw
 *   • result.sources.length < 500  (no runaway extraction)
 *   • result.targets.length < 200
 *
 * Wave 0 intent: measure the BASELINE pass rate. Some targeted tests are
 * KNOWN GAPS (e.g. ansi_old_01 comma-join, output_into patterns) and will FAIL.
 * That is expected — these failures are the RL signal for subsequent waves.
 * The journal records the initial pass rate.
 *
 * Exit code: 1 if any STABILITY failure (crash or runaway), or any ORACLE failure.
 * All failures are printed with detail so the RL loop can target them.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { parseSqlBody, loadRules } from '../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load rules ──────────────────────────────────────────────────────────────
const rulesYaml = readFileSync(resolve(__dirname, '../assets/defaultParseRules.yaml'), 'utf-8');
loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

// ─── Counters ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let stabilityFailed = 0;

// ─── EXPECT annotation parser ─────────────────────────────────────────────────
interface Expectation {
  sources: string[];
  targets: string[];
  exec: string[];
  absent: string[];
}

function parseExpectation(sql: string): Expectation | null {
  // Find line matching: -- EXPECT  sources:...  targets:...  exec:...  absent:...
  const lines = sql.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/--\s*EXPECT\b(.*)/i);
    if (!m) continue;

    const body = m[1];

    const parseField = (field: string): string[] => {
      // Capture everything until the next field keyword or end of string.
      // Uses lookahead so bracket names with spaces (e.g. [CRONUS International Ltd_$X]) work.
      const fm = body.match(new RegExp(`\\b${field}:(.*?)(?=\\s+(?:sources|targets|exec|absent):|$)`, 'i'));
      if (!fm || !fm[1].trim()) return [];
      // Split by comma — bracket names may contain spaces but not commas
      return fm[1].split(',').map(s => s.trim()).filter(Boolean);
    };

    return {
      sources: parseField('sources'),
      targets: parseField('targets'),
      exec:    parseField('exec'),
      absent:  parseField('absent'),
    };
  }
  return null;
}

// ─── Normalization for comparison (bracket-strip + lowercase) ─────────────────
function norm(s: string): string {
  return s.replace(/\[|\]/g, '').toLowerCase().trim();
}

function includes(list: string[], item: string): boolean {
  const n = norm(item);
  return list.some(x => norm(x) === n);
}

// ─── Single file test runner ───────────────────────────────────────────────────
function runFile(filePath: string, isStabilityOnly: boolean): boolean {
  const fileName = basename(filePath);
  let sql: string;
  try {
    sql = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`  ✗ [CRASH] Cannot read ${fileName}: ${e}`);
    stabilityFailed++;
    failed++;
    return false;
  }

  // ── Stability check ──────────────────────────────────────────────────────
  let result;
  try {
    result = parseSqlBody(sql);
  } catch (e) {
    console.error(`  ✗ [CRASH] parseSqlBody threw on ${fileName}: ${e}`);
    stabilityFailed++;
    failed++;
    return false;
  }

  if (result.sources.length >= 500) {
    console.error(`  ✗ [RUNAWAY] ${fileName}: ${result.sources.length} sources (≥500 — runaway extraction)`);
    stabilityFailed++;
    failed++;
    return false;
  }
  if (result.targets.length >= 200) {
    console.error(`  ✗ [RUNAWAY] ${fileName}: ${result.targets.length} targets (≥200 — runaway extraction)`);
    stabilityFailed++;
    failed++;
    return false;
  }

  if (isStabilityOnly) {
    console.log(`  ✓ [STABLE] ${fileName}  (src=${result.sources.length} tgt=${result.targets.length} exec=${result.execCalls.length})`);
    passed++;
    return true;
  }

  // ── Oracle assertion ─────────────────────────────────────────────────────
  const expect = parseExpectation(sql);
  if (!expect) {
    // No EXPECT line — run as stability-only
    console.log(`  ✓ [STABLE] ${fileName}  (no EXPECT annotation)`);
    passed++;
    return true;
  }

  const all = [...result.sources, ...result.targets, ...result.execCalls];
  const misses: string[] = [];
  const falsePositives: string[] = [];

  // Check expected sources
  for (const exp of expect.sources) {
    if (!includes(result.sources, exp)) {
      misses.push(`source ${exp} not found`);
    }
  }
  // Check expected targets
  for (const exp of expect.targets) {
    if (!includes(result.targets, exp)) {
      misses.push(`target ${exp} not found`);
    }
  }
  // Check expected exec calls
  for (const exp of expect.exec) {
    if (!includes(result.execCalls, exp)) {
      misses.push(`exec ${exp} not found`);
    }
  }
  // Check absent items (must NOT appear anywhere)
  for (const abs of expect.absent) {
    if (includes(all, abs)) {
      falsePositives.push(`absent ${abs} was found (false positive)`);
    }
  }

  const errors = [...misses, ...falsePositives];
  if (errors.length > 0) {
    console.error(`  ✗ [ORACLE] ${fileName}:`);
    for (const err of errors) {
      console.error(`        → ${err}`);
    }
    console.error(`        actual src=[${result.sources.join(', ')}]`);
    console.error(`        actual tgt=[${result.targets.join(', ')}]`);
    console.error(`        actual exec=[${result.execCalls.join(', ')}]`);
    failed++;
    return false;
  }

  console.log(`  ✓ [ORACLE] ${fileName}  (src=${result.sources.length} tgt=${result.targets.length} exec=${result.execCalls.length})`);
  passed++;
  return true;
}

// ─── Directory runner ─────────────────────────────────────────────────────────
function runDirectory(dirPath: string, stabilityOnly: boolean, label: string): void {
  if (!existsSync(dirPath)) {
    console.log(`\n── ${label} ── (directory not found: ${dirPath})`);
    return;
  }
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`\n── ${label} ── (${files.length} files)`);
  for (const file of files) {
    runFile(resolve(dirPath, file), stabilityOnly);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main(): void {
  console.log('═══ TSQL Complex Test Suite (Wave 0 Baseline) ═══');

  // Targeted: hand-crafted with EXPECT annotations
  runDirectory(
    resolve(__dirname, 'sql/targeted'),
    false,  // has EXPECT
    'TARGETED (oracle assertions)'
  );

  // Real-world: stability only
  runDirectory(
    resolve(__dirname, 'sql/real'),
    true,   // stability only
    'REAL-WORLD (stability only)'
  );

  // Generated: synthetic SPs with EXPECT annotations (populated in later waves)
  runDirectory(
    resolve(__dirname, 'sql/generated'),
    false,  // has EXPECT
    'GENERATED (oracle assertions)'
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Results: ${passed}/${total} passed  (${pct}%)`);
  if (stabilityFailed > 0) {
    console.log(`STABILITY failures (crash/runaway): ${stabilityFailed} — these are hard failures`);
  }
  if (failed - stabilityFailed > 0) {
    console.log(`ORACLE gap failures: ${failed - stabilityFailed} — RL targets for subsequent waves`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
