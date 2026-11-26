import type { ChatToExtensionMsg, ChatToWebviewMsg } from '../../engine/shared/chatContract';

type HostMessage<T extends ChatToWebviewMsg['type']> = Extract<ChatToWebviewMsg, { type: T }>;
export type TurnEvent = HostMessage<'chat.event'>['event'];
type ChatModelOption = HostMessage<'chat.state'>['models'][number];
type ChatFollowup = HostMessage<'chat.state'>['followups'][number];
type ChatHistoryMessage = HostMessage<'chat.history'>['messages'][number];
export type GateFullPlan = NonNullable<Extract<TurnEvent, { type: 'gate' }>['fullPlan']>;
export type GateDecision = Extract<ChatToExtensionMsg, { type: 'chat.gate' }>['decision'];

/** One renderable piece of a chat message. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'status'; label: string }
  | { type: 'gate'; gateId: string; summary: string; fullPlan?: GateFullPlan; replacesAnalysis?: boolean; decision: GateDecision | undefined }
  | { type: 'error'; message: string };

export interface ChatMessage {
  /** A turn's assistant message uses its `turnId`; user and replayed messages get a local id. */
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
}

export interface ChatState {
  messages: ChatMessage[];
  /** The running turn, as the host reports it; undefined when none runs. */
  turnId: string | undefined;
  /** True once the host has sent its first `chat.state`; before it the model list is unknown, not empty. */
  ready: boolean;
  /** Active AI transport (`vscode-lm` vs `api-key`). */
  provider: 'vscode-lm' | 'api-key';
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
  | { type: 'host-state'; provider?: 'vscode-lm' | 'api-key'; models: ChatModelOption[]; selectedModelId: string; effort?: string; turnId?: string; followups: ChatFollowup[] }
  | { type: 'host-history'; messages: ChatHistoryMessage[] }
  | { type: 'gate-decided'; turnId: string; gateId: string; decision: GateDecision };

export const initialChatState: ChatState = {
  messages: [],
  turnId: undefined,
  ready: false,
  provider: 'vscode-lm',
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
      return updateTurn(state, turnId, parts => [...withoutStatus(parts), { type: 'status', label: event.label }]);
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
        { type: 'gate', gateId: event.gateId, summary: event.summary, fullPlan: event.fullPlan, replacesAnalysis, decision: undefined },
      ]);
    case 'error':
      return updateTurn(state, turnId, parts => [...withoutStatus(parts), { type: 'error', message: event.message }]);
    case 'terminal': {
      const settled = updateTurn(state, turnId, parts => {
        const rest = withoutStatus(parts);
        const { error } = event;
        return error !== undefined && !rest.some(part => part.type === 'error' && part.message === error)
          ? [...rest, { type: 'error', message: error }]
          : rest;
      });
      return settled.turnId === undefined || settled.turnId === turnId
        ? { ...settled, turnId: undefined }
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
        nextLocalId: state.nextLocalId + 1,
        messages: [...state.messages, { id: `local-${state.nextLocalId}`, role: 'user', parts: [{ type: 'text', text: action.text }] }],
      };
    case 'host-event':
      return applyEvent(state, action.turnId, action.event, action.replacesAnalysis);
    case 'host-state':
      return {
        ...state,
        provider: action.provider ?? (action.selectedModelId.startsWith('lm:') ? 'vscode-lm' : state.provider),
        models: action.models,
        selectedModelId: action.selectedModelId,
        effort: action.effort,
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
