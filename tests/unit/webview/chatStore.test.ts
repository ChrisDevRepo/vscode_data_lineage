/**
 * Covers the chat store reducer: host chat messages in, the transcript the Thread renders out.
 * A defect here shows a wrong, duplicated or never-settling conversation.
 */

import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState, type ChatState, type TurnEvent } from '../../../src/components/chat/chatStore';

const event = (state: ChatState, turnId: string, e: TurnEvent): ChatState =>
  chatReducer(state, { type: 'host-event', turnId, event: e });

const sent = (text: string): ChatState => chatReducer(initialChatState, { type: 'send', text });

describe('chatReducer — turn events to messages', () => {
  it('shows the sent text as a user message and marks the chat busy', () => {
    const state = sent('where does dbo.Orders come from?');
    expect(state.busy).toBe(true);
    expect(state.messages).toEqual([
      { id: 'local-1', role: 'user', parts: [{ type: 'text', text: 'where does dbo.Orders come from?' }] },
    ]);
  });

  it('appends text deltas of one turn to a single text part of one assistant message', () => {
    let state = sent('hi');
    state = event(state, 't1', { type: 'text', delta: 'Hel' });
    state = event(state, 't1', { type: 'text', delta: 'lo' });
    const assistant = state.messages.filter(m => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].id).toBe('t1');
    expect(assistant[0].parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('keeps one status part showing the latest label, and drops it when text starts', () => {
    let state = sent('hi');
    state = event(state, 't1', { type: 'status', phase: 'thinking', label: 'Searching' });
    state = event(state, 't1', { type: 'status', phase: 'scoping', label: 'Scoping' });
    expect(state.messages[1].parts).toEqual([{ type: 'status', phase: 'scoping', label: 'Scoping' }]);
    state = event(state, 't1', { type: 'text', delta: 'Answer' });
    expect(state.messages[1].parts).toEqual([{ type: 'text', text: 'Answer' }]);
  });

  it('turns a gate event into an open gate card part', () => {
    let state = sent('hi');
    state = event(state, 't1', { type: 'gate', gateId: 'g1', gate: 'scope', summary: 'Trace 3 objects', classes: ['table'] });
    expect(state.messages[1].parts).toEqual([
      { type: 'gate', gateId: 'g1', gate: 'scope', summary: 'Trace 3 objects', classes: ['table'], replacesAnalysis: undefined, decision: undefined },
    ]);
  });

  it('records a gate decision on the matching card only', () => {
    let state = sent('hi');
    state = event(state, 't1', { type: 'gate', gateId: 'g1', gate: 'scope', summary: 's' });
    const stale = chatReducer(state, { type: 'gate-decided', turnId: 't1', gateId: 'other', decision: 'approve' });
    expect(stale.messages[1].parts[0]).toMatchObject({ decision: undefined });
    const decided = chatReducer(state, { type: 'gate-decided', turnId: 't1', gateId: 'g1', decision: 'approve' });
    expect(decided.messages[1].parts[0]).toMatchObject({ decision: 'approve' });
  });

  it('keeps the replaces-analysis flag on the gate card and ignores a decision for an unknown turn', () => {
    let state = sent('hi');
    state = chatReducer(state, {
      type: 'host-event', turnId: 't1', replacesAnalysis: true,
      event: { type: 'gate', gateId: 'g1', gate: 'scope', summary: 's' },
    });
    expect(state.messages[1].parts[0]).toMatchObject({ replacesAnalysis: true });
    expect(chatReducer(state, { type: 'gate-decided', turnId: 'nope', gateId: 'g1', decision: 'cancel' })).toBe(state);
  });

  it('adds an error part for an error event', () => {
    let state = sent('hi');
    state = event(state, 't1', { type: 'error', message: 'provider down', recoverable: true });
    expect(state.messages[1].parts).toEqual([{ type: 'error', message: 'provider down' }]);
  });

  it('settles busy on a terminal event, removes the status part, and shows a terminal error once', () => {
    let state = sent('hi');
    state = chatReducer(state, { type: 'host-state', models: [], selectedModelId: '', busy: true, turnId: 't1', followups: [] });
    state = event(state, 't1', { type: 'status', phase: 'tool', label: 'Working' });
    state = event(state, 't1', { type: 'error', message: 'boom' });
    state = event(state, 't1', { type: 'terminal', status: 'error', error: 'boom' });
    expect(state.busy).toBe(false);
    expect(state.turnId).toBeUndefined();
    expect(state.messages[1].parts).toEqual([{ type: 'error', message: 'boom' }]);
  });
});

describe('chatReducer — host state and history', () => {
  it('takes models, selection, effort, busy and turn id from chat.state', () => {
    const models = [{ id: 'm1', name: 'Local', supportsReasoningEffort: ['low', 'high'] }];
    const state = chatReducer(initialChatState, {
      type: 'host-state', models, selectedModelId: 'm1', effort: 'low', busy: true, turnId: 't9', followups: [],
    });
    expect(state).toMatchObject({ models, selectedModelId: 'm1', effort: 'low', busy: true, turnId: 't9' });
  });

  it('carries the host follow-ups, and a later state replaces them', () => {
    const followups = [{ label: 'Show full description', prompt: 'Show the full description' }];
    const state = chatReducer(initialChatState, { type: 'host-state', models: [], selectedModelId: '', busy: false, followups });
    expect(state.followups).toEqual(followups);
    expect(chatReducer(state, { type: 'host-state', models: [], selectedModelId: '', busy: true, followups: [] }).followups).toEqual([]);
  });

  it('replaces the transcript with chat.history (new chat resets to empty)', () => {
    let state = sent('old');
    state = chatReducer(state, {
      type: 'host-history',
      messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
    });
    expect(state.messages.map(m => [m.role, m.parts])).toEqual([
      ['user', [{ type: 'text', text: 'q' }]],
      ['assistant', [{ type: 'text', text: 'a' }]],
    ]);
    expect(chatReducer(state, { type: 'host-history', messages: [] }).messages).toEqual([]);
  });
});
