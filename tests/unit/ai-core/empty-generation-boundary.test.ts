import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { ModelPortError } from '../../../src/ai/model/modelPort';

describe('empty provider generation boundary', () => {
  it('completes a generation with no parts so the missing-tool-call reject can repair it', async () => {
    const debugLog = vi.fn();
    const port = new VscodeModelPort(emptyModel() as never, { debugLog });

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('trace dbo.Orders')],
      tools: [{ name: 'lineage_present_result', description: 'present', inputSchema: z.object({}) }],
      phase: 'discover',
    });

    // An empty completion is repairable, not terminal: it must reach the graph as a completed turn
    // with zero tool calls so `missing_required_tool_call` fires instead of failing the provider.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ content: [], text: '', toolCalls: [], finishReason: 'stop' });
    // The condition stays triageable from the Output channel at DEBUG — model behaviour, never warn.
    expect(debugLog.mock.calls.map(([line]) => line as string)).toContainEqual(
      expect.stringContaining('[AI] empty-generation phase=discover'),
    );
  });

  it('keeps a cancelled empty generation a cancellation, not a provider error', async () => {
    const controller = new AbortController();
    const model = {
      ...modelIdentity(),
      // Aborting as the stream opens is the user pressing Stop before any part arrives.
      sendRequest: vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ stream: asyncIterable([]) });
      }),
    };

    const result = await new VscodeModelPort(model as never).generateToolTurn({
      messages: [new HumanMessage('trace dbo.Orders')],
      tools: [],
      phase: 'discover',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
  });

  it('generateStructured surfaces a pre-aborted signal as a cancelled ModelPortError before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendRequest = vi.fn();
    const port = new VscodeModelPort({ ...modelIdentity(), sendRequest } as never);

    let err: unknown;
    try {
      await port.generateStructured({
        messages: [new HumanMessage('classify')],
        schema: z.object({ route: z.string() }),
        signal: controller.signal,
      });
    } catch (e) { err = e; }

    // A turn cancelled before the call started must classify as a clean cancel — never a bare
    // retry-helper Error the runtime would log and close as a provider failure.
    expect(err).toBeInstanceOf(ModelPortError);
    expect((err as ModelPortError).code).toBe('cancelled');
    expect(sendRequest, 'no provider dispatch after pre-abort').not.toHaveBeenCalled();
  });

  it('completeText surfaces a pre-aborted signal as a cancelled ModelPortError before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendRequest = vi.fn();
    const port = new VscodeModelPort({ ...modelIdentity(), sendRequest } as never);

    let err: unknown;
    try {
      await port.completeText({ messages: [new HumanMessage('summarize')], signal: controller.signal });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(ModelPortError);
    expect((err as ModelPortError).code).toBe('cancelled');
    expect(sendRequest, 'no provider dispatch after pre-abort').not.toHaveBeenCalled();
  });
});

function emptyModel() {
  return {
    ...modelIdentity(),
    sendRequest: vi.fn().mockResolvedValue({ stream: asyncIterable([]) }),
  };
}

function modelIdentity() {
  return {
    id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1',
  };
}

function asyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}
