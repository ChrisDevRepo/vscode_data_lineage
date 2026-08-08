#!/usr/bin/env node
// Asserts that `vsce ls` — the actual VSIX file listing — contains the
// files the packaged extension needs and none of the files it must never
// ship (source, tests, tmp/, evidence/debug artifacts, internal tooling,
// secrets, or a stray .vsix).
//
// Usage:
//   node tests/tools/assert-package-contents.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vsceCli = path.join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [vsceCli, 'ls'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  shell: false,
});

if (result.error) {
  console.error(`FATAL: could not run the local @vscode/vsce CLI: ${result.error.message}`);
  process.exit(2);
}

if (result.status !== 0) {
  const output = (result.stderr || result.stdout || '').trim();
  console.error('FAIL: `vsce ls` did not run successfully.');
  console.error(output || '(no output captured)');
  process.exit(result.status ?? 1);
}

const files = result.stdout
  .split(/\r?\n/u)
  .map((file) => file.trim().replaceAll('\\', '/'))
  .filter(Boolean);

if (files.length === 0) {
  console.error('FAIL: `vsce ls` returned zero files — treating as a tooling failure, not an empty package.');
  process.exit(2);
}

const required = [
  'package.json',
  'out/extension.js',
  'out/extensionRuntime.js',
  'dist/index.html',
  'dist/assets/index.js',
  'assets/defaultParseRules.yaml',
  'assets/dmvQueries.yaml',
  'assets/aiOutputTemplates.yaml',
];

const forbidden = [
  { pattern: /^(?:src|test|tests|test-results|tmp|tooling|scripts|ai)\//u, label: 'source/test/tmp/tooling directory' },
  // The headless harness compiles to `out/test/` and the LangSmith containment shell lives in
  // `stubs/`. Neither is referenced by the extension bundle, so neither can be caught by the
  // required-file list — these two patterns are what makes their absence PROVEN rather than assumed.
  { pattern: /^out\/test(?:\/|-)/u, label: 'compiled test/harness output' },
  { pattern: /^stubs\//u, label: 'dependency stub directory' },
  { pattern: /^(?:\.agents|\.codex|\.claude|\.gemini|\.cursor|\.continue)\//u, label: 'internal agent directory' },
  { pattern: /^(?:\.env(?:\..*)?|CLAUDE[^/]*|GEMINI[^/]*)$/iu, label: 'environment/agent-instruction file' },
  { pattern: /(?:^|\/)[^/]*internal[^/]*(?:\/|$)/iu, label: '"internal" marker path' },
  { pattern: /(?:^|\/)debug[^/]*\.txt$/iu, label: 'debug*.txt artifact' },
  { pattern: /(?:^|\/)evidence(?:\/|$)/iu, label: 'evidence/ artifact directory' },
  { pattern: /\.vsix$/iu, label: 'packaged .vsix artifact' },
];

const missing = required.filter((file) => !files.includes(file));
const leaked = files
  .map((file) => {
    const hit = forbidden.find((f) => f.pattern.test(file));
    return hit ? { file, label: hit.label } : null;
  })
  .filter(Boolean);

if (missing.length > 0 || leaked.length > 0) {
  if (missing.length > 0) {
    console.error(`Missing required VSIX files (${missing.length}):`);
    for (const f of missing) console.error(`  ${f}`);
  }
  if (leaked.length > 0) {
    console.error(`Forbidden VSIX files (${leaked.length}):`);
    for (const l of leaked) console.error(`  ${l.file}  [${l.label}]`);
  }
  process.exit(1);
}

console.log(
  `PASS: VSIX content OK (${files.length} files; required files present; ` +
    `no internal, source, test, tmp, tooling, debug-artifact, evidence, .vsix, or environment paths).`,
);
process.exit(0);
