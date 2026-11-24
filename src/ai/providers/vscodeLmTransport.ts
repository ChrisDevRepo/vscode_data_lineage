/**
 * The VS Code language-model kind: a model another extension (Copilot Chat, a provider extension)
 * publishes through `vscode.lm`, spoken to as a {@link ModelTransport} beside the OpenAI one. The one
 * file that touches `vscode.lm` and its `LanguageModel*` types. Structured output stays the port's
 * forced synthetic tool (`toolMode: Required`); the platform has no system role, so the system
 * prompt goes as the first User message, and no JSON-schema or strict mode exists. The message and
 * part mapping is the former `vscodeLangChainBridge`'s.
 */
import * as vscode from 'vscode';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import { cancelledError, ModelPortError, type ModelPortErrorCode } from '../model/modelPort';
import { isRecord } from '../../utils/isRecord';
import type { ModelTransport, TransportRequest } from '../model/providerModelPort';
import { safeTraceStringify, systemPromptHash, type TokenUsage, type WireMessage, type WirePart } from '../observability/wireLog';
import { sanitizeProviderError } from '../support/text';
import { countTokens } from '../support/tokenCount';
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
  /** Opaque to every caller but {@link createVscodeLmTransport}. */
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

/** One native part as the trace states it; a part not modeled is kept as `other` JSON. */
function toWirePart(part: unknown): WirePart {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', value: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) return { type: 'tool-call', callId: part.callId, name: part.name, input: part.input };
  if (part instanceof vscode.LanguageModelToolResultPart) return { type: 'tool-result', callId: part.callId, content: part.content.map(toWirePart) };
  return { type: 'other', json: safeTraceStringify(part) };
}

function toWireMessage(message: vscode.LanguageModelChatMessage): WireMessage {
  const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
  return { role, parts: message.content.map(toWirePart) };
}

/** Token usage from the UTF-8 JSON data part VS Code's built-in providers stream (OpenAI names); undefined if bad. */
function parseUsageData(data: unknown): TokenUsage | undefined {
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
  const present = Object.entries({
    inputTokens: count(raw.prompt_tokens),
    outputTokens: count(raw.completion_tokens),
    totalTokens: count(raw.total_tokens),
    reasoningTokens: nested('completion_tokens_details', 'reasoning_tokens'),
    cachedTokens: nested('prompt_tokens_details', 'cached_tokens'),
  }).filter(([, value]) => value !== undefined);
  return present.length > 0 ? Object.fromEntries(present) as TokenUsage : undefined;
}

const FAILURE_CODES: Readonly<Record<string, ModelPortErrorCode>> = {
  NoPermissions: 'no_permission',
  Blocked: 'blocked',
  NotFound: 'model_not_found',
};

/** One failure as a port error: cancellation by the token or signal, else a redacted message and the cause. */
function normalizeError(error: unknown, token: vscode.CancellationToken, signal: AbortSignal | undefined): ModelPortError {
  if (error instanceof ModelPortError) return error;
  if (token.isCancellationRequested || signal?.aborted) return cancelledError();
  const code = (isRecord(error) && typeof error.code === 'string' ? FAILURE_CODES[error.code] : undefined) ?? 'provider_error';
  const text = error instanceof Error ? error.message : '';
  return new ModelPortError(code, sanitizeProviderError(text) || `Language model request failed (${code}).`, error);
}

/**
 * `entry` over `model` as a transport. `modelOptions` is the entry's `requestBody` plus `max_tokens`
 * from `maxOutputTokens`, sent unchanged and left out when empty (a live selection has neither).
 */
export function createVscodeLmTransport(entry: VscodeLmModelEntry, model: vscode.LanguageModelChat): ModelTransport {
  const modelOptions = { ...(entry.maxOutputTokens === undefined ? {} : { max_tokens: entry.maxOutputTokens }), ...entry.requestBody };
  const hasOptions = Object.keys(modelOptions).length > 0;
  return {
    id: `provider:${entry.id}`,
    identity: { id: entry.id, name: entry.name, vendor: model.vendor, family: model.family, version: model.version },
    countTokens: (text) => Promise.resolve(countTokens(text)),
    async *stream({ messages, tools, toolChoice, signal, wire }: TransportRequest) {
      const cancellation = new vscode.CancellationTokenSource();
      const cancel = () => cancellation.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      const cancelled = () => cancellation.token.isCancellationRequested || signal?.aborted === true;
      try {
        if (cancelled()) throw cancelledError();
        const native = messages.map(toVscodeMessage);
        const toolMode = toolChoice !== undefined && toolChoice !== 'auto' ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto;
        wire?.({
          type: 'wire-request',
          messages: native.map(toWireMessage),
          tools: tools.map((tool) => ({ name: tool.name, descriptionHash: systemPromptHash(tool.description), inputSchema: tool.inputSchema })),
          toolMode: tools.length > 0 ? toolMode : undefined,
          ...(hasOptions ? { body: modelOptions } : {}),
        });
        const response = await model.sendRequest(native, {
          ...(tools.length > 0 ? { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), toolMode } : {}),
          ...(hasOptions ? { modelOptions } : {}),
        }, cancellation.token);
        let text = '';
        let usage: TokenUsage | undefined;
        const calls: Array<{ callId: string; name: string; input: unknown }> = [];
        const otherParts: WirePart[] = [];
        for await (const part of response.stream) {
          if (cancelled()) throw cancelledError();
          if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
            yield new AIMessageChunk({ content: part.value });
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            calls.push({ callId: part.callId, name: part.name, input: part.input });
            yield new AIMessageChunk({
              content: '',
              tool_call_chunks: [{ id: part.callId, name: part.name, args: JSON.stringify(part.input), index: calls.length - 1, type: 'tool_call_chunk' }],
            });
          } else if (isRecord(part) && part.mimeType === 'usage') {
            usage = parseUsageData(part.data) ?? usage;
          } else {
            otherParts.push(toWirePart(part));
          }
        }
        if (cancelled()) throw cancelledError();
        wire?.({ type: 'wire-response', text, toolCalls: calls, ...(otherParts.length > 0 ? { otherParts } : {}), ...(usage ? { usage } : {}) });
        yield new AIMessageChunk({ content: '', response_metadata: { streamEnd: true, ...(usage ? { providerUsage: usage } : {}) } });
      } catch (error) {
        throw normalizeError(error, cancellation.token, signal);
      } finally {
        signal?.removeEventListener('abort', cancel);
        cancellation.dispose();
      }
    },
  };
}
