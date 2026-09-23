#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MANIFEST = 'tests/tools/golden-sync.json';
const SURFACES = ['assets/aiOutputTemplates.yaml', 'src/ai/agent/stagePrompts.ts', 'src/ai/prompting'];

/** Line endings differ between the index (LF) and a Windows working copy (CRLF); only content matters. */
const normalize = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function surfaceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  for (const surface of SURFACES) {
    if (!existsSync(surface)) {
      console.error(
        `FAIL  prompt surface "${surface}" does not exist — it was renamed or removed without ` +
        `updating SURFACES in tests/tools/assert-golden-sync.mjs. Fix the list, regenerate the ` +
        `goldens, then refresh the manifest with --update.`,
      );
      process.exit(1);
    }
    if (statSync(surface).isDirectory()) walk(surface);
    else files.push(surface);
  }
  return files.map((file) => relative('.', file).split(sep).join('/')).sort();
}

function surfaceHash() {
  const hash = createHash('sha256');
  for (const file of surfaceFiles()) {
    hash.update(`${file}\0${sha256(normalize(readFileSync(file, 'utf8')))}\n`);
  }
  return hash.digest('hex');
}

const update = process.argv.includes('--update');
const files = surfaceFiles();
const current = surfaceHash();

if (update) {
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ algorithm: 'sha256', surfaces: SURFACES, fileCount: files.length, surfaceHash: current }, null, 2)}\n`,
    'utf8',
  );
  console.log(`PASS  ${MANIFEST} refreshed — surfaceHash ${current.slice(0, 12)}… over ${files.length} files.`);
  process.exit(0);
}

let recorded;
if (existsSync(MANIFEST)) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    recorded = manifest.algorithm === 'sha256' ? manifest.surfaceHash : undefined;
  } catch {
    recorded = undefined;
  }
}
if (typeof recorded !== 'string' || recorded.length !== 64) {
  console.error(
    `FAIL  ${MANIFEST} is missing or malformed — the gate cannot verify golden sync. Fail closed: ` +
    `regenerate the prompt goldens, review the golden diff, then run ` +
    `node ${MANIFEST.replace('golden-sync.json', 'assert-golden-sync.mjs')} --update.`,
  );
  process.exit(1);
}

if (recorded !== current) {
  console.error(
    `FAIL  prompt surface changed without golden regeneration — regenerate the prompt goldens, ` +
    `review the golden diff, then refresh the manifest with ` +
    `node tests/tools/assert-golden-sync.mjs --update. ` +
    `(manifest ${recorded.slice(0, 12)}… vs surface ${current.slice(0, 12)}… over ${files.length} files.)`,
  );
  process.exit(1);
}

console.log(`PASS  prompt surface matches the golden-regeneration manifest (${files.length} files, ${current.slice(0, 12)}…).`);
