#!/usr/bin/env node
/**
 * Proves a change to TypeScript sources touched comments only.
 *
 * Usage: node tests/tools/assert-comment-only.mjs [base-ref] [paths...]
 * Compares every changed .ts/.tsx file between `base-ref` (default HEAD) and the working tree by
 * printing both syntax trees with comments removed (code and types) and by transpiling both with comments
 * removed (emitted JavaScript); any difference fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';

const [base = 'HEAD', ...paths] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

const changed = git('diff', '--name-only', base, '--', ...(paths.length ? paths : ['src']))
  .split('\n')
  .filter(f => /\.tsx?$/.test(f) && existsSync(f));

const printer = ts.createPrinter({ removeComments: true });

/** @param {string} source @param {string} fileName */
function tokens(source, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return printer.printFile(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind));
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
