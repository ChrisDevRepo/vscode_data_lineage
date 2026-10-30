/** Runs one unit-test lane. Extra Vitest arguments and paths override the lane's default files. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCLI } from 'vitest/node';
import {
  classifyUnitTests,
  corePaths,
  runtimeContractTests,
} from './unit-lanes.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const lanes = {
  core: () => corePaths,
  lineage: () => corePaths.filter((entry) => entry !== 'tests/unit/parser'),
  runtime: () => runtimeContractTests,
  support: () => classifyUnitTests().support,
  gate: () => [...corePaths, ...runtimeContractTests],
};

/** Preserves Vitest option/value pairs; only positional filters override the lane selection. */
export function laneArguments(lane, rest = []) {
  if (!Object.hasOwn(lanes, lane))
    throw new Error(`Choose a lane: ${Object.keys(lanes).join(', ')}.`);
  const { filter } = parseCLI(['vitest', 'run', ...rest]);
  const selected = filter.length > 0 ? [] : lanes[lane]();
  if (filter.length === 0 && selected.length === 0)
    throw new Error(`Lane ${lane} selected no tests.`);
  return ['run', ...selected, ...rest];
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const runner = path.join(repoRoot, 'tests', 'tools', 'run-vitest.mjs');
  let args;
  try {
    const [lane, ...rest] = process.argv.slice(2);
    args = laneArguments(lane, rest);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
