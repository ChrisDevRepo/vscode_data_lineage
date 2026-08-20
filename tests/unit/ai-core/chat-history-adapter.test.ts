import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import {
  applyNativeChatBoundary,
  chatHistoryToModelMessages,
} from '../../../src/ai/participant/chatHistoryAdapter';

describe('native chat history adapter', () => {
  it('cancels an old native gate and applies the existing reset before a new chat continues', () => {
    const calls: string[] = [];
    const session = {
      id: 'old-session',
      beginNativeChatSession: vi.fn(() => calls.push('begin-native-session')),
    };

    const reset = applyNativeChatBoundary(
      history([]),
      session,
      { gateId: 'gate-1' },
      (gateId) => calls.push(`cancel:${gateId}`),
    );

    expect(reset).toBe(true);
    expect(calls).toEqual(['cancel:gate-1', 'begin-native-session']);
  });

  it('does not reset an established native conversation', () => {
    const session = {
      id: 'current-session',
      beginNativeChatSession: vi.fn(),
    };
    const cancel = vi.fn();

    const reset = applyNativeChatBoundary(
      history([{ prompt: 'follow up' }]),
      session,
      { gateId: 'gate-1' },
      cancel,
    );

    expect(reset).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(session.beginNativeChatSession).not.toHaveBeenCalled();
  });

  it('preserves ordered user and assistant prose without owning memory', () => {
    const messages = chatHistoryToModelMessages(history([
      { prompt: 'Which tables feed Sales?' },
      {
        response: [{ value: { value: 'Sales is fed by Orders.' } }],
        result: { metadata: {} },
      },
    ]));

    expect(messages).toHaveLength(2);
    expect(HumanMessage.isInstance(messages[0])).toBe(true);
    expect(messages[0].content).toBe('Which tables feed Sales?');
    expect(AIMessage.isInstance(messages[1])).toBe(true);
    expect(messages[1].content).toBe('Sales is fed by Orders.');
  });

  it('rebuilds complete assistant-call/tool-result pairs from native result metadata', () => {
    const messages = chatHistoryToModelMessages(history([
      { prompt: 'Inspect Sales.OrderHeader' },
      {
        response: [{ value: { value: 'Rendered answer' } }],
        result: {
          metadata: {
            toolCallsMetadata: {
              toolCallRounds: [{
                response: 'Checking the object.',
                toolCalls: [{
                  callId: 'call-42',
                  name: 'lineage_get_object_detail',
                  input: { id: 'Sales.OrderHeader' },
                }],
              }],
              toolCallResults: {
                'call-42': {
                  content: [{ value: '{"id":"Sales.OrderHeader","type":"table"}' }],
                },
              },
            },
          },
        },
      },
    ]));

    expect(messages).toHaveLength(3);
    const assistant = messages[1];
    expect(AIMessage.isInstance(assistant)).toBe(true);
    expect(assistant.content).toBe('Checking the object.');
    expect((assistant as AIMessage).tool_calls).toEqual([{
      id: 'call-42',
      name: 'lineage_get_object_detail',
      args: { id: 'Sales.OrderHeader' },
      type: 'tool_call',
    }]);
    expect(ToolMessage.isInstance(messages[2])).toBe(true);
    expect(messages[2]).toMatchObject({
      tool_call_id: 'call-42',
      name: 'lineage_get_object_detail',
      content: '{"id":"Sales.OrderHeader","type":"table"}',
    });
  });

  it('never emits an orphan tool call when its matching result is unavailable', () => {
    const messages = chatHistoryToModelMessages(history([
      {
        response: [{ value: { value: 'The visible answer remains available.' } }],
        result: {
          metadata: {
            toolCallsMetadata: {
              toolCallRounds: [{
                toolCalls: [{
                  callId: 'missing-result',
                  name: 'lineage_search_objects',
                  input: { query: 'Sales' },
                }],
              }],
              toolCallResults: {},
            },
          },
        },
      },
    ]));

    expect(messages).toHaveLength(1);
    expect(AIMessage.isInstance(messages[0])).toBe(true);
    expect(messages[0].content).toBe('The visible answer remains available.');
    expect((messages[0] as AIMessage).tool_calls).toEqual([]);
  });

  it('evicts oldest whole turns past the byte budget and marks the eviction with one stub', () => {
    const bigAnswer = 'x'.repeat(30_000);
    const turns = [1, 2, 3, 4].flatMap((index) => [
      { prompt: `question ${index}` },
      { response: [{ value: { value: bigAnswer } }], result: { metadata: {} } },
    ]);

    const messages = chatHistoryToModelMessages(history(turns));

    // 4 turns × ~30 KB answers exceed MAX_DISCOVERY_TRANSCRIPT_BYTES (64 KiB): only the newest two
    // turns fit, and the evicted half is replaced by exactly one stub user message at the head.
    expect(messages[0].content).toContain('evicted');
    const userPrompts = messages
      .filter((message) => HumanMessage.isInstance(message))
      .map((message) => message.content);
    expect(userPrompts).toEqual([messages[0].content, 'question 3', 'question 4']);
  });

  it('evicts past the turn-count ceiling even when every turn is small', () => {
    const turns = Array.from({ length: 25 }, (_unused, index) => [
      { prompt: `q${index}` },
      { response: [{ value: { value: `a${index}` } }], result: { metadata: {} } },
    ]).flat();

    const messages = chatHistoryToModelMessages(history(turns));

    const userPrompts = messages
      .filter((message) => HumanMessage.isInstance(message))
      .map((message) => message.content);
    // MAX_DISCOVERY_TRANSCRIPT_TURNS = 20: the newest 20 turns survive behind the stub.
    expect(userPrompts).toHaveLength(21);
    expect(userPrompts[0]).toContain('evicted');
    expect(userPrompts[1]).toBe('q5');
    expect(userPrompts[20]).toBe('q24');
  });

  it('always keeps the newest turn even when it alone exceeds the byte ceiling', () => {
    const messages = chatHistoryToModelMessages(history([
      { prompt: 'old question' },
      { response: [{ value: { value: 'old answer' } }], result: { metadata: {} } },
      { prompt: 'trace the second one' },
      { response: [{ value: { value: 'y'.repeat(70_000) } }], result: { metadata: {} } },
    ]));

    // The newest turn is above MAX_DISCOVERY_TRANSCRIPT_BYTES on its own. It must survive whole —
    // a follow-up prompt with no antecedent is worse than a bounded one-turn overshoot.
    const userPrompts = messages
      .filter((message) => HumanMessage.isInstance(message))
      .map((message) => message.content);
    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[0]).toContain('evicted');
    expect(userPrompts[1]).toBe('trace the second one');
    expect(messages.at(-1)?.content).toHaveLength(70_000);
  });

  it('charges a turn for its tool-call arguments, not only its prose', () => {
    // A replayed present_result/submit_findings turn carries its whole envelope in
    // `tool_calls[].args` while `content` is one short sentence. Measuring content alone reports
    // such a turn as tiny and lets the assembled request overrun the bound this module enforces.
    const bigArgs = { sections: [{ label: 'Result', text: 'z'.repeat(40_000) }] };
    const argHeavyTurn = (index: number) => [
      { prompt: `question ${index}` },
      {
        response: [{ value: { value: 'Done.' } }],
        result: {
          metadata: {
            toolCallsMetadata: {
              toolCallRounds: [{
                response: 'Done.',
                toolCalls: [{ callId: `call-${index}`, name: 'lineage_present_result', input: bigArgs }],
              }],
              toolCallResults: { [`call-${index}`]: { content: [{ value: 'ok' }] } },
            },
          },
        },
      },
    ];

    const messages = chatHistoryToModelMessages(history([1, 2, 3].flatMap(argHeavyTurn)));

    const userPrompts = messages
      .filter((message) => HumanMessage.isInstance(message))
      .map((message) => message.content);
    expect(userPrompts[0], 'the arg-heavy turns must trigger eviction').toContain('evicted');
    expect(userPrompts).not.toContain('question 1');
    expect(userPrompts.at(-1)).toBe('question 3');
  });

  it('caps one oversized replayed tool result without splitting its call/result pair', () => {
    const messages = chatHistoryToModelMessages(history([
      { prompt: 'Inspect the big object' },
      {
        response: [{ value: { value: 'Rendered answer' } }],
        result: {
          metadata: {
            toolCallsMetadata: {
              toolCallRounds: [{
                response: 'Checking.',
                toolCalls: [{ callId: 'call-1', name: 'lineage_get_object_detail', input: { id: 'dbo.Big' } }],
              }],
              toolCallResults: {
                'call-1': { content: [{ value: 'd'.repeat(60_000) }] },
              },
            },
          },
        },
      },
    ]));

    expect(messages).toHaveLength(3);
    const toolResult = messages[2];
    expect(ToolMessage.isInstance(toolResult)).toBe(true);
    expect(String(toolResult.content).length).toBeLessThanOrEqual(8_192);
    expect(String(toolResult.content)).toContain('truncated to history memory bound');
  });
});

function history(
  turns: readonly unknown[],
): vscode.ChatContext['history'] {
  return turns as vscode.ChatContext['history'];
}
