#!/usr/bin/env node
/**
 * Launcher for the headless real-model harness (DD-8).
 *
 * Compile first, then run:
 *
 *   npm run compile:harness
 *   npm run test:e2e-real -- --lane openrouter --prompt P1 --runs 1 --trace-verbose
 *
 * Three things happen here and nowhere else:
 *
 * 1. **`.env` is loaded without overwriting anything already set.** A variable exported in the shell
 *    always wins, so a one-off `LINEAGE_OPENROUTER_MODEL=… npm run test:e2e-real` behaves the way
 *    every other tool behaves. Hand-rolled because the harness adds zero npm dependencies; the
 *    parser is deliberately small: `KEY=VALUE`, `#` comments, optional `export`, optional matching
 *    quotes. No values are ever printed.
 * 2. **`require('vscode')` is aliased to the headless shim.** The compiled `src/` still asks for the
 *    extension host module; `Module._load` answers with `out/test/tests/harness/vscodeHostShim.js`
 *    instead of a fake npm package, so nothing under `src/` is modified or aware of the harness.
 * 3. **The compiled CLI is required and its exit code is returned.** No logic lives here — this file
 *    must stay small enough to be obviously correct, because it is the one part the TypeScript gate
 *    does not typecheck.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outHarness = join(repoRoot, 'out', 'test', 'tests', 'harness');

/** Applies `.env` to `process.env`, never overwriting a variable that is already set. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).replace(/^export\s+/, '').trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(join(repoRoot, '.env'));

const cliPath = join(outHarness, 'cli.js');
if (!existsSync(cliPath)) {
  console.error('[e2e] CONFIG the harness is not compiled. Run: npm run compile:harness');
  process.exit(4);
}

const Module = require('node:module');
const shimPath = join(outHarness, 'vscodeHostShim.js');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? require(shimPath) : originalLoad(request, parent, isMain);
};

const { main } = require(cliPath);
process.exitCode = await main(process.argv.slice(2));
