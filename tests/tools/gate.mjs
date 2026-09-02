#!/usr/bin/env node
// One command that answers "which gates are green?" — `npm run gate`.
//
// Local deterministic gate. Nothing here pushes, publishes, or runs a real
// model. The scripted S1-S7 scenario matrix and real-model T1-T7 measurement
// both launch outside this process (Electron / a live provider) and are
// internal-only.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeBin, npmCommand, pythonCommand } from './npm-launcher.mjs';

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

/**
 * Builds one internal-only Python gate step.
 *
 * @param name - Gate step label.
 * @param scriptPath - Path to the `.py` suite, relative to the repo root.
 * @returns A step descriptor: runnable when both the script and a Python interpreter are present,
 *   `skip`-flagged with the specific reason otherwise.
 *
 * @remarks
 * The step stays in `STEPS` unconditionally so a skip is a visible row in the summary, not an
 * entry that silently never existed. Two independent reasons can produce a skip — the script is
 * internal-only and absent from a public clone, or no interpreter is on PATH — and the summary
 * reports whichever applies, never a generic "skipped".
 */
function internalPythonStep(name, scriptPath) {
  if (!existsSync(scriptPath)) {
    return { name, skip: `${scriptPath} not present in this clone (internal-only)` };
  }
  const python = pythonCommand();
  if (!python) {
    return { name, skip: 'no python interpreter on PATH' };
  }
  return { name, cmd: python, args: [scriptPath] };
}

const STEPS = [
  // Ordered cheapest-first: type errors and derived-artifact drift fail in seconds, before the
  // suites, and everything needing build output runs after the single build step.
  npmRun('typecheck', 'typecheck'),
  npmRun('typecheck:tests', 'typecheck:tests'),
  { name: 'tool manifest codegen', cmd: nodeBin, args: ['scripts/generate-tool-manifest.mjs', '--check'] },
  { name: 'output template schema version', cmd: nodeBin, args: ['tests/tools/assert-template-schema-version.mjs'] },
  { name: 'honest test labels', cmd: nodeBin, args: ['tests/tools/assert-honest-test-labels.mjs'] },
  // The process guards live in .claude/, which is internal-only and never tracked here, so this
  // step SKIPs (reported, not omitted — see internalPythonStep) for a public clone that has
  // neither the suite nor necessarily a Python interpreter.
  internalPythonStep('process guards', '.claude/hooks/test_guard.py'),
  internalPythonStep('loop continuity', '.claude/hooks/test_continuity.py'),
  // One mocked improvement cycle end to end - start, guarded work, gate, Ladder, push gate,
  // recorded result, halt and ruling - against isolated state and scratch copies of a batch.
  internalPythonStep('mock cycle', '.claude/hooks/test_mock_cycle.py'),
  // Structural, so it runs with the other seconds-long checks rather than with the suites. Line
  // coverage cannot answer this: a rule matched by no fixture still reads as covered.
  { name: 'core case completeness', cmd: nodeBin, args: ['tests/tools/assert-core-cases-complete.mjs'] },
  // Runs before the two unit steps below, because it is what makes them add up to the whole
  // unit suite. Without it a new tests/unit/ directory is run by `npm test` and by no gate step.
  { name: 'unit project coverage', cmd: nodeBin, args: ['tests/tools/assert-unit-projects-cover-all.mjs'] },
  // src/engine/** is the deterministic core; it must stay independent of the React webview layer
  // (src/components/**) so it typechecks and tests without a DOM. Guards the X1 layering fix.
  { name: 'layer direction', cmd: nodeBin, args: ['tests/tools/assert-layer-direction.mjs'] },
  // Runs the same suite as `test:core`, with per-file coverage floors on the deterministic
  // core — SQL parsing and graph/BFS — so a regression there fails the gate rather than
  // showing up as a silently smaller number. Floors are measured, never aspirational.
  npmRun('unit: core (+ core coverage floors)', 'coverage:core'),
  // Not "unit: AI". These cover the agent runtime's own logic — state machine, tool dispatch,
  // schemas, gates — against a stubbed `vscode` and scripted model doubles. Zero model calls, so
  // naming them for AI would report inference coverage the step does not have.
  npmRun('unit: agent runtime', 'test:runtime'),

  // `pretest:integration` is `build` plus the integration-test compile, which keeps the optional
  // E2E tests from rotting without launching a host here.
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
