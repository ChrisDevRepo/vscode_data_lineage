#!/usr/bin/env node
/**
 * Fails when Git tracks local-only scratch directories or generated review reports.
 *
 * `tmp/` holds session handovers, logs and evidence that may name private paths, model pins or
 * conversation state; it is ignored, so a tracked file there was force-added by mistake.
 */
import { runCommand } from './command.mjs';

let tracked;
try {
  tracked = (await runCommand('git', ['ls-files', '-ci', '--exclude-standard', '-z'])).stdout
    .split('\0')
    .filter(Boolean);
} catch (error) {
  console.error(`FAIL  git ls-files failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (tracked.length > 0) {
  for (const path of tracked) console.error(`FAIL  tracked local-only file: ${path}`);
  console.error('Remove these files from the Git index and keep generated artifacts local.');
  process.exit(1);
}
console.log('PASS  no tracked local scratch or generated review/audit reports.');
