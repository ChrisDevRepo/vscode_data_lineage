#!/usr/bin/env node
/**
 * Repairs the `langsmith` dependency install after `npm install` / `npm ci`.
 *
 * Why this exists: the repo's LangSmith containment (see docs/ARCHITECTURE.md §LangSmith
 * containment) replaces the transitive `langsmith` dependency of `@langchain/core` with the
 * inert local stub in `stubs/langsmith/` via the root package.json `overrides` field. npm
 * declares that replacement as a symlink `node_modules/langsmith ->
 * node_modules/@langchain/core/stubs/langsmith`, but several npm 10.x releases fail to
 * materialize the symlink target — leaving `node_modules/langsmith` dangling, which fails
 * the extension bundle (`Could not resolve "langsmith"` in esbuild) for every fresh clone.
 *
 * This script runs as `postinstall`: whenever the resolved `langsmith` is missing, dangling,
 * or not the stub, it replaces it with a real-directory copy of `stubs/langsmith`. Idempotent,
 * offline, and safe to run repeatedly.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubSource = path.join(repoRoot, 'stubs', 'langsmith');
const stubTarget = path.join(repoRoot, 'node_modules', 'langsmith');

function stubIdentityOk(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name === 'langsmith' && pkg.version === '0.0.0-excluded';
  } catch {
    return false;
  }
}

function targetIsUsable() {
  if (!existsSync(stubTarget)) return false;
  try {
    // A dangling symlink passes existsSync() as false in some Node versions and true in
    // others — stat through it explicitly: a broken link throws here.
    statSync(stubTarget);
  } catch {
    return false;
  }
  return stubIdentityOk(stubTarget);
}

try {
  if (targetIsUsable()) {
    console.log('[repair-langsmith-stub] stub already in place — nothing to do.');
    process.exit(0);
  }

  // Resolve from Node's own resolver as the second opinion: a dangling link or missing
  // package throws here, confirming the repair is needed even if the filesystem state
  // above looked ambiguous. Resolving is not on its own a reason to stop — the containment
  // requires the STUB to be what resolves, so a real `langsmith` that resolves from anywhere
  // is reported rather than accepted.
  const probe = spawnSync(process.execPath, ['-p', 'require.resolve("langsmith/package.json")'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const resolvedDir = probe.status === 0 && probe.stdout.trim()
    ? path.dirname(probe.stdout.trim())
    : null;
  if (resolvedDir && stubIdentityOk(resolvedDir)) {
    console.log('[repair-langsmith-stub] the inert stub resolves — leaving the install untouched.');
    process.exit(0);
  }
  if (resolvedDir && path.resolve(resolvedDir) !== path.resolve(stubTarget)) {
    // Nested under a dependency, so writing the root stub cannot shadow it. Reported, not
    // silently repaired: `assert-no-langsmith` is the fail-closed gate that must see this.
    console.error(`[repair-langsmith-stub] WARNING: a non-stub "langsmith" resolves from ${resolvedDir}.`);
    console.error('The LangSmith containment is broken there — reinstall with `npm ci` and check the `overrides` entry.');
  }

  rmSync(stubTarget, { force: true, recursive: true });
  mkdirSync(path.dirname(stubTarget), { recursive: true });
  cpSync(stubSource, stubTarget, { recursive: true });
  console.log('[repair-langsmith-stub] reinstalled the inert langsmith stub (npm left the override symlink dangling).');
} catch (error) {
  console.error(`[repair-langsmith-stub] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error('The extension bundle will fail to resolve "langsmith" until this is fixed.');
  process.exit(1);
}
