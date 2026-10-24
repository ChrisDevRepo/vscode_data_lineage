#!/usr/bin/env node
// Prints the question field from each turn's metrics-manifest.json. No network.
// Usage: node tests/tools/prompt-from-run.mjs RUN_DIR
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tests/tools/prompt-from-run.mjs RUN_DIR');
  process.exit(2);
}

const turns = readdirSync(dir)
  .filter(name => /^turn-\d+$/.test(name))
  .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
const manifests = turns.length
  ? turns.map(name => join(dir, name, 'metrics-manifest.json'))
  : [join(dir, 'metrics-manifest.json')];

for (const path of manifests) {
  if (!existsSync(path)) continue;
  const { question } = JSON.parse(readFileSync(path, 'utf8'));
  console.log(typeof question === 'string' ? question : JSON.stringify(question ?? null));
}
