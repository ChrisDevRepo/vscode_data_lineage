#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const SKIP_EXIT_CODE = 77;
const stepOutcome = (status) => (status === 0 ? 'PASS' : status === SKIP_EXIT_CODE ? 'SKIP' : 'FAIL');
const stepFailureOutput = (step, run) => {
  if (run.output && run.output.trim()) return run.output;
  return `No output captured.\nCommand: ${JSON.stringify([step.cmd, ...step.args])}\n`
    + `Exit status: ${run.status ?? 'none'}\n`
    + (run.signal ? `Signal: ${run.signal}\n` : '')
    + (run.error ? `Spawn error: ${run.error.message}\n` : '');
};
import { nodeBin, npmCommand } from './npm-launcher.mjs';

/** Where a failing step's captured output is written, so a red gate stays diagnosable. */
const LOG_DIR = join('test-results', 'gate');

/** Runs one step, streaming its output live while retaining a copy. */
function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    let output = '';
    const capture = (stream, sink) => stream.on('data', (chunk) => {
      output += chunk;
      sink.write(chunk);
    });
    capture(child.stdout, process.stdout);
    capture(child.stderr, process.stderr);
    child.on('error', (error) => resolve({ status: null, error, output }));
    child.on('close', (status, signal) => resolve({ status, signal, error: null, output }));
  });
}

/** One gate step that runs an npm script by name. See npm-launcher.mjs for the spawn form. */
const npmRun = (name, script, args = []) => ({
  name, ...npmCommand('npm', ['run', script, ...(args.length ? ['--', ...args] : [])]),
});

/** Keep terminal progress and persist each unit lane's test failures in a JSON report. */
const unitReport = (lane) => join(LOG_DIR, `${lane}-unit.json`);
const unitReportArgs = (lane) => ['--reporter=default', '--reporter=json', `--outputFile.json=${unitReport(lane)}`];

const STEPS = [
  npmRun('typescript-eslint', 'lint'),
  npmRun('Prettier', 'format:check'),
  npmRun('knip', 'knip'),
  npmRun('typecheck', 'typecheck'),
  npmRun('typecheck:tests', 'typecheck:tests'),
  { name: 'tool manifest codegen', cmd: nodeBin, args: ['scripts/generate-tool-manifest.mjs', '--check'] },
  { name: 'source invariants', cmd: nodeBin, args: ['tests/tools/assert-invariants.mjs', 'source'] },
  { name: 'test environment profiles', cmd: nodeBin, args: ['--test', 'tests/tools/load-test-env.test.mjs'] },
  { name: 'markdown facts', cmd: nodeBin, args: ['scripts/verify-docs.mjs'] },
  { name: 'code comments', cmd: nodeBin, args: ['scripts/verify-code-comments.mjs'] },
  npmRun('unit: parser and lineage (+ coverage floors)', 'coverage:core', unitReportArgs('core')),
  npmRun('unit: AI and trust contracts', 'test:runtime', unitReportArgs('runtime')),

  npmRun('build + integration tsc', 'pretest:integration'),
  { name: 'third-party notices', cmd: nodeBin, args: ['scripts/generate-third-party-notices.mjs', '--check'] },
  { name: 'build invariants', cmd: nodeBin, args: ['tests/tools/assert-invariants.mjs', 'build'] },
];

mkdirSync(LOG_DIR, { recursive: true });
const startedAt = new Date().toISOString();
const unitReports = ['core', 'runtime'].map(unitReport);
for (const file of unitReports) rmSync(file, { force: true });

const results = [];
for (const step of STEPS) {
  process.stdout.write(`\n──── ${step.name}\n`);
  const started = Date.now();
  const run = await runStep(step);
  const outcome = run.error ? 'FAIL' : stepOutcome(run.status);
  const ok = outcome !== 'FAIL';
  let logPath = '';
  if (!ok) {
    logPath = join(LOG_DIR, `${step.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
    writeFileSync(logPath, stepFailureOutput(step, run), 'utf8');
  }
  results.push({
    name: step.name,
    outcome,
    ok,
    logPath,
    note: run.error ? `did not start: ${run.error.message}`
      : run.status === null ? `killed by signal${run.signal ? ` ${run.signal}` : ''}`
      : !ok && step.viaShim ? 'ran via the PATH npm shim'
      : '',
    ms: Date.now() - started,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
  });
}

/** Machine-readable verdicts: step outcomes plus test counts from this run's unit reports (null if one is missing). */
const totals = unitReports.every((file) => existsSync(file)) ? unitReports.map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .reduce((sum, r) => ({ passed: sum.passed + r.numPassedTests, failed: sum.failed + r.numFailedTests,
    skipped: sum.skipped + r.numPendingTests + r.numTodoTests }), { passed: 0, failed: 0, skipped: 0 }) : null;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null;
writeFileSync(join(LOG_DIR, 'summary.json'), `${JSON.stringify({ head, startedAt,
  steps: results.map(({ name, outcome, ms }) => ({ name, outcome, ms })), totals }, null, 2)}\n`);

const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write(`\n${'='.repeat(width + 18)}\nGATE SUMMARY\n${'='.repeat(width + 18)}\n`);
for (const r of results) {
  const note = r.note ? `  (${r.note})` : '';
  const log = r.logPath ? `  → ${r.logPath}` : '';
  process.stdout.write(`${r.outcome}  ${r.name.padEnd(width)}  ${r.seconds}s${note}${log}\n`);
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.outcome === 'SKIP');
process.stdout.write(`${'='.repeat(width + 18)}\n`);
process.stdout.write(
  `${results.length - failed.length - skipped.length}/${results.length} green`
  + `${skipped.length > 0 ? `, ${skipped.length} skipped (not verified)` : ''}\n`,
);
process.stdout.write('MODEL CALLS: 0 — every step above is deterministic; nothing here infers.\n');
process.stdout.write(
  'Additional checks: npm run test:support runs webview, database, routing and operator-tool tests. '
  + 'npm run test:edh exercises the VS Code host with fixed responses; '
  + 'npm run test:ai:smoke optionally calls a configured provider through that host. '
  + 'Review model answer correctness against the source SQL and graph. See docs/testing/README.md.\n',
);

process.exit(failed.length === 0 ? 0 : 1);
