/** Compile fresh, isolate the VS Code shim, then run an explicitly selected optional service check. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTestEnv, prepareDatabaseToken } from './load-test-env.mjs';
import { auditRunEvidence, resolveRunSource } from './lineage-score.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
process.chdir(root);
const [kind, ...args] = process.argv.slice(2);
if (!['ai', 'db'].includes(kind)) throw new Error('Choose ai or db.');
if (!args.includes('--help') && !args.includes('--list')) loadTestEnv();
const build = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tests/harness/tsconfig.json'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (build.status !== 0) process.exit(build.status ?? 1);
const Module = require('node:module');
const originalLoad = Module._load;
const shim = require(resolve(root, 'out/test-headless/tests/harness/vscodeHostShim.js'));
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? shim : originalLoad.call(this, request, parent, isMain);
};
const { main, parseOptions, aiRuns, caseInventory, readBaselineMap } = require(resolve(root, 'out/test-headless/tests/harness/cli.js'));
if (kind === 'db' && !args.includes('--help')) {
  try {
    const options = parseOptions(kind, args);
    await prepareDatabaseToken(process.env, undefined, options.timeoutMs);
  } catch (error) {
    console.error(`FAIL: database test setup: ${error instanceof Error ? error.message : 'invalid configuration'}`);
    process.exit(2);
  }
}
try {
  if (kind === 'ai' && !args.includes('--help') && !args.includes('--list')) {
    const options = parseOptions(kind, args);
    if (options.baselines) {
      const mapping = readBaselineMap(options.baselines);
      const resolvedSources = new Map();
      for (const run of aiRuns(options)) {
        for (const arm of Object.values(mapping.cases[run.id] ?? {})) {
          let source = resolvedSources.get(arm.runDir);
          if (!source) {
            try {
              source = await resolveRunSource(arm.runDir);
              if (!auditRunEvidence(source.directory).comparable) console.error('Baseline evidence is incomplete; continuing with comparison marked unknown.');
            } catch {
              source = { directory: arm.runDir };
              console.error('Baseline evidence could not be resolved; continuing the requested candidate run.');
            }
            resolvedSources.set(arm.runDir, source);
          }
          arm.runDir = source.directory;
        }
      }
      const preflight = mkdtempSync(resolve(tmpdir(), 'lineage-baseline-preflight-'));
      const path = resolve(preflight, 'baselines.json');
      writeFileSync(path, JSON.stringify(mapping, null, 2) + '\n');
      args[args.indexOf('--baselines') + 1] = path;
    }
  }
  if (kind === 'ai' && args.includes('--all') && !args.includes('--list') && !args.includes('--help')) {
    const options = parseOptions(kind, args);
    const runs = aiRuns(options);
    const inventory = [];
    for (const run of runs) {
      let result;
      const exitCode = await main(kind, [...args.filter(arg => arg !== '--all'), '--case', run.id], value => { result = value; });
      let comparison = { compared: false, reason: 'No paired comparison completed.' };
      const evidence = result?.artifacts ? auditRunEvidence(result.artifacts) : null;
      if (result?.artifacts) {
        try { comparison = JSON.parse(readFileSync(resolve(result.artifacts, 'baseline-score.json'), 'utf8')); } catch {}
      }
      inventory.push({ id: run.id, description: run.description ?? null, plannedTurns: run.prompts.length,
        execution: exitCode === 0 ? 'completed' : 'error', exitCode: evidence?.comparable ? exitCode : 2, artifacts: result?.artifacts ?? null,
        runtime: result?.runtime ?? 'not_started', captureGaps: result?.captureGaps ?? null,
        comparison, evidence, contentVerdict: 'unreviewed' });
      if (exitCode === 3 || exitCode === 4 || !evidence?.comparable) break;
    }
    const reportDir = resolve(root, 'test-results/headless', `all-${randomUUID()}`);
    mkdirSync(reportDir, { recursive: true });
    const report = { runner: 'headless', plannedCases: runs.length, plannedTurns: runs.reduce((sum, run) => sum + run.prompts.length, 0),
      cases: inventory, unexecutedCases: runs.filter(run => !inventory.some(row => row.id === run.id)).map(run => run.id),
      ...caseInventory(), otherSurfaces: 'docs/testing/README.md#optional-checks', contentVerdict: 'unreviewed' };
    writeFileSync(resolve(reportDir, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ inventory: resolve(reportDir, 'inventory.json') }));
    process.exitCode = inventory.find(row => row.exitCode !== 0)?.exitCode ?? 0;
  } else {
    let result;
    process.exitCode = await main(kind, args, value => { result = value; });
    if (kind === 'ai' && result?.artifacts && !auditRunEvidence(result.artifacts).comparable) {
      console.error('Capture evidence is incomplete; comparison is unavailable.');
      process.exitCode = 2;
    }
  }
} catch {
  console.error('FAIL: optional runner could not complete; inspect ignored test-results/headless output.');
  process.exitCode = 2;
}
