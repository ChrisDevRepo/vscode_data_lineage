#!/usr/bin/env node
// Gate step: no test surface may be named for AI unless it actually calls a model.
//
// A suite name is quoted as evidence. "the AI tests pass" was true of a run that made zero model
// calls, because `test:ai` was named for the subsystem it covered rather than for what it did.
// This check makes that naming impossible to reintroduce silently: every npm test script and every
// Extension Development Host label is matched against the AI vocabulary, and only the live-provider
// lanes are allowed to use it.
//
// The rule is about NAMES, not about what a suite covers. `tests/unit/ai-core/` keeps its
// directory name — a path names the code under test. A command a person types and quotes is
// different: it must say what it does.
import { readFileSync } from 'node:fs';

/** Words that make a reader expect inference. Matched case-insensitively on whole words. */
const AI_VOCABULARY = /(^|[^a-z])(ai|llm|model|copilot|gpt)([^a-z]|$)/i;

/**
 * Prohibited for every script without exception.
 *
 * @remarks
 * No automated suite runs the product's real path. The Electron lanes use a fixture provider; the
 * live-provider lane calls a model but drives the runtime through the harness's own port and a
 * `vscode` shim, so it never touches `vscode.lm`. Real is a user in real VS Code with their own
 * Copilot model — that is UAT, and UAT is not a script.
 */
const OVERCLAIM_VOCABULARY = /(^|[^a-z])(real|e2e|endtoend)([^a-z]|$)/i;

const problems = [];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of Object.keys(pkg.scripts ?? {})) {
  // `pretest:*` is included deliberately. It is quoted as a command like any other.
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

// `.vscode-test.mjs` is read as text rather than imported: importing it resolves the whole
// @vscode/test-cli chain for a string check.
const laneConfig = readFileSync('.vscode-test.mjs', 'utf8');
for (const [, label] of laneConfig.matchAll(/label:\s*'([^']+)'/g)) {
  if (AI_VOCABULARY.test(label)) {
    problems.push(
      `Extension Development Host label "${label}" is named for AI, but every EDH lane runs `
      + 'against the scripted fixture provider and performs no inference.',
    );
  }
}

// The gate's own step labels: the summary those produce is the single most-quoted artifact here.
const gateSource = readFileSync('tests/tools/gate.mjs', 'utf8');
for (const [, label] of gateSource.matchAll(/npmRun\('([^']+)'/g)) {
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
