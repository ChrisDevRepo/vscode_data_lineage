#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyUnitTests, laneScriptProblems, unitTestFiles } from './unit-lanes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const problems = laneScriptProblems(pkg.scripts);

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
