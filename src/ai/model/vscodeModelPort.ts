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
  cancelledToolTurnResult,
  errorToolTurnResult,
  isHostCancellationError,
  isPortCancellation,
  messageContentToText,
  messageProviderParts,
} from './modelPort';
import { VscodeLangChainBridge, type VscodeBridgeRunnable } from './vscodeLangChainBridge';
import { systemPromptHash, type WireEvent, type WireRecord } from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { DEFAULT_TURN_TOKEN_BUDGET, estimateTokens, type TurnTokenBudget } from '../support/tokenBudget';
import { rejectionFromZodError, zodFieldRepairHint, zodUnrecognizedKeys } from '../support/toolErrorEnvelope';
import { coerceStringifiedArguments, droppedKeyPaths } from '../support/inputNormalization';
import { sanitizeForLog, trunc } from '../../utils/log';
import {
  STRUCTURED_OUTPUT_TOOL,
  StructuredOutputError,
  structuredRejectReason,
} from '../providers/structuredOutput';

/**
 * Request-scoped model port over the exact native model selected in Chat UI.
 *
 * LangChain `BaseMessage` instances are the only history representation. The
 * port performs no model selection, fallback, tool execution, or lifecycle
 * routing.
 */
export class VscodeModelPort implements ModelPort {
  /** Request-scoped adapter identifier derived from the selected model ID. */
  public readonly id: string;

  /** Metadata copied from the exact model selected for this request. */
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
       * Debug wire sink, supplied only when session trace logging is enabled.
       *
       * @remarks
       * Unlike {@link debugLog} this carries model content — prompts, tool payloads, SQL — so it
       * never reaches the output channel and is absent unless the user opted in.
       */
      readonly wireLog?: (record: WireRecord) => void;
      /**
       * Whether the active trace captures the verbatim system instruction as its own field.
       *
       * @remarks
       * Off by default, in which case the `wire-request` `system` field carries the prompt's hash
       * only. This does **not** make the trace prompt-free: `vscode.lm` has no system role, so the
       * bridge downgrades the system instruction into the first User turn and it is recorded with
       * the rest of `messages[]` either way. That is deliberate — the message array is what makes a
       * bad turn reconstructable from the trace alone. The privacy control is the opt-in itself
       * plus the owner-only file mode, not partial redaction of the request.
       *
       * The port never captures provider bodies on this lane — `vscode.lm` hands back a stream of
       * parts, not an HTTP payload — so `provider-raw` has no emitter here.
       */
      readonly traceVerbose?: boolean;
      /**
       * Token budget the owning turn resolved from this model's window and the workspace settings.
       *
       * @remarks
       * Absent only where a caller builds a port outside a turn, which leaves the shipped defaults
       * and the ceilings in force.
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
   * {@inheritDoc SingleGenerationModelPort.getNumTokens} — delegates to the selected model's own
   * `countTokens`.
   *
   * @remarks
   * Carries no cancellation token: the caller is `trimMessages`' token counter, run outside any
   * single generation's request-scoped `CancellationTokenSource` — there is no live token in
   * scope to pass. A rejecting `countTokens` call (a BYOK provider whose counter throws) falls
   * back to the shared chars-per-token estimate rather than failing the node.
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

  /** Executes one tool-capable generation and validates emitted calls against the supplied tools. */
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
      const { message, nonTextChars } = await this.collectGeneration(
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

      for (const { id: callId = '', name: toolName, args } of message.tool_calls ?? []) {
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
          const parsed = definition.inputSchema.safeParse(decodedArgs);
          const dropped = parsed.success ? droppedKeyPaths(decodedArgs, parsed.data) : [];
          if (dropped.length > 0) {
            this.options.debugLog?.(
              `[AI] tool-input-keys-dropped tool=${toolName} paths=${trunc(sanitizeForLog(dropped.join(',')), 200)}`,
            );
          }
          if (parsed.success) {
            call = {
              valid: true,
              callId,
              toolName,
              input: parsed.data,
            };
          } else {
            const rejection = rejectionFromZodError(
              parsed.error,
              { code: REJECTION_CODES.invalidToolInput, input: decodedArgs, schema: definition.inputSchema },
            );
            const fieldHint = zodFieldRepairHint(parsed.error, decodedArgs, definition.inputSchema);
            const unrecognizedKeys = zodUnrecognizedKeys(parsed.error);
            call = {
              valid: false,
              callId,
              toolName,
              input: decodedArgs,
              code: REJECTION_CODES.invalidToolInput,
              reason: rejection.reason,
              ...(fieldHint !== undefined ? { hint: fieldHint } : {}),
              ...(rejection.issuePaths ? { issuePaths: rejection.issuePaths } : {}),
              ...(unrecognizedKeys.length > 0 ? { unrecognizedKeys } : {}),
            };
          }
        }
        toolCalls.push(call);
        content.push({ type: 'tool-call', call });
      }

      if (content.length === 0) {
        this.options.debugLog?.(
          `[AI] empty-generation phase=${input.phase} call=${this.modelCalls}`,
        );
      }

      const finishReason = toolCalls.length > 0 ? 'tool-calls' : 'stop';
      this.options.debugLog?.(
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}`
        + ` observed_parts=${content.length} observed_text_chars=${text.length}`
        + ` observed_nontext_chars=${nonTextChars} provider_parts=${providerParts.length}`
        + ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}`
        + ' (provider usage unavailable)',
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
    const { message } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      undefined,
      input.signal,
      undefined,
      input.phase,
      (bridge) => bridge.bindStructuredOutputTool(outputSchema, STRUCTURED_OUTPUT_TOOL),
    );
    const calls = (message.tool_calls ?? []).filter((call) => call.name === STRUCTURED_OUTPUT_TOOL);
    const decoded = calls.length === 1
      ? this.decodeStringifiedArguments(STRUCTURED_OUTPUT_TOOL, calls[0].args, outputSchema)
      : undefined;
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
    const { message } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      'none',
      input.signal,
      undefined,
      input.phase,
    );
    if ((message.tool_calls ?? []).length > 0) {
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
    nonTextChars: number;
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
      const runnable = buildRunnable
        ? buildRunnable(bridge)
        : tools.length > 0
          ? bridge.bindTools(tools, {
              tool_choice: toLangChainToolChoice(choice),
            })
          : bridge;
      const messages = system
        ? [new SystemMessage(system), ...history]
        : [...history];
      let message = new AIMessageChunk({ content: '' });
      let nonTextChars = 0;
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        message = message.concat(chunk);
        if (typeof chunk.content === 'string' && chunk.content) onTextDelta?.(chunk.content);
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number') nonTextChars += streamedNonText;
      }
      if (signal?.aborted) throw cancelledError();
      if ((message.invalid_tool_calls?.length ?? 0) > 0) {
        throw new ModelPortError(
          'unsupported_response',
          'Language model returned non-object tool input.',
        );
      }
      if ((message.tool_calls ?? []).some((call) => !call.id)) {
        throw new ModelPortError(
          'unsupported_response',
          'Language model returned an incomplete tool call.',
        );
      }
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason: (message.tool_calls?.length ?? 0) > 0 ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return { message, nonTextChars };
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

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
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

function cancelledError(): ModelPortError {
  return new ModelPortError('cancelled', 'Language model request was cancelled.');
}
