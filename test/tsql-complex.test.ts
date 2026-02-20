/**
 * SQL Pattern Test Suite
 *
 * Loads all .sql files from test/sql/targeted/ and verifies the parser
 * against expected results embedded in the file as a -- EXPECT comment:
 *
 *   -- EXPECT  sources:[dbo].[T1],[dbo].[T2]  targets:[dbo].[Out]  exec:[dbo].[usp_Log]
 *
 * Fields:
 *   sources:  schema.object names the parser must find in result.sources
 *   targets:  schema.object names the parser must find in result.targets
 *   exec:     schema.object names the parser must find in result.execCalls
 *   absent:   names that must NOT appear in any result (verifies comments/strings are cleaned)
 *
 * Files without a -- EXPECT line are run as stability-only tests
 * (parser must not crash; no assertion on content).
 *
 * Exit code 1 if any test fails.
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

// ─── EXPECT annotation parser ─────────────────────────────────────────────────
interface Expectation {
  sources: string[];
  targets: string[];
  exec: string[];
  absent: string[];
}

function parseExpectation(sql: string): Expectation | null {
  const lines = sql.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/--\s*EXPECT\b(.*)/i);
    if (!m) continue;

    const body = m[1];
    const parseField = (field: string): string[] => {
      const fm = body.match(new RegExp(`\\b${field}:(.*?)(?=\\s+(?:sources|targets|exec|absent):|$)`, 'i'));
      if (!fm || !fm[1].trim()) return [];
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

// ─── Normalization for comparison (strip brackets + lowercase) ────────────────
function norm(s: string): string {
  return s.replace(/\[|\]/g, '').toLowerCase().trim();
}

function includes(list: string[], item: string): boolean {
  const n = norm(item);
  return list.some(x => norm(x) === n);
}

// ─── Single file test ──────────────────────────────────────────────────────────
function runFile(filePath: string): boolean {
  const fileName = basename(filePath);
  const sql = readFileSync(filePath, 'utf-8');

  let result;
  try {
    result = parseSqlBody(sql);
  } catch (e) {
    console.error(`  ✗ [CRASH] ${fileName}: ${e}`);
    failed++;
    return false;
  }

  if (result.sources.length >= 500 || result.targets.length >= 200) {
    console.error(`  ✗ [RUNAWAY] ${fileName}: src=${result.sources.length} tgt=${result.targets.length}`);
    failed++;
    return false;
  }

  const expect = parseExpectation(sql);
  if (!expect) {
    console.log(`  ✓ [STABLE] ${fileName}  (src=${result.sources.length} tgt=${result.targets.length} exec=${result.execCalls.length})`);
    passed++;
    return true;
  }

  const all = [...result.sources, ...result.targets, ...result.execCalls];
  const errors: string[] = [];

  for (const exp of expect.sources) {
    if (!includes(result.sources, exp)) errors.push(`source ${exp} not found`);
  }
  for (const exp of expect.targets) {
    if (!includes(result.targets, exp)) errors.push(`target ${exp} not found`);
  }
  for (const exp of expect.exec) {
    if (!includes(result.execCalls, exp)) errors.push(`exec ${exp} not found`);
  }
  for (const abs of expect.absent) {
    if (includes(all, abs)) errors.push(`${abs} should not be extracted (false positive)`);
  }

  if (errors.length > 0) {
    console.error(`  ✗ ${fileName}:`);
    for (const err of errors) console.error(`        → ${err}`);
    console.error(`        actual src=[${result.sources.join(', ')}]`);
    console.error(`        actual tgt=[${result.targets.join(', ')}]`);
    console.error(`        actual exec=[${result.execCalls.join(', ')}]`);
    failed++;
    return false;
  }

  console.log(`  ✓ ${fileName}  (src=${result.sources.length} tgt=${result.targets.length} exec=${result.execCalls.length})`);
  passed++;
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main(): void {
  console.log('═══ SQL Pattern Tests ═══\n');

  const targetedDir = resolve(__dirname, 'sql/targeted');
  if (!existsSync(targetedDir)) {
    console.error('test/sql/targeted/ not found');
    process.exit(1);
  }

  const files = readdirSync(targetedDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    runFile(resolve(targetedDir, file));
  }

  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Results: ${passed}/${total} passed  (${pct}%)`);
  if (failed > 0) {
    console.log(`Failures: ${failed} — see details above`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
