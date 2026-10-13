/**
 * Request-scoped bridge from the VS Code Chat model selected by the user to LangChain.
 *
 * Adapted from the MIT-licensed `jitrodriguez/vscode-chat-langchain-bridge` project.
 * Source derivation: commit 1dda72d, copyright Juan Rodriguez, MIT License.
 * The local implementation intentionally keeps a narrower boundary: it translates messages,
 * tool definitions, stream parts, cancellation, and errors only. Tool execution, lifecycle,
 * semantic repair, authorization, and UI rendering remain outside the bridge.
 */
import * as vscode from 'vscode';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import {
  isHostCancellationError,
  messageProviderParts,
  ModelPortError,
  PROVIDER_PARTS_KEY,
  type ModelPortErrorCode,
} from './modelPort';
import { systemPromptHash, type WireEvent, type WirePart } from '../observability/wireLog';
import { toWireMessage, toWirePart } from '../observability/vscodeWireLog';
import { sanitizeProviderError } from '../support/text';
import { STRUCTURED_OUTPUT_TOOL_DESCRIPTION } from '../providers/structuredOutput';

/** Canonical tool metadata accepted by the bridge. The bridge never invokes the tool. */
export interface VscodeBridgeToolDefinition {
  /** Tool name the model addresses the call by. */
  readonly name: string;
  /** Natural-language tool description shown to the model. */
  readonly description: string;
  /** JSON Schema object describing the tool's input. */
  readonly inputSchema: Record<string, unknown>;
}

/** LangChain call options projected onto one VS Code Language Model request. */
export interface VscodeLangChainCallOptions extends BaseChatModelCallOptions {
  /** Tool definitions bound onto this request and passed to `vscode.lm.sendRequest`. */
  readonly tools?: readonly VscodeBridgeToolDefinition[];
  /** `'auto'`, `'any'` (a tool call is required), `'none'`, or the name of the one tool the model must call. */
  readonly tool_choice?: string;
}

/** A tool-bound bridge runnable, streamable for its raw `AIMessageChunk`s. */
export type VscodeBridgeRunnable = Runnable<BaseLanguageModelInput, AIMessageChunk, VscodeLangChainCallOptions>;

/** Constructor fields for one request-selected VS Code language model. */
export interface VscodeLangChainBridgeFields {
  /** The exact `vscode.LanguageModelChat` selected for this request. */
  readonly model: vscode.LanguageModelChat;
  /** Cancellation token for the request; firing it surfaces as a port-level cancellation. */
  readonly token: vscode.CancellationToken;
  /**
   * Debug wire capture, present only when session trace logging is enabled.
   *
   * @remarks
   * Absent by default so nothing is allocated on the normal path. The callback must never throw:
   * a capture failure is not allowed to fail the user's turn.
   */
  readonly wire?: (event: WireEvent) => void;
}

/**
 * LangChain `BaseChatModel` backed by exactly one VS Code `request.model`.
 *
 * The instance is request-scoped and has no model-selection or provider-fallback behavior.
 */
export class VscodeLangChainBridge extends BaseChatModel<
  VscodeLangChainCallOptions
> {
  private readonly model: vscode.LanguageModelChat;
  private readonly token: vscode.CancellationToken;
  private readonly wire?: (event: WireEvent) => void;

  constructor(fields: VscodeLangChainBridgeFields) {
    super({});
    this.model = fields.model;
    this.token = fields.token;
    this.wire = fields.wire;
  }

  /** LangChain serialization name for this bridge class. */
  static lc_name(): string {
    return 'VscodeLangChainBridge';
  }

  /** LangChain model-type discriminator for VS Code request-selected models. */
  _llmType(): string {
    return 'vscode-request-model';
  }

  /**
   * Binds model-facing tool metadata. Execution remains graph/dispatcher-owned.
   */
  bindTools(
    tools: VscodeBridgeToolDefinition[],
    kwargs: Partial<VscodeLangChainCallOptions> = {},
  ): VscodeBridgeRunnable {
    return this.withConfig({ tools, ...kwargs });
  }

  /** Binds one tool, described by its model-facing JSON Schema, forced via `tool_choice`, guaranteeing that exact call. */
  bindStructuredOutputTool(inputSchema: Record<string, unknown>, functionName: string): VscodeBridgeRunnable {
    return this.bindTools(
      [{ name: functionName, description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION, inputSchema }],
      { tool_choice: functionName },
    );
  }

  /** True once either the bridge's own cancellation token or the LangChain call's abort signal fires. */
  private isCancelled(options: this['ParsedCallOptions']): boolean {
    return this.token.isCancellationRequested || Boolean(options.signal?.aborted);
  }

  /** Folds the streaming bridge output into LangChain's non-streaming result shape. */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let combined: ChatGenerationChunk | undefined;
    for await (const generation of this._streamResponseChunks(messages, options, runManager)) {
      combined = combined ? combined.concat(generation) : generation;
    }
    return {
      generations: [{
        text: combined?.text ?? '',
        message: combined?.message ?? new AIMessageChunk({ content: '' }),
      }],
    };
  }

  /** Projects one LangChain request onto `vscode.lm.sendRequest` and yields normalized chunks. */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (this.isCancelled(options)) {
      throw cancelledError();
    }
    const definitions = [...(options.tools ?? [])];
    const { tools, toolMode } = projectToolChoice(definitions, options.tool_choice);
    let iterator: AsyncIterator<unknown> | undefined;
    let reachedEof = false;
    const capture = this.wire
      ? {
          text: '',
          calls: [] as Array<{ callId: string; name: string; input: unknown }>,
          otherParts: [] as WirePart[],
        }
      : undefined;
    const providerParts: unknown[] = [];
    try {
      const nativeMessages = messages.map(toVscodeMessage);
      this.wire?.({
        type: 'wire-request',
        messages: nativeMessages.map(toWireMessage),
        tools: tools.map((tool) => ({
          name: tool.name,
          descriptionHash: systemPromptHash(tool.description),
          inputSchema: tool.inputSchema,
        })),
        toolMode: tools.length > 0 ? toolMode : undefined,
      });
      const response = await this.model.sendRequest(
        nativeMessages,
        tools.length > 0 ? { tools, toolMode } : {},
        this.token,
      );
      if (this.isCancelled(options)) {
        throw cancelledError();
      }
      iterator = response.stream[Symbol.asyncIterator]();
      let toolIndex = 0;
      for (;;) {
        const next = await iterator.next();
        if (this.isCancelled(options)) {
          throw cancelledError();
        }
        if (next.done) {
          reachedEof = true;
          if (capture) {
            this.wire?.({
              type: 'wire-response',
              text: capture.text,
              toolCalls: capture.calls,
              ...(capture.otherParts.length > 0 ? { otherParts: capture.otherParts } : {}),
            });
          }
          if (this.isCancelled(options)) {
            throw cancelledError();
          }
          if (providerParts.length > 0) {
            const message = new AIMessageChunk({
              content: '',
              additional_kwargs: { [PROVIDER_PARTS_KEY]: providerParts },
            });
            yield new ChatGenerationChunk({ text: '', message });
          }
          break;
        }
        const part = next.value;
        if (part instanceof vscode.LanguageModelTextPart) {
          if (capture) capture.text += part.value;
          const message = new AIMessageChunk({ content: part.value });
          const chunk = new ChatGenerationChunk({ text: part.value, message });
          await runManager?.handleLLMNewToken(part.value, undefined, undefined, undefined, undefined, { chunk });
          yield chunk;
          continue;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          capture?.calls.push({ callId: part.callId, name: part.name, input: part.input });
          // The input goes to LangChain as its JSON text: a value that is not a JSON object lands in
          // `invalid_tool_calls` with its id and name, so the port can charge that one call.
          const message = new AIMessageChunk({
            content: '',
            tool_call_chunks: [{
              id: part.callId,
              name: part.name,
              args: JSON.stringify(part.input) ?? '',
              index: toolIndex++,
              type: 'tool_call_chunk',
            }],
          });
          yield new ChatGenerationChunk({ text: '', message });
          continue;
        }
        providerParts.push(part);
        capture?.otherParts.push(toWirePart(part));
        const nonTextChars = streamedValueChars(part);
        if (nonTextChars > 0) {
          const message = new AIMessageChunk({ content: '', response_metadata: { nonTextChars } });
          yield new ChatGenerationChunk({ text: '', message });
        }
      }
      if (this.isCancelled(options)) {
        throw cancelledError();
      }
    } catch (error) {
      throw normalizeBridgeError(error, this.token, options.signal);
    } finally {
      if (iterator?.return && !reachedEof) {
        try {
          await iterator.return();
        } catch {
        }
      }
    }
  }
}

/**
 * Converts one LangChain message without adding history or helper prose.
 *
 * @remarks
 * An assistant message replays the provider stream parts it carries ({@link PROVIDER_PARTS_KEY})
 * as the original objects, ahead of its text and tool calls, in the order the provider streamed
 * them: the model's own turn goes back verbatim, never rebuilt from the fields this bridge reads.
 *
 * A `ToolMessage`'s `status` is not projected: `vscode.LanguageModelToolResultPart` has no error
 * flag, and the bridge adds no prose. A failed call reaches the model through its content alone,
 * which for every rejection or dispatch error is the shared error envelope naming its code.
 */
export function toVscodeMessage(message: BaseMessage): vscode.LanguageModelChatMessage {
  if (SystemMessage.isInstance(message) || HumanMessage.isInstance(message)) {
    return vscode.LanguageModelChatMessage.User(toTextParts(message.content), message.name);
  }
  if (AIMessage.isInstance(message)) {
    const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [
      ...messageProviderParts(message) as ReadonlyArray<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
      ...toTextParts(message.content),
      ...(message.tool_calls ?? []).map((call) => {
        if (!call.id) {
          throw new ModelPortError(
            'invalid_request',
            'Assistant tool call requires a non-empty call ID.',
          );
        }
        return new vscode.LanguageModelToolCallPart(
          call.id,
          call.name,
          asRecord(call.args),
        );
      }),
    ];
    return vscode.LanguageModelChatMessage.Assistant(parts, message.name);
  }
  if (ToolMessage.isInstance(message)) {
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(
        message.tool_call_id,
        toTextParts(message.content),
      ),
    ], message.name);
  }
  throw new ModelPortError(
    'invalid_request',
    `Unsupported LangChain message type: ${message.getType()}.`,
  );
}

/** Character size of a stream part's string or string-array `value`; 0 for any other shape. */
function streamedValueChars(part: unknown): number {
  const value = part && typeof part === 'object' ? (part as { value?: unknown }).value : undefined;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + (typeof item === 'string' ? item.length : 0), 0);
  }
  return 0;
}

function toTextParts(content: MessageContent): vscode.LanguageModelTextPart[] {
  if (typeof content === 'string') {
    return content ? [new vscode.LanguageModelTextPart(content)] : [];
  }
  const parts: vscode.LanguageModelTextPart[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(new vscode.LanguageModelTextPart(part));
      continue;
    }
    if (part && typeof part === 'object' && part.type === 'text' && 'text' in part
      && typeof part.text === 'string') {
      parts.push(new vscode.LanguageModelTextPart(part.text));
      continue;
    }
    throw new ModelPortError(
      'invalid_request',
      'VS Code bridge supports text message content only.',
    );
  }
  return parts;
}

function projectToolChoice(
  definitions: readonly VscodeBridgeToolDefinition[],
  choice: string | undefined,
): {
  tools: vscode.LanguageModelChatTool[];
  toolMode: vscode.LanguageModelChatToolMode;
} {
  if (choice === 'none') {
    return { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto };
  }
  const named = choice !== undefined && choice !== 'auto' && choice !== 'any' ? choice : undefined;
  const selected = named ? definitions.filter((definition) => definition.name === named) : definitions;
  if (named && selected.length !== 1) {
    throw new ModelPortError('invalid_request', `Required tool is not available: ${named}.`);
  }
  if ((choice === 'any' || named) && selected.length === 0) {
    throw new ModelPortError('invalid_request', 'Required tool mode requires at least one tool.');
  }
  return {
    tools: selected.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
    toolMode: choice === 'any' || named
      ? vscode.LanguageModelChatToolMode.Required
      : vscode.LanguageModelChatToolMode.Auto,
  };
}

function normalizeBridgeError(
  error: unknown,
  token: vscode.CancellationToken,
  signal?: AbortSignal,
): ModelPortError {
  if (error instanceof ModelPortError) return error;
  if (token.isCancellationRequested || signal?.aborted || isHostCancellationError(error)) {
    return cancelledError();
  }
  const rawCode = isRecord(error) && 'code' in error ? String(error.code) : '';
  const mapped: Record<string, ModelPortErrorCode> = {
    NoPermissions: 'no_permission',
    Blocked: 'blocked',
    NotFound: 'model_not_found',
  };
  const code = mapped[rawCode] ?? 'provider_error';
  return new ModelPortError(code, providerFailureMessage(error, code), error);
}

/** Redacted, length-capped provider message, falling back to the neutral code line when empty. */
function providerFailureMessage(error: unknown, code: ModelPortErrorCode): string {
  return sanitizeProviderError(rawErrorText(error))
    || `Language model request failed (${code}).`;
}

function rawErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return typeof error.message === 'string' ? error.message : '';
  return error === null || error === undefined ? '' : String(error);
}

function cancelledError(): ModelPortError {
  return new ModelPortError('cancelled', 'Language model request was cancelled.');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ModelPortError(
      'unsupported_response',
      'Language model returned non-object tool input.',
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
