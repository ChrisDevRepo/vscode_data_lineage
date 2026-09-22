#!/usr/bin/env node
/**
 * Proves a change to TypeScript sources touched comments only.
 *
 * Usage: node tests/tools/assert-comment-only.mjs [base-ref] [paths...]
 * Compares every changed .ts/.tsx file between `base-ref` (default HEAD) and the working tree by
 * scanning both sides with trivia skipped (catches type edits) and by transpiling both with comments
 * removed (catches string and template edits the context-free scanner cannot see); any difference fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';

const [base = 'HEAD', ...paths] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

const changed = git('diff', '--name-only', base, '--', ...(paths.length ? paths : ['src']))
  .split('\n')
  .filter(f => /\.tsx?$/.test(f) && existsSync(f));

/** @param {string} source @param {string} fileName */
function tokens(source, fileName) {
  const variant = fileName.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, source);
  const out = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    out.push(`${kind}:${scanner.getTokenText()}`);
  }
  return out.join('\n');
}

/** @param {string} source @param {string} fileName */
function emit(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  }).outputText;
}

/** @param {string} a @param {string} b @param {string} fileName */
const same = (a, b, fileName) => tokens(a, fileName) === tokens(b, fileName) && emit(a, fileName) === emit(b, fileName);

const failures = [];
for (const file of changed) {
  let before = '';
  try { before = git('show', `${base}:${file}`); } catch { failures.push(`${file} (new file)`); continue; }
  if (!same(before, readFileSync(file, 'utf8'), file)) failures.push(file);
}

if (failures.length > 0) {
  console.error(`[assert-comment-only] code differs in ${failures.length} file(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[assert-comment-only] ${changed.length} file(s) changed; code identical, comments only.`);
