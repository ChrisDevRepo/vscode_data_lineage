import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';

/**
 * Regression coverage for the zero-output stall: UAT 2026-08-19 recorded a generation that
 * streamed nothing for 16m42s until the user cancelled manually — neither `vscode.lm` nor the
 * host bounds that path. The watchdog must abort a generation that produced no chunk at all,
 * surface it as a provider error (not a cancellation), and never fire once any chunk arrived.
 */

const FIRST_OUTPUT_TIMEOUT_MS = 600_000;

interface StubToken {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** A stream that never yields; its pending `next()` rejects as Canceled when the token fires. */
function stalledPort() {
  const debugLines: string[] = [];
  const sendRequest = vi.fn().mockImplementation(async (
    _messages: unknown,
    _options: unknown,
    token: StubToken,
  ) => ({
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise((_resolve, reject) => {
            token.onCancellationRequested(() => {
              reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
            });
          }),
        };
      },
    },
  }));
  const model = {
    id: 'publisher.stalled', name: 'Stalled', vendor: 'test', family: 'scripted', version: '1',
    sendRequest,
  };
  const port = new VscodeModelPort(model as never, { debugLog: (line) => debugLines.push(line) });
  return { port, debugLines };
}

/** A stream that yields one chunk promptly, then EOF. */
function promptPort() {
  const debugLines: string[] = [];
  let index = 0;
  const sendRequest = vi.fn().mockResolvedValue({
    stream: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index > 0) return { done: true, value: undefined };
            index += 1;
            const { LanguageModelTextPart } = await import('vscode');
            return { done: false, value: new LanguageModelTextPart('prompt answer') };
          },
        };
      },
    },
  });
  const model = {
    id: 'publisher.prompt', name: 'Prompt', vendor: 'test', family: 'scripted', version: '1',
    sendRequest,
  };
  const port = new VscodeModelPort(model as never, { debugLog: (line) => debugLines.push(line) });
  return { port, debugLines };
}

describe('VscodeModelPort first-output timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a zero-output generation at the deadline and surfaces a provider timeout error, not a cancel', async () => {
    vi.useFakeTimers();
    const { port, debugLines } = stalledPort();

    const pending = port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });
    await vi.advanceTimersByTimeAsync(FIRST_OUTPUT_TIMEOUT_MS);
    const result = await pending;

    expect(result.status).toBe('error');
    expect(debugLines.some((line) => line.includes('[AI] generation-timeout'))).toBe(true);
    expect(debugLines.some((line) => line.includes('[AI] provider-error'))).toBe(true);
  });

  it('never fires once a chunk has arrived — a completed generation leaves no timeout trace', async () => {
    const { port, debugLines } = promptPort();

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('act')],
      tools: [],
      phase: 'active',
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('prompt answer');
    expect(debugLines.some((line) => line.includes('generation-timeout'))).toBe(false);
  });
});
