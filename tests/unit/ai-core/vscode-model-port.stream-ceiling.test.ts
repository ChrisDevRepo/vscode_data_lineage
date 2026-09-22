import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';

/**
 * Regression coverage for B3/T15/A4: a provider that streams pseudo-tool-call prose instead of a
 * real tool call must not drain unbounded. UAT turn 24 (deepseek-v4-flash) streamed 3,638,544
 * characters of `<｜DSML｜tool_calls>` markup before anything bounded the drain.
 *
 * The per-phase calibration (issue runaway-text-toolcall) extends the same guard: tool-bearing
 * phases carry a tighter ceiling than the 200,000-char outer bound, derived from the per-phase
 * legitimate text maxima observed on the wire traces. The outer-bound tests below run in a phase
 * mapped to the outer bound (`compose`) so they keep proving the 200,000 behavior byte-identically.
 */

// The exact recorded turn-24 signature: marker at char offset 168, `invoke name=` at offset 202.
const DSML_MARKER = '<｜DSML｜tool_calls>';
const INVOKE_TOKEN = 'invoke name="lineage_present_result">';
const STREAM_TEXT_CHAR_CEILING = 200_000;
// Mirrors PHASE_STREAM_TEXT_CHAR_CEILINGS.active — the phase with the most recorded runaways.
const ACTIVE_PHASE_TEXT_CEILING = 50_000;

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
function trackedStream(chunks: readonly (string | vscode.LanguageModelToolCallPart)[]): {
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
      const value = typeof chunks[index] === 'string'
        ? new vscode.LanguageModelTextPart(chunks[index] as string)
        : chunks[index] as vscode.LanguageModelToolCallPart;
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

function portOver(chunks: readonly (string | vscode.LanguageModelToolCallPart)[]) {
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

    // `compose` maps to the 200,000 outer bound: this test pins the outer bound's behavior, which
    // must stay byte-identical for phases without a smaller cap.
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'compose',
    });

    // Retry-capable outcome: a normal completed, tool-call-free generation — the same shape the
    // existing missing-required-tool retry path already handles downstream, not an error/cancel.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'length', toolCalls: [] });
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

    // `compose` has no smaller cap (outer bound): a 199,019-char stream sits below 200,000 and
    // must reach natural EOF untouched, proving the phase calibration never fires there.
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'compose',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(expectedText);
    // Natural EOF: every chunk fetched, one extra EOF-signalling call, and no early `.return()`.
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });
});

describe('VscodeModelPort per-phase stream ceiling (runaway-text-toolcall)', () => {
  it('aborts a tool-free stream at the phase cap with finishReason length', async () => {
    // Four 20K fillers cross the 50K `active` cap on the 3rd chunk; the POISON chunk after the
    // 4th (read-ahead absorber) must never be fetched if the drain is actually aborted.
    const filler = 'f'.repeat(20_000);
    const chunks = [filler, filler, filler, filler, 'POISON-SHOULD-NOT-STREAM'];
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });

    // Same retry-capable shape as the outer-bound break: a completed, tool-call-free generation
    // carrying finishReason `length`, classified `output_limit` by the retry layer.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'length', toolCalls: [] });
    expect(result.text.length).toBeGreaterThanOrEqual(ACTIVE_PHASE_TEXT_CEILING);
    expect(result.text.length).toBeLessThan(chunks.reduce((sum, c) => sum + c.length, 0));
    expect(result.text).not.toContain('POISON-SHOULD-NOT-STREAM');

    // 3 consumer pulls cross the cap; at most 1 scheduler read-ahead; closed exactly once via
    // the normal `.return()` path — mirroring the outer-bound break contract above.
    expect(script.nextCalls()).toBeGreaterThanOrEqual(3);
    expect(script.nextCalls()).toBeLessThanOrEqual(4);
    expect(script.returnCalls()).toBe(1);
  });

  it('does not fire the phase cap once a tool-call delta has streamed', async () => {
    const filler = 'f'.repeat(30_000);
    const chunks = [
      filler,
      new vscode.LanguageModelToolCallPart('call-1', 'lineage_present_result', {}),
      filler,
      filler,
    ];
    const { port, script } = portOver(chunks);

    // 90K chars of text in an `active` phase (50K cap): the tool-call delta exempts the stream
    // from the phase break, so the whole stream drains to natural EOF and the call is delivered.
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('present')],
      tools: [{
        name: 'lineage_present_result',
        description: 'present',
        inputSchema: z.object({}).strict(),
      }],
      phase: 'active',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, callId: 'call-1' });
    expect(result.text).toBe(chunks.filter((c) => typeof c === 'string').join(''));
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });

  it('reports non-text (reasoning) part size in the usage line without capping or surfacing it', async () => {
    // 90K chars of reasoning in `active` (50K text cap): the text ceilings are calibrated on text
    // alone, so reasoning is reported but never cut, and its content never reaches the text.
    const reasoning = { value: 'r'.repeat(45_000) };
    const parts: unknown[] = [reasoning, { value: ['r'.repeat(20_000), 'r'.repeat(25_000)] }, 'answer', { data: new Uint8Array(4) }];
    const sendRequest = vi.fn().mockResolvedValue({
      stream: (async function* () { yield* parts.map((part) => typeof part === 'string' ? new vscode.LanguageModelTextPart(part) : part); })(),
    });
    const model = { id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1', sendRequest };
    const lines: string[] = [];
    const port = new VscodeModelPort(model as never, { debugLog: (line) => lines.push(line) });

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', text: 'answer', toolCalls: [] });
    const usage = lines.find((line) => line.startsWith('[AI] usage'));
    expect(usage).toContain('observed_text_chars=6');
    expect(usage).toContain('observed_nontext_chars=90000');
    expect(lines.some((line) => line.includes('stream-ceiling'))).toBe(false);
  });

  it('resolves an unrecognized phase label to the outer bound, never to a smaller cap', async () => {
    // 80K chars: above every smaller cap in the map, below the 200K outer bound. An unknown
    // label must behave exactly like a phase mapped to the outer bound.
    const filler = 'f'.repeat(40_000);
    const chunks = [filler, filler];
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'not_an_instruction_phase',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(chunks.join(''));
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });
});
