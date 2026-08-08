#!/usr/bin/env node
// One command that answers "which gates are green?" — `npm run gate`.
//
// Local deterministic gate. Nothing here pushes, publishes, or runs a real
// model. T1-T7 runs in the tracked scenario-matrix EDH lane (`npm run
// test:scenario-matrix`), which launches Electron and is therefore not part of
// this gate.
import { spawnSync } from 'node:child_process';
import { nodeBin, npmCommand } from './npm-launcher.mjs';

/**
 * One gate step that runs an npm script by name.
 *
 * Prefers running npm's own JavaScript with node — the only form that works on Windows — and falls
 * back to the original `npm` PATH lookup, which macOS and Linux have always been able to use. See
 * npm-launcher.mjs for the full rationale.
 */
const npmRun = (name, script) => ({ name, ...npmCommand('npm', ['run', script]) });

const STEPS = [
  // Fast, no VS Code. Run first so an obvious break fails in seconds rather than minutes.
  npmRun('typecheck', 'typecheck'),
  npmRun('typecheck:tests', 'typecheck:tests'),
  // Derived-artifact check: `contributes.languageModelTools` is generated from the Zod tool
  // catalog. Runs before the suite because a stale manifest is a one-command fix, not a debug session.
  { name: 'tool manifest codegen', cmd: nodeBin, args: ['scripts/generate-tool-manifest.mjs', '--check'] },
  npmRun('unit: core', 'test:core'),
  npmRun('unit: AI', 'test:ai'),
  npmRun('unit: prompts (golden)', 'test:prompts'),

  // Build once, then the gates that read build output. `pretest:integration` is `build` plus the
  // integration-test compile. Compiling the optional E2E tests here prevents them from rotting
  // without paying the cost of launching a real VS Code host on every local gate.
  npmRun('build + integration tsc', 'pretest:integration'),
  { name: 'package contents', cmd: nodeBin, args: ['tests/tools/assert-package-contents.mjs'] },
  { name: 'no LangSmith in bundle', cmd: nodeBin, args: ['tests/tools/assert-no-langsmith.mjs'] },
];

const results = [];
for (const step of STEPS) {
  process.stdout.write(`\n──── ${step.name}\n`);
  const started = Date.now();
  // No `shell` on any platform — see npm-launcher.mjs.
  const run = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: false });
  results.push({
    name: step.name,
    ok: run.status === 0,
    // A step that never started is not the same as a step that ran and failed — reporting both as
    // FAIL once made a build-ordering bug read as a bundle-size breach.
    note: run.error ? `did not start: ${run.error.message}` : run.status === null ? 'killed by signal' : '',
    seconds: ((Date.now() - started) / 1000).toFixed(1),
  });
}

const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write(`\n${'='.repeat(width + 18)}\nGATE SUMMARY\n${'='.repeat(width + 18)}\n`);
for (const r of results) {
  const note = r.note ? `  (${r.note})` : '';
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.seconds}s${note}\n`);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`${'='.repeat(width + 18)}\n`);
process.stdout.write(`${results.length - failed.length}/${results.length} green\n`);
// Not covered here, and not inferable from a green run: the optional Electron E2E suite, the
// T1-T7 scenario lane, or any real-model lane.
process.stdout.write(
  'NOT covered: Electron E2E (npm run test:e2e), T1-T7 (npm run test:scenario-matrix), '
  + 'or the headless real-model lanes (npm run test:e2e-real -- --lane <azure-foundry|openrouter|'
  + 'local-mlx> --prompt <P1-P3|T1-T7>), which need provider credentials in .env; '
  + 'see docs/E2E_TESTING.md.\n',
);

process.exit(failed.length === 0 ? 0 : 1);
