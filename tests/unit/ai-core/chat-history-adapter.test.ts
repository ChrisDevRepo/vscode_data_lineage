import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { chatHistoryToModelMessages } from '../../../src/ai/participant/chatHistoryAdapter';
import { MAX_DISCOVERY_TRANSCRIPT_TURNS } from '../../../src/ai/session/session';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { GATE_CARD_HEADER, HOLD_GATE_NOTICE } from '../../../src/ai/prompting/scopeSummaryRenderer';

type History = vscode.ChatContext['history'];
const request = (prompt: string) => ({ prompt, command: undefined, references: [], participant: 'dataLineageViz.lineage', toolReferences: [] });
const response = (text: string, metadata: Record<string, unknown> = { status: 'ok' }) => ({
  response: [{ value: { value: text } }],
  result: { metadata },
  participant: 'dataLineageViz.lineage',
});
const budget = createTurnTokenBudget({ modelWindowTokens: 128_000 });
const roles = (messages: readonly unknown[]) => messages.map(message =>
  message instanceof ToolMessage ? 'tool' : message instanceof AIMessage ? 'ai' : message instanceof HumanMessage ? 'human' : 'other');

describe('chatHistoryToModelMessages', () => {
  it('projects prior turns as ordered user and assistant text', () => {
    const history = [request('Where does Revenue come from?'), response('From Orders.'), request('And Orders?'), response('From Staging.')] as unknown as History;
    const messages = chatHistoryToModelMessages(history, budget);
    expect(roles(messages)).toEqual(['human', 'ai', 'human', 'ai']);
    expect(messages.map(message => message.content)).toEqual(['Where does Revenue come from?', 'From Orders.', 'And Orders?', 'From Staging.']);
  });

  it('replays no tool calls or results, even when a turn result carries tool metadata', () => {
    const toolCallsMetadata = {
      toolCallRounds: [{ response: 'Reading the catalog.', toolCalls: [{ callId: 'call-1', name: 'lineage_get_object_detail', input: { id: '[dbo].[Orders]' } }] }],
      toolCallResults: { 'call-1': { content: [{ value: '{"ddl":"CREATE TABLE dbo.Orders (Id int)"}' }] } },
    };
    const history = [request('Describe Orders.'), response('Orders holds one row per order.', { toolCallsMetadata })] as unknown as History;
    const messages = chatHistoryToModelMessages(history, budget);
    expect(roles(messages)).toEqual(['human', 'ai']);
    expect(messages[1]).toBeInstanceOf(AIMessage);
    expect((messages[1] as AIMessage).tool_calls ?? []).toEqual([]);
    expect(messages[1].content).toBe('Orders holds one row per order.');
    expect(JSON.stringify(messages)).not.toContain('CREATE TABLE');
  });

  it('replaces the approval card frame with a neutral lead-in and keeps the plan', () => {
    const history = [request('Trace Revenue.'), response(`${GATE_CARD_HEADER}Origin: Revenue${HOLD_GATE_NOTICE}`)] as unknown as History;
    const [, assistant] = chatHistoryToModelMessages(history, budget);
    expect(assistant.content).toContain('Origin: Revenue');
    expect(assistant.content).toContain('An exploration proposal was shown to the user for review');
    expect(assistant.content).not.toContain(GATE_CARD_HEADER);
    expect(assistant.content).not.toContain(HOLD_GATE_NOTICE.trim());
  });

  it('keeps the newest turns within the turn-count bound and marks the eviction', () => {
    const turns = MAX_DISCOVERY_TRANSCRIPT_TURNS + 3;
    const history = Array.from({ length: turns }, (_, index) => [request(`question ${index}`), response(`answer ${index}`)]).flat() as unknown as History;
    const debug: string[] = [];
    const messages = chatHistoryToModelMessages(history, budget, line => debug.push(line));
    expect(messages[0].content).toMatch(/Earlier turns were evicted/);
    expect(messages).toHaveLength(1 + MAX_DISCOVERY_TRANSCRIPT_TURNS * 2);
    expect(messages[1].content).toBe('question 3');
    expect(messages.at(-1)?.content).toBe(`answer ${turns - 1}`);
    expect(debug).toEqual([expect.stringMatching(/evicted 3 of 23 turn\(s\)/)]);
  });
});
