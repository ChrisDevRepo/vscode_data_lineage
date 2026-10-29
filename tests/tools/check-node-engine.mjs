#!/usr/bin/env node
/** Fails fast when the running Node does not satisfy package.json engines.node. */
import { readFileSync } from 'node:fs';
import semver from 'semver';

const range = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines?.node ?? '';
if (!semver.validRange(range)) {
  console.error(`check-node-engine: invalid engines.node "${range}".`);
  process.exit(1);
}
if (!semver.satisfies(process.versions.node, range)) {
  console.error(`Node ${process.versions.node} does not satisfy engines.node "${range}" (${process.execPath}). Put a supported Node version first on PATH and rerun.`);
  process.exit(1);
}
