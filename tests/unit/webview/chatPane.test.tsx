// @vitest-environment jsdom
/**
 * Covers the ChatPane seams: the store-to-library message mapping, and the composer notice shown
 * while the host offers no model.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../../../src/components/chat/ChatContext';
import { ComposerControls, modelsMissing, toContent, toThreadMessage } from '../../../src/components/chat/ChatPane';
import { initialChatState, type ChatMessage, type ChatState } from '../../../src/components/chat/chatStore';
import type { ChatActions } from '../../../src/components/chat/useChat';

const gate = { type: 'gate', gateId: 'g1', gate: 'scope', summary: 'Trace 3', classes: ['table'], decision: undefined } as const;

describe('toContent', () => {
  it('maps text to a text part and a status to a status tool call keyed by the turn', () => {
    expect(toContent([{ type: 'status', phase: 'thinking', label: 'Searching' }, { type: 'text', text: 'hi' }], 't1')).toEqual([
      { type: 'tool-call', toolCallId: 't1:status', toolName: 'lineage_status', args: { label: 'Searching' } },
      { type: 'text', text: 'hi' },
    ]);
  });

  it('maps an open gate to a tool call without a result', () => {
    const [part] = toContent([gate], 't1');
    expect(part).toMatchObject({
      type: 'tool-call', toolCallId: 'g1', toolName: 'lineage_gate',
      args: { turnId: 't1', gateId: 'g1', gate: 'scope', summary: 'Trace 3', classes: ['table'] },
    });
    expect(part).not.toHaveProperty('result');
  });

  it('maps a decided gate to a finished tool call carrying the decision', () => {
    const [part] = toContent([{ ...gate, decision: 'approve' }], 't1');
    expect(part).toMatchObject({ result: 'approve', args: { decision: 'approve' } });
  });
});

describe('toThreadMessage', () => {
  it('turns an error part into the incomplete error status of the message and drops it from the content', () => {
    const message: ChatMessage = { id: 't1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }, { type: 'error', message: 'provider down' }] };
    expect(toThreadMessage(message)).toEqual({
      id: 't1',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      status: { type: 'incomplete', reason: 'error', error: 'provider down' },
    });
  });

  it('leaves a message without an error without a status', () => {
    expect(toThreadMessage({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'q' }] })).toEqual({
      id: 'u', role: 'user', content: [{ type: 'text', text: 'q' }],
    });
  });
});

describe('no configured model', () => {
  const noModels: ChatState = { ...initialChatState, ready: true };
  const actions = {} as ChatActions;
  const markup = (state: ChatState): string => renderToStaticMarkup(
    <ChatContext.Provider value={{ state, actions }}><ComposerControls /></ChatContext.Provider>,
  );

  it('is unknown, not missing, until the host has sent its first state', () => {
    expect(modelsMissing(initialChatState)).toBe(false);
    expect(markup(initialChatState)).toBe('');
  });

  it('is missing once the host reports an empty model list, and the composer says what to do', () => {
    expect(modelsMissing(noModels)).toBe(true);
    expect(markup(noModels)).toContain('No model is configured. Add an entry to the dataLineageViz.ai.models setting and set dataLineageViz.ai.defaultModel.');
  });

  it('is not missing when the host lists a model', () => {
    expect(modelsMissing({ ...noModels, models: [{ id: 'm', name: 'M' }], selectedModelId: 'm' })).toBe(false);
  });
});
