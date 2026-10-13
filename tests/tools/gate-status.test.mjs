// Covers how gate steps report a skipped comparison, and when the template-version step may skip.
import assert from 'node:assert/strict';
import { runCommand } from './command.mjs';
import { checkTemplateSchema } from './assert-template-schema-version.mjs';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCi, SKIP_EXIT_CODE, stepOutcome, stepFailureOutput } from './gate-status.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(repoRoot, 'tests', 'tools', 'assert-template-schema-version.mjs');
const TRACKED = ['assets/aiOutputTemplates.yaml', 'src/ai/session/types.ts'];

test('step outcome distinguishes pass, skip and failure', () => {
  assert.equal(stepOutcome(0), 'PASS');
  assert.equal(stepOutcome(SKIP_EXIT_CODE), 'SKIP');
  assert.equal(stepOutcome(1), 'FAIL');
  assert.equal(stepOutcome(null), 'FAIL');
});

test('CI detection follows the conventional CI variable', () => {
  assert.equal(isCi({}), false);
  assert.equal(isCi({ CI: '' }), false);
  assert.equal(isCi({ CI: 'false' }), false);
  assert.equal(isCi({ CI: '0' }), false);
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(isCi({ CI: '1' }), true);
});

/** A throwaway repository holding the two files the template-version check reads, with no remote or tags. */
async function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dlv-gate-'));
  try {
    for (const path of TRACKED) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      copyFileSync(join(repoRoot, path), join(dir, path));
    }
    const git = (...args) => runCommand('git', args, { cwd: dir });
    await git('init', '-q');
    await git('add', '.');
    await git('-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', 'commit', '-q', '-m', 'baseline');
    return await run(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runCheck(cwd, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  const stdout = [], stderr = [];
  const status = await checkTemplateSchema({ cwd, env,
    stdout: message => stdout.push(message), stderr: message => stderr.push(message),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** Checks the real CLI status; diagnostic text is asserted at its shared function boundary. */
async function cliStatus(cwd, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  try {
    await runCommand(process.execPath, [SCRIPT], { cwd, env });
    return 0;
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return error.code;
  }
}

test('without a release tag or origin/main the check skips locally with a distinct status', () => withRepo(async (dir) => {
  const run = await runCheck(dir);
  assert.equal(run.status, SKIP_EXIT_CODE, run.stdout + run.stderr);
  assert.match(run.stdout, /^SKIP /);
  assert.equal(await cliStatus(dir), SKIP_EXIT_CODE);
}));

test('without a release tag or origin/main the check fails under CI', () => withRepo(async (dir) => {
  const run = await runCheck(dir, 'true');
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^FAIL .*fetch/);
  assert.equal(await cliStatus(dir, 'true'), 1);
}));

test('with origin/main present the comparison runs and passes', () => withRepo(async (dir, git) => {
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = await runCheck(dir, 'true');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^PASS .*unchanged since origin\/main/);
  assert.equal(await cliStatus(dir, 'true'), 0);
}));

test('failure logs preserve captured output and diagnose empty child output', () => {
  const step = { cmd: 'node', args: ['check.mjs'] };
  assert.equal(stepFailureOutput(step, { output: 'original diagnostic\n', status: 1 }), 'original diagnostic\n');
  const silent = stepFailureOutput(step, { output: '', status: 7 });
  assert.match(silent, /No output captured/);
  assert.match(silent, /node.*check\.mjs/);
  assert.match(silent, /Exit status: 7/);
  assert.match(stepFailureOutput(step, { output: '', status: null, signal: 'SIGTERM' }), /Signal: SIGTERM/);
  assert.match(stepFailureOutput(step, { output: '', status: null, error: new Error('spawn ENOENT') }), /spawn ENOENT/);
});

test('a missing Git executable is a failure, never a skipped comparison', () => withRepo(async dir => {
  const diagnostics = [];
  await assert.rejects(checkTemplateSchema({ cwd: dir, env: { ...process.env, PATH: dir, CI: 'true' },
    stdout: message => diagnostics.push(message), stderr: message => diagnostics.push(message),
  }), { code: 'ENOENT' });
  assert.deepEqual(diagnostics, []);
}));

test('a corrupt baseline object is a failure, never a predates-file skip', () => withRepo(async dir => {
  mkdirSync(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), '1111111111111111111111111111111111111111\n');
  const diagnostics = [];
  await assert.rejects(checkTemplateSchema({ cwd: dir, env: { ...process.env, CI: 'true' },
    stdout: message => diagnostics.push(message), stderr: message => diagnostics.push(message),
  }));
  assert.deepEqual(diagnostics, []);
}));

test('a baseline that genuinely lacks the asset still reports the predates skip', () => withRepo(async (dir, git) => {
  await git('rm', 'assets/aiOutputTemplates.yaml');
  await git('-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', 'commit', '-q', '-m', 'pre-asset baseline');
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  copyFileSync(join(repoRoot, 'assets/aiOutputTemplates.yaml'), join(dir, 'assets/aiOutputTemplates.yaml'));
  const run = await runCheck(dir, 'true');
  assert.equal(run.status, SKIP_EXIT_CODE);
  assert.match(run.stdout, /origin\/main predates assets\/aiOutputTemplates\.yaml/);
  assert.equal(await cliStatus(dir, 'true'), SKIP_EXIT_CODE);
}));
