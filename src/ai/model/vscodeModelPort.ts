import * as vscode from 'vscode';
import {
  AIMessageChunk,
  SystemMessage,
  type BaseMessage,
  type MessageContent,
  type ToolCall,
} from '@langchain/core/messages';
import {
  assertToolCallIds,
  classifyToolCall,
  type CompleteTextInput,
  type EmittedToolCall,
  finishStructured,
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
  modelToolCallMessage,
  errorToolTurnResult,
  isHostCancellationError,
  isPortCancellation,
  messageContentToText,
  messageProviderParts,
} from './modelPort';
import {
  VscodeLangChainBridge,
  type VscodeBridgeRunnable,
} from './vscodeLangChainBridge';
import {
  systemPromptHash,
  type WireEvent,
  type WireRecord,
} from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import {
  DEFAULT_TURN_TOKEN_BUDGET,
  estimateTokens,
  type TurnTokenBudget,
} from '../support/tokenBudget';
import { STRUCTURED_OUTPUT_TOOL } from '../providers/structuredOutput';
import { errorMessage } from '../../utils/errorMessage';

/** Request-scoped model port over the exact native model selected in Chat UI. */
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
      /** Debug wire sink, supplied only when session trace logging is enabled. */
      readonly wireLog?: (record: WireRecord) => void;
      /** Whether the active trace captures the verbatim system instruction as its own field. */
      readonly traceVerbose?: boolean;
      /** Token budget the owning turn resolved from this model's window and the workspace settings. */
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

  /** {@inheritDoc SingleGenerationModelPort.getNumTokens} — delegates to the selected model's own `countTokens`. */
  public async getNumTokens(content: MessageContent): Promise<number> {
    const text = messageContentToText(content);
    try {
      return await this.model.countTokens(text);
    } catch (error) {
      this.options.debugLog?.(
        `[AI] count-tokens-fallback model=${this.model.id}` +
          ` error=${errorMessage(error)}`,
      );
      return estimateTokens(text.length);
    }
  }

  /** Executes one tool-capable generation and validates emitted calls against the supplied tools. */
  public async generateToolTurn(
    input: ToolGenerationInput,
  ): Promise<ToolGenerationResult> {
    if (input.signal?.aborted) return cancelledToolTurnResult();

    const namedTool =
      typeof input.toolChoice === 'object'
        ? input.toolChoice.toolName
        : undefined;
    const definitions =
      input.toolChoice === 'none'
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
      const {
        message,
        emitted: emittedCalls,
        nonTextChars,
      } = await this.collectGeneration(
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
      const content: ToolGenerationContent[] = text
        ? [{ type: 'text', text }]
        : [];
      const toolCalls: GeneratedToolCall[] = [];
      /** The calls as the transcript replays them; `{}` stands in for arguments that were no object. */
      const replayed: Array<{
        callId: string;
        toolName: string;
        input: unknown;
      }> = [];
      let rebuilt = false;

      for (const emittedCall of emittedCalls) {
        // Malformed calls need a replay anchor regardless of which rejection takes precedence.
        if ('malformedArgs' in emittedCall) rebuilt = true;
        const { call, replayInput } = classifyToolCall(
          emittedCall,
          definitionsByName,
          this.options.debugLog,
        );
        replayed.push({
          callId: call.callId,
          toolName: call.toolName,
          input: replayInput,
        });
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
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}` +
          ` observed_parts=${content.length} observed_text_chars=${text.length}` +
          ` observed_nontext_chars=${nonTextChars} provider_parts=${providerParts.length}` +
          ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}` +
          ' (provider usage unavailable)',
      );
      return {
        status: 'completed',
        // A call whose arguments were no object is replayed with `{}`: the transcript needs an object
        // and the model sent none; its rejection carries the truth.
        message: rebuilt
          ? modelToolCallMessage(replayed, text, providerParts)
          : message,
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
  public async generateStructured<T>(
    input: GenerateStructuredInput<T>,
  ): Promise<T> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const outputSchema = toModelJsonSchema(input.schema);
    const { emitted } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      undefined,
      input.signal,
      undefined,
      input.phase,
      (bridge) =>
        bridge.bindStructuredOutputTool(outputSchema, STRUCTURED_OUTPUT_TOOL),
    );
    return finishStructured(emitted, input.schema, this.options.debugLog);
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
    /** Overrides the bound runnable this streams, for a caller (structured output) whose tool binding the bridge already owns ({@link VscodeLangChainBridge.bindStructuredOutputTool}); `definitions`/`choice` are unused when supplied. */
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
    const systemFields =
      wireLog && system
        ? {
            systemHash: systemPromptHash(system),
            ...(this.options.traceVerbose ? { system } : {}),
          }
        : {};
    const emitWire =
      wireLog &&
      ((event: WireEvent) => {
        if (event.type === 'wire-request') requestEmitted = true;
        wireLog({
          ...(event.type === 'wire-request'
            ? { ...event, ...systemFields }
            : event),
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
        if (typeof chunk.content === 'string' && chunk.content)
          onTextDelta?.(chunk.content);
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number')
          nonTextChars += streamedNonText;
      }
      if (signal?.aborted) throw cancelledError();
      const emitted = emittedToolCalls(message);
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason:
          (message.tool_calls?.length ?? 0) > 0 ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return { message, emitted, nonTextChars };
    } catch (error) {
      if (
        emitWire &&
        requestEmitted &&
        !signal?.aborted &&
        !isCancellation(error)
      ) {
        emitWire({
          type: 'wire-error',
          diagnostic: sanitizeProviderErrorDiagnostic(
            error,
            phase ?? 'unknown',
          ),
        });
      }
      throw error;
    } finally {
      cancellation.dispose();
    }
  }
}

/** The generation's tool calls in emission order, pairing LangChain's parsed `tool_calls` and its `invalid_tool_calls` (arguments that were no JSON object) back onto the bridge's one chunk per call. */
function emittedToolCalls(message: AIMessageChunk): EmittedToolCall[] {
  const valid: ToolCall[] = [...(message.tool_calls ?? [])];
  const invalid = [...(message.invalid_tool_calls ?? [])];
  const incomplete = (): ModelPortError =>
    new ModelPortError(
      'unsupported_response',
      'Language model returned an incomplete tool call.',
    );
  const ids = [...valid, ...invalid].map((call) => call.id);
  assertToolCallIds(ids);
  const take = <T extends { id?: string }>(
    list: T[],
    id: string | undefined,
  ): T | undefined => {
    const at = list.findIndex((call) => call.id === id);
    return at < 0 ? undefined : list.splice(at, 1)[0];
  };
  const toEmitted = (id: string | undefined): EmittedToolCall => {
    if (!id) throw incomplete();
    const parsed = take(valid, id);
    if (parsed) return { callId: id, toolName: parsed.name, args: parsed.args };
    const malformed = take(invalid, id);
    if (malformed)
      return {
        callId: id,
        toolName: malformed.name ?? '',
        malformedArgs: malformed.args ?? '',
      };
    throw incomplete();
  };
  const chunks = [...(message.tool_call_chunks ?? [])].sort(
    (left, right) => Number(left.index ?? 0) - Number(right.index ?? 0),
  );
  if (chunks.length === valid.length + invalid.length)
    return chunks.map((chunk) => toEmitted(chunk.id));
  return ids.map(toEmitted);
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
