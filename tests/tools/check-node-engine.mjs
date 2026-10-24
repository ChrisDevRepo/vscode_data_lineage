#!/usr/bin/env node
/** Fails fast when the running Node does not satisfy package.json engines.node (a ">=N" floor). */
import { readFileSync } from 'node:fs';

const range = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines?.node ?? '';
const floor = /^>=\s*(\d+)$/.exec(range.trim())?.[1];
const major = Number(process.versions.node.split('.')[0]);
if (!floor) {
  console.error(`check-node-engine: unsupported engines.node "${range}"; expected ">=N".`);
  process.exit(1);
}
if (major < Number(floor)) {
  console.error(`Node ${process.versions.node} does not satisfy engines.node "${range}" (${process.execPath}). Put Node ${floor}+ first on PATH and rerun.`);
  process.exit(1);
}
