import assert from 'node:assert/strict';
import test from 'node:test';
import { laneArguments } from './run-lane.mjs';
import { classifyUnitTests, corePaths, runtimeContractTests } from './unit-lanes.mjs';

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
