import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { laneArguments } from './run-lane.mjs';
import { classifyUnitTests, corePaths, laneScriptProblems, runtimeContractTests } from './unit-lanes.mjs';

const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;

test('aggregate scripts preserve complete lanes and enabled coverage', () => {
  assert.deepEqual(laneScriptProblems(scripts), []);
  assert.deepEqual(laneScriptProblems({ ...scripts, test: '  node   tests/tools/run-lane.mjs gate  ' }), []);
  for (const [script, command] of [
    ['test', 'node tests/tools/run-lane.mjs support # gate'],
    ['test', 'node tests/tools/run-lane.mjs gate tests/unit/parser'],
    ['test:runtime', 'node tests/tools/run-lane.mjs runtime --passWithNoTests'],
    ['coverage:core', 'node tests/tools/run-lane.mjs core --coverage.enabled=false'],
    ['coverage:core', 'node tests/tools/run-lane.mjs core --coverage tests/unit/parser'],
    ['coverage:core', 'node tests/tools/run-lane.mjs core'],
    ['test', 'node tests/tools/run-lane.mjs gate || true'],
    ['test', 'node tests/tools/run-lane.mjs\n gate'],
  ]) {
    assert.equal(laneScriptProblems({ ...scripts, [script]: command }).length, 1, command);
  }
  assert.equal(laneScriptProblems({ ...scripts, test: undefined }).length, 1);
  assert.equal(laneScriptProblems({ ...scripts, test: 123 }).length, 1);
});

test('separated Vitest option values preserve the lane and their argument order', () => {
  const options = ['--testNamePattern', 'keeps a value', '--reporter', 'dot', '--maxWorkers', '1'];
  assert.deepEqual(laneArguments('core', options), ['run', ...corePaths, ...options]);
});

test('a positional test filter overrides the lane without moving option values', () => {
  const options = ['--testNamePattern', 'Orders', 'tests/unit/ai-core/dispatcher-matrix.test.ts', '--reporter=dot'];
  assert.deepEqual(laneArguments('support', options), ['run', ...options]);
});

test('the partition rejects a repeated declaration before it can execute twice', () => {
  const repeated = runtimeContractTests[0];
  runtimeContractTests.push(repeated);
  try {
    assert.ok(classifyUnitTests().problems.includes(`${repeated} is claimed more than once (runtime, runtime).`));
  } finally {
    runtimeContractTests.pop();
  }
});
