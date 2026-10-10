// Covers selection of the recorded live trace the chat-UI badge lane replays, without launching VS Code.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BADGE_REPLAY_SETUP, findBadgeReplayTrace } from './chat-ui-replay-trace.mjs';

/** Native start holds its gate; a button with no owning turn starts the successful continuation. */
const successfulRows = (origin = '[ai].[spImportOrders]', classification = 'both') => [
  { type: 'trace-open', origin: 'extension-host', verbose: false },
  { type: 'turn-start', requestId: 'proposal', sessionFingerprint: 'public-session', runFingerprint: 'proposal-run' },
  { type: 'wire-response', requestId: 'proposal', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'start', name: 'lineage_start_exploration', input: { origin, classification } }] },
  { type: 'tool', requestId: 'proposal', phase: 'scoping', seq: 1, toolName: 'lineage_start_exploration', status: 'gate' },
  { type: 'gate', requestId: 'proposal', phase: 'confirm_sm_start', gateId: 'plan', seq: 1 },
  { type: 'turn-terminal', requestId: 'proposal', status: 'ok' },
  { type: 'gate-resolution', requestId: 'proposal', gateId: 'plan', gate: 'confirm_sm_start', action: 'hold', outcome: 'accepted' },
  { type: 'gate-resolution', requestId: 'proposal', gateId: 'plan', gate: 'confirm_sm_start', action: 'approve', outcome: 'no_owning_turn' },
  { type: 'turn-start', requestId: 'continuation', sessionFingerprint: 'public-session', runFingerprint: 'continuation-run' },
  { type: 'wire-response', requestId: 'continuation', generation: 1, phase: 'active_worker', toolCalls: [{ callId: 'finding', name: 'lineage_submit_findings', input: {} }] },
  { type: 'tool', requestId: 'continuation', phase: 'tool', seq: 1, toolName: 'lineage_submit_findings', status: 'accepted' },
  { type: 'wire-response', requestId: 'continuation', generation: 2, phase: 'synthesis', toolCalls: [{ callId: 'present', name: 'lineage_present_result', input: {} }] },
  { type: 'tool', requestId: 'continuation', phase: 'synthesizing', seq: 2, toolName: 'lineage_present_result', status: 'accepted' },
  { type: 'turn-terminal', requestId: 'continuation', status: 'ok' },
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

for (const [name, change] of [
  ['rejected start', rows => { rows.find(row => row.toolName === 'lineage_start_exploration').status = 'rejected'; }],
  ['rejected presentation', rows => { rows.find(row => row.toolName === 'lineage_present_result').status = 'rejected'; }],
  ['dispatch error', rows => { rows.find(row => row.toolName === 'lineage_present_result').status = 'dispatch_error'; }],
  ['cancelled continuation', rows => { rows.at(-1).status = 'cancelled'; }],
  ['failed continuation', rows => { rows.at(-1).status = 'error'; }],
  ['unfinished continuation', rows => { rows.pop(); }],
  ['presentation accepted in another request', rows => { rows.find(row => row.toolName === 'lineage_present_result').requestId = 'unrelated'; }],
  ['terminal belongs to another request', rows => { rows.at(-1).requestId = 'unrelated'; }],
  ['another native session', rows => { rows.find(row => row.type === 'turn-start' && row.requestId === 'continuation').sessionFingerprint = 'other-session'; }],
  ['gate without accepted work', rows => { rows.find(row => row.toolName === 'lineage_submit_findings').status = 'rejected'; }],
  ['findings without a matching wire call', rows => { rows.splice(9, 1); }],
  ['held gate without a recorded approval route', rows => { rows.splice(7, 1); }],
  ['approval belongs to another card', rows => { rows[7].gateId = 'unrelated'; }],
  ['failed native approval', rows => { rows[7].outcome = 'failed'; }],
  ['approval precedes its raised gate', rows => { const approval = rows.splice(7, 1)[0]; rows.splice(1, 0, approval); }],
  ['native fresh-turn approval follows the continuation start', rows => { const approval = rows.splice(7, 1)[0]; rows.splice(9, 0, approval); }],
  ['unrelated same-session gate cannot supply approval', rows => {
    rows.splice(7, 1,
      { type: 'turn-start', requestId: 'unrelated', sessionFingerprint: 'public-session' },
      { type: 'gate', requestId: 'unrelated', phase: 'confirm_sm_start', gateId: 'other-card' },
      { type: 'gate-resolution', requestId: 'unrelated', gateId: 'other-card', gate: 'confirm_sm_start', action: 'approve', outcome: 'no_owning_turn' });
  }],
  ['JSON prose does not prove native typed approval', rows => {
    rows.splice(7, 1);
    rows.splice(8, 0, { type: 'wire-response', requestId: 'continuation', phase: 'detect_entry', text: '{"action":"approve"}', toolCalls: [] });
  }],
  ['typed approval with schema-invalid extra fields', rows => {
    rows.splice(7, 1);
    rows.splice(8, 0, { type: 'wire-response', requestId: 'continuation', phase: 'detect_entry', toolCalls: [{ callId: 'invalid-approval', name: 'structured_output', input: { action: 'approve', unknown: true } }] });
  }],
  ['ambiguous typed structured output', rows => {
    rows.splice(7, 1);
    rows.splice(8, 0, { type: 'wire-response', requestId: 'continuation', phase: 'detect_entry', toolCalls: [
      { callId: 'approve', name: 'structured_output', input: { action: 'approve' } },
      { callId: 'cancel', name: 'structured_output', input: { action: 'cancel' } }] });
  }],
  ['same request without its turn-start', rows => {
    for (const row of rows) if (row.requestId === 'continuation') row.requestId = 'proposal';
    rows.splice(8, 1);
    rows.splice(1, 1);
  }],
  ['headless producer', rows => { rows[0].origin = 'headless-harness'; }],
  ['later different exploration in the same session', rows => { rows.splice(9, 0,
    { type: 'wire-response', requestId: 'continuation', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'other', name: 'lineage_start_exploration', input: { origin: '[dbo].[Other]', classification: 'both' } }] },
    { type: 'tool', requestId: 'continuation', phase: 'scoping', seq: 1, toolName: 'lineage_start_exploration', status: 'gate' }); }],
  ['later classification revision', rows => { rows.splice(9, 0,
    { type: 'wire-response', requestId: 'continuation', generation: 1, phase: 'gate_refine', toolCalls: [{ callId: 'revision', name: 'lineage_start_exploration', input: { origin: '[ai].[spImportOrders]', classification: 'business' } }] },
    { type: 'tool', requestId: 'continuation', phase: 'scoping', seq: 1, toolName: 'lineage_start_exploration', status: 'gate' }); }],
  ['ambiguous unpaired presentation outcomes', rows => { rows.splice(-1, 0,
    { type: 'tool', requestId: 'continuation', toolName: 'lineage_present_result', status: 'rejected' }); }],
]) {
  test(`${name} does not establish successful public analysis`, () => withRoot(root => {
    const rows = successfulRows();
    change(rows);
    writeTrace(root, 'invalid.ndjson', rows);
    assert.throws(() => findBadgeReplayTrace(root), error => error.message.startsWith(BADGE_REPLAY_SETUP));
  }));
}

test('typed approval can continue without a button gate-resolution record', () => withRoot(root => {
  const rows = successfulRows().filter(row => row.type !== 'gate-resolution' || row.action !== 'approve');
  rows.splice(8, 0, { type: 'wire-response', requestId: 'continuation', generation: 1, phase: 'detect_entry', toolCalls: [{ callId: 'typed-approval', name: 'structured_output', input: { action: 'approve' } }] });
  const expected = writeTrace(root, 'typed-approval.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));

test('a rejected refinement keeps the original held target eligible', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(7, 0,
    { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session', runFingerprint: 'refinement-run' },
    { type: 'wire-response', requestId: 'refinement', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'stale-revision', name: 'lineage_start_exploration', input: { origin: '[dbo].[Other]', classification: 'business', proposalRevision: 0 } }] },
    { type: 'tool', requestId: 'refinement', phase: 'scoping', toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode: 'stale_proposal_revision' },
    { type: 'turn-terminal', requestId: 'refinement', status: 'ok' });
  const expected = writeTrace(root, 'kept-proposal.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));

test('an admitted depth-only refinement inherits its held origin and classification', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(7, 0,
    { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session', runFingerprint: 'refinement-run' },
    { type: 'wire-response', requestId: 'refinement', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'refine', name: 'lineage_start_exploration', input: { proposalRevision: 1, depth: { upstream: { levels: 2, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } } } }] },
    { type: 'tool', requestId: 'refinement', phase: 'scoping', toolName: 'lineage_start_exploration', status: 'gate' },
    { type: 'gate', requestId: 'refinement', phase: 'confirm_sm_start', gateId: 'revised-card' },
    { type: 'turn-terminal', requestId: 'refinement', status: 'ok' },
    { type: 'gate-resolution', requestId: 'refinement', gateId: 'revised-card', gate: 'confirm_sm_start', action: 'hold', outcome: 'accepted' });
  rows.find(row => row.type === 'gate-resolution' && row.action === 'approve').requestId = 'refinement';
  rows.find(row => row.type === 'gate-resolution' && row.action === 'approve').gateId = 'revised-card';
  const expected = writeTrace(root, 'depth-refinement.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));

test('a partial refinement of an admitted different origin cannot borrow the original target', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(9, 0,
    { type: 'wire-response', requestId: 'continuation', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'other', name: 'lineage_start_exploration', input: { origin: '[dbo].[Other]', classification: 'both', proposalRevision: 1 } }] },
    { type: 'tool', requestId: 'continuation', toolName: 'lineage_start_exploration', status: 'gate' },
    { type: 'gate', requestId: 'continuation', phase: 'confirm_sm_start', gateId: 'other-card' },
    { type: 'wire-response', requestId: 'continuation', generation: 2, phase: 'sm_entry', toolCalls: [{ callId: 'partial', name: 'lineage_start_exploration', input: { proposalRevision: 2 } }] },
    { type: 'tool', requestId: 'continuation', toolName: 'lineage_start_exploration', status: 'gate' });
  writeTrace(root, 'other-refinement.ndjson', rows);
  assert.throws(() => findBadgeReplayTrace(root), error => error.message.startsWith(BADGE_REPLAY_SETUP));
}));

test('an internal refinement error cannot prove the earlier proposal survived', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(7, 0,
    { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session' },
    { type: 'wire-response', requestId: 'refinement', generation: 1, phase: 'sm_entry', toolCalls: [{ callId: 'broken', name: 'lineage_start_exploration', input: { origin: '[dbo].[Other]', classification: 'both', proposalRevision: 1 } }] },
    { type: 'tool', requestId: 'refinement', toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode: 'internal_error' },
    { type: 'turn-terminal', requestId: 'refinement', status: 'error' });
  writeTrace(root, 'uncertain-refinement.ndjson', rows);
  assert.throws(() => findBadgeReplayTrace(root), error => error.message.startsWith(BADGE_REPLAY_SETUP));
}));

test('native approval recorded after the released turn remains eligible', () => withRoot(root => {
  const rows = successfulRows().filter(row => !(row.type === 'turn-terminal' && row.requestId === 'proposal')
    && !(row.type === 'turn-start' && row.requestId === 'continuation')
    && !(row.type === 'gate-resolution' && row.action === 'hold'));
  const approval = rows.splice(rows.findIndex(row => row.type === 'gate-resolution'), 1)[0];
  approval.outcome = 'accepted';
  for (const row of rows) if (row.requestId === 'continuation') row.requestId = 'proposal';
  rows.push(approval);
  const expected = writeTrace(root, 'resumed-native.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));

test('a refused over-budget refinement preserves the earlier held scope', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(7, 0,
    { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session' },
    { type: 'wire-response', requestId: 'refinement', phase: 'sm_entry', toolCalls: [{ callId: 'over-budget', name: 'lineage_start_exploration', input: { origin: '[dbo].[Other]', classification: 'business', proposalRevision: 1 } }] },
    { type: 'tool', requestId: 'refinement', toolName: 'lineage_start_exploration', status: 'refused', rejectionCode: 'over_active_scope_budget' },
    { type: 'turn-terminal', requestId: 'refinement', status: 'ok' });
  const expected = writeTrace(root, 'budget-refinement.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));

for (const [name, input, rejectionCode] of [
  ['missing revision', { origin: '[dbo].[Other]', classification: 'business' }, 'stale_proposal_revision'],
  ['schema-invalid revision', { proposalRevision: 'invalid' }, 'invalid_type'],
]) {
  test(`a rejected refinement with ${name} preserves the earlier held scope`, () => withRoot(root => {
    const rows = successfulRows();
    rows.splice(7, 0,
      { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session' },
      { type: 'wire-response', requestId: 'refinement', phase: 'sm_entry', toolCalls: [{ callId: 'invalid-refinement', name: 'lineage_start_exploration', input }] },
      { type: 'tool', requestId: 'refinement', toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode },
      { type: 'turn-terminal', requestId: 'refinement', status: 'ok' });
    const expected = writeTrace(root, 'rejected-refinement.ndjson', rows);
    assert.equal(findBadgeReplayTrace(root), expected);
  }));
}

test('an unknown refinement outcome does not prove the held scope survived', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(7, 0,
    { type: 'turn-start', requestId: 'refinement', sessionFingerprint: 'public-session' },
    { type: 'wire-response', requestId: 'refinement', phase: 'sm_entry', toolCalls: [{ callId: 'unknown-refinement', name: 'lineage_start_exploration', input: { proposalRevision: 1 } }] },
    { type: 'tool', requestId: 'refinement', toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode: 'unknown_future_code' },
    { type: 'turn-terminal', requestId: 'refinement', status: 'ok' });
  writeTrace(root, 'unknown-refinement.ndjson', rows);
  assert.throws(() => findBadgeReplayTrace(root), error => error.message.startsWith(BADGE_REPLAY_SETUP));
}));

test('a partial proposal outside the recorded refinement phase inherits no scope', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(9, 0,
    { type: 'wire-response', requestId: 'continuation', phase: 'discovery', toolCalls: [{ callId: 'partial', name: 'lineage_start_exploration', input: { proposalRevision: 1 } }] },
    { type: 'tool', requestId: 'continuation', toolName: 'lineage_start_exploration', status: 'gate' });
  writeTrace(root, 'unverified-partial.ndjson', rows);
  assert.throws(() => findBadgeReplayTrace(root), error => error.message.startsWith(BADGE_REPLAY_SETUP));
}));

for (const [name, change] of [
  ['worker calls are not an array', rows => { rows[9].toolCalls = {}; }],
  ['typed calls are an array-like object', rows => {
    rows.splice(7, 1);
    rows.splice(8, 0, { type: 'wire-response', requestId: 'continuation', phase: 'detect_entry', toolCalls: {
      0: { callId: 'invalid-approval', name: 'structured_output', input: { action: 'approve' } }, length: 1 } });
  }],
]) {
  test(`malformed trace where ${name} is skipped in favor of an older valid trace`, () => withRoot(root => {
    const expected = writeTrace(root, 'older-valid.ndjson', successfulRows(), 1_000);
    const rows = successfulRows();
    change(rows);
    writeTrace(root, 'newer-malformed.ndjson', rows, 2_000);
    assert.equal(findBadgeReplayTrace(root), expected);
  }));
}

test('a rejected presentation repaired by a later accepted call remains eligible', () => withRoot(root => {
  const rows = successfulRows();
  rows.splice(11, 0,
    { type: 'wire-response', requestId: 'continuation', generation: 2, phase: 'synthesis', toolCalls: [{ callId: 'rejected-present', name: 'lineage_present_result', input: {} }] },
    { type: 'tool', requestId: 'continuation', phase: 'synthesizing', toolName: 'lineage_present_result', status: 'rejected' });
  const expected = writeTrace(root, 'repaired.ndjson', rows);
  assert.equal(findBadgeReplayTrace(root), expected);
}));
