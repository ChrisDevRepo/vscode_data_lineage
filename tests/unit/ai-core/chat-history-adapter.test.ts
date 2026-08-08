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
});

function history(
  turns: readonly unknown[],
): vscode.ChatContext['history'] {
  return turns as vscode.ChatContext['history'];
}
