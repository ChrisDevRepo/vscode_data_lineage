#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyUnitTests, unitTestFiles } from './unit-lanes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * npm scripts that must keep pointing at the lane runner.
 * Gate steps are `coverage:core` and `test:runtime`. `test` is their union.
 * `test:support` is intentional and stays out of the gate.
 */
const SCRIPT_LANES = {
  test: 'gate',
  'test:core': 'core',
  'test:lineage': 'lineage',
  'test:bfs': 'lineage',
  'test:runtime': 'runtime',
  'test:support': 'support',
  'coverage:core': 'core',
};

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const problems = [];

for (const [script, lane] of Object.entries(SCRIPT_LANES)) {
  const command = pkg.scripts?.[script];
  if (!command) {
    problems.push(`package.json has no "${script}" script.`);
    continue;
  }
  if (!command.includes('tests/tools/run-lane.mjs') || !command.includes(lane)) {
    problems.push(`"${script}" must run tests/tools/run-lane.mjs ${lane}. It is: ${command}`);
  }
  if (script === 'coverage:core' && !command.includes('--coverage')) {
    problems.push('"coverage:core" must pass --coverage so the parser and lineage floors still run.');
  }
}

const allFiles = unitTestFiles().sort();
if (allFiles.length === 0) {
  console.error('FAIL: found no tests/unit/**/*.test.ts(x) files at all — treating as a tooling failure.');
  process.exit(2);
}

const classified = classifyUnitTests(allFiles);
problems.push(...classified.problems);

const gateCount = classified.core.length + classified.runtime.length;
if (classified.support.length === 0) {
  problems.push('support lane is empty; optional suites would have been folded back into the gate.');
}

if (problems.length > 0) {
  console.error('FAIL  the unit lanes do not partition the suite:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error('See docs/testing/README.md and tests/tools/unit-lanes.mjs.');
  process.exit(1);
}

console.log(
  `PASS  ${allFiles.length} unit test files partitioned: `
  + `${classified.core.length} core, ${classified.runtime.length} runtime, `
  + `${classified.support.length} support. The gate runs ${gateCount}.`,
);
