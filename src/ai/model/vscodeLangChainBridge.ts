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
  type BindToolsInput,
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
  type ToolCall,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { ModelPortError, type ModelPortErrorCode } from './modelPort';
import type { WireEvent } from '../observability/wireLog';
import { toWireMessage } from '../observability/vscodeWireLog';
import { sanitizeProviderError } from '../support/text';

/** Canonical tool metadata accepted by the bridge. The bridge never invokes the tool. */
export interface VscodeBridgeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** LangChain call options projected onto one VS Code Language Model request. */
export interface VscodeLangChainCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly VscodeBridgeToolDefinition[];
}

/** Constructor fields for one request-selected VS Code language model. */
export interface VscodeLangChainBridgeFields {
  readonly model: vscode.LanguageModelChat;
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
    tools: BindToolsInput[],
    kwargs: Partial<VscodeLangChainCallOptions> = {},
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, VscodeLangChainCallOptions> {
    const definitions = tools.map(toBridgeToolDefinition);
    return this.withConfig({ tools: definitions, ...kwargs });
  }

  /** True once either the bridge's own cancellation token or the LangChain call's abort signal fires. */
  private isCancelled(options: this['ParsedCallOptions']): boolean {
    return this.token.isCancellationRequested || Boolean(options.signal?.aborted);
  }

  /** Collects the streaming bridge output into LangChain's non-streaming result shape. */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for await (const generation of this._streamResponseChunks(messages, options, runManager)) {
      text += generation.text;
      const chunkCalls = AIMessageChunk.isInstance(generation.message)
        ? generation.message.tool_calls ?? []
        : [];
      for (const call of chunkCalls) {
        toolCalls.push(call);
      }
    }
    return {
      generations: [{
        text,
        message: new AIMessage({ content: text, tool_calls: toolCalls }),
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
    // `this.token` is already the caller's cancellation: VscodeModelPort binds the request
    // AbortSignal to one CancellationTokenSource (`bindCancellation`) and hands its token to this
    // bridge. Deriving a second source here would only duplicate that chain.
    let iterator: AsyncIterator<unknown> | undefined;
    let reachedEof = false;
    // Only allocated when the wire log is on, so the normal path pays one truthiness check.
    const capture = this.wire
      ? { text: '', calls: [] as Array<{ callId: string; name: string; input: unknown }> }
      : undefined;
    try {
      const nativeMessages = messages.map(toVscodeMessage);
      // Emitted before the request, so a request that never returns still leaves its own evidence.
      this.wire?.({
        type: 'wire-request',
        messages: nativeMessages.map(toWireMessage),
        tools: tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
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
            });
          }
          if (this.isCancelled(options)) {
            throw cancelledError();
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
          const message = new AIMessageChunk({
            content: '',
            tool_call_chunks: [{
              id: part.callId,
              name: part.name,
              args: JSON.stringify(asRecord(part.input)),
              index: toolIndex++,
              type: 'tool_call_chunk',
            }],
          });
          yield new ChatGenerationChunk({ text: '', message });
          continue;
        }
        // `LanguageModelChatResponse.stream` is typed `… | unknown` as the API's forward-compat
        // placeholder, so a part kind added by a newer VS Code must never end the user's turn.
        // Ignore it silently: providers may emit many metadata parts, and logging each one floods
        // the Output channel without adding actionable diagnostics.
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
          // Preserve the primary provider/cancellation outcome.
        }
      }
    }
  }
}

/** Converts one LangChain message without adding history or helper prose. */
export function toVscodeMessage(message: BaseMessage): vscode.LanguageModelChatMessage {
  // Platform constraint, not a simplification: `LanguageModelChatMessageRole` exposes only User and
  // Assistant — VS Code has no System role — so a SystemMessage can only be projected onto `.User()`
  // alongside genuine human turns. System instructions therefore reach the model as leading user
  // content; nothing downstream can distinguish them again.
  if (SystemMessage.isInstance(message) || HumanMessage.isInstance(message)) {
    return vscode.LanguageModelChatMessage.User(toTextParts(message.content), message.name);
  }
  if (AIMessage.isInstance(message)) {
    const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [
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

function toBridgeToolDefinition(tool: BindToolsInput): VscodeBridgeToolDefinition {
  const candidate = tool as Record<string, unknown>;
  const name = typeof candidate.name === 'string'
    ? candidate.name
    : readOpenAiFunctionField(candidate, 'name');
  const description = typeof candidate.description === 'string'
    ? candidate.description
    : readOpenAiFunctionField(candidate, 'description');
  const inputSchema = readInputSchema(candidate);
  if (!name || !description || !inputSchema) {
    throw new ModelPortError(
      'invalid_request',
      'LangChain tool requires name, description, and an input schema.',
    );
  }
  // Shared, never mutated downstream: `readInputSchema` may hand back the same memoized
  // `toModelJsonSchema` object across many calls (see jsonSchema.ts's WeakMap cache), and neither
  // this bridge nor `vscode.lm.sendRequest` writes into it, so no defensive clone is needed here.
  return { name, description, inputSchema };
}

function readInputSchema(tool: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(tool.inputSchema)) return tool.inputSchema;
  if (isRecord(tool.function) && isRecord(tool.function.parameters)) return tool.function.parameters;
  if (!('schema' in tool) || !tool.schema) return null;
  const schema = toJsonSchema(tool.schema as Parameters<typeof toJsonSchema>[0]);
  return isRecord(schema) ? schema : null;
}

function readOpenAiFunctionField(
  tool: Record<string, unknown>,
  field: 'name' | 'description',
): string {
  return isRecord(tool.function) && typeof tool.function[field] === 'string'
    ? tool.function[field]
    : '';
}

function projectToolChoice(
  definitions: readonly VscodeBridgeToolDefinition[],
  choice: VscodeLangChainCallOptions['tool_choice'],
): {
  tools: vscode.LanguageModelChatTool[];
  toolMode: vscode.LanguageModelChatToolMode;
} {
  if (choice === 'none') {
    return { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto };
  }
  const named = typeof choice === 'string' && !['auto', 'any'].includes(choice)
    ? choice
    : readNamedToolChoice(choice);
  if (isRecord(choice) && !named) {
    throw new ModelPortError(
      'invalid_request',
      'Unsupported LangChain tool choice object.',
    );
  }
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
      // Same shared-and-immutable reasoning as `toBridgeToolDefinition` — no clone needed.
      inputSchema: definition.inputSchema,
    })),
    // VS Code Required means one of the supplied tools. Providers that only support one tool must
    // reject explicitly; silently weakening LangChain `any` to Auto changes graph semantics.
    toolMode: choice === 'any' || named
      ? vscode.LanguageModelChatToolMode.Required
      : vscode.LanguageModelChatToolMode.Auto,
  };
}

function readNamedToolChoice(choice: unknown): string | undefined {
  if (!isRecord(choice)) return undefined;
  if (typeof choice.name === 'string') return choice.name;
  if (isRecord(choice.function) && typeof choice.function.name === 'string') {
    return choice.function.name;
  }
  return undefined;
}

function normalizeBridgeError(
  error: unknown,
  token: vscode.CancellationToken,
  signal?: AbortSignal,
): ModelPortError {
  if (error instanceof ModelPortError) return error;
  if (token.isCancellationRequested || signal?.aborted
    || (error instanceof Error && ['AbortError', 'Canceled', 'Cancelled'].includes(error.name))) {
    return cancelledError();
  }
  const rawCode = isRecord(error) && 'code' in error ? String(error.code) : '';
  const mapped: Record<string, ModelPortErrorCode> = {
    NoPermissions: 'no_permission',
    Blocked: 'blocked',
    NotFound: 'model_not_found',
  };
  const code = mapped[rawCode] ?? 'provider_error';
  // The provider's own message is retained — redacted and length-capped by `sanitizeProviderError`
  // — and the original exception is kept as `cause`. Flattening both away makes every non-verdict
  // failure indistinguishable because `sanitizeProviderErrorDiagnostic` cannot preserve a nested
  // connection-level code for the user-facing transport classification. Sanitizing here keeps that
  // distinction without ever putting an unredacted provider body into a message.
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
