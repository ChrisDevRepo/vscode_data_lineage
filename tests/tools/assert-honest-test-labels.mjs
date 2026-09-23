#!/usr/bin/env node
import { readFileSync } from 'node:fs';

/** Words that make a reader expect inference. Matched case-insensitively on whole words. */
const AI_VOCABULARY = /(^|[^a-z])(ai|llm|model|copilot|gpt)([^a-z]|$)/i;

/**
 * Prohibited for every script without exception.
 *
 * @remarks
 * No public automated suite runs the product's real path. The Electron lanes use a fixture
 * provider and perform no inference. Real is a user in real VS Code with their own Copilot
 * model — that is UAT, and UAT is not a script.
 */
const OVERCLAIM_VOCABULARY = /(^|[^a-z])(real|e2e|endtoend)([^a-z]|$)/i;

const problems = [];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of Object.keys(pkg.scripts ?? {})) {
  if (!/^(?:pre)?test/u.test(name)) continue;
  if (OVERCLAIM_VOCABULARY.test(name)) {
    problems.push(
      `npm script "${name}" claims to be real or end-to-end. No automated suite runs the product `
      + "path (real VS Code + the user's own Copilot model) — that is UAT. Name it for the path it "
      + 'actually drives, e.g. test:edh.',
    );
  }
  if (AI_VOCABULARY.test(name)) {
    problems.push(
      `npm script "${name}" is named for AI but calls no model. Name it for what it exercises `
      + '(e.g. test:runtime, test:bare-environment). No public script calls a live provider.',
    );
  }
}

const laneConfig = readFileSync('.vscode-test.mjs', 'utf8');
for (const [, label] of laneConfig.matchAll(/label:\s*'([^']+)'/g)) {
  if (AI_VOCABULARY.test(label)) {
    problems.push(
      `Extension Development Host label "${label}" is named for AI, but every EDH lane runs `
      + 'against the scripted fixture provider and performs no inference.',
    );
  }
}

const gateSource = readFileSync('tests/tools/gate.mjs', 'utf8');
for (const [, label] of gateSource.matchAll(/(?:npmRun\(|name: )'([^']+)'/g)) {
  if (AI_VOCABULARY.test(label)) {
    problems.push(`Gate step label "${label}" is named for AI, but no gate step calls a model.`);
  }
}

if (problems.length > 0) {
  console.error('FAIL  test surfaces named for AI that make no model call:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error('See docs/EDH_TESTING.md §What the public suite proves.');
  process.exit(1);
}

console.log('PASS  no test script, EDH label, or gate step claims AI without calling a model.');
