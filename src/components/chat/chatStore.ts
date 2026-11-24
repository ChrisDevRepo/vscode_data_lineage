import type { ChatToExtensionMsg, ChatToWebviewMsg } from '../../engine/shared/chatContract';

type HostMessage<T extends ChatToWebviewMsg['type']> = Extract<ChatToWebviewMsg, { type: T }>;
export type TurnEvent = HostMessage<'chat.event'>['event'];
type ChatModelOption = HostMessage<'chat.state'>['models'][number];
type ChatFollowup = HostMessage<'chat.state'>['followups'][number];
type ChatHistoryMessage = HostMessage<'chat.history'>['messages'][number];
export type GateDecision = Extract<ChatToExtensionMsg, { type: 'chat.gate' }>['decision'];

/** One renderable piece of a chat message. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'status'; phase: string; label: string }
  | { type: 'gate'; gateId: string; gate: string; summary: string; classes?: readonly string[]; replacesAnalysis?: boolean; decision: GateDecision | undefined }
  | { type: 'error'; message: string };

export interface ChatMessage {
  /** A turn's assistant message uses its `turnId`; user and replayed messages get a local id. */
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
}

export interface ChatState {
  messages: ChatMessage[];
  busy: boolean;
  turnId: string | undefined;
  /** True once the host has sent its first `chat.state`; before it the model list is unknown, not empty. */
  ready: boolean;
  models: ChatModelOption[];
  selectedModelId: string;
  effort: string | undefined;
  /** The host's follow-up buttons for the session as it stands. */
  followups: ChatFollowup[];
  /** Counter behind the local message ids. */
  nextLocalId: number;
}

export type ChatAction =
  | { type: 'send'; text: string }
  | { type: 'host-event'; turnId: string; event: TurnEvent; replacesAnalysis?: boolean }
  | { type: 'host-state'; models: ChatModelOption[]; selectedModelId: string; effort?: string; busy: boolean; turnId?: string; followups: ChatFollowup[] }
  | { type: 'host-history'; messages: ChatHistoryMessage[] }
  | { type: 'gate-decided'; turnId: string; gateId: string; decision: GateDecision };

export const initialChatState: ChatState = {
  messages: [],
  busy: false,
  turnId: undefined,
  ready: false,
  models: [],
  selectedModelId: '',
  effort: undefined,
  followups: [],
  nextLocalId: 1,
};

const withoutStatus = (parts: ChatPart[]): ChatPart[] => parts.filter(part => part.type !== 'status');

/** Applies `update` to the turn's assistant message, creating it on the turn's first event. */
function updateTurn(state: ChatState, turnId: string, update: (parts: ChatPart[]) => ChatPart[]): ChatState {
  const index = state.messages.findIndex(m => m.id === turnId);
  if (index < 0) {
    return { ...state, messages: [...state.messages, { id: turnId, role: 'assistant', parts: update([]) }] };
  }
  const messages = state.messages.slice();
  messages[index] = { ...messages[index], parts: update(messages[index].parts) };
  return { ...state, messages };
}

function applyEvent(state: ChatState, turnId: string, event: TurnEvent, replacesAnalysis: boolean | undefined): ChatState {
  switch (event.type) {
    case 'status':
      return updateTurn(state, turnId, parts => [...withoutStatus(parts), { type: 'status', phase: event.phase, label: event.label }]);
    case 'text':
      return updateTurn(state, turnId, parts => {
        const rest = withoutStatus(parts);
        const last = rest[rest.length - 1];
        if (last?.type === 'text') return [...rest.slice(0, -1), { type: 'text', text: last.text + event.delta }];
        return [...rest, { type: 'text', text: event.delta }];
      });
    case 'gate':
      return updateTurn(state, turnId, parts => [
        ...withoutStatus(parts),
        { type: 'gate', gateId: event.gateId, gate: event.gate, summary: event.summary, classes: event.classes, replacesAnalysis, decision: undefined },
      ]);
    case 'error':
      return updateTurn(state, turnId, parts => [...withoutStatus(parts), { type: 'error', message: event.message }]);
    case 'terminal': {
      const settled = updateTurn(state, turnId, parts => {
        const rest = withoutStatus(parts);
        const shown = event.error !== undefined && !rest.some(part => part.type === 'error' && part.message === event.error);
        return shown ? [...rest, { type: 'error', message: event.error ?? '' }] : rest;
      });
      return settled.turnId === undefined || settled.turnId === turnId
        ? { ...settled, busy: false, turnId: undefined }
        : settled;
    }
  }
}

/** Folds host chat messages and local actions into the transcript the Thread renders. */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return {
        ...state,
        busy: true,
        nextLocalId: state.nextLocalId + 1,
        messages: [...state.messages, { id: `local-${state.nextLocalId}`, role: 'user', parts: [{ type: 'text', text: action.text }] }],
      };
    case 'host-event':
      return applyEvent(state, action.turnId, action.event, action.replacesAnalysis);
    case 'host-state':
      return {
        ...state,
        models: action.models,
        selectedModelId: action.selectedModelId,
        effort: action.effort,
        busy: action.busy,
        turnId: action.turnId,
        followups: action.followups,
        ready: true,
      };
    case 'host-history':
      return {
        ...state,
        nextLocalId: state.nextLocalId + action.messages.length,
        messages: action.messages.map((m, i) => ({
          id: `local-${state.nextLocalId + i}`,
          role: m.role,
          parts: [{ type: 'text', text: m.text }],
        })),
      };
    case 'gate-decided':
      if (!state.messages.some(m => m.id === action.turnId)) return state;
      return updateTurn(state, action.turnId, parts => parts.map(part =>
        part.type === 'gate' && part.gateId === action.gateId ? { ...part, decision: action.decision } : part));
  }
}
