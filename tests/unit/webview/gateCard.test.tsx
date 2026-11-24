// @vitest-environment jsdom
/**
 * Covers the gate card: each decision posts exactly once and gives way to the outcome, and a refine
 * decision carries the trimmed change text.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../../src/components/chat/ChatContext';
import { GateCard, type GateArgs } from '../../../src/components/chat/GateCard';
import { initialChatState } from '../../../src/components/chat/chatStore';
import type { ChatActions } from '../../../src/components/chat/useChat';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api: VsCodeAPI = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
const args: GateArgs = { turnId: 't1', gateId: 'g1', gate: 'scope', summary: 'Trace **3** objects', classes: ['sliding_memory'] };

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount(gateArgs: GateArgs) {
  const decideGate = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const actions = { decideGate } as unknown as ChatActions;
  const element = (a: GateArgs) => (
    <VsCodeProvider api={api}>
      <ChatContext.Provider value={{ state: initialChatState, actions }}><GateCard args={a} /></ChatContext.Provider>
    </VsCodeProvider>
  );
  act(() => root?.render(element(gateArgs)));
  return { decideGate, rerender: (a: GateArgs) => act(() => root?.render(element(a))) };
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...(host?.querySelectorAll('button') ?? [])].find(b => b.textContent === label);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('GateCard', () => {
  it('shows the summary as markdown and the full plan in a collapsed disclosure, never the object classes', () => {
    const { rerender } = mount({ ...args, fullPlan: { markdown: '**Goal:** every object', objects: 6 } });
    expect(host?.querySelector('strong')?.textContent).toBe('3');
    expect(host?.querySelector('[aria-label="Object classes"]')).toBeNull();
    expect(host?.textContent).not.toContain('sliding_memory');
    const details = host?.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Show full plan (6 objects)');
    expect(details?.querySelectorAll('strong')[0]?.textContent).toBe('Goal:');
    rerender(args);
    expect(host?.querySelector('details')).toBeNull();
  });

  it.each([['Approve', 'approve'], ['Cancel', 'cancel']] as const)('%s posts once and hides the buttons', (label, decision) => {
    const { decideGate, rerender } = mount(args);
    act(() => button(label)?.click());
    expect(decideGate).toHaveBeenCalledTimes(1);
    expect(decideGate).toHaveBeenCalledWith('t1', 'g1', decision, undefined);
    rerender({ ...args, decision });
    expect(host?.querySelectorAll('button')).toHaveLength(0);
    expect(host?.querySelector('[role="status"]')).not.toBeNull();
  });

  it('posts a refine decision with the trimmed change text, and not an empty one', () => {
    const { decideGate } = mount(args);
    act(() => button('Refine')?.click());
    expect(button('Send change')?.disabled).toBe(true);
    const field = host?.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, '  only dbo.Orders  ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Send change')?.click());
    expect(decideGate).toHaveBeenCalledTimes(1);
    expect(decideGate).toHaveBeenCalledWith('t1', 'g1', 'refine', 'only dbo.Orders');
  });
});
