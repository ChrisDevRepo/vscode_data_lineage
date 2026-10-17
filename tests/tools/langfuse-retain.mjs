#!/usr/bin/env node
// Asks Langfuse to batch-delete traces older than N days.
// The free plan has no project retention setting. This is not a second retention system.
// It only lists GET /api/public/v2/observations and, with --apply, DELETE /api/public/traces.
// Default is a dry run. Usage: node tests/tools/langfuse-retain.mjs [--days N] [--keep-session ID]... [--apply]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTestEnv } from './load-test-env.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const READ_WINDOW_DAYS = 30;
const DEFAULT_DAYS = 7;
const PAGE_LIMIT = 100;
const DELETE_BATCH = 1000;
const MAX_DELETE_REQUESTS = 50;
const PACE_MS = 2000;
const RETRY_CAP_MS = 60_000;
const OBSERVATIONS_PATH = '/api/public/v2/observations';
const DELETE_PATH = '/api/public/traces';

export const USAGE = 'usage: node tests/tools/langfuse-retain.mjs [--days N] [--keep-session ID]... [--apply]';

/** Trace ids whose newest observation is older than `days` and not kept. */
export function selectTraceIds(observations, options = {}) {
  return classifyTraces(observations, options).deleteIds;
}

/** Splits ids into batches of at most 1000. */
export function chunkIds(ids, size = DELETE_BATCH) {
  if (!Array.isArray(ids)) throw new Error('ids must be an array.');
  if (!Number.isInteger(size) || size < 1) throw new Error('Chunk size must be a positive integer.');
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
  return chunks;
}

/** First 50 batches fit the free-plan daily delete budget. Later ids are remaining. */
export function planDeletions(ids) {
  const batches = chunkIds(ids);
  return {
    batches: batches.slice(0, MAX_DELETE_REQUESTS),
    remaining: batches.slice(MAX_DELETE_REQUESTS).flat(),
  };
}

/** Reads retain CLI flags. Default is a dry run of 7 days. */
export function parseRetainArgs(argv) {
  let days = DEFAULT_DAYS;
  let apply = false;
  const keepSessions = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, days, apply, keepSessions };
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--days' || arg.startsWith('--days=')) {
      const value = arg === '--days' ? argv[index += 1] : arg.slice('--days='.length);
      if (!/^[1-9]\d*$/u.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--days must be a positive integer.');
      }
      days = Number(value);
      continue;
    }
    if (arg === '--keep-session' || arg.startsWith('--keep-session=')) {
      const value = arg === '--keep-session' ? argv[index += 1] : arg.slice('--keep-session='.length);
      if (value === undefined || value.startsWith('--')) throw new Error('--keep-session needs a session id.');
      keepSessions.push(value);
      continue;
    }
    throw new Error(`Unknown argument ${arg}.`);
  }
  return { help: false, days, apply, keepSessions };
}

/**
 * Lists observations in the free-plan read window and, with `apply`, batch-deletes old traces.
 * Dry run does not call DELETE. Inject `fetchImpl`, `clock`, and `wait` in tests; no network otherwise.
 */
export async function retainTraces({
  now = Date.now(),
  days = DEFAULT_DAYS,
  apply = false,
  keepSessions = [],
  baseUrl,
  publicKey,
  secretKey,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  wait = (ms) => new Promise((resolveWait) => { setTimeout(resolveWait, ms); }),
} = {}) {
  const settings = retentionOptions({ now, days, keepSessions });
  if (typeof baseUrl !== 'string' || typeof publicKey !== 'string' || typeof secretKey !== 'string'
    || baseUrl.length === 0 || publicKey.length === 0 || secretKey.length === 0) {
    throw new Error('Set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY.');
  }
  const base = normalizeBase(baseUrl);
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64')}`;
  const scrub = (error) => safeMessage(error, [publicKey, secretKey, authorization]);
  let requests = 0;
  let deleteSends = 0;
  let stopped = '';
  let nextAt = 0;
  const fail = (message) => {
    if (!stopped) stopped = message;
  };
  const finish = ({ kept = 0, deleteCount = 0, remaining = [], extraNote = '' } = {}) => {
    const budgetNote = !stopped && remaining.length > 0
      ? 'The free-plan daily budget is 50 delete requests. Remaining ids were not sent.'
      : '';
    const note = [windowNote(settings.days), extraNote, stopped, budgetNote].filter(Boolean).join(' ');
    const result = {
      dryRun: !apply,
      days: settings.days,
      kept,
      delete: deleteCount,
      requests,
      remaining,
      readWindowDays: READ_WINDOW_DAYS,
      note,
    };
    if (stopped) result.stopped = stopped;
    return result;
  };

  if (settings.days >= READ_WINDOW_DAYS) return finish();

  const pace = async () => {
    const start = clock();
    if (start < nextAt) await wait(nextAt - start);
    nextAt = Math.max(clock(), nextAt) + PACE_MS;
  };
  const attempt = async (method, url, body) => {
    if (stopped) return null;
    if (method === 'DELETE' && deleteSends >= MAX_DELETE_REQUESTS) return null;
    let path;
    try {
      path = new URL(url).pathname;
    } catch (error) {
      fail(scrub(error));
      return null;
    }
    const allowed = (method === 'GET' && path === OBSERVATIONS_PATH) || (method === 'DELETE' && path === DELETE_PATH);
    if (!allowed) {
      fail(`Refusing ${method} ${path}.`);
      return null;
    }
    await pace();
    if (stopped) return null;
    const headers = { authorization };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await fetchImpl(url, { method, headers, body, redirect: 'error' });
      requests += 1;
      if (method === 'DELETE') deleteSends += 1;
      return response;
    } catch (error) {
      fail(scrub(error));
      return null;
    }
  };
  const callApi = async (method, url, body) => {
    let response = await attempt(method, url, body);
    if (!response) return null;
    if (response.status === 429) {
      const delay = retryAfterMs(response.headers?.get?.('retry-after'), clock());
      await drain(response);
      if (delay !== undefined && delay > RETRY_CAP_MS) {
        fail('Retry-After exceeds 60 seconds.');
        return null;
      }
      if (method === 'DELETE' && deleteSends >= MAX_DELETE_REQUESTS) {
        fail('Rate limited and the daily delete budget has no retry left.');
        return null;
      }
      if (delay !== undefined && delay > 0) await wait(delay);
      response = await attempt(method, url, body);
      if (!response) {
        if (!stopped) fail('Rate limited and the retry was not sent.');
        return null;
      }
      if (response.status === 429) {
        await drain(response);
        fail('Rate limited after one retry.');
        return null;
      }
    }
    if (!response.ok) {
      await drain(response);
      fail(`${method} failed: HTTP ${response.status}.`);
      return null;
    }
    return response;
  };

  // List the whole 30-day read so the newest startTime can keep a trace that continued
  // after the age cutoff. max(now-30d, now-days) is that later cutoff, not the GET start.
  const query = {
    fromStartTime: new Date(settings.now - READ_WINDOW_DAYS * DAY_MS).toISOString(),
    toStartTime: new Date(settings.now).toISOString(),
  };
  const observations = [];
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        fail('Observations cursor repeated.');
        break;
      }
      seenCursors.add(cursor);
    }
    const response = await callApi('GET', observationsUrl(base, { ...query, cursor }));
    if (!response) break;
    let body;
    try {
      body = JSON.parse(await response.text());
    } catch {
      fail('Observations response was not JSON.');
      break;
    }
    let page;
    try {
      page = pageOf(body);
    } catch (error) {
      fail(scrub(error));
      break;
    }
    observations.push(...page.data);
    if (!page.cursor || page.data.length === 0) {
      cursor = null;
      break;
    }
    cursor = page.cursor;
  }
  if (stopped) return finish();

  const { deleteIds, kept } = classifyTraces(observations, { now: settings.now, days: settings.days, keepSessions });
  const planned = planDeletions(deleteIds);
  if (!apply) {
    const deleteCount = planned.batches.reduce((sum, batch) => sum + batch.length, 0);
    return finish({ kept, deleteCount, remaining: planned.remaining });
  }

  let deleted = 0;
  const remaining = [];
  for (let index = 0; index < planned.batches.length; index += 1) {
    const batch = planned.batches[index];
    if (stopped || deleteSends >= MAX_DELETE_REQUESTS) {
      remaining.push(...planned.batches.slice(index).flat(), ...planned.remaining);
      break;
    }
    if (batch.length < 1 || batch.length > DELETE_BATCH) {
      fail('Refusing a delete batch that is not 1 to 1000 trace ids.');
      remaining.push(...planned.batches.slice(index).flat(), ...planned.remaining);
      break;
    }
    const response = await callApi('DELETE', `${base}${DELETE_PATH}`, JSON.stringify({ traceIds: batch }));
    if (!response) {
      remaining.push(...planned.batches.slice(index).flat(), ...planned.remaining);
      break;
    }
    await drain(response);
    deleted += batch.length;
  }
  if (remaining.length === 0) remaining.push(...planned.remaining);
  return finish({ kept, deleteCount: deleted, remaining });
}

function retentionOptions({ now, days, keepSessions }) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer.');
  const keep = new Set();
  for (const id of keepSessions ?? []) {
    if (typeof id === 'string' && id.length > 0) keep.add(id);
  }
  return { now: toMs(now), days, keepSessions: keep };
}

function classifyTraces(observations, options) {
  if (!Array.isArray(observations)) throw new Error('observations must be an array.');
  const { now, days, keepSessions } = retentionOptions({ ...options, keepSessions: options.keepSessions ?? [] });
  const cutoff = now - days * DAY_MS;
  const groups = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const traceId = traceIdOf(observation);
    if (!traceId) continue;
    let group = groups.get(traceId);
    if (!group) {
      group = { newest: null, sessions: new Set(), tags: [] };
      groups.set(traceId, group);
    }
    const start = startMs(observation.startTime);
    if (start !== null && (group.newest === null || start > group.newest)) group.newest = start;
    collectIdentifiers(observation, group.sessions, group.tags);
  }
  const deleteIds = [];
  let kept = 0;
  for (const [traceId, group] of groups) {
    if (group.newest === null) continue;
    const protect = [...group.sessions].some((sessionId) => keepSessions.has(sessionId) || containsBaseline(sessionId))
      || group.tags.some(containsBaseline);
    if (group.newest >= cutoff || protect) kept += 1;
    else deleteIds.push(traceId);
  }
  return { deleteIds, kept };
}

function traceIdOf(observation) {
  if (typeof observation.traceId === 'string' && observation.traceId.length > 0) return observation.traceId;
  for (const node of [observation.traceContext, observation.trace_context]) {
    if (typeof node?.traceId === 'string' && node.traceId.length > 0) return node.traceId;
  }
  return null;
}

function collectIdentifiers(observation, sessions, tags) {
  for (const node of [observation, observation.traceContext, observation.trace_context, observation.trace]) {
    if (!node || typeof node !== 'object') continue;
    for (const key of ['sessionId', 'session_id']) {
      const value = node[key];
      if (typeof value === 'string' && value.length > 0) sessions.add(value);
    }
    if (typeof node.tags === 'string') tags.push(node.tags);
    else if (Array.isArray(node.tags)) {
      for (const tag of node.tags) if (typeof tag === 'string') tags.push(tag);
    }
  }
}

function containsBaseline(value) {
  return typeof value === 'string' && value.toLowerCase().includes('baseline');
}

function startMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  } else if (typeof value === 'number' && Number.isFinite(value)) return value;
  else if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error('now must be a date.');
}

function windowNote(days) {
  if (days >= READ_WINDOW_DAYS) {
    return `The free-plan read window is ${READ_WINDOW_DAYS} days and cannot see traces older than ${days} days. Nothing was deleted.`;
  }
  return `Observations older than ${READ_WINDOW_DAYS} days are outside the free-plan read window and were not deleted.`;
}

function observationsUrl(base, { fromStartTime, toStartTime, cursor }) {
  const url = new URL(OBSERVATIONS_PATH, `${base}/`);
  url.searchParams.set('fromStartTime', fromStartTime);
  url.searchParams.set('toStartTime', toStartTime);
  url.searchParams.set('fields', 'core,trace_context');
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.href;
}

function pageOf(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
    throw new Error('Observations response did not include a data array.');
  }
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const cursor = meta.cursor ?? meta.nextCursor ?? body.cursor ?? null;
  return { data: body.data, cursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : null };
}

function retryAfterMs(header, now) {
  if (header == null) return undefined;
  const text = String(header).trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function drain(response) {
  try {
    await response.text();
  } catch {
    // The body is not a result. Drop it.
  }
}

function safeMessage(error, secrets) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/Basic\s+[A-Za-z0-9+/=]+/gu, 'Basic [redacted]');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/\s+/gu, ' ').slice(0, 300);
}

function normalizeBase(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('LANGFUSE_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('LANGFUSE_BASE_URL must use HTTP(S) without embedded credentials.');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('LANGFUSE_BASE_URL must not include a path.');
  return url.origin;
}

async function main() {
  let parsed;
  try {
    parsed = parseRetainArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  let publicKey = '';
  let secretKey = '';
  try {
    loadTestEnv();
    publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? '';
    secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() ?? '';
    const baseUrl = process.env.LANGFUSE_BASE_URL?.trim() ?? '';
    if (!baseUrl || !publicKey || !secretKey) {
      console.error('Set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY.');
      process.exit(2);
    }
    const result = await retainTraces({
      days: parsed.days,
      apply: parsed.apply,
      keepSessions: parsed.keepSessions,
      baseUrl,
      publicKey,
      secretKey,
    });
    console.log(JSON.stringify(result));
    if (result.stopped) process.exit(1);
  } catch (error) {
    console.error(safeMessage(error, [publicKey, secretKey]));
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
