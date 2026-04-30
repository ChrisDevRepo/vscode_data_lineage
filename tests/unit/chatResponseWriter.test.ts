/**
 * Unit tests for ChatResponseWriter lifecycle.
 *
 * Covers the bug fix for the `Response stream has been closed` crash:
 * the writer must silently no-op on cancellation and on observed stream-close,
 * but still surface unrelated errors untouched.
 */

import { assert, printSummary, resetCounters } from './helpers/testUtils';
import { ChatResponseWriter } from '../../src/ai/chatResponseWriter';

type LogEntry = { level: 'info' | 'warn' | 'debug' | 'error'; msg: string };

function makeLogger(): { logger: any; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = {
    info: (msg: string) => entries.push({ level: 'info', msg }),
    debug: (msg: string) => entries.push({ level: 'debug', msg }),
    warn: (msg: string) => entries.push({ level: 'warn', msg }),
    error: (op: string, err: unknown) => entries.push({ level: 'error', msg: `${op}: ${err instanceof Error ? err.message : String(err)}` }),
  };
  return { logger, entries };
}

type StubCall = { kind: 'markdown' | 'progress' | 'button'; arg: unknown };

function makeStubStream(throwOn: { markdown?: Error; progress?: Error; button?: Error } = {}): {
  stream: any;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const stream = {
    markdown: (text: string) => { if (throwOn.markdown) throw throwOn.markdown; calls.push({ kind: 'markdown', arg: text }); },
    progress: (text: string) => { if (throwOn.progress) throw throwOn.progress; calls.push({ kind: 'progress', arg: text }); },
    button: (cmd: unknown) => { if (throwOn.button) throw throwOn.button; calls.push({ kind: 'button', arg: cmd }); },
  };
  return { stream, calls };
}

function makeToken(initial = false): { token: any; cancel: () => void } {
  let cancelled = initial;
  const token = { get isCancellationRequested() { return cancelled; } };
  return { token, cancel: () => { cancelled = true; } };
}

async function runTests() {
  console.log('\n══════ chatResponseWriter tests ══════');
  resetCounters();

  // ── 1. Open accepts writes; cancellation converts subsequent writes to no-ops ──
  console.log('\n── open → cancelled transition ──');
  {
    const { logger, entries } = makeLogger();
    const { stream, calls } = makeStubStream();
    const { token, cancel } = makeToken();
    const w = new ChatResponseWriter(stream, token, logger, 'sess_test');

    w.markdown('first');
    assert(calls.length === 1 && calls[0].arg === 'first', 'first markdown lands while open');

    cancel();
    w.markdown('second');
    w.progress('third');
    w.button({ command: 'x', title: 'y' });

    assert(calls.length === 1, 'no further writes after cancellation');
    assert(w.status().kind === 'cancelled', 'status is cancelled');
    const infos = entries.filter(e => e.level === 'info');
    const errs = entries.filter(e => e.level === 'error');
    assert(infos.length === 1, 'exactly one info log on cancellation');
    assert(errs.length === 0, 'zero error logs on cancellation');
    assert(/cancelled by user/.test(infos[0].msg), 'info log mentions cancellation');
  }

  // ── 2. Observed close flips status to `closed` and swallows the error ──
  console.log('\n── open → closed (stream threw) ──');
  {
    const { logger, entries } = makeLogger();
    const { stream, calls } = makeStubStream({ markdown: new Error('Response stream has been closed') });
    const { token } = makeToken();
    const w = new ChatResponseWriter(stream, token, logger, 'sess_test');

    // Must NOT rethrow.
    let threw = false;
    try { w.markdown('will-trigger-close'); } catch { threw = true; }
    assert(!threw, 'stream-closed error is swallowed, not rethrown');
    assert(w.status().kind === 'closed', 'status is closed after observed throw');
    assert(calls.length === 0, 'failed call is not recorded');

    // Further writes no-op, no more logs.
    const entriesBefore = entries.length;
    w.markdown('after-close');
    w.progress('still-after');
    w.button({ command: 'x', title: 'y' });
    assert(entries.length === entriesBefore, 'no new logs after close transition');
    const warns = entries.filter(e => e.level === 'warn');
    assert(warns.length === 1, 'exactly one warn log on observed close');
    assert(/closed unexpectedly/.test(warns[0].msg), 'warn log mentions unexpected close');
  }

  // ── 3. Non-stream-closed errors rethrow; status stays open ──
  console.log('\n── foreign errors bubble up ──');
  {
    const { logger, entries } = makeLogger();
    const { stream } = makeStubStream({ markdown: new Error('boom') });
    const { token } = makeToken();
    const w = new ChatResponseWriter(stream, token, logger, 'sess_test');

    let caught: Error | null = null;
    try { w.markdown('triggers-boom'); } catch (e) { caught = e as Error; }
    assert(caught !== null && /boom/.test(caught!.message), 'foreign error is rethrown');
    assert(w.status().kind === 'open', 'status stays open on foreign error');
    assert(entries.length === 0, 'no log entry added on foreign error (caller surfaces it)');
  }

  printSummary('chatResponseWriter');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
