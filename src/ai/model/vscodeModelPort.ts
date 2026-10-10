import * as vscode from 'vscode';
import { AIMessageChunk, SystemMessage, type BaseMessage, type MessageContent, type ToolCall } from '@langchain/core/messages';
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
  TOOL_ARGUMENTS_NOT_OBJECT_REASON,
  cancelledToolTurnResult,
  modelToolCallMessage,
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
import { coerceStringifiedArguments } from '../support/inputNormalization';
import { toolCallNotationFault } from '../support/toolCallNotation';
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
      const { message, emitted: emittedCalls, nonTextChars } = await this.collectGeneration(
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
      /** The calls as the transcript replays them; `{}` stands in for arguments that were no object. */
      const replayed: Array<{ callId: string; toolName: string; input: unknown }> = [];
      let rebuilt = false;

      for (const emittedCall of emittedCalls) {
        const { id: callId, name: toolName } = emittedCall;
        const args = 'args' in emittedCall ? emittedCall.args : emittedCall.malformedArgs;
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
        } else if ('malformedArgs' in emittedCall) {
          // Charged to the call and answered by its own tool result, so the next reply can correct it.
          rebuilt = true;
          call = {
            valid: false,
            callId,
            toolName,
            input: emittedCall.malformedArgs,
            code: REJECTION_CODES.invalidToolInput,
            reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON,
          };
        } else {
          const decodedArgs = this.decodeStringifiedArguments(toolName, args, toModelJsonSchema(definition.inputSchema));
          call = { valid: true, callId, toolName, input: decodedArgs };
        }
        replayed.push({ callId, toolName, input: 'malformedArgs' in emittedCall ? {} : args });
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
        // A call whose arguments were no object is replayed with `{}`: the transcript needs an object
        // and the model sent none; its rejection carries the truth.
        message: rebuilt ? modelToolCallMessage(replayed, text, providerParts) : message,
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
    if (calls.length === 0 && (message.invalid_tool_calls ?? []).some((call) => call.name === STRUCTURED_OUTPUT_TOOL)) {
      throw new StructuredOutputError(`${STRUCTURED_OUTPUT_TOOL} arguments were not a JSON object`);
    }
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
    /** The message's tool calls in emission order, each verified to carry a call ID. */
    emitted: readonly EmittedToolCall[];
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
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        message = message.concat(chunk);
        if (typeof chunk.content === 'string' && chunk.content) onTextDelta?.(chunk.content);
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number') nonTextChars += streamedNonText;
      }
      if (signal?.aborted) throw cancelledError();
      const emitted = emittedToolCalls(message);
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason: (message.tool_calls?.length ?? 0) > 0 ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return { message, emitted, nonTextChars };
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

/** One provider tool call: its parsed object arguments, or the JSON text LangChain could not read as an object. */
export type EmittedToolCall = { readonly id: string; readonly name: string } & (
  | { readonly args: Record<string, unknown> }
  | { readonly malformedArgs: string }
);

/**
 * The generation's tool calls in emission order, pairing LangChain's parsed `tool_calls` and its
 * `invalid_tool_calls` (arguments that were no JSON object) back onto the bridge's one chunk per
 * call.
 *
 * @throws {@link ModelPortError} `unsupported_response` when a call carries no id: nothing can
 *   answer it, so the generation is incomplete as a whole.
 */
export function emittedToolCalls(message: AIMessageChunk): EmittedToolCall[] {
  const valid: ToolCall[] = [...(message.tool_calls ?? [])];
  const invalid = [...(message.invalid_tool_calls ?? [])];
  const incomplete = (): ModelPortError => new ModelPortError('unsupported_response', 'Language model returned an incomplete tool call.');
  if (invalid.some((call) => !call.id)) throw incomplete();
  const take = <T extends { id?: string }>(list: T[], id: string | undefined): T | undefined => {
    const at = list.findIndex((call) => call.id === id);
    return at < 0 ? undefined : list.splice(at, 1)[0];
  };
  const toEmitted = (id: string | undefined): EmittedToolCall => {
    if (!id) throw incomplete();
    const parsed = take(valid, id);
    if (parsed) return { id, name: parsed.name, args: parsed.args };
    const malformed = take(invalid, id);
    if (malformed) return { id, name: malformed.name ?? '', malformedArgs: malformed.args ?? '' };
    throw incomplete();
  };
  const chunks = [...(message.tool_call_chunks ?? [])].sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
  if (chunks.length === valid.length + invalid.length) return chunks.map((chunk) => toEmitted(chunk.id));
  const ids = [...valid, ...invalid].map((call) => call.id);
  return ids.map(toEmitted);
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
