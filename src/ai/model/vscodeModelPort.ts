import * as vscode from 'vscode';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
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
} from './modelPort';
import { VscodeLangChainBridge } from './vscodeLangChainBridge';
import { systemPromptHash, type WireEvent, type WireRecord } from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { rejectionFromZodError } from '../support/toolErrorEnvelope';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  StructuredOutputError,
  structuredRejectReason,
} from '../providers/structuredOutput';

type PortGenerationPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
    };

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
       * Whether the active trace captures the verbatim system instruction.
       *
       * @remarks
       * Off by default, in which case `wire-request` carries the system prompt's hash only. The port
       * never captures provider bodies on this lane — `vscode.lm` hands back a stream of parts, not
       * an HTTP payload — so `provider-raw` has no emitter here.
       */
      readonly traceVerbose?: boolean;
    } = {},
  ) {
    this.id = `vscode-lm:${model.id}`;
    this.identity = {
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      version: model.version,
    };
    // Record the selected model before any provider request can fail.
    this.options.debugLog?.(
      `[AI] model id=${model.id} vendor=${model.vendor} family=${model.family} version=${model.version}`,
    );
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
      const response = await this.collectGeneration(
        input.messages,
        input.system,
        definitions,
        input.toolChoice,
        input.signal,
        input.onTextDelta,
        input.phase,
      );
      const content: ToolGenerationContent[] = [];
      const toolCalls: GeneratedToolCall[] = [];
      const callIds = new Set<string>();
      let text = '';

      for (const part of response) {
        if (part.type === 'text') {
          text += part.text;
          content.push(part);
          continue;
        }
        const duplicate = callIds.has(part.callId);
        callIds.add(part.callId);
        const definition = definitionsByName.get(part.toolName);
        let call: GeneratedToolCall;
        if (duplicate) {
          call = {
            valid: false,
            callId: part.callId,
            toolName: part.toolName,
            code: REJECTION_CODES.duplicateCallId,
            reason: 'The provider repeated a tool call identifier.',
          };
        } else if (!definition) {
          call = {
            valid: false,
            callId: part.callId,
            toolName: part.toolName,
            code: 'unknown_tool',
            reason: 'Tool is not available in this phase.',
          };
        } else {
          const parsed = definition.inputSchema.safeParse(part.input);
          call = parsed.success
            ? {
                valid: true,
                callId: part.callId,
                toolName: part.toolName,
                input: parsed.data,
              }
            : {
                valid: false,
                callId: part.callId,
                toolName: part.toolName,
                code: 'invalid_tool_input',
                reason: rejectionFromZodError(
                  parsed.error,
                  { code: 'invalid_tool_input', input: part.input },
                ).reason,
                issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
              };
        }
        toolCalls.push(call);
        content.push({ type: 'tool-call', call });
      }

      // An empty generation is how an endpoint commonly answers a tool choice it cannot satisfy, and
      // also how a quota soft-fail looks; it self-repairs downstream, so it is a signal, not a fault.
      if (content.length === 0) {
        this.options.debugLog?.(
          `[AI] empty-generation phase=${input.phase} call=${this.modelCalls}`,
        );
      }

      const finishReason = toolCalls.length > 0 ? 'tool-calls' : 'stop';
      // Every generation leaves one `[AI] usage` line: without it a completed turn is
      // indistinguishable from one that never reached the model. Token counts are structurally
      // unavailable on this lane — `vscode.lm` exposes no usage — hence observed counters plus an
      // explicit `(provider usage unavailable)` marker rather than omitting the line.
      this.options.debugLog?.(
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}`
        + ` observed_parts=${content.length} observed_text_chars=${text.length}`
        + ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}`
        + ' (provider usage unavailable)',
      );
      return {
        status: 'completed',
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

  /** Generates a schema-constrained result through the synthetic structured-output tool. */
  public async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    // Same pre-flight as generateToolTurn: a pre-aborted signal must surface as a clean,
    // classifiable cancellation before any provider request is attempted.
    if (input.signal?.aborted) throw cancelledError();
    const definitions: ModelToolDefinition[] = [{
      name: STRUCTURED_OUTPUT_TOOL,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      inputSchema: input.schema,
    }];
    this.modelCalls += 1;
    const response = await this.collectGeneration(
      input.messages,
      input.system,
      definitions,
      { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
      input.signal,
      undefined,
      input.phase,
    );
    const calls = response.filter(
      (part): part is Extract<PortGenerationPart, { type: 'tool-call' }> =>
        part.type === 'tool-call' && part.toolName === STRUCTURED_OUTPUT_TOOL,
    );
    const parsed = calls.length === 1
      ? input.schema.safeParse(calls[0].input)
      : undefined;
    if (parsed?.success) return parsed.data;
    const emptyRequiredPayload = calls.length === 1
      && isEmptyRecord(calls[0].input);
    throw new StructuredOutputError(
      emptyRequiredPayload
        ? `${STRUCTURED_OUTPUT_TOOL} arguments were empty`
        : calls.length > 1
        ? `multiple ${STRUCTURED_OUTPUT_TOOL} tool calls`
        : structuredRejectReason(calls.length === 1, parsed?.error),
      emptyRequiredPayload ? 'empty_structured_output' : 'invalid_structured_output',
    );
  }

  /** Completes text without exposing tools. */
  public async completeText(input: CompleteTextInput): Promise<string> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const response = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      'none',
      input.signal,
      undefined,
      input.phase,
    );
    if (response.some((part) => part.type !== 'text')) {
      throw new ModelPortError(
        'unsupported_response',
        'Text completion returned a tool call.',
      );
    }
    return response
      .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> =>
        part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
  }

  private async collectGeneration(
    history: readonly BaseMessage[],
    system: string | undefined,
    definitions: readonly ModelToolDefinition[],
    choice: ModelToolChoice | undefined,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
    phase?: string,
  ): Promise<readonly PortGenerationPart[]> {
    const cancellation = bindCancellation(signal);
    const wireLog = this.options.wireLog;
    // Captured now rather than read at emit time: concurrent generations would otherwise all
    // stamp whichever call happened to increment the counter last.
    const generation = this.modelCalls;
    let requestEmitted = false;
    // The bridge emits `wire-request` without knowing the system instruction — it only sees the
    // already-projected leading User turn — so the port, which owns the original, stamps it here.
    // Gated on wireLog: without a trace sink the hash would be computed and discarded on every call.
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
      const runnable = tools.length > 0
        ? bridge.bindTools(tools, {
            tool_choice: toLangChainToolChoice(choice),
          })
        : bridge;
      const messages = system
        ? [new SystemMessage(system), ...history]
        : [...history];
      const parts: PortGenerationPart[] = [];
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        if (signal?.aborted) throw cancelledError();
        if (typeof chunk.content === 'string' && chunk.content) {
          onTextDelta?.(chunk.content);
          parts.push({ type: 'text', text: chunk.content });
        }
        for (const call of chunk.tool_call_chunks ?? []) {
          if (!call.id || !call.name || typeof call.args !== 'string') {
            throw new ModelPortError(
              'unsupported_response',
              'Language model returned an incomplete tool call.',
            );
          }
          parts.push({
            type: 'tool-call',
            callId: call.id,
            toolName: call.name,
            input: parseToolInput(call.args),
          });
        }
      }
      if (signal?.aborted) throw cancelledError();
      // One measurement row per completed generation, for all three port entry points. `usage` is
      // omitted rather than zeroed: `vscode.lm` reports no token counts at all, and a zero would be
      // indistinguishable from a provider that genuinely billed nothing.
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason: parts.some((part) => part.type === 'tool-call') ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return parts;
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

function parseToolInput(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelPortError(
      'unsupported_response',
      'Language model returned non-object tool input.',
    );
  }
  return parsed as Record<string, unknown>;
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
  return error instanceof ModelPortError && error.code === 'cancelled'
    || (error instanceof Error
      && ['AbortError', 'Canceled', 'Cancelled'].includes(error.name));
}

function cancelledError(): ModelPortError {
  return new ModelPortError('cancelled', 'Language model request was cancelled.');
}
