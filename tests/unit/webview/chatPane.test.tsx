// @vitest-environment jsdom
/**
 * Covers the ChatPane seams: the store-to-library message mapping, and the composer notice shown
 * while the host offers no model.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../../src/components/chat/ChatContext';
import ChatPane, { ComposerControls, modelsMissing, toContent, toSuggestions, toThreadMessage } from '../../../src/components/chat/ChatPane';
import { initialChatState, type ChatMessage, type ChatState } from '../../../src/components/chat/chatStore';
import type { ChatActions } from '../../../src/components/chat/useChat';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { NO_MODEL_MESSAGE } from '../../../src/engine/shared/chatContract';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gate = { type: 'gate', gateId: 'g1', summary: 'Trace 3', decision: undefined } as const;

describe('toContent', () => {
  it('maps text to a text part and a status to a status tool call keyed by the turn', () => {
    expect(toContent([{ type: 'status', label: 'Searching' }, { type: 'text', text: 'hi' }], 't1')).toEqual([
      { type: 'tool-call', toolCallId: 't1:status', toolName: 'lineage_status', args: { label: 'Searching' } },
      { type: 'text', text: 'hi' },
    ]);
  });

  it('maps an open gate to a tool call without a result', () => {
    const [part] = toContent([gate], 't1');
    expect(part).toMatchObject({
      type: 'tool-call', toolCallId: 'g1', toolName: 'lineage_gate',
      args: { turnId: 't1', gateId: 'g1', summary: 'Trace 3' },
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

  it('is missing once the host reports an empty model list, and the composer offers the Add model button', async () => {
    expect(modelsMissing(noModels)).toBe(true);
    expect(markup(noModels)).toContain(NO_MODEL_MESSAGE);
    const modelCommand = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<ChatContext.Provider value={{ state: noModels, actions: { modelCommand } as unknown as ChatActions }}><ComposerControls /></ChatContext.Provider>));
    await act(async () => { host.querySelector('button')?.click(); });
    act(() => root.unmount());
    expect(modelCommand).toHaveBeenCalledExactlyOnceWith('add');
  });

  it('is not missing when the host lists a model', () => {
    expect(modelsMissing({ ...noModels, models: [{ id: 'm', name: 'M' }], selectedModelId: 'm' })).toBe(false);
  });
});

describe('follow-up suggestions', () => {
  it('maps a host follow-up to a library suggestion titled by its label and sending its prompt', () => {
    expect(toSuggestions([{ label: 'Show full description', prompt: 'Show the full description' }])).toEqual([
      { title: 'Show full description', prompt: 'Show the full description' },
    ]);
  });

  describe('in the mounted pane', () => {
    let root: Root | undefined;
    let host: HTMLElement | undefined;
    afterEach(() => {
      act(() => root?.unmount());
      host?.remove();
    });

    it('shows the host follow-ups as buttons and a click posts the follow-up prompt', async () => {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      const postMessage = vi.fn();
      const api = { postMessage, getState: () => undefined, setState: () => undefined } as unknown as VsCodeAPI;
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      act(() => root?.render(<VsCodeProvider api={api}><ChatPane /></VsCodeProvider>));
      const post = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...(data as object) } })); });
      post({ type: 'chat.history', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] });
      post({
        type: 'chat.state', models: [{ id: 'm', name: 'M' }], selectedModelId: 'm', busy: false,
        followups: [{ label: 'Start deeper hop-by-hop analysis', prompt: 'Run trace' }],
      });
      const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Start deeper hop-by-hop analysis');
      expect(button).toBeDefined();
      await act(async () => { button?.click(); });
      expect(postMessage).toHaveBeenCalledWith({ type: 'chat.send', text: 'Run trace' });
    });

    it('offers Stop only once the host reports the running turn, and Stop posts that turn id', async () => {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      const postMessage = vi.fn();
      const api = { postMessage, getState: () => undefined, setState: () => undefined } as unknown as VsCodeAPI;
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      act(() => root?.render(<VsCodeProvider api={api}><ChatPane /></VsCodeProvider>));
      const post = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...(data as object) } })); });
      const stop = () => host?.querySelector('.aui-composer-cancel');
      post({ type: 'chat.history', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] });
      post({ type: 'chat.state', models: [{ id: 'm', name: 'M' }], selectedModelId: 'm', busy: false, followups: [{ label: 'Go', prompt: 'Go on' }] });
      expect(stop()).toBeNull();
      // A send before the host reports its turn offers no Stop that could only be dropped.
      await act(async () => { [...(host?.querySelectorAll('button') ?? [])].find((el) => el.textContent === 'Go')?.click(); });
      expect(postMessage).toHaveBeenCalledWith({ type: 'chat.send', text: 'Go on' });
      expect(stop()).toBeNull();
      post({ type: 'chat.state', models: [{ id: 'm', name: 'M' }], selectedModelId: 'm', busy: true, turnId: 's:r1', followups: [] });
      await act(async () => { (stop() as HTMLElement | null)?.click(); });
      expect(postMessage).toHaveBeenCalledWith({ type: 'chat.cancel', turnId: 's:r1' });
    });
  });
});
