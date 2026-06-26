/**
 * Engine-parity baseline (UNIT layer) — golden regression net.
 *
 * Computes the deterministic engine battery from `assets/demo.dacpac` and compares
 * it to the committed `tests/fixtures/engine-parity-baseline.json`. The electron
 * layer (`tests/integration/engine-parity.test.ts`) asserts the SAME report against
 * the SAME baseline, so a unit-pass + electron-fail = an integration/bundling regression.
 *
 * Regenerate the baseline (after a vetted, intentional change):
 *   DLV_PARITY_UPDATE=1 npx tsx tests/unit/engine-parity.test.ts
 * Verify (also runs under `npm test` via the support runner):
 *   npx tsx tests/unit/engine-parity.test.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { loadDemoModel, testPath, assert, assertEq, printSummary } from './helpers/testUtils';
import { buildEngineParityReport } from '../../src/engine/engineParityReport';

const BASELINE_PATH = testPath('engine-parity-baseline.json');

async function main() {
  console.log('═══ Engine Parity Baseline (demo.dacpac) ═══');
  const model = await loadDemoModel();
  const report = buildEngineParityReport(model);
  const json = JSON.stringify(report, null, 2);

  if (process.env.DLV_PARITY_UPDATE === '1' || process.argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, json + '\n', 'utf-8');
    console.log(`  ✓ wrote baseline (${json.length} chars): ${BASELINE_PATH}`);
    printSummary('Engine Parity (updated)');
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  // Full deep equality (byte-stable JSON) is the real gate…
  assertEq(JSON.stringify(report), JSON.stringify(baseline), 'engine parity report matches committed baseline');
  // …plus a few explicit fields for readable diffs when it fails.
  assertEq(report.model.nodes, baseline.model.nodes, `model.nodes == ${baseline.model.nodes}`);
  assertEq(report.model.edges, baseline.model.edges, `model.edges == ${baseline.model.edges}`);
  assertEq(report.graph.size, baseline.graph.size, `graph.size == ${baseline.graph.size}`);
  assertEq(report.model.nodeIdHash, baseline.model.nodeIdHash, `nodeIdHash == ${baseline.model.nodeIdHash}`);
  assert(report.search.length === baseline.search.length, 'search battery length matches');
  printSummary('Engine Parity (unit)');
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err);
  throw err;
});
