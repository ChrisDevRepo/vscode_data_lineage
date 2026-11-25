import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, AIMessageChunk, SystemMessage, ToolMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import {
  type CompleteTextInput,
  type GeneratedToolCall,
  type GenerateStructuredInput,
  type ModelPort,
  type ModelIdentity,
  ModelPortError,
  type ModelToolChoice,
  type ToolGenerationContent,
  type ToolGenerationInput,
  type ToolGenerationResult,
  cancelledError,
  cancelledToolTurnResult,
  errorToolTurnResult,
  isPortCancellation,
  messageContentToText,
  messageProviderParts,
  type ModelPortErrorCode,
} from './modelPort';
import {
  systemPromptHash,
  type TokenUsage,
  type WireEvent,
  type WireMessage,
  type WirePart,
  type WireRecord,
} from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderError,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { countTokens } from '../support/tokenCount';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../support/tokenBudget';
import { coerceStringifiedArguments, parseJson } from '../support/inputNormalization';
import { toolCallNotationFault } from '../support/toolCallNotation';
import { isRecord } from '../../utils/isRecord';
import { sanitizeForLog, trunc } from '../../utils/log';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  StructuredOutputError,
  structuredRejectReason,
} from '../providers/structuredOutput';

/** One tool offered on a generation, in the OpenAI function form every chat model takes. */
export interface ChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema object of the tool input ({@link toModelJsonSchema}). */
    readonly parameters: Record<string, unknown>;
  };
}

/** One generation as its provider takes it. */
interface ProviderRequest {
  /** The chat model, tools bound. */
  readonly model: {
    stream(messages: BaseMessage[], options?: Record<string, unknown>): Promise<AsyncIterable<AIMessageChunk>>;
  };
  /** The conversation as the provider sends it, system instruction first. */
  readonly messages: BaseMessage[];
  /** Call options of this generation beyond the port's own (`signal`, `callbacks`). */
  readonly options?: Record<string, unknown>;
}

/**
 * The model behind a port: a LangChain chat model and the one place that maps a generation to its
 * provider's request. The model owns the wire and its stream; the port owns error mapping, wire
 * capture and the usage budget.
 */
export interface ProviderChat {
  /** Port identifier derived from the model. */
  readonly id: string;
  readonly identity: ModelIdentity;
  /**
   * Maps a generation to the provider's request: the messages it takes and the model with `tools`
   * bound. `toolChoice` is `'auto'`, `'any'` (a tool call is required), `'none'` or the one tool the
   * model must call; absent when the request binds no tools.
   */
  request(messages: readonly BaseMessage[], tools: readonly ChatTool[], toolChoice: string | undefined): ProviderRequest;
  /** Throws the {@link ModelPortError} of a chunk that ends the generation as the provider's failure. */
  check?(chunk: AIMessageChunk): void;
}

/** Marks a message with the entry that produced it; a later request replays only provider state it owns. */
export const ENTRY_KEY = 'entryId';

/** What a port reports to: logs, wire capture and the turn's token budget. */
export interface ProviderModelPortOptions {
  readonly debugLog?: (message: string) => void;
  /** Native request identifier shared by wire and runtime lifecycle records. */
  readonly requestId?: string;
  /**
   * Debug wire sink, supplied only when session trace logging is enabled. Unlike
   * {@link debugLog} it carries model content (prompts, tool payloads, SQL), so it never
   * reaches the output channel and is absent unless the user opted in.
   */
  readonly wireLog?: (record: WireRecord) => void;
  /**
   * Whether the active trace captures the verbatim system instruction as its own field. Off by
   * default, so the `wire-request` `system` field carries the prompt's hash only. This does
   * **not** make the trace prompt-free: a provider may carry the system instruction inside
   * the message array, which is recorded with `messages[]` either way, deliberately, since the
   * message array makes a bad turn reconstructable from the trace alone. The privacy control
   * is the opt-in plus the owner-only file mode, not partial redaction.
   */
  readonly traceVerbose?: boolean;
  /**
   * Token budget the owning turn resolved from this model's window and the workspace settings.
   * Absent only where a caller builds a port outside a turn, which leaves the shipped defaults
   * and ceilings in force.
   */
  readonly budget?: TurnTokenBudget;
}

/**
 * Request-scoped model port over one {@link ProviderChat}. LangChain `BaseMessage` instances are
 * the only history representation; the port performs no model selection, fallback, tool execution
 * or lifecycle routing.
 */
export class ProviderModelPort implements ModelPort {
  /** Request-scoped adapter identifier derived from the selected model ID. */
  public readonly id: string;

  public readonly identity: ModelIdentity;

  /** Number of native provider requests attempted through this port. */
  public modelCalls = 0;

  /** {@inheritDoc SingleGenerationModelPort.budget} */
  public readonly budget: TurnTokenBudget;

  public constructor(
    private readonly chat: ProviderChat,
    private readonly options: ProviderModelPortOptions = {},
  ) {
    this.budget = options.budget ?? DEFAULT_TURN_TOKEN_BUDGET;
    this.id = chat.id;
    this.identity = chat.identity;
    const { id, vendor, family, version } = this.identity;
    this.options.debugLog?.(`[AI] model id=${id} vendor=${vendor} family=${family} version=${version}`);
  }

  /**
   * {@link SingleGenerationModelPort.getNumTokens}; the one shared counter. Carries no
   * cancellation: the caller is `trimMessages`' counter, run outside any generation.
   */
  public getNumTokens(content: MessageContent): Promise<number> {
    return Promise.resolve(countTokens(messageContentToText(content)));
  }

  /** Runs one tool-capable generation and validates emitted calls against the supplied tools. */
  public async generateToolTurn(input: ToolGenerationInput): Promise<ToolGenerationResult> {
    if (input.signal?.aborted) return cancelledToolTurnResult();

    const namedTool = typeof input.toolChoice === 'object'
      ? input.toolChoice.toolName
      : undefined;
    const definitions = input.toolChoice === 'none'
      ? []
      : namedTool
        ? input.tools.filter((tool) => tool.name === namedTool)
        : [...input.tools];
    const definitionsByName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );

    const startedAt = Date.now();
    try {
      this.modelCalls += 1;
      const { message, toolCalls: emittedCalls, finishReason, usage } = await this.collectGeneration(
        input.messages,
        input.system,
        definitions.map((definition) => toChatTool(definition.name, definition.description, toModelJsonSchema(definition.inputSchema))),
        input.toolChoice,
        input.signal,
        input.onTextDelta,
        input.phase,
      );
      const text = messageContentToText(message.content);
      const providerParts = messageProviderParts(message);
      const content: ToolGenerationContent[] = text ? [{ type: 'text', text }] : [];
      const toolCalls: GeneratedToolCall[] = [];
      const callIds = new Set<string>();

      for (const { id: callId, name: toolName, args } of emittedCalls) {
        const duplicate = callIds.has(callId);
        callIds.add(callId);
        const definition = definitionsByName.get(toolName);
        let call: GeneratedToolCall;
        if (duplicate) {
          call = {
            valid: false,
            callId,
            toolName,
            input: args,
            code: REJECTION_CODES.duplicateCallId,
            reason: 'The provider repeated a tool call identifier.',
          };
        } else if (!definition) {
          call = {
            valid: false,
            callId,
            toolName,
            input: args,
            code: REJECTION_CODES.unknownTool,
            reason: 'Tool is not available in this phase.',
          };
        } else {
          const decodedArgs = this.decodeStringifiedArguments(toolName, args, toModelJsonSchema(definition.inputSchema));
          call = { valid: true, callId, toolName, input: decodedArgs };
        }
        toolCalls.push(call);
        content.push({ type: 'tool-call', call });
      }

      if (content.length === 0) {
        this.options.debugLog?.(
          `[AI] empty-generation phase=${input.phase} call=${this.modelCalls}`,
        );
      }

      this.options.debugLog?.(
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}`
        + ` observed_parts=${content.length} observed_text_chars=${text.length}`
        + ` provider_parts=${providerParts.length}`
        + ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}`
        + (usage
          ? ` input_tokens=${usage.inputTokens ?? 'n/a'} output_tokens=${usage.outputTokens ?? 'n/a'}`
            + ` total_tokens=${usage.totalTokens ?? 'n/a'} reasoning_tokens=${usage.reasoningTokens ?? 'n/a'}`
            + ` cached_tokens=${usage.cachedTokens ?? 'n/a'}`
          : ' (provider usage unavailable)'),
      );
      return {
        status: 'completed',
        message,
        content,
        text,
        toolCalls,
        finishReason,
      };
    } catch (error) {
      if (input.signal?.aborted || isCancellation(error)) {
        return cancelledToolTurnResult();
      }
      const diagnostic = sanitizeProviderErrorDiagnostic(error, input.phase);
      this.options.debugLog?.(
        `[AI] provider-error ${formatProviderErrorDiagnostic(diagnostic)}`,
      );
      return errorToolTurnResult(error, diagnostic);
    }
  }

  /** Generates a schema-constrained result through a forced structured-output tool. */
  public async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const outputSchema = toModelJsonSchema(input.schema);
    const { toolCalls } = await this.collectGeneration(
      input.messages,
      input.system,
      [toChatTool(STRUCTURED_OUTPUT_TOOL, STRUCTURED_OUTPUT_TOOL_DESCRIPTION, outputSchema)],
      { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
      input.signal,
      undefined,
      input.phase,
    );
    const calls = toolCalls.filter((call) => call.name === STRUCTURED_OUTPUT_TOOL);
    const decoded = calls.length === 1
      ? this.decodeStringifiedArguments(STRUCTURED_OUTPUT_TOOL, calls[0].args, outputSchema)
      : undefined;
    const notation = toolCallNotationFault(decoded);
    if (notation) throw new StructuredOutputError(notation.reason, REJECTION_CODES.invalidStructuredOutput, notation.hint);
    const parsed = calls.length === 1 ? input.schema.safeParse(decoded) : undefined;
    if (parsed?.success) return parsed.data;
    const emptyRequiredPayload = calls.length === 1
      && isEmptyRecord(calls[0].args);
    if (emptyRequiredPayload) {
      throw new StructuredOutputError(
        `${STRUCTURED_OUTPUT_TOOL} arguments were empty`,
        REJECTION_CODES.emptyStructuredOutput,
      );
    }
    if (calls.length > 1) {
      throw new StructuredOutputError(`multiple ${STRUCTURED_OUTPUT_TOOL} tool calls`);
    }
    const { reason, hint } = structuredRejectReason(calls.length === 1, parsed?.error, decoded, input.schema);
    throw new StructuredOutputError(reason, REJECTION_CODES.invalidStructuredOutput, hint);
  }

  /** Decodes JSON-string array/object arguments against the tool's schema and logs each decode. */
  private decodeStringifiedArguments(toolName: string, args: unknown, jsonSchema: unknown): unknown {
    const decoded = coerceStringifiedArguments(args, jsonSchema);
    if (decoded.paths.length > 0) {
      this.options.debugLog?.(
        `[AI] tool-input-decoded tool=${toolName} paths=${trunc(sanitizeForLog(decoded.paths.join(',')), 200)}`,
      );
    }
    return decoded.value;
  }

  /** Completes text without exposing tools. */
  public async completeText(input: CompleteTextInput): Promise<string> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const { message, toolCalls } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      'none',
      input.signal,
      undefined,
      input.phase,
    );
    if (toolCalls.length > 0) {
      throw new ModelPortError(
        'unsupported_response',
        'Text completion returned a tool call.',
      );
    }
    return messageContentToText(message.content).trim();
  }

  private async collectGeneration(
    history: readonly BaseMessage[],
    system: string | undefined,
    tools: readonly ChatTool[],
    choice: ModelToolChoice | undefined,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
    phase?: string,
  ): Promise<{
    message: AIMessageChunk;
    /** The message's tool calls, each verified to carry a call ID. */
    toolCalls: readonly IdentifiedToolCall[];
    finishReason: 'tool-calls' | 'stop' | 'unknown';
    /** Provider-reported usage of the generation; absent when none. */
    usage?: TokenUsage;
  }> {
    const wireLog = this.options.wireLog;
    const generation = this.modelCalls;
    let requestEmitted = false;
    const systemFields = wireLog && system
      ? {
          systemHash: systemPromptHash(system),
          ...(this.options.traceVerbose ? { system } : {}),
        }
      : {};
    const emitWire = wireLog && ((event: WireEvent) => {
      if (event.type === 'wire-request') requestEmitted = true;
      wireLog({
        ...(event.type === 'wire-request' ? { ...event, ...systemFields } : event),
        requestId: this.options.requestId ?? 'unknown',
        generation,
        phase,
      });
    });
    const startedAt = Date.now();
    try {
      const requiresTool = choice === 'required' || typeof choice === 'object';
      if (typeof choice === 'object' && !tools.some((tool) => tool.function.name === choice.toolName)) {
        throw new ModelPortError('invalid_request', `Required tool is not available: ${choice.toolName}.`);
      }
      if (requiresTool && tools.length === 0) {
        throw new ModelPortError('invalid_request', 'Required tool mode requires at least one tool.');
      }
      const request = this.chat.request(
        system ? [new SystemMessage(system), ...history] : history,
        tools,
        tools.length > 0 || requiresTool ? toToolChoice(choice, tools) : undefined,
      );
      const stream = await request.model.stream(request.messages, {
        ...request.options,
        signal,
        ...(emitWire ? { callbacks: [wireRequestCapture(emitWire, tools)] } : {}),
      });
      let message = new AIMessageChunk({ content: '' });
      let received = false;
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        received = true;
        this.chat.check?.(chunk);
        message = message.concat(chunk);
        const delta = messageContentToText(chunk.content);
        if (delta) onTextDelta?.(delta);
      }
      if (signal?.aborted) throw cancelledError();
      if (!received) throw new ModelPortError('unsupported_response', 'Provider reply carried no event stream.');
      message.response_metadata = { ...message.response_metadata, [ENTRY_KEY]: this.identity.id };
      // The chunks keep the provider's call order and every call. LangChain files a call apart from
      // `tool_calls` when its text cannot be completed to JSON, and completes a cut text into
      // `tool_calls`; the chunks carry the text as streamed. A text that is no JSON stays that text,
      // and the receiving boundary rejects the call by its ID instead of the turn failing.
      const toolCalls: Array<{ id?: string; name: string; args: unknown }> = (message.tool_call_chunks ?? []).map((chunk) => ({
        id: chunk.id,
        name: chunk.name ?? '',
        args: parseStreamedArguments(chunk.args),
      }));
      const providerFinish = message.response_metadata.finish_reason;
      const finishReason = observedFinishReason(typeof providerFinish === 'string' && providerFinish !== '', toolCalls.length);
      const usage = toUsage(message.usage_metadata);
      emitWire?.({
        type: 'wire-response',
        text: messageContentToText(message.content),
        toolCalls: toolCalls.map((call) => ({ callId: call.id ?? '', name: call.name, input: call.args })),
        finishReason: typeof providerFinish === 'string' ? providerFinish : undefined,
        usage,
      });
      if (!toolCalls.every(hasCallId)) {
        throw new ModelPortError(
          'unsupported_response',
          'Language model returned an incomplete tool call.',
        );
      }
      emitWire?.({
        type: 'generation',
        modelId: this.identity.id,
        finishReason,
        latencyMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
      });
      return { message, toolCalls, finishReason, usage };
    } catch (error) {
      const failure = toPortError(error, signal);
      if (emitWire && requestEmitted && !signal?.aborted && !isCancellation(failure)) {
        emitWire({
          type: 'wire-error',
          diagnostic: sanitizeProviderErrorDiagnostic(failure, phase ?? 'unknown'),
        });
      }
      throw failure;
    }
  }
}

/**
 * Captures the request as the model sends it: `handleChatModelStart` runs before the HTTP request
 * (`awaitHandlers`), with the messages the provider takes, the call options and the model's own
 * `invocation_params`, so the trace states the wire, not a re-derivation of it.
 */
function wireRequestCapture(emitWire: (event: WireEvent) => void, tools: readonly ChatTool[]): BaseCallbackHandler {
  const handler = BaseCallbackHandler.fromMethods({
    handleChatModelStart: (_llm, [sent], _runId, _parentRunId, extra) => {
      const params = isRecord(extra?.invocation_params) ? extra.invocation_params : {};
      const body = Object.fromEntries(WIRE_BODY_FIELDS.filter((field) => params[field] !== undefined).map((field) => [field, params[field]]));
      emitWire({
        type: 'wire-request',
        messages: sent.map(toWireMessage),
        tools: tools.map(({ function: tool }) => ({
          name: tool.name,
          descriptionHash: systemPromptHash(tool.description),
          inputSchema: tool.parameters,
        })),
        toolMode: tools.length > 0 ? (isRecord(extra?.options) && extra.options.tool_choice === 'auto' ? 1 : 2) : undefined,
        ...(Object.keys(body).length > 0 ? { body } : {}),
      });
    },
  });
  handler.awaitHandlers = true;
  return handler;
}

/** The body fields a trace states: the ones that steer sampling, output length, reasoning and tool use, never a header. */
const WIRE_BODY_FIELDS = [
  'tool_choice', 'reasoning_effort', 'reasoning', 'output_config', 'thinking',
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
] as const;

const WIRE_ROLES: Readonly<Record<string, string>> = { human: 'user', ai: 'assistant' };

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
    role: WIRE_ROLES[message.getType()] ?? message.getType(),
    parts: [
      ...content.filter((part) => part !== '').map(toWirePart),
      ...(AIMessage.isInstance(message) ? message.tool_calls ?? [] : []).map((call) => (
        { type: 'tool-call' as const, callId: call.id ?? '', name: call.name, input: call.args }
      )),
    ],
  };
}

/** The usage a generation reports; absent when it reports none. */
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

/** One tool in the form a chat model takes. */
function toChatTool(name: string, description: string, parameters: Record<string, unknown>): ChatTool {
  return { type: 'function', function: { name, description, parameters } };
}

/**
 * The finish the trace states. A provider that saw a stream to its end reports a `finish_reason`.
 * Without one the stream may have been cut, so the call count alone must not name a finish.
 */
function observedFinishReason(finished: boolean, toolCallCount: number): 'tool-calls' | 'stop' | 'unknown' {
  if (!finished) return 'unknown';
  return toolCallCount > 0 ? 'tool-calls' : 'stop';
}

/** The streamed arguments as JSON, the text itself when it is not valid JSON, `{}` when none streamed. */
function parseStreamedArguments(text: string | undefined): unknown {
  if (!text) return {};
  const parsed = parseJson(text);
  return parsed === undefined ? text : parsed;
}

/** A tool call whose provider call ID is present; `args` is the input exactly as streamed. */
interface IdentifiedToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

function hasCallId(call: { readonly id?: string }): call is IdentifiedToolCall {
  return typeof call.id === 'string' && call.id.length > 0;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * The provider's choice. A required call with exactly one tool names that tool: the one form
 * every wire carries (MAIN does the same). With several tools it stays `'any'` and the provider
 * writes the form its API takes.
 */
function toToolChoice(
  choice: ModelToolChoice | undefined,
  tools: readonly ChatTool[],
): 'auto' | 'any' | 'none' | string {
  if (choice === 'required') return tools.length === 1 ? tools[0].function.name : 'any';
  if (choice === 'none') return 'none';
  if (typeof choice === 'object') return choice.toolName;
  return 'auto';
}

function failureCode(error: unknown): ModelPortErrorCode {
  const status = isRecord(error) ? error.status : undefined;
  if (status === 401 || status === 403) return 'no_permission';
  return status === 404 ? 'model_not_found' : 'provider_error';
}

/**
 * One failure as a port error: cancellation by the signal, else a redacted message and the cause.
 * `code` is the provider's own classification when it has one; else the HTTP status names it.
 */
export function toPortError(error: unknown, signal: AbortSignal | undefined, code?: ModelPortErrorCode): ModelPortError {
  if (error instanceof ModelPortError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelledError();
  const named = code ?? failureCode(error);
  const text = error instanceof Error ? error.message : '';
  return new ModelPortError(named, sanitizeProviderError(text) || `Language model request failed (${named}).`, error);
}

function isCancellation(error: unknown): boolean {
  return isPortCancellation(error);
}
