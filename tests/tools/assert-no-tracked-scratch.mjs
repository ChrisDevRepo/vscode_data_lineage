#!/usr/bin/env node
/**
 * Fails when git tracks files under local-only scratch directories.
 *
 * `tmp/` holds session handovers, logs and evidence that may name private paths, model pins or
 * conversation state; it is ignored, so a tracked file there was force-added by mistake.
 */
import { execFileSync } from 'node:child_process';

const FORBIDDEN_ROOTS = ['tmp/'];

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z', '--', ...FORBIDDEN_ROOTS], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
} catch (error) {
  console.error(`FAIL  git ls-files failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (tracked.length > 0) {
  for (const path of tracked) console.error(`FAIL  tracked local-only file: ${path}`);
  console.error(`Remove with: git rm --cached -r ${FORBIDDEN_ROOTS.join(' ')}`);
  process.exit(1);
}
console.log(`PASS  no tracked files under ${FORBIDDEN_ROOTS.join(', ')}.`);
