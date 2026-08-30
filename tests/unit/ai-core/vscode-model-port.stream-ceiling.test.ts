import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';

/**
 * Regression coverage for B3/T15/A4: a provider that streams pseudo-tool-call prose instead of a
 * real tool call must not drain unbounded. UAT turn 24 (deepseek-v4-flash) streamed 3,638,544
 * characters of `<｜DSML｜tool_calls>` markup before anything bounded the drain.
 */

// The exact recorded turn-24 signature: marker at char offset 168, `invoke name=` at offset 202.
const DSML_MARKER = '<｜DSML｜tool_calls>';
const INVOKE_TOKEN = 'invoke name="lineage_present_result">';
const STREAM_TEXT_CHAR_CEILING = 200_000;

/** Builds the recorded turn-24 prefix, self-verifying both signature offsets before use. */
function turn24Prefix(): string {
  const beforeMarker = 'x'.repeat(168);
  const gap = 202 - (beforeMarker.length + DSML_MARKER.length);
  const prefix = beforeMarker + DSML_MARKER + 'y'.repeat(Math.max(gap, 0)) + INVOKE_TOKEN;
  if (prefix.indexOf(DSML_MARKER) !== 168 || prefix.indexOf('invoke name=') !== 202) {
    throw new Error('turn24Prefix() drifted from the recorded turn-24 signature offsets.');
  }
  return prefix;
}

/** A hand-tracked native `vscode.lm` stream: counts `next()`/`return()` calls like the transport does. */
function trackedStream(chunks: readonly string[]): {
  readonly stream: AsyncIterable<unknown>;
  readonly nextCalls: () => number;
  readonly returnCalls: () => number;
} {
  let nextCalls = 0;
  let returnCalls = 0;
  let index = 0;
  const iterator = {
    async next() {
      nextCalls += 1;
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = new vscode.LanguageModelTextPart(chunks[index]);
      index += 1;
      return { done: false, value };
    },
    async return() {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return {
    stream: { [Symbol.asyncIterator]: () => iterator },
    nextCalls: () => nextCalls,
    returnCalls: () => returnCalls,
  };
}

function portOver(chunks: readonly string[]) {
  const script = trackedStream(chunks);
  const sendRequest = vi.fn().mockResolvedValue({ stream: script.stream });
  const model = {
    id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1',
    sendRequest,
  };
  return { port: new VscodeModelPort(model as never), script };
}

describe('VscodeModelPort stream ceiling (B3/T15/A4)', () => {
  it('aborts a stream that crosses the ceiling, keeping the turn-24 signature in a bounded tail', async () => {
    const prefix = turn24Prefix();
    const filler = 'f'.repeat(50_000);
    // prefix + 4 filler chunks crosses STREAM_TEXT_CHAR_CEILING (200,000) on the 4th filler chunk;
    // a 5th benign filler absorbs the bridge's one-chunk read-ahead, so the POISON chunk after it
    // is never fetched if the drain is actually aborted.
    const chunks = [prefix, filler, filler, filler, filler, filler, 'POISON-SHOULD-NOT-STREAM'];
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'discover',
    });

    // Retry-capable outcome: a normal completed, tool-call-free generation — the same shape the
    // existing missing-required-tool retry path already handles downstream, not an error/cancel.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'stop', toolCalls: [] });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThanOrEqual(STREAM_TEXT_CHAR_CEILING);
    // Bounded: the poison chunk's ~4M-char analog (3,638,544 in the recorded incident) never lands.
    expect(result.text).not.toContain('POISON-SHOULD-NOT-STREAM');
    expect(result.text.length).toBeLessThan(chunks.reduce((sum, c) => sum + c.length, 0));

    // The bounded tail still carries the recognizable pseudo-call markup at its recorded offsets.
    expect(result.text.indexOf(DSML_MARKER)).toBe(168);
    expect(result.text.indexOf('invoke name=')).toBe(202);

    // The drain actually stopped early (not merely truncated by luck): the poison chunk was never
    // pulled, and the underlying stream was closed exactly once through the normal return path.
    // Contract: `IterableReadableStream.fromAsyncGenerator`'s WHATWG ReadableStream (default
    // highWaterMark 1) may read one chunk ahead of the consumer, so the ceiling breaks on the 5th
    // `next()` call and the read-ahead — when the runtime schedules it (older Node did, current
    // Node 22.x does not) — consumes the 6th (a benign filler). Either way the poison chunk is
    // never pulled: 5 consumer pulls to reach the ceiling, at most 1 scheduler read-ahead.
    expect(script.nextCalls()).toBeGreaterThanOrEqual(5);
    expect(script.nextCalls()).toBeLessThanOrEqual(6);
    expect(script.returnCalls()).toBe(1);
  });

  it('leaves a stream below the ceiling byte-identical to today', async () => {
    const chunks = ['below the ceiling: ', 'a'.repeat(STREAM_TEXT_CHAR_CEILING - 1000)];
    const expectedText = chunks.join('');
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'discover',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(expectedText);
    // Natural EOF: every chunk fetched, one extra EOF-signalling call, and no early `.return()`.
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });
});
