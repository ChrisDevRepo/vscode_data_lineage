import * as vscode from 'vscode';
import { AIMessageChunk, SystemMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import {
  type CompleteTextInput,
  type GeneratedToolCall,
  type GenerateStructuredInput,
  type ModelPort,
  type ModelIdentity,
  ModelPortError,
  type ModelToolChoice,
  type ModelToolDefinition,
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
} from './modelPort';
import { VscodeLangChainBridge, type VscodeBridgeRunnable } from './vscodeLangChainBridge';
import { systemPromptHash, type TokenUsage, type WireEvent, type WireRecord } from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { DEFAULT_TURN_TOKEN_BUDGET, estimateTokens, type TurnTokenBudget } from '../support/tokenBudget';
import { coerceStringifiedArguments } from '../support/inputNormalization';
import { toolCallNotationFault } from '../support/toolCallNotation';
import { sanitizeForLog, trunc } from '../../utils/log';
import {
  STRUCTURED_OUTPUT_TOOL,
  StructuredOutputError,
  structuredRejectReason,
} from '../providers/structuredOutput';

/**
 * Request-scoped model port over the exact native model selected in Chat UI. LangChain
 * `BaseMessage` instances are the only history representation; the port performs no model
 * selection, fallback, tool execution or lifecycle routing.
 */
export class VscodeModelPort implements ModelPort {
  /** Request-scoped adapter identifier derived from the selected model ID. */
  public readonly id: string;

  public readonly identity: ModelIdentity;

  /** Number of native provider requests attempted through this port. */
  public modelCalls = 0;

  /** {@inheritDoc SingleGenerationModelPort.budget} */
  public readonly budget: TurnTokenBudget;

  public constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly options: {
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
       * **not** make the trace prompt-free: `vscode.lm` has no system role, so the bridge
       * downgrades the system instruction into the first User turn and it is recorded with
       * `messages[]` either way, deliberately, since the message array makes a bad turn
       * reconstructable from the trace alone. The privacy control is the opt-in plus the owner-only
       * file mode, not partial redaction.
       *
       * The port never captures provider bodies (`vscode.lm` yields a stream of parts, not an HTTP
       * payload), so `provider-raw` has no emitter here.
       */
      readonly traceVerbose?: boolean;
      /**
       * Token budget the owning turn resolved from this model's window and the workspace settings.
       * Absent only where a caller builds a port outside a turn, which leaves the shipped defaults
       * and ceilings in force.
       */
      readonly budget?: TurnTokenBudget;
    } = {},
  ) {
    this.budget = options.budget ?? DEFAULT_TURN_TOKEN_BUDGET;
    this.id = `vscode-lm:${model.id}`;
    this.identity = {
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      version: model.version,
    };
    this.options.debugLog?.(
      `[AI] model id=${model.id} vendor=${model.vendor} family=${model.family} version=${model.version}`,
    );
  }

  /**
   * {@inheritDoc SingleGenerationModelPort.getNumTokens}; delegates to the selected model's
   * `countTokens`. Carries no cancellation token: the caller is `trimMessages`' counter, run
   * outside any generation's request-scoped `CancellationTokenSource`. A rejecting `countTokens` (a
   * BYOK provider whose counter throws) falls back to the shared chars-per-token estimate rather
   * than failing the node.
   */
  public async getNumTokens(content: MessageContent): Promise<number> {
    const text = messageContentToText(content);
    try {
      return await this.model.countTokens(text);
    } catch (error) {
      this.options.debugLog?.(
        `[AI] count-tokens-fallback model=${this.model.id}`
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
        definitions,
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
      return errorToolTurnResult(diagnostic);
    }
  }

  /** Generates a schema-constrained result through the bridge's forced structured-output tool. */
  public async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const outputSchema = toModelJsonSchema(input.schema);
    const { toolCalls } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      undefined,
      input.signal,
      undefined,
      input.phase,
      (bridge) => bridge.bindStructuredOutputTool(outputSchema, STRUCTURED_OUTPUT_TOOL),
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
    definitions: readonly ModelToolDefinition[],
    choice: ModelToolChoice | undefined,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
    phase?: string,
    /**
     * Overrides the bound runnable this streams, for a caller (structured output) whose tool
     * binding the bridge already owns ({@link VscodeLangChainBridge.bindStructuredOutputTool});
     * `definitions`/`choice` are unused when supplied.
     */
    buildRunnable?: (bridge: VscodeLangChainBridge) => VscodeBridgeRunnable,
  ): Promise<{
    message: AIMessageChunk;
    /** The message's tool calls, each verified to carry a call ID. */
    toolCalls: readonly IdentifiedToolCall[];
    nonTextChars: number;
    finishReason: 'tool-calls' | 'stop' | 'unknown';
    /** Provider-reported usage of the last readable 'usage' stream part; absent when none. */
    usage?: TokenUsage;
  }> {
    const cancellation = bindCancellation(signal);
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
      const bridge = new VscodeLangChainBridge({
        model: this.model,
        token: cancellation.source.token,
        wire: emitWire,
      });
      const tools = definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toModelJsonSchema(definition.inputSchema),
      }));
      const requiresTool = choice === 'required' || typeof choice === 'object';
      const runnable = buildRunnable
        ? buildRunnable(bridge)
        : tools.length > 0 || requiresTool
          ? bridge.bindTools(tools, {
              tool_choice: toLangChainToolChoice(choice),
            })
          : bridge;
      const messages = system
        ? [new SystemMessage(system), ...history]
        : [...history];
      let message = new AIMessageChunk({ content: '' });
      let nonTextChars = 0;
      let usageReceived = false;
      let usage: TokenUsage | undefined;
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        message = message.concat(chunk);
        if (typeof chunk.content === 'string' && chunk.content) onTextDelta?.(chunk.content);
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number') nonTextChars += streamedNonText;
        if (chunk.response_metadata?.usageParts) usageReceived = true;
        const streamedUsage = chunk.response_metadata?.providerUsage;
        if (streamedUsage) usage = streamedUsage as TokenUsage;
      }
      if (signal?.aborted) throw cancelledError();
      // A non-object input is LangChain's invalid call; it stays a call of the turn, so the
      // receiving boundary rejects it by its call ID instead of the turn failing.
      const nonObjectCalls = (message.invalid_tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.name ?? '',
        args: call.args === undefined ? undefined : JSON.parse(call.args) as unknown,
      }));
      const toolCalls: Array<{ id?: string; name: string; args: unknown }> = [...(message.tool_calls ?? []), ...nonObjectCalls];
      if (!toolCalls.every(hasCallId)) {
        throw new ModelPortError(
          'unsupported_response',
          'Language model returned an incomplete tool call.',
        );
      }
      const finishReason = observedFinishReason(usageReceived, toolCalls.length);
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
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
    } finally {
      cancellation.dispose();
    }
  }
}

/**
 * The finish the trace states. `vscode.lm` passes no provider finish reason; a usage data part is
 * the one sign the provider ended the stream itself. Without it the stream may have been cut, so
 * the call count alone must not name a finish.
 */
function observedFinishReason(usageReceived: boolean, toolCallCount: number): 'tool-calls' | 'stop' | 'unknown' {
  if (!usageReceived) return 'unknown';
  return toolCallCount > 0 ? 'tool-calls' : 'stop';
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

function toLangChainToolChoice(
  choice: ModelToolChoice | undefined,
): 'auto' | 'any' | 'none' | string {
  if (choice === 'required') return 'any';
  if (choice === 'none') return 'none';
  if (typeof choice === 'object') return choice.toolName;
  return 'auto';
}

function bindCancellation(signal?: AbortSignal): {
  readonly source: vscode.CancellationTokenSource;
  dispose(): void;
} {
  const source = new vscode.CancellationTokenSource();
  const abort = (): void => source.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) source.cancel();
  return {
    source,
    dispose: () => {
      signal?.removeEventListener('abort', abort);
      source.dispose();
    },
  };
}

function isCancellation(error: unknown): boolean {
  return isPortCancellation(error) || isHostCancellationError(error);
}
