#!/usr/bin/env node
// Gate step: every unit test file runs in exactly one of the gate's three unit projects.
//
// `npm test` runs `tests/unit/**/*.test.ts` from one glob, but the gate runs `test:core` and
// `test:runtime` — two hard-coded path lists. They happen to cover the same files today, and
// nothing enforces it: a new `tests/unit/<dir>/` would be picked up by `npm test` and silently
// never run by the gate, so a green gate would stop meaning "the unit suite passed".
//
// This compares the two and fails on either half of the mismatch — a file no project claims, or a
// file two projects both claim (which double-counts a suite total and makes a per-project failure
// ambiguous). It reads the path lists out of package.json rather than restating them, so the check
// cannot drift from the scripts it is checking.
//
// Usage:
//   node tests/tools/assert-unit-projects-cover-all.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIT_ROOT = path.join(repoRoot, 'tests', 'unit');

/** The scripts the gate runs as its unit steps. Keep in step with `STEPS` in gate.mjs. */
const GATE_UNIT_SCRIPTS = ['coverage:core', 'test:runtime'];

/** Repo-relative POSIX path, so package.json arguments and disk paths compare as strings. */
const rel = (absolute) => path.relative(repoRoot, absolute).replaceAll('\\', '/');

/** Every `*.test.ts` under `tests/unit`, repo-relative, matching the `npm test` include glob. */
function unitTestFiles(dir = UNIT_ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) unitTestFiles(full, found);
    else if (entry.name.endsWith('.test.ts')) found.push(rel(full));
  }
  return found;
}

/**
 * Path arguments one `run-vitest.mjs` script passes to Vitest.
 *
 * @param command - The npm script body.
 * @returns Repo-relative path arguments, flags and the runner invocation removed.
 */
function pathArgsOf(command) {
  return command
    .split(/\s+/u)
    .slice(3) // `node tests/tools/run-vitest.mjs run`
    .filter((token) => token && !token.startsWith('-'))
    .map((token) => token.replaceAll('\\', '/'));
}

/** Every unit test file a path argument selects: a file directly, or a directory recursively. */
function filesSelectedBy(pathArg, allFiles) {
  const absolute = path.join(repoRoot, pathArg);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return null; // Signals a path that no longer exists — reported as its own failure.
  }
  if (stats.isFile()) return [pathArg];
  const prefix = `${pathArg.replace(/\/+$/u, '')}/`;
  return allFiles.filter((file) => file.startsWith(prefix));
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const allFiles = unitTestFiles().sort();
const problems = [];

if (allFiles.length === 0) {
  console.error('FAIL: found no tests/unit/**/*.test.ts files at all — treating as a tooling failure.');
  process.exit(2);
}

/** file -> the gate scripts that run it. */
const claimedBy = new Map(allFiles.map((file) => [file, []]));

for (const script of GATE_UNIT_SCRIPTS) {
  const command = pkg.scripts?.[script];
  if (!command) {
    problems.push(`package.json has no "${script}" script, but gate.mjs runs it as a unit step.`);
    continue;
  }
  for (const pathArg of pathArgsOf(command)) {
    const selected = filesSelectedBy(pathArg, allFiles);
    if (selected === null) {
      problems.push(`"${script}" names ${pathArg}, which does not exist.`);
      continue;
    }
    if (selected.length === 0) {
      problems.push(`"${script}" names ${pathArg}, which selects no test file.`);
      continue;
    }
    for (const file of selected) claimedBy.get(file)?.push(script);
  }
}

for (const [file, scripts] of claimedBy) {
  if (scripts.length === 0) {
    problems.push(
      `${file} runs under "npm test" but under no gate unit step. Add its directory to one of `
      + `${GATE_UNIT_SCRIPTS.join(', ')} in package.json, or the gate will report green without it.`,
    );
  } else if (new Set(scripts).size > 1) {
    problems.push(`${file} is claimed by more than one gate unit step (${[...new Set(scripts)].join(', ')}).`);
  }
}

if (problems.length > 0) {
  console.error('FAIL  the gate unit steps do not cover the unit suite exactly:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error('See docs/EDH_TESTING.md §Pre-push gate.');
  process.exit(1);
}

console.log(
  `PASS  all ${allFiles.length} unit test files run in exactly one gate unit step `
  + `(${GATE_UNIT_SCRIPTS.join(', ')}).`,
);
