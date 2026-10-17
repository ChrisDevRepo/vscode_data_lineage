// Pure retention selection and a scripted Langfuse client. No network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkIds, parseRetainArgs, planDeletions, retainTraces, selectTraceIds, USAGE } from './langfuse-retain.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const KEYS = { baseUrl: 'https://cloud.langfuse.com', publicKey: 'pk-test', secretKey: 'sk-test-value' };

test('observations that share a traceId use the newest startTime', () => {
  const older = { traceId: 't', startTime: iso(20) };
  const recent = { traceId: 't', startTime: iso(2) };
  const stillOld = { traceId: 't', startTime: iso(8) };
  assert.deepEqual(selectTraceIds([older, recent], { now: NOW, days: 7 }), []);
  assert.deepEqual(selectTraceIds([recent, older], { now: NOW, days: 7 }), []);
  assert.deepEqual(selectTraceIds([older, stillOld], { now: NOW, days: 7 }), ['t']);
  assert.deepEqual(selectTraceIds([stillOld, { traceId: 't', startTime: iso(15) }], { now: NOW, days: 7 }), ['t']);
});

test('a session id or tag containing baseline is kept', () => {
  assert.deepEqual(selectTraceIds([
    { traceId: 'session', startTime: iso(8), sessionId: 'Nightly-Baseline' },
    { traceId: 'tag', startTime: iso(9), tags: ['arm', 'BASELINE'] },
    { traceId: 'nested', startTime: iso(12), traceContext: { tags: ['prebaseline'] } },
    { traceId: 'plain', startTime: iso(8), sessionId: 'candidate', tags: ['base-line'] },
  ], { now: NOW, days: 7, keepSessions: [] }), ['plain']);
});

test('an explicit keep session is kept', () => {
  assert.deepEqual(selectTraceIds([
    { traceId: 'hold', startTime: iso(8), sessionId: 'sess-9' },
    { traceId: 'tag-only', startTime: iso(8), sessionId: 'other', tags: ['sess-9'] },
    { traceId: 'other', startTime: iso(8), sessionId: 'sess-10' },
  ], { now: NOW, days: 7, keepSessions: ['sess-9'] }), ['tag-only', 'other']);
});

test('a trace newer than 7 days is kept', () => {
  assert.deepEqual(selectTraceIds([
    { traceId: 'six', startTime: iso(6) },
    { traceId: 'edge', startTime: iso(7) },
  ], { now: NOW, days: 7 }), []);
});

test('an old unbound trace is selected', () => {
  assert.deepEqual(selectTraceIds([
    { traceId: 'old', startTime: iso(8), sessionId: null, tags: null },
  ], { now: NOW, days: 7, keepSessions: [] }), ['old']);
});

test('chunks of 1000', () => {
  assert.deepEqual(chunkIds([]), []);
  assert.equal(chunkIds(Array.from({ length: 1000 }, (_, index) => String(index))).length, 1);
  const chunks = chunkIds(Array.from({ length: 1001 }, (_, index) => `id-${index}`));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1]);
  assert.equal(chunks[0][0], 'id-0');
  assert.equal(chunks[1][0], 'id-1000');
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  const plan = planDeletions(Array.from({ length: 50_001 }, (_, index) => `t${index}`));
  assert.equal(plan.batches.length, 50);
  assert.ok(plan.batches.every((batch) => batch.length === 1000));
  assert.deepEqual(plan.remaining, ['t50000']);
});

test('CLI flags default to a dry run and repeat keep-session', () => {
  assert.equal(USAGE, 'usage: node tests/tools/langfuse-retain.mjs [--days N] [--keep-session ID]... [--apply]');
  assert.deepEqual(parseRetainArgs([]), { help: false, days: 7, apply: false, keepSessions: [] });
  assert.deepEqual(parseRetainArgs(['--days', '14', '--keep-session', 'a', '--keep-session=b', '--apply']), {
    help: false, days: 14, apply: true, keepSessions: ['a', 'b'],
  });
  assert.equal(parseRetainArgs(['--days=3']).days, 3);
  assert.equal(parseRetainArgs(['--help']).help, true);
  assert.throws(() => parseRetainArgs(['--days', '0']), /positive integer/);
  assert.throws(() => parseRetainArgs(['--nope']), /Unknown argument/);
});

test('dry run lists the 30-day window and does not delete', async () => {
  const { fetchImpl, calls } = watchFetch(async ({ method, url }) => {
    assert.equal(method, 'GET');
    assert.equal(url.searchParams.get('fields'), 'core,trace_context');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('fromStartTime'), iso(30));
    assert.equal(url.searchParams.get('toStartTime'), new Date(NOW).toISOString());
    if (url.searchParams.get('cursor') === null) {
      return jsonResponse({
        data: [
          { traceId: 'old', startTime: iso(10), sessionId: 'run', tags: [] },
          { traceId: 'mixed', startTime: iso(10), sessionId: 'run' },
          { traceId: 'base', startTime: iso(10), traceContext: { sessionId: 'x', tags: ['Baseline'] } },
          { traceId: 'hold', startTime: iso(10), trace_context: { sessionId: 'keep-me' } },
        ],
        meta: { cursor: 'page-2' },
      });
    }
    assert.equal(url.searchParams.get('cursor'), 'page-2');
    return jsonResponse({
      data: [
        { traceId: 'mixed', startTime: iso(1), sessionId: 'run' },
        { traceId: 'fresh', startTime: iso(1), sessionId: null, tags: [] },
      ],
      meta: { cursor: null },
    });
  });
  const clock = virtualClock();
  const result = await retainTraces({
    ...KEYS, ...clock, fetchImpl, now: NOW, days: 7, apply: false, keepSessions: ['keep-me'],
  });
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.deepEqual(clock.waits, [2000]);
  assert.equal(result.dryRun, true);
  assert.equal(result.days, 7);
  assert.equal(result.kept, 4);
  assert.equal(result.delete, 1);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.readWindowDays, 30);
  assert.match(result.note, /older than 30 days/);
  assert.match(result.note, /were not deleted/);
  assert.equal(JSON.stringify(result).includes('sk-test-value'), false);
  assert.equal(JSON.stringify(result).includes('startTime'), false);
  for (const key of ['dryRun', 'days', 'kept', 'delete', 'requests', 'remaining', 'readWindowDays']) {
    assert.ok(Object.hasOwn(result, key));
  }
});

test('apply sends batches of at most 1000 and stops at 50 delete requests', async () => {
  const lengths = [];
  const { fetchImpl } = watchFetch(async ({ method, init }) => {
    if (method === 'GET') {
      return jsonResponse({
        data: Array.from({ length: 50_001 }, (_, index) => ({ traceId: `t${index}`, startTime: iso(9) })),
        meta: { cursor: null },
      });
    }
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body), ['traceIds']);
    assert.ok(body.traceIds.length <= 1000);
    lengths.push(body.traceIds.length);
    return jsonResponse({ traceIds: body.traceIds });
  });
  const result = await retainTraces({
    ...KEYS, ...virtualClock(), fetchImpl, now: NOW, days: 7, apply: true,
  });
  assert.equal(lengths.length, 50);
  assert.ok(lengths.every((length) => length === 1000));
  assert.equal(result.dryRun, false);
  assert.equal(result.delete, 50_000);
  assert.equal(result.kept, 0);
  assert.deepEqual(result.remaining, ['t50000']);
  assert.match(result.note, /50 delete requests/);
  assert.match(result.note, /were not deleted/);
  assert.equal(result.stopped, undefined);
});

test('a 429 waits for Retry-After once and a second 429 stops with remaining ids', async () => {
  const deletes = [];
  const { fetchImpl } = watchFetch(async ({ method, init }) => {
    if (method === 'GET') return jsonResponse({ data: [{ traceId: 'old', startTime: iso(9) }], meta: {} });
    deletes.push(JSON.parse(init.body).traceIds);
    return jsonResponse('limited', deletes.length === 1 ? 429 : 429, { 'retry-after': '5' });
  });
  const clock = virtualClock();
  const result = await retainTraces({ ...KEYS, ...clock, fetchImpl, now: NOW, days: 7, apply: true });
  assert.equal(deletes.length, 2);
  assert.deepEqual(deletes[0], ['old']);
  assert.deepEqual(clock.waits, [2000, 5000]);
  assert.equal(result.delete, 0);
  assert.deepEqual(result.remaining, ['old']);
  assert.match(result.stopped, /one retry/);
  assert.match(result.note, /were not deleted/);
});

test('Retry-After above 60 seconds does not retry', async () => {
  let deletes = 0;
  const { fetchImpl } = watchFetch(async ({ method }) => {
    if (method === 'GET') return jsonResponse({ data: [{ traceId: 'old', startTime: iso(9) }], meta: {} });
    deletes += 1;
    return jsonResponse('limited', 429, { 'retry-after': '61' });
  });
  const clock = virtualClock();
  const result = await retainTraces({ ...KEYS, ...clock, fetchImpl, now: NOW, days: 7, apply: true });
  assert.equal(deletes, 1);
  assert.deepEqual(clock.waits, [2000]);
  assert.equal(result.delete, 0);
  assert.deepEqual(result.remaining, ['old']);
  assert.match(result.stopped, /60 seconds/);
});

test('an age outside the read window lists nothing and does not claim a delete', async () => {
  let called = false;
  const result = await retainTraces({
    ...KEYS,
    fetchImpl: async () => { called = true; throw new Error('network'); },
    now: NOW,
    days: 40,
    apply: true,
  });
  assert.equal(called, false);
  assert.equal(result.requests, 0);
  assert.equal(result.delete, 0);
  assert.deepEqual(result.remaining, []);
  assert.match(result.note, /cannot see traces older than 40 days/);
  assert.match(result.note, /Nothing was deleted/);
});

test('a base URL with credentials is rejected before a request', async () => {
  let called = false;
  await assert.rejects(
    () => retainTraces({
      baseUrl: 'https://user:secret@cloud.langfuse.com',
      publicKey: 'pk-test',
      secretKey: 'sk-test-value',
      fetchImpl: async () => { called = true; throw new Error('network'); },
      now: NOW,
      days: 7,
    }),
    (error) => {
      assert.match(error.message, /without embedded credentials/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    },
  );
  assert.equal(called, false);
});

function virtualClock() {
  let time = 0;
  const waits = [];
  return {
    waits,
    clock: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
  };
}

function watchFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}`;
    assert.ok(key === 'GET /api/public/v2/observations' || key === 'DELETE /api/public/traces', key);
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
    assert.equal(typeof init.headers?.authorization, 'string');
    assert.equal(init.headers.authorization.startsWith('Basic '), true);
    assert.equal(JSON.stringify(init.headers).includes('sk-test-value'), false);
    calls.push({ method, url: parsed, init });
    return handler({ method, url: parsed, init, calls });
  };
  return { fetchImpl, calls };
}
