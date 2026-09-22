import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';

/**
 * The degenerate-repeat early stop (TASKLIST §0.-5): a tool-required hop whose model oscillates
 * over one choice emits a small line cycle tens to hundreds of times — measured 146k-150k chars
 * against 4-18k unique, all `finish=length`, zero tool calls. The 3rd identical substantial line
 * now breaks the stream exactly as the phase ceiling does, at 3-17% of the wasted characters
 * (corpus scan 2026-09-16: 341 archived wire bodies, 9 trips all degenerate, zero false cuts).
 */

// One recorded cycle shape (m17-head run-T7 gen 8): substantial routing sentences, one per line.
const CYCLE_LINE = 'But I should verify by routing to spBuildSalesReport. Let me do that.';
const CYCLE = `${CYCLE_LINE}\nLet me reconsider. Maybe the intent is:\n`;

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

function portOver(
  chunks: readonly (string | vscode.LanguageModelToolCallPart)[],
  debugLog?: (message: string) => void,
) {
  const script = trackedStream(chunks);
  const sendRequest = vi.fn().mockResolvedValue({ stream: script.stream });
  const model = {
    id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1',
    sendRequest,
  };
  return { port: new VscodeModelPort(model as never, debugLog ? { debugLog } : {}), script };
}

describe('VscodeModelPort stream repetition stop (TASKLIST §0.-5)', () => {
  it('breaks a degenerate cycle at the 3rd identical line, far below the phase ceiling', async () => {
    // Three cycles carry the 3rd occurrence of CYCLE_LINE; a 4th cycle absorbs the bridge's
    // one-chunk read-ahead, and the POISON cycle after it must never be fetched.
    const chunks = [CYCLE, CYCLE, CYCLE, CYCLE, 'POISON-SHOULD-NOT-STREAM'];
    const lines: string[] = [];
    const { port, script } = portOver(chunks, (line) => lines.push(line));

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });

    // Same retry-capable shape as a ceiling break: completed, tool-free, finishReason `length`,
    // so the retry layer's truncation-before-required-call correction handles it downstream.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'length', toolCalls: [] });
    // Cut within the chunk carrying the 3rd occurrence — three cycles total, an order of
    // magnitude under the 50,000-char active ceiling, and the 4th cycle + poison never bill.
    expect(result.text.length).toBeLessThanOrEqual(CYCLE.length * 3);
    expect(result.text.length).toBeGreaterThan(CYCLE.length);
    expect(result.text.length).toBeLessThan(chunks.reduce((sum, c) => sum + c.length, 0));
    expect(result.text).not.toContain('POISON-SHOULD-NOT-STREAM');
    // The stop is named in the debug log, distinguished from a size-ceiling break.
    const repetition = lines.find((line) => line.startsWith('[AI] stream-repetition'));
    expect(repetition).toContain('phase=active');
    expect(repetition).toContain('repeats=3');
    expect(lines.some((line) => line.startsWith('[AI] stream-ceiling'))).toBe(false);
    // The drain actually stopped: poison never pulled, stream closed once through return().
    expect(script.nextCalls()).toBeGreaterThanOrEqual(3);
    expect(script.nextCalls()).toBeLessThanOrEqual(5);
    expect(script.returnCalls()).toBe(1);
  });

  it('never breaks on one or two repeats of a line', async () => {
    const unique = Array.from({ length: 6 }, (_, i) => `distinct reasoning step ${i} with enough length to count`);
    const chunks = [CYCLE, CYCLE, `${unique.join('\n')}\n`];
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });

    // Two occurrences never strike: natural EOF, byte-identical text, no early close.
    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(chunks.join(''));
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });

  it('freezes the counter once a tool-call delta has streamed', async () => {
    const chunks = [
      CYCLE,
      CYCLE,
      new vscode.LanguageModelToolCallPart('call-1', 'lineage_present_result', {}),
      // A third occurrence arrives after the call delta: the model is answering, never cut.
      CYCLE,
    ];
    const { port, script } = portOver(chunks);

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

  it('does not stop compose: the text channel there is the deliverable', async () => {
    const chunks = [CYCLE, CYCLE, CYCLE, CYCLE, CYCLE];
    const { port, script } = portOver(chunks);

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('compose')],
      tools: [],
      phase: 'compose',
    });

    // Five repeats in compose drain untouched — a cut would be silently delivered (the ceiling
    // map's own compose rationale), and repetition in a deliverable is the outer bound's affair.
    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(chunks.join(''));
    expect(script.nextCalls()).toBe(chunks.length + 1);
    expect(script.returnCalls()).toBe(0);
  });
});
