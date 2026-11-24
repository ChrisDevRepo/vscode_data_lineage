/**
 * The one provider kind: an OpenAI-compatible endpoint, spoken to by `@langchain/openai`'s standard
 * `ChatOpenAI` client over Chat Completions or Responses. Azure is a `/openai/v1/` base URL and
 * Anthropic its `/v1/` chat-completions URL; nothing here branches on a vendor. The client takes
 * the host's `fetch` (VS Code patches the global one for proxy support), so no `fetch`, agent,
 * retry or timeout is injected. The key reaches only the client's `Authorization` header.
 */
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type { ModelEntry } from './modelEntries';
import {
  ProviderModelPort,
  type ModelTransport,
  type ProviderModelPortOptions,
  type TransportRequest,
  type TransportTool,
} from '../model/providerModelPort';
import { cancelledError, ModelPortError, type ModelPortErrorCode } from '../model/modelPort';
import { systemPromptHash, type TokenUsage, type WireMessage, type WirePart } from '../observability/wireLog';
import { sanitizeProviderError } from '../support/text';

/**
 * Factor on every token count. The counter is OpenAI's `o200k_base`; other models tokenize SQL and
 * identifiers into more tokens, and a 32k window has no room for the difference.
 *
 * @internal Test seam.
 */
export const TOKEN_COUNT_MARGIN = 1.2;

let encoder: Tiktoken | undefined;

function countTokens(text: string): Promise<number> {
  encoder ??= new Tiktoken(o200kBase);
  return Promise.resolve(Math.ceil(encoder.encode(text).length * TOKEN_COUNT_MARGIN));
}

/** Request fields the entry's own settings produce, below `requestBody`. */
function entryBody(entry: ModelEntry, effort: string | undefined): Record<string, unknown> {
  if (entry.apiType === 'responses') {
    return {
      store: true,
      include: ['reasoning.encrypted_content'],
      ...(effort ? { reasoning: { effort } } : {}),
    };
  }
  return effort ? { reasoning_effort: effort } : {};
}

/**
 * The client for one entry; `maxRetries: 0` keeps the single connection retry in the graph. The
 * Chat Completions client writes `verbosity` and one output-cap key (`max_tokens`, or
 * `max_completion_tokens` for a reasoning model name) after `requestBody`. `verbosity` goes to its
 * own field; the cap goes there only when the key the client writes is the key the entry names, so
 * `requestBody` reaches the wire unchanged and never as two keys.
 */
function createChatModel(entry: ModelEntry, apiKey: string, effort: string | undefined): ChatOpenAI {
  const responses = entry.apiType === 'responses';
  const body = entry.requestBody ?? {};
  const build = (maxTokens?: number): ChatOpenAI => new ChatOpenAI({
    model: entry.model,
    apiKey,
    configuration: { baseURL: entry.url, ...(entry.requestHeaders ? { defaultHeaders: entry.requestHeaders } : {}) },
    useResponsesApi: responses,
    streaming: true,
    maxRetries: 0,
    // The Responses wire carries the output cap and a non-strict tool schema.
    ...(responses ? { supportsStrictToolCalling: false } : {}),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(!responses && typeof body.verbosity === 'string' ? { verbosity: body.verbosity as 'low' | 'medium' | 'high' } : {}),
    modelKwargs: { ...entryBody(entry, effort), ...entry.requestBody },
  });
  if (responses) return build(entry.maxOutputTokens);
  const named = (['max_tokens', 'max_completion_tokens'] as const).find((key) => typeof body[key] === 'number');
  if (!named) return build();
  const cap = body[named] as number;
  const probe: Record<string, unknown> = new ChatOpenAI({ model: entry.model, apiKey, maxTokens: cap }).invocationParams();
  const written = probe.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens';
  return written === named ? build(cap) : build();
}

function toUsage(usage: AIMessageChunk['usage_metadata']): TokenUsage | undefined {
  if (!usage) return undefined;
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const present = Object.entries({
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    totalTokens: count(usage.total_tokens),
    reasoningTokens: count(usage.output_token_details?.reasoning),
    cachedTokens: count(usage.input_token_details?.cache_read),
  }).filter(([, value]) => value !== undefined);
  return present.length > 0 ? Object.fromEntries(present) as TokenUsage : undefined;
}

/** Marks the messages this entry produced; a later request replays only provider state it owns. */
const ENTRY_KEY = 'entryId';

function responseMetadata(message: BaseMessage): Record<string, unknown> {
  return message.response_metadata as Record<string, unknown>;
}

function isOwnTurn(message: BaseMessage, entry: ModelEntry): boolean {
  return responseMetadata(message)[ENTRY_KEY] === entry.id;
}

/**
 * The messages one request sends. An assistant turn another endpoint produced loses its provider
 * state (reasoning, response items, ids), which only that endpoint can resolve. A Responses entry
 * that stores its responses sends only what follows the last of its own responses and names that
 * response, as the request continues it.
 */
function projectMessages(
  messages: readonly BaseMessage[],
  entry: ModelEntry,
): { readonly messages: BaseMessage[]; readonly previousResponseId?: string } {
  const projected = messages.map((message) => (
    AIMessage.isInstance(message) && !isOwnTurn(message, entry)
      ? new AIMessage({ content: message.content, tool_calls: message.tool_calls, name: message.name })
      : message
  ));
  if (entry.apiType !== 'responses' || entry.requestBody?.store === false) return { messages: projected };
  let last = messages.length - 1;
  while (last >= 0 && !(AIMessage.isInstance(messages[last]) && isOwnTurn(messages[last], entry))) last -= 1;
  const id: unknown = last >= 0 ? responseMetadata(messages[last]).id : undefined;
  return typeof id === 'string' && id && last < messages.length - 1
    ? { messages: projected.slice(last + 1), previousResponseId: id }
    : { messages: projected };
}

function toWirePart(value: unknown): WirePart {
  return { type: 'text', value: typeof value === 'string' ? value : JSON.stringify(value) };
}

/** The request as the trace states it: role and parts per message, never a header. */
function toWireMessage(message: BaseMessage): WireMessage {
  const content = typeof message.content === 'string' ? [message.content] : message.content.map((part) => (
    typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : part
  ));
  if (ToolMessage.isInstance(message)) {
    return { role: 'tool', parts: [{ type: 'tool-result', callId: message.tool_call_id, content: content.map(toWirePart) }] };
  }
  return {
    role: message.getType(),
    parts: [
      ...content.filter((part) => part !== '').map(toWirePart),
      ...(AIMessage.isInstance(message) ? message.tool_calls ?? [] : []).map((call) => (
        { type: 'tool-call' as const, callId: call.id ?? '', name: call.name, input: call.args }
      )),
    ],
  };
}

function failureCode(error: unknown): ModelPortErrorCode {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return 'no_permission';
  return status === 404 ? 'model_not_found' : 'provider_error';
}

/**
 * One failure as a port error: cancellation by the signal, else a redacted message and the cause.
 */
function normalizeError(error: unknown, signal: AbortSignal | undefined, replyReceived: boolean): ModelPortError {
  if (error instanceof ModelPortError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelledError();
  const code = failureCode(error);
  const text = error instanceof Error ? error.message : '';
  return new ModelPortError(code, sanitizeProviderError(text) || `Language model request failed (${code}).`, error, replyReceived);
}

type WireToolChoice = NonNullable<Parameters<ChatOpenAI['bindTools']>[1]>['tool_choice'];

/**
 * The choice as the entry's API takes it. The Responses client drops a string choice, so a required
 * call over several tools goes as the API's `allowed_tools` object; Chat Completions takes `'any'`.
 */
function wireToolChoice(entry: ModelEntry, choice: string | undefined, tools: readonly TransportTool[]): WireToolChoice {
  if (choice !== 'any' || entry.apiType !== 'responses') return choice;
  return {
    type: 'allowed_tools',
    allowed_tools: { mode: 'required', tools: tools.map((tool) => ({ type: 'function', name: tool.name })) },
  } as unknown as WireToolChoice;
}

/**
 * `entry` as a transport; `effort` overrides the entry's own `reasoningEffort` for its requests.
 */
function createOpenAiTransport(entry: ModelEntry, apiKey: string, effort = entry.reasoningEffort): ModelTransport {
  const chat = createChatModel(entry, apiKey, effort);
  return {
    id: `provider:${entry.id}`,
    identity: { id: entry.id, name: entry.name, vendor: 'openai-compatible', family: entry.model, version: entry.apiType },
    countTokens,
    async *stream({ messages, tools, toolChoice, signal, wire }: TransportRequest) {
      let replyReceived = false;
      try {
        if (signal?.aborted) throw cancelledError();
        const forced = toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'none';
        const sentChoice = forced && !entry.forcedToolChoice ? 'auto' : wireToolChoice(entry, toolChoice, tools);
        const request = projectMessages(messages, entry);
        wire?.({
          type: 'wire-request',
          messages: request.messages.map(toWireMessage),
          tools: tools.map((tool) => ({
            name: tool.name,
            descriptionHash: systemPromptHash(tool.description),
            inputSchema: tool.inputSchema,
          })),
          toolMode: tools.length > 0 ? (forced ? 2 : 1) : undefined,
        });
        const model = tools.length > 0
          ? chat.bindTools(
              tools.map((tool) => ({
                type: 'function' as const,
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
              { tool_choice: sentChoice },
            )
          : chat;
        let total: AIMessageChunk | undefined;
        let usage: TokenUsage | undefined;
        for await (const chunk of await model.stream(request.messages, {
          signal,
          ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        })) {
          replyReceived = true;
          usage = toUsage(chunk.usage_metadata) ?? usage;
          total = total ? total.concat(chunk) : chunk;
          yield chunk;
        }
        wire?.({
          type: 'wire-response',
          text: typeof total?.content === 'string' ? total.content : '',
          toolCalls: (total?.tool_calls ?? []).map((call) => ({ callId: call.id ?? '', name: call.name, input: call.args })),
          finishReason: typeof total?.response_metadata?.finish_reason === 'string' ? total.response_metadata.finish_reason : undefined,
          usage,
        });
        yield new AIMessageChunk({
          content: '',
          response_metadata: { streamEnd: true, [ENTRY_KEY]: entry.id, ...(usage ? { providerUsage: usage } : {}) },
        });
      } catch (error) {
        throw normalizeError(error, signal, replyReceived);
      }
    },
  };
}

/** The model port over one entry: the connection a turn runs on once the user picked the entry. */
export function createProviderModelPort(
  entry: ModelEntry,
  apiKey: string,
  options: ProviderModelPortOptions & { readonly effort?: string } = {},
): ProviderModelPort {
  const { effort, ...portOptions } = options;
  return new ProviderModelPort(createOpenAiTransport(entry, apiKey, effort), portOptions);
}
