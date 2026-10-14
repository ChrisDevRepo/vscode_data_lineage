#!/usr/bin/env node

import { listFiles, PackageManager } from '@vscode/vsce';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let files;
try {
  files = (await listFiles({ cwd: repoRoot, packageManager: PackageManager.None }))
    .map(file => file.replaceAll('\\', '/'));
} catch (error) {
  console.error(`FAIL: could not list VSIX files: ${error.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error('FAIL: VSIX file listing returned zero files — treating as a tooling failure, not an empty package.');
  process.exit(2);
}

const required = [
  'package.json',
  'out/extension.js',
  'out/extensionRuntime.js',
  'out/regexSearch.worker.js',
  'dist/index.html',
  'dist/assets/index.js',
  'assets/defaultParseRules.yaml',
  'assets/dmvQueries.yaml',
  'assets/aiOutputTemplates.yaml',
  'THIRD_PARTY_NOTICES.md',
];

const forbidden = [
  { pattern: /(?:^|\/)(?:\.audit|\.reviews|reviews?|audits?)\//iu, label: 'local review/audit directory' },
  { pattern: /(?:^|\/)(?:[^/]*[-_.])?(?:review|audit)[^/]*\.md$/iu, label: 'local review/audit report' },
  { pattern: /^(?:src|test|tests|test-results|tmp|tooling|scripts|ai)\//u, label: 'source/test/tmp/tooling directory' },
  { pattern: /^out\/test(?:\/|-)/u, label: 'compiled test/harness output' },
  { pattern: /^\.vscode-test[^/]*\.mjs$/u, label: 'VS Code test runner configuration' },
  { pattern: /^stubs\//u, label: 'dependency stub directory' },
  { pattern: /^(?:\.agents|\.muse|\.codex|\.claude|\.gemini|\.cursor|\.continue|\.glm-skills)\//u, label: 'internal agent directory' },
  { pattern: /^(?:\.env(?:\..*)?|\.?CLAUDE[^/]*|\.?GEMINI[^/]*|\.?GLM[^/]*|\.?AGENTS[^/]*|\.?CODEX[^/]*|\.cursorrules|\.aider[^/]*)$/iu, label: 'environment/agent-instruction file' },
  { pattern: /(?:^|\/)[^/]*internal[^/]*(?:\/|$)/iu, label: '"internal" marker path' },
  { pattern: /(?:^|\/)debug[^/]*\.txt$/iu, label: 'debug*.txt artifact' },
  { pattern: /^(?:PLAN[^/]*\.md|TASKLIST[^/]*)$/iu, label: 'internal task/plan notes' },
  { pattern: /\.tmp$/iu, label: 'stray .tmp scratch file' },
  { pattern: /(?:^|\/)evidence(?:\/|$)/iu, label: 'evidence/ artifact directory' },
  { pattern: /\.vsix$/iu, label: 'packaged .vsix artifact' },
  { pattern: /(?:^|\/)\.verify[^/]*\//iu, label: 'package-verification scratch tree' },
  { pattern: /\.log$/iu, label: 'log file' },
  { pattern: /^\.g[^/]*\//iu, label: 'local worktree or .github tree' },
  { pattern: /^[^/]+\.dacpac$/iu, label: 'root-level dacpac' },
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
