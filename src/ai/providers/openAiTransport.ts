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
import { isRecord } from '../../utils/isRecord';

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
 * The client for one entry. Its retry is the OpenAI SDK's own (`configuration.maxRetries`, the SDK
 * default of 2): connection errors, timeouts and 408/409/429/5xx, with backoff, `retry-after`, and
 * the turn's signal ending a pending wait. `maxRetries: 0` turns off LangChain's second layer,
 * which would also retry other 4xx. `organization` and `project` are `null` so ambient OpenAI env
 * vars never attach headers to another endpoint unless named in `requestHeaders`. The output cap is
 * the entry's `maxOutputTokens` alone: the client writes the cap key (`max_tokens`, or
 * `max_completion_tokens` for a reasoning model name, `max_output_tokens` on Responses) after
 * `requestBody`, which therefore names no cap.
 */
function createChatModel(entry: OpenAiModelEntry, apiKey: string, effort: string | undefined, requestBody: Record<string, unknown>): ChatOpenAI {
  return new ChatOpenAI({
    model: entry.model,
    apiKey,
    configuration: {
      baseURL: entry.url,
      maxRetries: 2,
      organization: null,
      project: null,
      ...(entry.requestHeaders ? { defaultHeaders: entry.requestHeaders } : {}),
    },
    useResponsesApi: entry.apiType === 'responses',
    streaming: true,
    maxRetries: 0,
    // The Responses wire carries the output cap. Off (default) sends non-strict tools; `strictTools`
    // leaves per-tool `strict` flags in place so a projected schema can be marked strict.
    ...(entry.apiType === 'responses' && !entry.strictTools ? { supportsStrictToolCalling: false } : {}),
    maxTokens: entry.maxOutputTokens,
    modelKwargs: { ...entryBody(entry, effort), ...requestBody },
  });
}

type Verbosity = 'low' | 'medium' | 'high';

const isVerbosity = (value: unknown): value is Verbosity => value === 'low' || value === 'medium' || value === 'high';

/**
 * The entry's `requestBody` split into the verbosity, which goes to the client as its `verbosity`
 * call option, and the rest, which is the client's `modelKwargs`. The client writes `text`
 * (Responses) after `modelKwargs`, so a `text` there would replace the `text.format` of a
 * structured request. On Responses only a `text` that holds nothing but its verbosity moves; any
 * other `text` stays in the body.
 */
function splitRequestBody(entry: OpenAiModelEntry): { readonly verbosity?: Verbosity; readonly body: Record<string, unknown> } {
  const body = entry.requestBody ?? {};
  const without = (key: string) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
  if (entry.apiType === 'responses') {
    const { text } = body;
    return isRecord(text) && Object.keys(text).length === 1 && isVerbosity(text.verbosity) ? { verbosity: text.verbosity, body: without('text') } : { body };
  }
  return isVerbosity(body.verbosity) ? { verbosity: body.verbosity, body: without('verbosity') } : { body };
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
 * The choice as the entry's API takes it. The Responses client drops a string choice, so a
 * required call over several tools goes as the API's flat `allowed_tools` object (`mode`, `tools`
 * beside `type`); Chat Completions takes `'any'`.
 */
function wireToolChoice(entry: OpenAiModelEntry, choice: string | undefined, tools: readonly ChatTool[]): WireToolChoice {
  if (choice !== 'any' || entry.apiType !== 'responses') return choice;
  return {
    type: 'allowed_tools',
    mode: 'required',
    tools: tools.map((tool) => ({ type: 'function', name: tool.function.name })),
  } as unknown as WireToolChoice;
}

/**
 * `entry` as a provider chat: `ChatOpenAI` as is, with the entry's request mapping. `effort`
 * overrides the entry's own `reasoningEffort` for its requests.
 * @internal test seam: tests pass call options such as `response_format` to the chat it returns.
 */
export function createOpenAiChat(entry: OpenAiModelEntry, apiKey: string, effort = entry.reasoningEffort): ProviderChat {
  const { verbosity, body } = splitRequestBody(entry);
  const chat = createChatModel(entry, apiKey, effort, body);
  return {
    id: `provider:${entry.id}`,
    identity: { id: entry.id, name: entry.name, vendor: 'openai-compatible', family: entry.model, version: entry.apiType },
    request(messages, tools, toolChoice) {
      const forced = toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'none';
      const sentChoice = forced && !entry.forcedToolChoice ? 'auto' : wireToolChoice(entry, toolChoice, tools);
      const request = projectMessages(messages, entry);
      // Responses copies `strict` from the tool's top-level key (`fields.strict ?? null` otherwise).
      const bound = entry.apiType === 'responses'
        ? tools.map((tool) => (tool.function.strict === undefined ? tool : { ...tool, strict: tool.function.strict }))
        : tools;
      return {
        model: bound.length > 0 ? chat.bindTools([...bound], { tool_choice: sentChoice }) : chat,
        messages: request.messages,
        options: {
          ...(verbosity ? { verbosity } : {}),
          ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        },
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
  return new ProviderModelPort(createOpenAiChat(entry, apiKey, effort), { ...portOptions, strictTools: entry.strictTools });
}
