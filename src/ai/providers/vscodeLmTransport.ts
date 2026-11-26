/**
 * The VS Code language-model kind: a model another extension (Copilot Chat, a provider extension)
 * publishes through `vscode.lm`, spoken to as a LangChain chat model beside the OpenAI one. The one
 * file that touches `vscode.lm` and its `LanguageModel*` types. Structured output stays the port's
 * forced synthetic tool (`toolMode: Required`); the platform has no system role, so the system
 * prompt goes as the first User message, and no JSON-schema or strict mode exists.
 */
import * as vscode from 'vscode';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type MessageContent, type UsageMetadata } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { cancelledError, ModelPortError, type ModelPortErrorCode } from '../model/modelPort';
import { isRecord } from '../../utils/isRecord';
import { toPortError, type ChatTool, type ProviderChat } from '../model/providerModelPort';
import { LIVE_MODEL_ID_PREFIX, type VscodeLmModelEntry } from './modelEntries';

/** One language model as the host lists it, free of `vscode` types except the handle. */
export interface LmModelInfo {
  /** Id the model is offered under when no entry names it: the reserved prefix, vendor and model id. */
  readonly selectionId: string;
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  /** The input window the model reports. */
  readonly maxInputTokens: number;
  /** Opaque to every caller but {@link createVscodeLmChat}. */
  readonly model: vscode.LanguageModelChat;
}

/** The models the host lists, and the one model each `vscode-lm` entry's selector resolved to. */
export interface LmCatalog {
  readonly live: readonly LmModelInfo[];
  readonly resolved: ReadonlyMap<string, LmModelInfo>;
}

function toInfo(model: vscode.LanguageModelChat): LmModelInfo {
  const { id, name, vendor, family, version, maxInputTokens } = model;
  return { selectionId: `${LIVE_MODEL_ID_PREFIX}${vendor}/${id}`, id, name, vendor, family, version, maxInputTokens, model };
}

/** Lists the live models and resolves each entry's selector by VS Code's own matching, first match. */
export async function loadLmCatalog(entries: readonly VscodeLmModelEntry[]): Promise<LmCatalog> {
  const live = (await vscode.lm.selectChatModels()).map(toInfo);
  const resolved = new Map<string, LmModelInfo>();
  for (const entry of entries) {
    const [match] = await vscode.lm.selectChatModels(entry.selector);
    if (match) resolved.set(entry.id, toInfo(match));
  }
  return { live, resolved };
}

/** The model an entry id or a live selection id names, if the catalog has it. */
export function findLmModel(catalog: LmCatalog | undefined, id: string): LmModelInfo | undefined {
  return catalog?.resolved.get(id) ?? catalog?.live.find((info) => info.selectionId === id);
}

/** Calls `listener` whenever the host's model list changes. */
export function onLmModelsChanged(listener: () => void): { dispose(): void } {
  return vscode.lm.onDidChangeChatModels(listener);
}

/** The model the panel starts on with no entry or pick: the first Copilot model, in the host's order. */
export function preferredStartModel(live: readonly LmModelInfo[]): LmModelInfo | undefined {
  return live.find((info) => info.vendor === 'copilot');
}

function toTextParts(content: MessageContent): vscode.LanguageModelTextPart[] {
  if (typeof content === 'string') return content ? [new vscode.LanguageModelTextPart(content)] : [];
  return content.map((part) => {
    if (typeof part === 'string') return new vscode.LanguageModelTextPart(part);
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') return new vscode.LanguageModelTextPart(part.text);
    throw new ModelPortError('invalid_request', 'The VS Code language model path supports text message content only.');
  });
}

/**
 * One message as the platform takes it. The system message is a User message (no system role). An
 * assistant turn goes as text and tool calls only: a history from another entry carries no foreign
 * state. A tool message's `status` is not projected (`LanguageModelToolResultPart` has no error
 * flag); a failed call reaches the model through its content.
 */
function toVscodeMessage(message: BaseMessage): vscode.LanguageModelChatMessage {
  if (SystemMessage.isInstance(message) || HumanMessage.isInstance(message)) {
    return vscode.LanguageModelChatMessage.User(toTextParts(message.content), message.name);
  }
  if (AIMessage.isInstance(message)) {
    const calls = (message.tool_calls ?? []).map((call) => {
      if (!call.id) throw new ModelPortError('invalid_request', 'Assistant tool call requires a non-empty call ID.');
      return new vscode.LanguageModelToolCallPart(call.id, call.name, call.args);
    });
    return vscode.LanguageModelChatMessage.Assistant([...toTextParts(message.content), ...calls], message.name);
  }
  if (ToolMessage.isInstance(message)) {
    return vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(message.tool_call_id, toTextParts(message.content))], message.name);
  }
  throw new ModelPortError('invalid_request', `Unsupported LangChain message type: ${message.getType()}.`);
}

/**
 * Copilot Auto routes a request on the text of its last user message and rejects one that ends with tool
 * results ("Auto mode needs a prompt or a command to route a request."), so a tool loop continues with this
 * trailing user prompt. Nothing else is sent for any other model.
 */
const COPILOT_AUTO_ROUTING_TEXT = 'Continue.';

function isCopilotAuto(model: vscode.LanguageModelChat): boolean {
  return model.vendor === 'copilot' && model.id === 'auto';
}

/** Token usage from the UTF-8 JSON data part VS Code's built-in providers stream (OpenAI names); undefined if bad. */
function parseUsageData(data: unknown): UsageMetadata | undefined {
  if (!(data instanceof Uint8Array)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const nested = (key: string, field: string): number | undefined => (isRecord(raw[key]) ? count(raw[key][field]) : undefined);
  const input = count(raw.prompt_tokens);
  const output = count(raw.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  const reasoning = nested('completion_tokens_details', 'reasoning_tokens');
  const cached = nested('prompt_tokens_details', 'cached_tokens');
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: count(raw.total_tokens) ?? input + output,
    ...(reasoning === undefined ? {} : { output_token_details: { reasoning } }),
    ...(cached === undefined ? {} : { input_token_details: { cache_read: cached } }),
  };
}

const FAILURE_CODES: Readonly<Record<string, ModelPortErrorCode>> = {
  NoPermissions: 'no_permission',
  Blocked: 'blocked',
  NotFound: 'model_not_found',
};

/** Whether a provider tool choice forces the model to call a tool rather than leaving it optional or off. */
function isForcedToolChoice(choice: unknown): boolean {
  return choice !== undefined && choice !== 'auto' && choice !== 'none';
}

/** The call options: the OpenAI-form tools and the choice the port binds with {@link VscodeLmChatModel.bindTools}. */
interface VscodeLmCallOptions extends BaseChatModelCallOptions {
  tools?: ChatTool[];
}

/**
 * One `vscode.lm` model as a LangChain chat model. `modelOptions` go to the host unchanged and
 * are what the trace states as the request body. The reply is streamed as chunks: text, whole tool
 * calls, and a last chunk whose `finish_reason` says the stream was seen to its end and whose
 * `usage_metadata` is the last readable usage data part. A failure is a {@link ModelPortError}.
 */
export class VscodeLmChatModel extends BaseChatModel<VscodeLmCallOptions> {
  public constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly modelOptions: Record<string, unknown> = {},
  ) {
    super({});
  }

  public _llmType(): string {
    return 'vscode-lm';
  }

  public override invocationParams(): Record<string, unknown> {
    return this.modelOptions;
  }

  public override bindTools(tools: ChatTool[], kwargs?: Partial<VscodeLmCallOptions>) {
    return this.withConfig({ tools, ...kwargs });
  }

  public async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    let reply: ChatGenerationChunk | undefined;
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) reply = reply ? reply.concat(chunk) : chunk;
    return { generations: reply ? [reply] : [] };
  }

  public override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { signal, tools = [], tool_choice: toolChoice } = options;
    const cancellation = new vscode.CancellationTokenSource();
    // LangChain drops a stream on abort without closing it; the host's stream is closed here, with its token.
    let host: AsyncIterator<unknown> | undefined;
    const cancel = () => {
      cancellation.cancel();
      host?.return?.().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const chunk = (message: AIMessageChunk) => new ChatGenerationChunk({ message, text: typeof message.content === 'string' ? message.content : '' });
    try {
      if (signal?.aborted) throw cancelledError();
      const nativeMessages = messages.map(toVscodeMessage);
      if (isCopilotAuto(this.model) && ToolMessage.isInstance(messages.at(-1))) nativeMessages.push(vscode.LanguageModelChatMessage.User(COPILOT_AUTO_ROUTING_TEXT));
      const toolMode = isForcedToolChoice(toolChoice)
        ? vscode.LanguageModelChatToolMode.Required
        : vscode.LanguageModelChatToolMode.Auto;
      const response = await this.model.sendRequest(nativeMessages, {
        ...(tools.length > 0 ? { tools: tools.map(({ function: { name, description, parameters } }) => ({ name, description, inputSchema: parameters })), toolMode } : {}),
        ...(Object.keys(this.modelOptions).length > 0 ? { modelOptions: this.modelOptions } : {}),
      }, cancellation.token);
      let calls = 0;
      let usage: UsageMetadata | undefined;
      host = response.stream[Symbol.asyncIterator]();
      for (let next = await host.next(); !next.done; next = await host.next()) {
        const part = next.value;
        if (signal?.aborted) throw cancelledError();
        if (part instanceof vscode.LanguageModelTextPart) {
          yield chunk(new AIMessageChunk({ content: part.value }));
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          yield chunk(new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ id: part.callId, name: part.name, args: JSON.stringify(part.input), index: calls, type: 'tool_call_chunk' }],
          }));
          calls += 1;
        } else if (isRecord(part) && part.mimeType === 'usage') {
          usage = parseUsageData(part.data) ?? usage;
        }
      }
      if (signal?.aborted) throw cancelledError();
      yield chunk(new AIMessageChunk({ content: '', response_metadata: { finish_reason: calls > 0 ? 'tool_calls' : 'stop' }, ...(usage ? { usage_metadata: usage } : {}) }));
    } catch (error) {
      throw toPortError(error, signal, isRecord(error) && typeof error.code === 'string' ? FAILURE_CODES[error.code] : undefined);
    } finally {
      signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
    }
  }
}

/**
 * `entry` over `model` as a provider chat. `modelOptions` is `max_tokens` from `maxOutputTokens`
 * then the entry's `requestBody` (which names no cap), sent unchanged and left out when empty (a
 * live selection has neither).
 */
export function createVscodeLmChat(entry: VscodeLmModelEntry, model: vscode.LanguageModelChat): ProviderChat {
  const chat = new VscodeLmChatModel(model, { ...(entry.maxOutputTokens === undefined ? {} : { max_tokens: entry.maxOutputTokens }), ...entry.requestBody });
  return {
    id: `provider:${entry.id}`,
    identity: { id: entry.id, name: entry.name, vendor: model.vendor, family: model.family, version: model.version },
    request: (messages, tools, toolChoice) => {
      const sentChoice = isForcedToolChoice(toolChoice) && !entry.forcedToolChoice ? 'auto' : toolChoice;
      return {
        model: tools.length > 0 ? chat.bindTools([...tools], { tool_choice: sentChoice }) : chat,
        messages: [...messages],
      };
    },
  };
}
