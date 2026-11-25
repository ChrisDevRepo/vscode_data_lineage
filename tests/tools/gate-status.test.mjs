// Covers how gate steps report a skipped comparison, and when the template-version step may skip.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Baselines the copy at `origin/main`, rewrites the templates asset in the working tree, then runs the check under CI. */
function checkEditedAsset(edit) {
  return withRepo((dir, git) => {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const asset = join(dir, 'assets', 'aiOutputTemplates.yaml');
    const before = readFileSync(asset, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, 'the edit must change the asset');
    writeFileSync(asset, after);
    return runCheck(dir, 'true');
  });
}

test('a removed template with an unchanged version passes: an old overlay is skipped by the unknown-key warning', () => {
  const run = checkEditedAsset((text) => text.replace(/^loading_pattern:\n(?:[ \t]+.*\n|\n)*/m, ''));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^PASS /);
  assert.match(run.stdout, /- loading_pattern \(template removed\)/);
});

test('an added template with an unchanged version passes: an old overlay falls back to the built-in', () => {
  const run = checkEditedAsset((text) => `${text}\nextra_template:\n  instruction: x\n`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^PASS /);
  assert.match(run.stdout, /\+ extra_template \(new template\)/);
});

test('a retyped field with an unchanged version fails: an old overlay would be read against the wrong shape', () => {
  const run = checkEditedAsset((text) => text.replace('title:\n  stages: [synthesis]', 'title:\n  stages: synthesis'));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /~ title\.stages: array → string/);
  assert.doesNotMatch(run.stderr, /Any added, removed/);
});

test('a removed field with an unchanged version fails: the loader ignores an unknown field inside a template without a warning', () => {
  const run = checkEditedAsset((text) => text.replace('title:\n  stages: [synthesis]\n', 'title:\n'));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /- title\.stages: array/);
});
