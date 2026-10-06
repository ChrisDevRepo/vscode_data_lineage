// Covers selection of the recorded live trace the chat-UI badge lane replays, without launching VS Code.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BADGE_REPLAY_SETUP, findBadgeReplayTrace } from './chat-ui-replay-trace.mjs';

/** NDJSON rows of a successful public analysis: approved start, then a synthesis that presents. */
const successfulRows = (origin = '[ai].[spImportOrders]', classification = 'both') => [
  { type: 'wire-response', phase: 'discovery', toolCalls: [{ name: 'lineage_start_exploration', input: { origin, classification } }] },
  { type: 'wire-response', phase: 'synthesis', toolCalls: [{ name: 'lineage_present_result', input: {} }] },
];

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'dlv-replay-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeTrace(root, name, rows, mtimeSeconds) {
  const dir = join(root, 'tmp', 'lm-trace');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, typeof rows === 'string' ? rows : rows.map((row) => JSON.stringify(row)).join('\n'));
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

test('a missing trace directory reports the setup step, not a raw ENOENT', () => withRoot((root) => {
  assert.throws(() => findBadgeReplayTrace(root), (error) => {
    assert.match(error.message, new RegExp(BADGE_REPLAY_SETUP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(error.message, /ENOENT/);
    assert.ok(error.message.includes(join(root, 'tmp', 'lm-trace')));
    return true;
  });
}));

test('traces are read under the given root, independent of the working directory', () => withRoot((root) => {
  const expected = writeTrace(root, 'run.ndjson', successfulRows());
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.equal(findBadgeReplayTrace(root), expected);
  } finally {
    process.chdir(cwd);
  }
}));

test('the newest qualifying trace wins; other origins, classifications and unfinished runs do not', () => withRoot((root) => {
  writeTrace(root, 'older.ndjson', successfulRows(), 1_000);
  const newest = writeTrace(root, 'newer.ndjson', successfulRows('[AI].[SPIMPORTORDERS]'), 2_000);
  writeTrace(root, 'other-origin.ndjson', successfulRows('[dbo].[uspOther]'), 3_000);
  writeTrace(root, 'business-only.ndjson', successfulRows(undefined, 'business'), 3_000);
  writeTrace(root, 'no-synthesis.ndjson', successfulRows().slice(0, 1), 3_000);
  writeTrace(root, 'notes.txt', successfulRows(), 4_000);
  assert.equal(findBadgeReplayTrace(root), newest);
}));

test('a truncated trace is skipped rather than aborting the search', () => withRoot((root) => {
  const good = writeTrace(root, 'good.ndjson', successfulRows(), 1_000);
  writeTrace(root, 'truncated.ndjson', `${JSON.stringify(successfulRows()[0])}\n{"type":"wire-resp`, 2_000);
  assert.equal(findBadgeReplayTrace(root), good);
}));

test('a directory without a qualifying trace reports the setup step', () => withRoot((root) => {
  writeTrace(root, 'other.ndjson', successfulRows('[dbo].[uspOther]'));
  assert.throws(() => findBadgeReplayTrace(root), (error) => error.message.startsWith(BADGE_REPLAY_SETUP));
}));
