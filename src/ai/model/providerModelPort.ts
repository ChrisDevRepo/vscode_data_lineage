import { AIMessageChunk, SystemMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
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
  isHostCancellationError,
  isPortCancellation,
  isRecord,
  messageContentToText,
  messageProviderParts,
  recordStreamedToolArguments,
} from './modelPort';
import { systemPromptHash, type TokenUsage, type WireEvent, type WireRecord } from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { DEFAULT_TURN_TOKEN_BUDGET, estimateTokens, type TurnTokenBudget } from '../support/tokenBudget';
import { coerceStringifiedArguments, parseJson } from '../support/inputNormalization';
import { toolCallNotationFault } from '../support/toolCallNotation';
import { sanitizeForLog, trunc } from '../../utils/log';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  StructuredOutputError,
  structuredRejectReason,
} from '../providers/structuredOutput';

/** One tool offered on a generation, as the transport sends it. */
export interface TransportTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object of the tool input ({@link toModelJsonSchema}). */
  readonly inputSchema: Record<string, unknown>;
}

/** One generation as a transport receives it. */
export interface TransportRequest {
  /** The conversation, system instruction first. */
  readonly messages: readonly BaseMessage[];
  readonly tools: readonly TransportTool[];
  /**
   * `'auto'`, `'any'` (a tool call is required), `'none'` or the one tool the model must call;
   * absent when the request binds no tools.
   */
  readonly toolChoice?: string;
  readonly signal?: AbortSignal;
  /** Wire capture, present only while session trace logging is on. */
  readonly wire?: (event: WireEvent) => void;
}

/**
 * The provider connection behind a port: the only code that knows one wire. It owns cancellation,
 * error classification (every failure is a {@link ModelPortError}) and the wire events of its own
 * request.
 */
export interface ModelTransport {
  /** Port identifier derived from the model. */
  readonly id: string;
  readonly identity: ModelIdentity;
  /** Token count of one text; may reject, the port then estimates. */
  countTokens(text: string): Promise<number>;
  /**
   * Streams one generation as LangChain chunks. A stream seen to its end finishes with one chunk
   * whose `response_metadata.streamEnd` is true; a failure throws a {@link ModelPortError}.
   */
  stream(request: TransportRequest): AsyncIterable<AIMessageChunk>;
}

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
   * **not** make the trace prompt-free: a transport may carry the system instruction inside
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
 * Request-scoped model port over one {@link ModelTransport}. LangChain `BaseMessage` instances are
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
    private readonly transport: ModelTransport,
    private readonly options: ProviderModelPortOptions = {},
  ) {
    this.budget = options.budget ?? DEFAULT_TURN_TOKEN_BUDGET;
    this.id = transport.id;
    this.identity = transport.identity;
    const { id, vendor, family, version } = this.identity;
    this.options.debugLog?.(`[AI] model id=${id} vendor=${vendor} family=${family} version=${version}`);
  }

  /**
   * {@link SingleGenerationModelPort.getNumTokens}; delegates to the transport's counter. Carries
   * no cancellation: the caller is `trimMessages`' counter, run outside any generation. A rejecting
   * counter falls back to the shared chars-per-token estimate rather than failing the node.
   */
  public async getNumTokens(content: MessageContent): Promise<number> {
    const text = messageContentToText(content);
    try {
      return await this.transport.countTokens(text);
    } catch (error) {
      this.options.debugLog?.(
        `[AI] count-tokens-fallback model=${this.identity.id}`
        + ` error=${error instanceof Error ? error.message : String(error)}`,
      );
      return estimateTokens(text.length);
    }
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
      const { message, toolCalls: emittedCalls, nonTextChars, finishReason, usage } = await this.collectGeneration(
        input.messages,
        input.system,
        definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          inputSchema: toModelJsonSchema(definition.inputSchema),
        })),
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
        + ` observed_nontext_chars=${nonTextChars} provider_parts=${providerParts.length}`
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
      [{ name: STRUCTURED_OUTPUT_TOOL, description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION, inputSchema: outputSchema }],
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
    tools: readonly TransportTool[],
    choice: ModelToolChoice | undefined,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
    phase?: string,
  ): Promise<{
    message: AIMessageChunk;
    /** The message's tool calls, each verified to carry a call ID. */
    toolCalls: readonly IdentifiedToolCall[];
    nonTextChars: number;
    finishReason: 'tool-calls' | 'stop' | 'unknown';
    /** Provider-reported usage of the last readable 'usage' stream part; absent when none. */
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
      if (typeof choice === 'object' && !tools.some((tool) => tool.name === choice.toolName)) {
        throw new ModelPortError('invalid_request', `Required tool is not available: ${choice.toolName}.`);
      }
      if (requiresTool && tools.length === 0) {
        throw new ModelPortError('invalid_request', 'Required tool mode requires at least one tool.');
      }
      const messages = system
        ? [new SystemMessage(system), ...history]
        : [...history];
      let message = new AIMessageChunk({ content: '' });
      let nonTextChars = 0;
      let streamEnded = false;
      let usage: TokenUsage | undefined;
      const stream = this.transport.stream({
        messages,
        tools,
        toolChoice: tools.length > 0 || requiresTool ? toTransportToolChoice(choice, tools) : undefined,
        signal,
        wire: emitWire,
      });
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        message = message.concat(chunk);
        if (typeof chunk.content === 'string' && chunk.content) onTextDelta?.(chunk.content);
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number') nonTextChars += streamedNonText;
        if (chunk.response_metadata?.streamEnd) streamEnded = true;
        const streamedUsage = chunk.response_metadata?.providerUsage;
        if (streamedUsage) usage = streamedUsage as TokenUsage;
      }
      if (signal?.aborted) throw cancelledError();
      // The chunks keep the provider's call order and every call. LangChain files a call apart from
      // `tool_calls` when its text cannot be completed to JSON, and completes a cut text into
      // `tool_calls`; the chunks carry the text as streamed. A text that is no JSON stays that text,
      // and the receiving boundary rejects the call by its ID instead of the turn failing.
      const notObjects: Record<string, string> = {};
      const toolCalls: Array<{ id?: string; name: string; args: unknown }> = (message.tool_call_chunks ?? []).map((chunk) => {
        const args = chunk.args ? parseStreamedArguments(chunk.args) : {};
        // A text that is no JSON object cannot ride `tool_calls` as it was sent: the transport replays it from here.
        if (chunk.id && chunk.args && !isRecord(args)) notObjects[chunk.id] = chunk.args;
        return { id: chunk.id, name: chunk.name ?? '', args };
      });
      recordStreamedToolArguments(message, notObjects);
      if (!toolCalls.every(hasCallId)) {
        throw new ModelPortError(
          'unsupported_response',
          'Language model returned an incomplete tool call.',
        );
      }
      const finishReason = observedFinishReason(streamEnded, toolCalls.length);
      emitWire?.({
        type: 'generation',
        modelId: this.identity.id,
        finishReason,
        latencyMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
      });
      return { message, toolCalls, nonTextChars, finishReason, usage };
    } catch (error) {
      if (emitWire && requestEmitted && !signal?.aborted && !isCancellation(error)) {
        emitWire({
          type: 'wire-error',
          diagnostic: sanitizeProviderErrorDiagnostic(error, phase ?? 'unknown'),
        });
      }
      throw error;
    }
  }
}

/**
 * The finish the trace states. The transport ends a stream it saw to its end with one `streamEnd`
 * chunk. Without it the stream may have been cut, so the call count alone must not name a finish.
 */
function observedFinishReason(streamEnded: boolean, toolCallCount: number): 'tool-calls' | 'stop' | 'unknown' {
  if (!streamEnded) return 'unknown';
  return toolCallCount > 0 ? 'tool-calls' : 'stop';
}

/** The streamed arguments as JSON, or the text itself when it is not valid JSON. */
function parseStreamedArguments(text: string): unknown {
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
 * The transport's choice. A required call with exactly one tool names that tool: the one form
 * every wire carries (MAIN does the same). With several tools it stays `'any'` and the transport
 * writes the form its API takes.
 */
function toTransportToolChoice(
  choice: ModelToolChoice | undefined,
  tools: readonly TransportTool[],
): 'auto' | 'any' | 'none' | string {
  if (choice === 'required') return tools.length === 1 ? tools[0].name : 'any';
  if (choice === 'none') return 'none';
  if (typeof choice === 'object') return choice.toolName;
  return 'auto';
}

function isCancellation(error: unknown): boolean {
  return isPortCancellation(error) || isHostCancellationError(error);
}
