/** Shared OpenAI-compatible message projection and response decoding. */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { ModelPortError } from '../../src/ai/model/modelPort';
import type { TokenUsage, WireMessage, WirePart } from '../../src/ai/observability/wireLog';

/** One assistant tool call in the `/chat/completions` request and response shape. */
export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
  /**
   * Provider-specific payload sitting beside the call, e.g. Gemini 3's `thought_signature` under
   * `google`. Opaque: never read, only carried from a response back onto the same call id
   * when that assistant turn is replayed. Present only on lanes that sent one.
   */
  readonly extra_content?: Record<string, unknown>;
}

/** One message exactly as it sits in the `/chat/completions` request body. */
export interface OpenAiChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
  readonly tool_call_id?: string;
  /** Provider-specific reasoning echo; present only on lanes whose capability flag asks for it. */
  readonly reasoning_content?: string;
  /** Opaque ordered provider reasoning blocks; echoed only by an explicitly enabled lane. */
  readonly reasoning_details?: readonly unknown[];
}

/** Looks up the reasoning text a previous generation produced for one assistant turn. */
export type ReasoningLookup = (
  callIds: readonly string[],
  text: string,
) => string | undefined;

/** Looks up the complete opaque reasoning block sequence for one assistant turn. */
export type ReasoningDetailsLookup = (callIds: readonly string[], text: string) => readonly unknown[] | undefined;

/**
 * Looks up the opaque `extra_content` a previous generation returned for one tool call.
 *
 * @remarks
 * Primarily keyed per call id: unlike reasoning, which belongs to the whole assistant message, a
 * signature belongs to the one function call it rode in on. A provider that signs only the first
 * call of a parallel tool-call response leaves its siblings with none of their own, so `callIds`
 * carries every call id that arrived together in the same assistant turn — the same shape
 * {@link ReasoningLookup} already uses — letting the port fall back to that turn's first signature
 * for a call that has none, without ever reaching a call from a different turn.
 */
export type ExtraContentLookup = (
  callId: string,
  callIds: readonly string[],
) => Record<string, unknown> | undefined;

/**
 * Projects the system instruction plus LangChain history onto `/chat/completions` messages.
 *
 * @param system - Verbatim system instruction, or `undefined` when the caller sent none.
 * @param history - The graph's provider-neutral message history, oldest first.
 * @param reasoningFor - Port-owned reasoning echo lookup; omitted when the lane does not echo.
 * @param extraContentFor - Port-owned per-call `extra_content` lookup; omitted when the
 * lane never received one, in which case every call simply carries none.
 * @param reasoningDetailsFor - Complete provider reasoning sequence lookup; omitted unless enabled.
 * @returns The request's `messages` array, in order.
 * @throws {@link ModelPortError} for a message type or content shape this protocol cannot carry.
 */
export function projectMessages(
  system: string | undefined,
  history: readonly BaseMessage[],
  reasoningFor?: ReasoningLookup,
  extraContentFor?: ExtraContentLookup,
  reasoningDetailsFor?: ReasoningDetailsLookup,
): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const message of history) {
    messages.push(projectMessage(message, reasoningFor, extraContentFor, reasoningDetailsFor));
  }
  return messages;
}

function projectMessage(
  message: BaseMessage,
  reasoningFor?: ReasoningLookup,
  extraContentFor?: ExtraContentLookup,
  reasoningDetailsFor?: ReasoningDetailsLookup,
): OpenAiChatMessage {
  if (SystemMessage.isInstance(message)) {
    return { role: 'system', content: messageText(message.content) };
  }
  if (HumanMessage.isInstance(message)) {
    return { role: 'user', content: messageText(message.content) };
  }
  if (AIMessage.isInstance(message)) {
    const text = messageText(message.content);
    const ids = (message.tool_calls ?? []).map((call) => {
      if (!call.id) {
        throw new ModelPortError(
          'invalid_request',
          'Assistant tool call requires a non-empty call ID.',
        );
      }
      return call.id;
    });
    const calls = (message.tool_calls ?? []).map((call, index) => {
      const extraContent = extraContentFor?.(ids[index], ids);
      return {
        id: ids[index],
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        ...(extraContent ? { extra_content: extraContent } : {}),
      };
    });
    const reasoning = reasoningFor?.(ids, text);
    const reasoningDetails = reasoningDetailsFor?.(ids, text);
    return {
      role: 'assistant',
      // Tool-only turns send `null`: some servers reject `''` there. An empty turn with no
      // tool_calls must send a string — Azure 400s `expected a string, got null` on
      // `messages[n].content` otherwise (m22-head T7, empty_generation retry).
      content: text || (calls.length > 0 ? null : ''),
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
    };
  }
  if (ToolMessage.isInstance(message)) {
    return {
      role: 'tool',
      content: messageText(message.content),
      tool_call_id: message.tool_call_id,
    };
  }
  throw new ModelPortError(
    'invalid_request',
    `Unsupported LangChain message type: ${message.getType()}.`,
  );
}

/** Flattens LangChain message content to text, refusing shapes this lane cannot send. */
function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (part && typeof part === 'object' && part.type === 'text' && 'text' in part
      && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    throw new ModelPortError(
      'invalid_request',
      'OpenAI-compatible lane supports text message content only.',
    );
  }
  return text;
}

/**
 * Captures the projected request messages for the wire trace, keeping the wire role verbatim.
 *
 * @remarks
 * `reasoning_content`, `reasoning_details` and a tool call's `extra_content` are recorded as `other` parts rather than
 * being dropped: both are bytes the provider received, and the whole point of the capture is that
 * the trace can answer what was sent. Neither fits `WirePart`'s `tool-call` variant (owned by
 * `src/`, shared with the `vscode.lm` lane), so both stay opaque JSON alongside it.
 */
export function toWireMessages(messages: readonly OpenAiChatMessage[]): WireMessage[] {
  return messages.map((message) => {
    const parts: WirePart[] = [];
    if (message.role === 'tool') {
      parts.push({
        type: 'tool-result',
        callId: message.tool_call_id ?? '',
        content: message.content ? [{ type: 'text', value: message.content }] : [],
      });
    } else if (message.content) {
      parts.push({ type: 'text', value: message.content });
    }
    for (const call of message.tool_calls ?? []) {
      parts.push({
        type: 'tool-call',
        callId: call.id,
        name: call.function.name,
        input: safeJson(call.function.arguments),
      });
      if (call.extra_content) {
        parts.push({
          type: 'other',
          json: JSON.stringify({ callId: call.id, extra_content: call.extra_content }),
        });
      }
    }
    if (message.reasoning_content) {
      parts.push({ type: 'other', json: JSON.stringify({ reasoning_content: message.reasoning_content }) });
    }
    if (message.reasoning_details) {
      parts.push({ type: 'other', json: JSON.stringify({ reasoning_details: message.reasoning_details }) });
    }
    return { role: message.role, parts };
  });
}

function safeJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    // The unparsable string IS the evidence on this lane — see the port's `invalid_tool_input`
    // divergence — so the capture keeps it rather than reporting an empty object.
    return serialized;
  }
}

/**
 * Markers of a model that described a tool call in prose instead of emitting one.
 *
 * @remarks
 * DeepSeek's chat template leaks its own tool-call control tokens into `content` when the server
 * did not parse them; other servers leak an XML-ish or bracketed form. These are the literal token
 * spellings, not a semantic judgement.
 */
const TOOL_CALL_IN_TEXT_MARKERS: readonly RegExp[] = [
  /<｜tool▁calls?▁begin｜>/,
  /<\|tool_calls?_begin\|>/,
  /<tool_call>/i,
  /\[TOOL_CALLS\]/,
  /<function_calls>/i,
];

/**
 * Whether a text-only generation looks like a tool call the server failed to parse.
 *
 * @remarks
 * A *suspicion*, never a status: DD-5 pins this as a flag in the run summary only. A completed text
 * generation stays completed, because the harness records what a provider does and does not invent
 * product behaviour for it. False positives are acceptable (a model may legitimately quote a tool
 * schema); a status change on a guess would not be. A quoted JSON object flags too, which the same
 * contract covers: the flag still changes no status.
 */
export function suspectsToolCallAsText(text: string): boolean {
  if (!text) return false;
  if (TOOL_CALL_IN_TEXT_MARKERS.some((marker) => marker.test(text))) return true;
  if (/"name"\s*:\s*"[A-Za-z0-9_.-]+"/.test(text) && /"(arguments|parameters)"\s*:/.test(text)) {
    return true;
  }
  // The `{name, arguments}` wrapper is one spelling among several, and flagged none of the 27
  // recorded occurrences: those are bare JSON records — fenced, unfenced, or Hermes/XML.
  return readProseToolCandidate(text) !== null;
}

/** A fenced ```json (or bare ```) code block wrapping exactly one JSON value. */
const FENCED_JSON_BLOCK = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/** One `<parameter=name>` pair of the Hermes/XML tool-call envelope; the closing tag is the bare `</parameter>`. */
const XML_TOOL_PARAMETER = /<parameter=([A-Za-z0-9_]+)>\n?([\s\S]*?)\n?<\/parameter>/g;

/**
 * Reads a text-only generation as the record a tool call would carry — fenced JSON, the whole body
 * as JSON, or the Hermes/XML `<parameter=…>` envelope — without judging it against any schema.
 *
 * @remarks
 * Harness diagnostics only: it feeds {@link suspectsToolCallAsText}. Zero `<parameter=…>` pairs is
 * not this envelope.
 */
export function readProseToolCandidate(text: string): Record<string, unknown> | null {
  const match = FENCED_JSON_BLOCK.exec(text);
  let candidate: unknown;
  try {
    candidate = JSON.parse(match ? match[1] : text.trim());
  } catch {
    const xmlParameters = [...text.matchAll(XML_TOOL_PARAMETER)];
    if (xmlParameters.length === 0) return null;
    candidate = Object.fromEntries(
      xmlParameters.map(([, name, raw]): [string, unknown] => {
        const value = raw.trim();
        try {
          return [name, JSON.parse(value) as unknown];
        } catch {
          return [name, value];
        }
      }),
    );
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

/**
 * Reads the provider's token accounting, keeping every field optional.
 *
 * @remarks
 * An absent field means "not reported", never zero, so a value is copied only when the provider
 * sent a finite number for it.
 */
export function readUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const mapped: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  } = {};
  const input = finite(usage.prompt_tokens);
  const output = finite(usage.completion_tokens);
  const total = finite(usage.total_tokens);
  const reasoning = finite(details?.reasoning_tokens);
  if (input !== undefined) mapped.inputTokens = input;
  if (output !== undefined) mapped.outputTokens = output;
  if (total !== undefined) mapped.totalTokens = total;
  if (reasoning !== undefined) mapped.reasoningTokens = reasoning;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
