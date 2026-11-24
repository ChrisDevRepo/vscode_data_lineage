import { useMemo } from 'react';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
  type Toolkit,
} from '@assistant-ui/react';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { ModelSelector } from '@/components/assistant-ui/elements/model-selector.aui';
import type { ModelOption } from '@/components/assistant-ui/utils/model-selection';
import { NO_MODEL_MESSAGE } from '../../engine/shared/chatContract';
import { ChatContext, useChatContext } from './ChatContext';
import { GateCard, type GateArgs } from './GateCard';
import { StatusPart } from './StatusPart';
import type { ChatMessage, ChatPart, ChatState } from './chatStore';
import { useChat } from './useChat';

const GATE_TOOL = 'lineage_gate';
const STATUS_TOOL = 'lineage_status';

/**
 * The gate card and the progress line render as tool-call parts, the library's slot for custom
 * message parts. `human` shows the card standalone, outside the tool group; `backend` has nothing to
 * execute here, the host owns every turn.
 */
const NO_PARAMETERS = { type: 'object' } as const;
const TOOLKIT: Toolkit = {
  [GATE_TOOL]: { type: 'human', parameters: NO_PARAMETERS, render: ({ args }) => <GateCard args={args as GateArgs} /> },
  [STATUS_TOOL]: { type: 'backend', display: 'standalone', render: ({ args }) => <StatusPart label={String(args.label)} /> },
};
const AUI_CONFIG = AuiConfig({ tools: Tools({ toolkit: TOOLKIT }) });

/** The message content parts the library renders for a store message's parts (errors are not parts). @internal */
export function toContent(parts: readonly ChatPart[], turnId: string): Exclude<ThreadMessageLike['content'], string> {
  return parts.flatMap((part): Exclude<ThreadMessageLike['content'], string> => {
    switch (part.type) {
      case 'text':
        return [{ type: 'text', text: part.text }];
      case 'status':
        return [{ type: 'tool-call', toolCallId: `${turnId}:status`, toolName: STATUS_TOOL, args: { label: part.label } }];
      case 'gate':
        return [{
          type: 'tool-call',
          toolCallId: part.gateId,
          toolName: GATE_TOOL,
          args: {
            turnId,
            gateId: part.gateId,
            gate: part.gate,
            summary: part.summary,
            ...(part.classes ? { classes: part.classes } : {}),
            ...(part.replacesAnalysis ? { replacesAnalysis: true } : {}),
            ...(part.decision ? { decision: part.decision } : {}),
          },
          // A decided gate is a finished call; an open one waits on the user.
          ...(part.decision === undefined ? {} : { result: part.decision }),
        }];
      case 'error':
        return [];
    }
  });
}

/**
 * Maps a store message to the library's message shape; an error part becomes the message's error status.
 * @internal
 */
export function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  const error = message.parts.filter(part => part.type === 'error').at(-1);
  return {
    id: message.id,
    role: message.role,
    content: toContent(message.parts, message.id),
    ...(error?.type === 'error' ? { status: { type: 'incomplete', reason: 'error', error: error.message } } : {}),
  };
}

function textOf(message: AppendMessage): string {
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * The host has answered and offers no model, so a send could only fail.
 * @internal
 */
export function modelsMissing(state: ChatState): boolean {
  return state.ready && state.models.length === 0;
}

/**
 * Model picker (with the effort levels of the selected model) in the composer's action row.
 * @internal
 */
export function ComposerControls() {
  const { state, actions } = useChatContext();
  const models = useMemo<ModelOption[]>(() => state.models.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.supportsReasoningEffort ? { efforts: model.supportsReasoningEffort.map(id => ({ id, name: id })) } : {}),
  })), [state.models]);
  if (modelsMissing(state)) {
    return <p className="text-muted-foreground text-xs">{NO_MODEL_MESSAGE}</p>;
  }
  if (models.length === 0) return null;
  const selected = state.models.find(model => model.id === state.selectedModelId);
  return (
    <ModelSelector
      models={models}
      value={state.selectedModelId}
      onValueChange={actions.selectModel}
      effort={state.effort ?? selected?.reasoningEffort}
      onEffortChange={actions.selectEffort}
      variant="ghost"
      size="sm"
    />
  );
}

/** The empty-thread heading: the template's Welcome slot, in the app's small panel-title style. */
function ChatWelcome() {
  return (
    <div className="mb-4 flex flex-col gap-1 px-2">
      <p className="text-sm font-semibold">Data Lineage Assistant</p>
      <p className="text-muted-foreground text-xs">Ask about the lineage of the loaded project.</p>
    </div>
  );
}

const THREAD_COMPONENTS = { ComposerExtra: ComposerControls, Welcome: ChatWelcome };

/**
 * The chat: assistant-ui's Thread over an external-store runtime. The host owns every turn; this
 * pane shows what `useChat` folds out of the host's frames and posts the user's actions back.
 * Attachments, voice, edit, reload and feedback have no adapter, so the runtime offers none.
 */
export default function ChatPane() {
  const chat = useChat();
  const { state, actions } = chat;
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: state.messages,
    isRunning: state.busy,
    // The library's own disabled composer; the notice above tells the user why.
    isDisabled: modelsMissing(state),
    convertMessage: toThreadMessage,
    onNew: async (message) => { actions.send(textOf(message)); },
    onCancel: async () => { actions.cancel(); },
  });
  return (
    <ChatContext.Provider value={chat}>
      <AssistantRuntimeProvider runtime={runtime} config={AUI_CONFIG}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-end gap-1 py-1 pr-10 pl-2 text-xs">
            <button type="button" className="ln-btn-ghost rounded-sm px-2 py-1" onClick={actions.newChat}>New chat</button>
          </div>
          <div className="min-h-0 flex-1">
            <Thread components={THREAD_COMPONENTS} autoFocus={false} />
          </div>
        </div>
      </AssistantRuntimeProvider>
    </ChatContext.Provider>
  );
}
