/**
 * AdventureWorks parser baseline snapshot tool.
 *
 * Produces a deterministic TSV with one row per stored procedure across the
 * committed AdventureWorks dacpacs. Used to detect regressions after parser changes.
 *
 * Usage:
 *   npx tsx tests/unit/snapshot-aw-baseline.ts           # Check against committed baseline
 *   npx tsx tests/unit/snapshot-aw-baseline.ts --update  # Regenerate baseline file
 *
 * The TSV is committed as tests/fixtures/aw-baseline.tsv. A diff → test failure (exit 1).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { loadRules, parseSqlBody } from '../../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../../src/engine/sqlBodyParser';
import { extractDacpac } from '../../src/engine/dacpacExtractor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const FIXTURES = resolve(ROOT, 'tests', 'fixtures');

const DACPACS = [
  { label: 'ai',        path: resolve(FIXTURES, 'AdventureWorks2025_AI.dacpac') },
  { label: 'sdk-style', path: resolve(FIXTURES, 'AdventureWorks_sdk-style.dacpac') },
] as const;

const BASELINE_PATH = resolve(FIXTURES, 'aw-baseline.tsv');
const HEADER = 'dacpac\tsp_name\tregex_sources\tregex_targets\tregex_exec\tedge_count';

// ─── Generate snapshot rows ───────────────────────────────────────────────────

async function generateRows(): Promise<string[]> {
  // Load parse rules (must happen before parseSqlBody is called)
  const rulesYaml = readFileSync(resolve(ROOT, 'assets/defaultParseRules.yaml'), 'utf-8');
  loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

  const rows: string[] = [HEADER];

  for (const dacpac of DACPACS) {
    if (!existsSync(dacpac.path)) {
      console.error(`[SKIP] ${dacpac.label}: ${dacpac.path} not found`);
      continue;
    }

    const buffer = readFileSync(dacpac.path);
    const model = await extractDacpac(buffer.buffer as ArrayBuffer);

    // Only stored procedures with body scripts participate
    const sps = model.nodes
      .filter(n => n.type === 'procedure' && n.bodyScript)
      .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));

    for (const sp of sps) {
      const parsed = parseSqlBody(sp.bodyScript!);
      const spName  = `${sp.schema}.${sp.name}`;
      const sources = [...parsed.sources].sort().join(',') || '-';
      const targets = [...parsed.targets].sort().join(',') || '-';
      const exec    = [...parsed.execCalls].sort().join(',') || '-';
      const edgeCount = model.edges.filter(e => e.source === sp.id || e.target === sp.id).length;

      rows.push([dacpac.label, spName, sources, targets, exec, String(edgeCount)].join('\t'));
    }

    console.error(`[${dacpac.label}] ${sps.length} SPs processed`);
  }

  return rows;
}

// ─── Diff reporting ───────────────────────────────────────────────────────────

function reportDiff(baseline: string[], current: string[]): boolean {
  const baselineSet = new Set(baseline);
  const currentSet = new Set(current);

  const removed = baseline.filter(r => r !== HEADER && !currentSet.has(r));
  const added   = current.filter(r => r !== HEADER && !baselineSet.has(r));

  if (removed.length === 0 && added.length === 0) {
    console.log('✓ Snapshot matches baseline — no parser regressions');
    return true;
  }

  console.error(`\n✗ Snapshot diff detected!\n`);

  if (removed.length > 0) {
    console.error(`REMOVED (${removed.length} rows — potential regressions):`);
    for (const r of removed) console.error(`  - ${r}`);
  }

  if (added.length > 0) {
    console.error(`\nADDED (${added.length} rows — new detections or changes):`);
    for (const r of added) console.error(`  + ${r}`);
  }

  console.error(`\nRun with --update to accept these changes as the new baseline.`);
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const updateMode = process.argv.includes('--update');

  const current = await generateRows();

  if (updateMode) {
    writeFileSync(BASELINE_PATH, current.join('\n') + '\n', 'utf-8');
    console.log(`✓ Baseline updated: ${BASELINE_PATH} (${current.length - 1} SP rows)`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    // First run: auto-create baseline so contributors aren't blocked
    writeFileSync(BASELINE_PATH, current.join('\n') + '\n', 'utf-8');
    console.log(`✓ Baseline created: ${BASELINE_PATH} (${current.length - 1} SP rows)`);
    console.log(`  Commit test/aw-baseline.tsv to lock in this snapshot.`);
    return;
  }

  const baseline = readFileSync(BASELINE_PATH, 'utf-8').replace(/\r/g, '').split('\n').filter(Boolean);
  const ok = reportDiff(baseline, current);

  if (!ok) process.exit(1);
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err);
  process.exit(1);
});
