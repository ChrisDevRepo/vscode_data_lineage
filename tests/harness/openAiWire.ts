/**
 * The OpenAI-compatible wire shapes: LangChain history in, `/chat/completions` messages out.
 *
 * @remarks
 * Split from the port for the same reason `vscodeWireLog.ts` is split from `wireLog.ts` — the
 * projection is pure, so it is testable without a transport and readable without a provider. Three
 * things here are deliberate lane *differences*, not accidents of implementation:
 *
 * - **A real `{role:'system'}` message.** The `vscode.lm` lane has no system role and folds system
 *   instructions onto the leading user turn (`toVscodeMessage`); this protocol has one, and using it
 *   is a fidelity improvement that closes the system-prompt blind spot. It also means the two lanes
 *   do not send byte-identical requests, which `docs/E2E_TESTING.md` records as a known difference.
 * - **`reasoning_content` echo.** Supplied by the port through the `reasoningFor` lookup, never read
 *   from LangChain history: the field is provider-specific and must not pollute the provider-neutral
 *   graph history, but DeepSeek answers `500` when a prior assistant turn comes back without it.
 * - **`toWireMessages` records the wire string role verbatim** (`'system'`/`'user'`/…), where the
 *   VS Code lane records the `LanguageModelChatMessageRole` integer. `WireMessage.role` is
 *   `number | string` precisely so a trace never claims a role its provider never saw.
 */
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
}

/** One message exactly as it sits in the `/chat/completions` request body. */
export interface OpenAiChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
  readonly tool_call_id?: string;
  /** Provider-specific reasoning echo; present only on lanes whose capability flag asks for it. */
  readonly reasoning_content?: string;
}

/** Looks up the reasoning text a previous generation produced for one assistant turn. */
export type ReasoningLookup = (
  callIds: readonly string[],
  text: string,
) => string | undefined;

/**
 * Projects the system instruction plus LangChain history onto `/chat/completions` messages.
 *
 * @param system - Verbatim system instruction, or `undefined` when the caller sent none.
 * @param history - The graph's provider-neutral message history, oldest first.
 * @param reasoningFor - Port-owned reasoning echo lookup; omitted when the lane does not echo.
 * @returns The request's `messages` array, in order.
 * @throws {@link ModelPortError} for a message type or content shape this protocol cannot carry.
 */
export function projectMessages(
  system: string | undefined,
  history: readonly BaseMessage[],
  reasoningFor?: ReasoningLookup,
): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const message of history) {
    messages.push(projectMessage(message, reasoningFor));
  }
  return messages;
}

function projectMessage(
  message: BaseMessage,
  reasoningFor?: ReasoningLookup,
): OpenAiChatMessage {
  if (SystemMessage.isInstance(message)) {
    return { role: 'system', content: messageText(message.content) };
  }
  if (HumanMessage.isInstance(message)) {
    return { role: 'user', content: messageText(message.content) };
  }
  if (AIMessage.isInstance(message)) {
    const text = messageText(message.content);
    const calls = (message.tool_calls ?? []).map((call) => {
      if (!call.id) {
        throw new ModelPortError(
          'invalid_request',
          'Assistant tool call requires a non-empty call ID.',
        );
      }
      return {
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      };
    });
    const reasoning = reasoningFor?.(calls.map((call) => call.id), text);
    return {
      role: 'assistant',
      // `null` rather than `''`: an assistant turn that only called tools has no content, and some
      // servers reject the empty string where they accept the explicit null.
      content: text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
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
 * `reasoning_content` is recorded as an `other` part rather than being dropped: it is bytes the
 * provider received, and the whole point of the capture is that the trace can answer what was sent.
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
    }
    if (message.reasoning_content) {
      parts.push({ type: 'other', json: JSON.stringify({ reasoning_content: message.reasoning_content }) });
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
 * schema); a status change on a guess would not be.
 */
export function suspectsToolCallAsText(text: string): boolean {
  if (!text) return false;
  if (TOOL_CALL_IN_TEXT_MARKERS.some((marker) => marker.test(text))) return true;
  return /"name"\s*:\s*"[A-Za-z0-9_.-]+"/.test(text)
    && /"(arguments|parameters)"\s*:/.test(text);
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
