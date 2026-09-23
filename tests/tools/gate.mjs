#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeBin, npmCommand } from './npm-launcher.mjs';

/** Where a failing step's captured output is written, so a red gate stays diagnosable. */
const LOG_DIR = join('test-results', 'gate');

/**
 * Runs one step, streaming its output live while retaining a copy.
 *
 * @param step - Step descriptor.
 * @returns Exit status, spawn error, and the combined output.
 *
 * @remarks
 * `stdio: 'inherit'` cannot tee, so a failed step's diagnostics survived only in terminal
 * scrollback — worthless for an intermittent failure, which is the case that most needs them.
 * Streaming keeps the live view a long step depends on.
 */
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
    child.on('close', (status) => resolve({ status, error: null, output }));
  });
}

/** One gate step that runs an npm script by name. See npm-launcher.mjs for the spawn form. */
const npmRun = (name, script) => ({ name, ...npmCommand('npm', ['run', script]) });

const STEPS = [
  npmRun('typecheck', 'typecheck'),
  npmRun('typecheck:tests', 'typecheck:tests'),
  { name: 'tool manifest codegen', cmd: nodeBin, args: ['scripts/generate-tool-manifest.mjs', '--check'] },
  { name: 'output template schema version', cmd: nodeBin, args: ['tests/tools/assert-template-schema-version.mjs'] },
  { name: 'prompt golden sync', cmd: nodeBin, args: ['tests/tools/assert-golden-sync.mjs'] },
  { name: 'honest test labels', cmd: nodeBin, args: ['tests/tools/assert-honest-test-labels.mjs'] },
  { name: 'core case completeness', cmd: nodeBin, args: ['tests/tools/assert-core-cases-complete.mjs'] },
  { name: 'unit project coverage', cmd: nodeBin, args: ['tests/tools/assert-unit-projects-cover-all.mjs'] },
  { name: 'layer direction', cmd: nodeBin, args: ['tests/tools/assert-layer-direction.mjs'] },
  npmRun('unit: core (+ core coverage floors)', 'coverage:core'),
  npmRun('unit: agent runtime', 'test:runtime'),

  npmRun('build + integration tsc', 'pretest:integration'),
  { name: 'package contents', cmd: nodeBin, args: ['tests/tools/assert-package-contents.mjs'] },
  { name: 'no LangSmith in bundle', cmd: nodeBin, args: ['tests/tools/assert-no-langsmith.mjs'] },
];

mkdirSync(LOG_DIR, { recursive: true });

const results = [];
for (const step of STEPS) {
  process.stdout.write(`\n──── ${step.name}\n`);
  if (step.skip) {
    // A skipped step never spawns — nothing to time, capture, or log. It still gets a row, so a
    // reader of the summary sees why a step is missing instead of having to notice it is.
    process.stdout.write(`SKIP  ${step.name}  (${step.skip})\n`);
    results.push({ name: step.name, skipped: true, reason: step.skip });
    continue;
  }
  const started = Date.now();
  const run = await runStep(step);
  const ok = run.status === 0;
  let logPath = '';
  if (!ok) {
    logPath = join(LOG_DIR, `${step.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
    writeFileSync(logPath, run.output, 'utf8');
  }
  results.push({
    name: step.name,
    skipped: false,
    ok,
    logPath,
    // A step that never started is reported differently from one that ran and failed. `viaShim`
    // marks the degraded PATH lookup, which changes what a failure likely means — npm-launcher.mjs
    // documents that callers report it, and this is the caller.
    note: run.error ? `did not start: ${run.error.message}`
      : run.status === null ? 'killed by signal'
      : !ok && step.viaShim ? 'ran via the PATH npm shim'
      : '',
    seconds: ((Date.now() - started) / 1000).toFixed(1),
  });
}

const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write(`\n${'='.repeat(width + 18)}\nGATE SUMMARY\n${'='.repeat(width + 18)}\n`);
for (const r of results) {
  if (r.skipped) {
    process.stdout.write(`SKIP  ${r.name.padEnd(width)}  (${r.reason})\n`);
    continue;
  }
  const note = r.note ? `  (${r.note})` : '';
  const log = r.logPath ? `  → ${r.logPath}` : '';
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.seconds}s${note}${log}\n`);
}

// Skipped steps are neither green nor red — they never ran — so the tally counts them apart from
// the green/total ratio instead of letting them inflate or deflate it silently.
const judged = results.filter((r) => !r.skipped);
const failed = judged.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
process.stdout.write(`${'='.repeat(width + 18)}\n`);
process.stdout.write(`${judged.length - failed.length}/${judged.length} green, ${skipped.length} skipped\n`);
// Stated on every run, green or red. A gate summary is quoted as a result, and every step above
// runs against a stubbed `vscode` and scripted doubles — so without this line a reader can take a
// green gate for evidence about model behaviour, which no step here produces.
process.stdout.write('MODEL CALLS: 0 — every step above is deterministic; nothing here infers.\n');
process.stdout.write(
  'NOT covered: extension-host behaviour (npm run test:edh — smoke lanes only, still 0 '
  + 'inference); model behaviour, which is measured internally, never by this repository; or the '
  + "product path itself — real VS Code with the user's own Copilot model — which no automated "
  + 'suite covers and only UAT does. See docs/EDH_TESTING.md.\n',
);

process.exit(failed.length === 0 ? 0 : 1);
