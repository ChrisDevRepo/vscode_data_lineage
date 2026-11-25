/**
 * The one provider kind: an OpenAI-compatible endpoint, spoken to by `@langchain/openai`'s standard
 * `ChatOpenAI` client over Chat Completions or Responses. Azure is a `/openai/v1/` base URL and
 * Anthropic its `/v1/` chat-completions URL; nothing here branches on a vendor. The client takes
 * the host's `fetch` (VS Code patches the global one for proxy support), so no `fetch`, agent or
 * timeout is injected; the retry is the SDK's (see `createChatModel`). The key reaches only the
 * client's `Authorization` header.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { OpenAiModelEntry } from './modelEntries';
import {
  ENTRY_KEY,
  ProviderModelPort,
  type ChatTool,
  type ProviderChat,
  type ProviderModelPortOptions,
} from '../model/providerModelPort';
import { ModelPortError } from '../model/modelPort';

/** Request fields the entry's own settings produce, below `requestBody`. */
function entryBody(entry: OpenAiModelEntry, effort: string | undefined): Record<string, unknown> {
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
 * The client for one entry. Its retry is the OpenAI SDK's own (`configuration.maxRetries`, the SDK default
 * of 2): connection errors, timeouts and 408/409/429/5xx, with backoff, `retry-after`, and the turn's signal
 * ending a pending wait. `maxRetries: 0` turns off LangChain's second layer, which would also retry other 4xx.
 * The output cap is the entry's `maxOutputTokens`, or the cap `requestBody` names (`max_tokens` or
 * `max_completion_tokens`) on Chat Completions. The client writes `verbosity` and the cap key
 * (`max_tokens`, or `max_completion_tokens` for a reasoning model name) after `requestBody`, so both
 * go to its own fields; a named cap goes there only when the key the client writes is the key
 * `requestBody` names, so `requestBody` reaches the wire unchanged and never as two keys.
 */
function createChatModel(entry: OpenAiModelEntry, apiKey: string, effort: string | undefined): ChatOpenAI {
  const responses = entry.apiType === 'responses';
  const body = entry.requestBody ?? {};
  const build = (maxTokens?: number): ChatOpenAI => new ChatOpenAI({
    model: entry.model,
    apiKey,
    configuration: { baseURL: entry.url, maxRetries: 2, ...(entry.requestHeaders ? { defaultHeaders: entry.requestHeaders } : {}) },
    useResponsesApi: responses,
    streaming: true,
    maxRetries: 0,
    // The Responses wire carries the output cap and a non-strict tool schema.
    ...(responses ? { supportsStrictToolCalling: false } : {}),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(!responses && typeof body.verbosity === 'string' ? { verbosity: body.verbosity as 'low' | 'medium' | 'high' } : {}),
    modelKwargs: { ...entryBody(entry, effort), ...entry.requestBody },
  });
  const named = responses ? undefined : (['max_tokens', 'max_completion_tokens'] as const).find((key) => typeof body[key] === 'number');
  if (!named) return build(entry.maxOutputTokens);
  const cap = body[named] as number;
  const probe: Record<string, unknown> = new ChatOpenAI({ model: entry.model, apiKey, maxTokens: cap }).invocationParams();
  const written = probe.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens';
  return written === named ? build(cap) : build();
}

function responseMetadata(message: BaseMessage): Record<string, unknown> {
  return message.response_metadata as Record<string, unknown>;
}

function isOwnTurn(message: BaseMessage, entry: OpenAiModelEntry): boolean {
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
  entry: OpenAiModelEntry,
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

/** Whether a chunk's metadata ends the generation on the provider's content filter (Chat Completions `finish_reason`, Responses `incomplete_details.reason`). */
function isContentFilter(metadata: Record<string, unknown> | undefined): boolean {
  const incomplete = metadata?.incomplete_details;
  return metadata?.finish_reason === 'content_filter'
    || (typeof incomplete === 'object' && incomplete !== null && (incomplete as { reason?: unknown }).reason === 'content_filter');
}

type WireToolChoice = NonNullable<Parameters<ChatOpenAI['bindTools']>[1]>['tool_choice'];

/**
 * The choice as the entry's API takes it. The Responses client drops a string choice, so a required
 * call over several tools goes as the API's `allowed_tools` object; Chat Completions takes `'any'`.
 */
function wireToolChoice(entry: OpenAiModelEntry, choice: string | undefined, tools: readonly ChatTool[]): WireToolChoice {
  if (choice !== 'any' || entry.apiType !== 'responses') return choice;
  return {
    type: 'allowed_tools',
    allowed_tools: { mode: 'required', tools: tools.map((tool) => ({ type: 'function', name: tool.function.name })) },
  } as unknown as WireToolChoice;
}

/**
 * `entry` as a provider chat: `ChatOpenAI` as is, with the entry's request mapping. `effort`
 * overrides the entry's own `reasoningEffort` for its requests.
 */
function createOpenAiChat(entry: OpenAiModelEntry, apiKey: string, effort = entry.reasoningEffort): ProviderChat {
  const chat = createChatModel(entry, apiKey, effort);
  return {
    id: `provider:${entry.id}`,
    identity: { id: entry.id, name: entry.name, vendor: 'openai-compatible', family: entry.model, version: entry.apiType },
    request(messages, tools, toolChoice) {
      const forced = toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'none';
      const sentChoice = forced && !entry.forcedToolChoice ? 'auto' : wireToolChoice(entry, toolChoice, tools);
      const request = projectMessages(messages, entry);
      return {
        model: tools.length > 0 ? chat.bindTools([...tools], { tool_choice: sentChoice }) : chat,
        messages: request.messages,
        options: request.previousResponseId ? { previous_response_id: request.previousResponseId } : undefined,
      };
    },
    check(chunk) {
      // A choice that finished with `error` is the provider's failure, whatever it streamed before.
      if (chunk.response_metadata?.finish_reason === 'error') {
        throw new ModelPortError('provider_error', 'Provider ended the generation with finish_reason error.');
      }
      // A vendor safety refusal ends the turn: resending the flagged text only repeats it.
      if (isContentFilter(chunk.response_metadata)) throw new ModelPortError('blocked', 'Model declined to respond.');
    },
  };
}

/** The model port over one entry: the connection a turn runs on once the user picked the entry. */
export function createProviderModelPort(
  entry: OpenAiModelEntry,
  apiKey: string,
  options: ProviderModelPortOptions & { readonly effort?: string } = {},
): ProviderModelPort {
  const { effort, ...portOptions } = options;
  return new ProviderModelPort(createOpenAiChat(entry, apiKey, effort), portOptions);
}
