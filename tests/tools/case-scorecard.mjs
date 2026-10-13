#!/usr/bin/env node
// Per-case answer scorecard for two headless runs of the same catalog rows.
// Usage: node tests/tools/case-scorecard.mjs BASE_RUN_DIR CAND_RUN_DIR [--out DIR]
// A run dir is test-results/headless/ai-<uuid>. Scores are signals that rank which answers to read
// first; the decision is made by reading the side-by-side files against the SQL and the graph.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { loadCases } = require('../cases/loadCases.cjs');

/** A formatting drop larger than this, or any correctness drop, marks a case regressed. */
export const FORMAT_DROP = 0.2;

const mean = values => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const round = value => (value === null ? null : Math.round(value * 100) / 100);

/**
 * Correctness signals of one case: every turn ended `ok`, and the first answer meets the row's
 * `must_contain` and `preview_chars_min`. Follow-up answers are not held to the first turn's keywords.
 *
 * @param {{ outcomes: string[], answer: string }} result - The case's turn outcomes and first answer.
 * @param {{ must_contain?: string[], preview_chars_min?: number }} expect - The catalog row's `expect`.
 * @returns {number} Mean of the applicable checks, 0..1.
 */
export function correctness(result, expect = {}) {
  const checks = [result.outcomes.length > 0 && result.outcomes.every(outcome => outcome === 'ok') ? 1 : 0];
  const lower = result.answer.toLowerCase();
  if (expect.must_contain?.length) {
    checks.push(expect.must_contain.filter(word => lower.includes(word.toLowerCase())).length / expect.must_contain.length);
  }
  if (expect.preview_chars_min !== undefined) checks.push(result.answer.length >= expect.preview_chars_min ? 1 : 0);
  return mean(checks);
}

/**
 * Formatting signals of one answer: balanced code fences, well-formed markdown tables, no leaked
 * tool-call JSON, and — when the run recorded its section labels — bold labels drawn from that set.
 *
 * @param {string} answer - The rendered answer markdown.
 * @param {string[]} [sections] - Allowed section labels; omitted when the run did not record them.
 * @returns {number | null} Mean of the applicable checks, 0..1; null for an empty answer.
 */
export function formatting(answer, sections) {
  if (answer.trim() === '') return null;
  const lines = answer.split('\n');
  const fences = lines.filter(line => line.trimStart().startsWith('```')).length;
  const checks = [fences % 2 === 0 ? 1 : 0];

  const prose = lines.filter((_line, index) => lines.slice(0, index).filter(l => l.trimStart().startsWith('```')).length % 2 === 0);
  const tables = [];
  let block = [];
  for (const line of [...prose, '']) {
    if (line.trim().startsWith('|')) block.push(line);
    else if (block.length) { tables.push(block); block = []; }
  }
  if (tables.length) {
    const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').length;
    const wellFormed = tables.filter(rows => rows.length >= 2 && /^\s*\|?\s*:?-{3,}/.test(rows[1]) && rows.every(row => cells(row) === cells(rows[0])));
    checks.push(wellFormed.length / tables.length);
  }
  checks.push(/"focus_node_id"|"tool_calls"|<\/?function|lineage_[a-z_]+\s*\(\s*\{/.test(answer) ? 0 : 1);

  if (sections?.length) {
    const allowed = new Set(sections.map(label => label.toLowerCase()));
    const labels = prose.map(line => /^\s*\*\*([^*]+)\*\*\s*$/.exec(line)?.[1]?.trim().toLowerCase()).filter(Boolean);
    if (labels.length) checks.push(labels.filter(label => allowed.has(label)).length / labels.length);
  }
  return mean(checks);
}

/**
 * Groups a run dir's turns by catalog case. `run.json.turns` lists turns in order, so turn N is
 * `turn-N`; the first turn of a case is its scored answer.
 *
 * @param {string} runDir
 * @returns {{ run: object, cases: Map<string, { outcomes: string[], answer: string, answerPath: string | null, modelCalls: number }> }}
 */
export function readRun(runDir) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const cases = new Map();
  (run.turns ?? []).forEach((turn, index) => {
    const id = turn.id ?? `turn-${index + 1}`;
    const answerPath = join(runDir, `turn-${index + 1}`, 'answer.md');
    const entry = cases.get(id) ?? { outcomes: [], answer: '', answerPath: null, modelCalls: 0 };
    if (entry.answerPath === null) {
      entry.answerPath = existsSync(answerPath) ? answerPath : '';
      entry.answer = entry.answerPath ? readFileSync(answerPath, 'utf8') : '';
    }
    entry.outcomes.push(turn.outcome);
    entry.modelCalls += turn.modelCalls ?? 0;
    cases.set(id, entry);
  });
  for (const id of run.cases ?? []) if (!cases.has(id)) cases.set(id, { outcomes: ['not_run'], answer: '', answerPath: null, modelCalls: 0 });
  return { run, cases };
}

/**
 * Scores both runs per case and gives each a verdict: `regressed` when correctness drops or
 * formatting drops by more than {@link FORMAT_DROP}, `improved` for the reverse, `missing` when
 * the case is in only one run, `same` otherwise. Section labels count only when both runs recorded them.
 *
 * @param {ReturnType<typeof readRun>} base
 * @param {ReturnType<typeof readRun>} cand
 * @param {Record<string, { must_contain?: string[], preview_chars_min?: number }>} expectations - `expect` by case id.
 */
export function compareCases(base, cand, expectations = {}) {
  const ids = [...new Set([...base.cases.keys(), ...cand.cases.keys()])];
  // Label conformance is scored only when both runs recorded their labels, so neither side is held to a check the other skips.
  const labelled = Boolean(base.run.sections?.length && cand.run.sections?.length);
  return ids.map(id => {
    const score = (side) => {
      const result = side.cases.get(id);
      if (!result) return undefined;
      return {
        c: round(correctness(result, expectations[id])),
        f: round(formatting(result.answer, labelled ? side.run.sections : undefined)),
        chars: result.answer.length,
        modelCalls: result.modelCalls,
        answerPath: result.answerPath,
      };
    };
    const b = score(base);
    const c = score(cand);
    let verdict = 'same';
    if (!b || !c) verdict = 'missing';
    else {
      const dc = c.c - b.c;
      const df = (c.f ?? 0) - (b.f ?? 0);
      if (dc < 0 || df < -FORMAT_DROP) verdict = 'regressed';
      else if (dc > 0 || df > FORMAT_DROP) verdict = 'improved';
    }
    return { id, base: b, cand: c, verdict };
  });
}

/** Renders the comparison as one markdown table and a one-line summary. */
export function renderTable(rows) {
  const cf = side => (side ? `${side.c ?? '–'}/${side.f ?? '–'}` : 'missing');
  const out = ['| case | base C/F | cand C/F | chars base→cand | model calls base→cand | verdict |', '|---|---|---|---|---|---|'];
  for (const row of rows) {
    out.push(`| ${row.id} | ${cf(row.base)} | ${cf(row.cand)} | ${row.base?.chars ?? '–'}→${row.cand?.chars ?? '–'} | ${row.base?.modelCalls ?? '–'}→${row.cand?.modelCalls ?? '–'} | ${row.verdict} |`);
  }
  const count = verdict => rows.filter(row => row.verdict === verdict).length;
  out.push('', `${count('improved')} improved, ${count('regressed')} regressed, ${count('same')} same, ${count('missing')} missing. C = correctness signals, F = formatting signals (0..1). Read the side-by-side files before accepting any verdict.`);
  return out.join('\n');
}

/**
 * Reads the command line: two run directories and an optional `--out DIR`.
 * @returns `{ dirs, out }`, or `null` for `--help`, an unknown flag or a run-directory count other than two.
 */
export function parseArgs(args) {
  const outIndex = args.indexOf('--out');
  const dirs = args.filter((arg, index) => !arg.startsWith('-') && (outIndex === -1 || index !== outIndex + 1));
  if (args.includes('--help') || dirs.length !== 2 || args.some(arg => arg.startsWith('-') && arg !== '--out')) return null;
  return { dirs, out: outIndex === -1 ? undefined : args[outIndex + 1] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const usage = 'usage: node tests/tools/case-scorecard.mjs BASE_RUN_DIR CAND_RUN_DIR [--out DIR]';
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(usage);
    process.exit(args.includes('--help') ? 0 : 2);
  }
  const { dirs } = parsed;
  const [base, cand] = dirs.map(dir => readRun(resolve(dir)));
  const expectations = Object.fromEntries(loadCases('headless').map(row => [row.id, row.expect ?? {}]));
  const rows = compareCases(base, cand, expectations);
  const outDir = resolve(parsed.out ?? join('test-results', 'scorecard', `${basename(dirs[0])}_vs_${basename(dirs[1])}`));
  for (const row of rows) {
    const dir = join(outDir, row.id);
    mkdirSync(dir, { recursive: true });
    if (row.base?.answerPath) writeFileSync(join(dir, 'base.md'), readFileSync(row.base.answerPath, 'utf8'));
    if (row.cand?.answerPath) writeFileSync(join(dir, 'cand.md'), readFileSync(row.cand.answerPath, 'utf8'));
  }
  writeFileSync(join(outDir, 'scorecard.json'), JSON.stringify(rows, null, 1) + '\n');
  console.log(renderTable(rows));
  console.log(`\nSide by side: ${outDir}/<case>/{base,cand}.md`);
}
