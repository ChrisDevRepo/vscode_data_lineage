// Covers how gate steps report a skipped comparison, and when the template-version step may skip.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCi, SKIP_EXIT_CODE, stepOutcome } from './gate-status.mjs';

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
function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dlv-gate-'));
  try {
    for (const path of TRACKED) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      copyFileSync(join(repoRoot, path), join(dir, path));
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', 'commit', '-q', '-m', 'baseline');
    return run(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCheck(cwd, ci) {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
}

test('without a release tag or origin/main the check skips locally with a distinct status', () => withRepo((dir) => {
  const run = runCheck(dir);
  assert.equal(run.status, SKIP_EXIT_CODE, run.stdout + run.stderr);
  assert.match(run.stdout, /^SKIP /);
}));

test('without a release tag or origin/main the check fails under CI', () => withRepo((dir) => {
  const run = runCheck(dir, 'true');
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^FAIL .*fetch/);
}));

test('with origin/main present the comparison runs and passes', () => withRepo((dir, git) => {
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = runCheck(dir, 'true');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^PASS .*unchanged since origin\/main/);
}));
