import { useCallback, useEffect, useReducer } from 'react';
import { useVsCode } from '../../contexts/VsCodeContext';
import { ExtensionToWebviewMsgSchema, validateBridgeFrame } from '../../engine/shared/bridgeContract';
import { chatReducer, initialChatState, type ChatState, type GateDecision } from './chatStore';

/** What a chat view does with the transcript: every action posts to the host and updates local state. */
export interface ChatActions {
  send: (text: string) => void;
  cancel: () => void;
  decideGate: (turnId: string, gateId: string, decision: GateDecision, text?: string) => void;
  newChat: () => void;
  modelCommand: (command: 'add' | 'manage') => void;
  selectModel: (modelId: string) => void;
  selectEffort: (effort: string) => void;
}

/**
 * The chat view's store: host chat frames fold into the transcript, user actions post to the host.
 * `chat.ready` goes out once the listener is attached, so the host's first state and history frames
 * cannot be missed.
 */
export function useChat(): { state: ChatState; actions: ChatActions } {
  const vscodeApi = useVsCode();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      const type = (e.data as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !type.startsWith('chat.')) return;
      const frame = validateBridgeFrame(ExtensionToWebviewMsgSchema, e.data);
      if (!frame.ok) {
        vscodeApi.postMessage({ type: 'log', level: 'debug', text: `[Chat] Rejected host frame ${frame.msgType}` });
        return;
      }
      const msg = frame.data;
      switch (msg.type) {
        case 'chat.event':
          dispatch({ type: 'host-event', turnId: msg.turnId, event: msg.event, replacesAnalysis: msg.replacesAnalysis });
          break;
        case 'chat.state':
          dispatch({ type: 'host-state', models: msg.models, selectedModelId: msg.selectedModelId, effort: msg.effort, busy: msg.busy, turnId: msg.turnId, followups: msg.followups });
          break;
        case 'chat.history':
          dispatch({ type: 'host-history', messages: msg.messages });
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'chat.ready' });
    return () => window.removeEventListener('message', handler);
  }, [vscodeApi]);

  const turnId = state.turnId;
  const actions: ChatActions = {
    send: useCallback((text: string) => {
      dispatch({ type: 'send', text });
      vscodeApi.postMessage({ type: 'chat.send', text });
    }, [vscodeApi]),
    cancel: useCallback(() => {
      if (turnId) vscodeApi.postMessage({ type: 'chat.cancel', turnId });
      else vscodeApi.postMessage({ type: 'log', level: 'debug', text: '[Chat] Cancel ignored: the host has not reported a running turn yet' });
    }, [vscodeApi, turnId]),
    decideGate: useCallback((gateTurnId, gateId, decision, text) => {
      dispatch({ type: 'gate-decided', turnId: gateTurnId, gateId, decision });
      vscodeApi.postMessage({ type: 'chat.gate', turnId: gateTurnId, gateId, decision, ...(text ? { text } : {}) });
    }, [vscodeApi]),
    newChat: useCallback(() => vscodeApi.postMessage({ type: 'chat.newChat' }), [vscodeApi]),
    modelCommand: useCallback((command: 'add' | 'manage') => vscodeApi.postMessage({ type: 'chat.modelCommand', command }), [vscodeApi]),
    selectModel: useCallback((modelId: string) => vscodeApi.postMessage({ type: 'chat.selectModel', modelId }), [vscodeApi]),
    selectEffort: useCallback((effort: string) => vscodeApi.postMessage({ type: 'chat.selectEffort', effort }), [vscodeApi]),
  };
  return { state, actions };
}
