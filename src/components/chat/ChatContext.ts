import { createContext, useContext } from 'react';
import type { ChatActions } from './useChat';
import type { ChatState } from './chatStore';

/** The chat store reaches the Thread's custom parts (gate card, composer controls) through this context. */
export interface ChatContextValue {
  state: ChatState;
  actions: ChatActions;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

/** Reads the chat store; throws outside a `ChatPane`. */
export function useChatContext(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChatContext must be used within ChatPane');
  return value;
}
