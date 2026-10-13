import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCases, correctness, formatting, parseArgs, readRun, renderTable } from './case-scorecard.mjs';

function writeRun(turns, answers, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ turns, ...extra }));
  answers.forEach((answer, index) => {
    if (answer === undefined) return;
    mkdirSync(join(dir, `turn-${index + 1}`));
    writeFileSync(join(dir, `turn-${index + 1}`, 'answer.md'), answer);
  });
  return dir;
}

test('correctness: outcome, keywords and length each count', () => {
  const expect = { must_contain: ['Price', 'Orders'], preview_chars_min: 10 };
  assert.equal(correctness({ outcomes: ['ok'], answer: 'price from orders table' }, expect), 1);
  assert.equal(correctness({ outcomes: ['ok'], answer: 'price' }, expect), 0.5);
  assert.equal(correctness({ outcomes: ['error'], answer: '' }, expect), 0);
  assert.equal(correctness({ outcomes: [], answer: 'x' }), 0);
});

test('formatting: fences, tables, leaked tool JSON and labels', () => {
  assert.equal(formatting(''), null);
  assert.equal(formatting('**Summary**\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 1);
  assert.equal(formatting('```sql\nSELECT 1'), 0.5);
  assert.equal(formatting('| a | b |\n| 1 |'), 2 / 3);
  assert.equal(formatting('```\n| not | a table\n```'), 1);
  assert.equal(formatting('call {"focus_node_id": "x"}'), 0.5);
  assert.equal(formatting('**Summary**\n\n**Extra**', ['Summary']), 2.5 / 3);
});

test('readRun: first turn of a case is scored, follow-ups add outcomes, unrun cases are marked', () => {
  const dir = writeRun(
    [{ id: 'a', outcome: 'ok', modelCalls: 2 }, { id: 'a', outcome: 'ok', modelCalls: 1 }, { id: 'b', outcome: 'error' }],
    ['first', 'follow-up', undefined],
    { cases: ['a', 'b', 'c'] },
  );
  const { cases } = readRun(dir);
  assert.equal(cases.get('a').answer, 'first');
  assert.deepEqual(cases.get('a').outcomes, ['ok', 'ok']);
  assert.equal(cases.get('a').modelCalls, 3);
  assert.equal(cases.get('b').answer, '');
  assert.deepEqual(cases.get('c').outcomes, ['not_run']);
});

test('compareCases: regressed, improved, same and missing verdicts', () => {
  const run = entries => ({ run: {}, cases: new Map(entries.map(([id, outcome, answer]) => [id, { outcomes: [outcome], answer, answerPath: null, modelCalls: 0 }])) });
  const base = run([['same', 'ok', 'ok'], ['down', 'ok', 'ok'], ['up', 'error', ''], ['gone', 'ok', 'ok']]);
  const cand = run([['same', 'ok', 'ok'], ['down', 'error', ''], ['up', 'ok', 'ok'], ['new', 'ok', 'ok']]);
  const verdicts = Object.fromEntries(compareCases(base, cand).map(row => [row.id, row.verdict]));
  assert.deepEqual(verdicts, { same: 'same', down: 'regressed', up: 'improved', gone: 'missing', new: 'missing' });

  const table = renderTable(compareCases(base, cand));
  assert.match(table, /1 improved, 1 regressed, 1 same, 2 missing/);
});

test('compareCases: a formatting drop beyond the threshold regresses', () => {
  const run = answer => ({ run: {}, cases: new Map([['x', { outcomes: ['ok'], answer, answerPath: null, modelCalls: 0 }]]) });
  assert.equal(compareCases(run('fine'), run('```\nopen'))[0].verdict, 'regressed');
});

test('compareCases: section labels count only when both runs recorded them', () => {
  const run = sections => ({ run: { sections }, cases: new Map([['x', { outcomes: ['ok'], answer: '**Old label**', answerPath: null, modelCalls: 0 }]]) });
  assert.equal(compareCases(run(undefined), run(['Purpose']))[0].cand.f, 1);
  assert.equal(compareCases(run(['Purpose']), run(['Purpose']))[0].cand.f, 0.67);
});

test('parseArgs: two run directories with or without --out', () => {
  assert.deepEqual(parseArgs(['base', 'cand']), { dirs: ['base', 'cand'], out: undefined });
  assert.deepEqual(parseArgs(['base', 'cand', '--out', 'dir']), { dirs: ['base', 'cand'], out: 'dir' });
  assert.deepEqual(parseArgs(['--out', 'dir', 'base', 'cand']), { dirs: ['base', 'cand'], out: 'dir' });
  assert.equal(parseArgs(['base']), null);
  assert.equal(parseArgs(['base', 'cand', '--other']), null);
  assert.equal(parseArgs(['--help']), null);
});
