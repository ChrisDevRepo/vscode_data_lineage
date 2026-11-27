import { useMemo } from 'react';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  ComposerPrimitive,
  Tools,
  useExternalStoreRuntime,
  type AppendMessage,
  type DirectiveFormatter,
  type ThreadMessageLike,
  type Toolkit,
  type TriggerAdapter,
  type TriggerItem,
} from '@assistant-ui/react';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { ModelSelector } from '@/components/assistant-ui/elements/model-selector.aui';
import { useModelSelectorContext } from '@/components/assistant-ui/elements/model-selector';
import { CommandItem } from '@/components/ui/command';
import type { ModelOption } from '@/components/assistant-ui/utils/model-selection';
import { CHAT_COMMANDS, NO_MODEL_MESSAGE } from '../../engine/shared/chatContract';
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

/** The message content parts the library renders for a store message's parts (errors are not parts). */
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
            summary: part.summary,
            ...(part.fullPlan ? { fullPlan: part.fullPlan } : {}),
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
 */
export function modelsMissing(state: ChatState): boolean {
  return state.ready && state.models.length === 0;
}

/** The picker's last row: opens the host's Manage AI Models menu and closes the picker. */
function ManageModelsItem() {
  const { actions } = useChatContext();
  const { setOpen } = useModelSelectorContext();
  return (
    <CommandItem value="manage-models" onSelect={() => { setOpen(false); actions.modelCommand('manage'); }}>
      Manage models…
    </CommandItem>
  );
}

/**
 * Model picker (with the effort levels of the selected model and a Manage models… row) in the
 * composer's action row; with no model configured, the notice and the Add model button instead.
 */
export function ComposerControls() {
  const { state, actions } = useChatContext();
  const models = useMemo<ModelOption[]>(() => state.models.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.supportsReasoningEffort ? { efforts: model.supportsReasoningEffort.map(id => ({ id, name: id })) } : {}),
  })), [state.models]);
  if (modelsMissing(state)) {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-muted-foreground text-xs">{NO_MODEL_MESSAGE}</p>
        <button type="button" className="ln-btn-ghost rounded-sm px-2 py-1 text-xs" onClick={() => actions.modelCommand('add')}>Add model</button>
      </div>
    );
  }
  if (models.length === 0) return null;
  return (
    <ModelSelector.Root
      models={models}
      value={state.selectedModelId}
      onValueChange={actions.selectModel}
      effort={state.effort}
      onEffortChange={actions.selectEffort}
    >
      <ModelSelector.Trigger variant="ghost" size="sm" />
      <ModelSelector.Content>
        <ModelSelector.List>
          <ModelSelector.Group>
            {models.map(model => <ModelSelector.Item key={model.id} model={model} />)}
          </ModelSelector.Group>
          <ModelSelector.Separator />
          <ModelSelector.Group>
            <ManageModelsItem />
          </ModelSelector.Group>
        </ModelSelector.List>
        <ModelSelector.Effort />
      </ModelSelector.Content>
    </ModelSelector.Root>
  );
}

const COMMAND_ITEMS: readonly TriggerItem[] = CHAT_COMMANDS.map(({ id, description }) => ({ id, type: 'command', label: id, description }));

/** A flat list of the host's commands, narrowed by what follows the slash. */
const COMMAND_ADAPTER: TriggerAdapter = {
  categories: () => [],
  categoryItems: () => [],
  search: query => COMMAND_ITEMS.filter(item => item.id.startsWith(query.toLowerCase())),
};

/** A picked command goes into the composer as the plain text the host parses; Enter then sends it. */
const COMMAND_FORMATTER: DirectiveFormatter = {
  serialize: item => `/${item.id}`,
  parse: text => [{ kind: 'text', text }],
};

/** The command list the library opens above the composer when the text starts a `/` word. */
function CommandPopover() {
  return (
    <ComposerPrimitive.TriggerPopover
      char="/"
      adapter={COMMAND_ADAPTER}
      className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-10 mb-14 w-64 rounded-lg border p-1 shadow-md"
    >
      <ComposerPrimitive.TriggerPopover.Directive formatter={COMMAND_FORMATTER} />
      <ComposerPrimitive.TriggerPopoverItems>
        {items => items.map((item, index) => (
          <ComposerPrimitive.TriggerPopoverItem
            key={item.id}
            item={item}
            index={index}
            className="data-[highlighted]:bg-accent flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs"
          >
            <span className="font-mono font-medium">/{item.label}</span>
            <span className="text-muted-foreground truncate">{item.description}</span>
          </ComposerPrimitive.TriggerPopoverItem>
        ))}
      </ComposerPrimitive.TriggerPopoverItems>
    </ComposerPrimitive.TriggerPopover>
  );
}

/** The composer's action-row slot: the model controls and the command popover. */
function ComposerExtra() {
  return (
    <>
      <ComposerControls />
      <CommandPopover />
    </>
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

const THREAD_COMPONENTS = { ComposerExtra, Welcome: ChatWelcome };

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
    isRunning: state.turnId !== undefined,
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
            <ComposerPrimitive.TriggerPopoverRoot>
              <Thread components={THREAD_COMPONENTS} autoFocus={false} />
            </ComposerPrimitive.TriggerPopoverRoot>
          </div>
          <div className="text-muted-foreground flex items-center justify-between px-3 py-1 text-xs" data-slot="chat-transport-footer">
            <span>{state.provider === 'api-key' ? 'Mode: Direct API key' : 'Mode: VS Code LM (Copilot)'}</span>
          </div>
        </div>
      </AssistantRuntimeProvider>
    </ChatContext.Provider>
  );
}
