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

// Backstop against an unbounded drain when a provider streams prose (e.g. pseudo-tool-call markup)
// instead of a real tool call: UAT recorded a 3,638,544-char runaway against a ~33.6 KB legitimate
// maximum, so 200,000 sits far above any real answer while stopping a runaway drain early.
const STREAM_TEXT_CHAR_CEILING = 200_000;

// A provider that streams nothing at all is indistinguishable from a hung connection: UAT recorded
// a generation that produced zero chunks for 16m42s until manually cancelled, and neither
// `vscode.lm` nor Copilot Chat's default fetchers bound that path. The watchdog covers ONLY the
// zero-output window — the first streamed chunk of any kind disarms it for the rest of the
// generation, so a model that is thinking or streaming slowly is never interrupted. 600s still
// bounds that hang while leaving better than 2x margin over the slowest completed generation
// observed in the same UAT (270.5s): the observed maximum is a sample, not a ceiling, and a
// margin that thin would abort a slower model that was about to answer.
const FIRST_OUTPUT_TIMEOUT_MS = 600_000;

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
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      this.options.debugLog?.(
        `[AI] generation-timeout phase=${phase ?? 'unknown'} call=${generation}`
        + ` zero output after ${FIRST_OUTPUT_TIMEOUT_MS}ms — cancelling the request`,
      );
      cancellation.source.cancel();
    }, FIRST_OUTPUT_TIMEOUT_MS);
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
      let textChars = 0;
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        clearTimeout(watchdog);
        if (signal?.aborted) throw cancelledError();
        if (typeof chunk.content === 'string' && chunk.content) {
          onTextDelta?.(chunk.content);
          parts.push({ type: 'text', text: chunk.content });
          textChars += chunk.content.length;
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
        // Breaking here (rather than throwing) closes the underlying stream through the normal
        // async-generator return path and lets the accumulated `parts` fall through as an ordinary
        // completed, tool-call-free generation — the same shape the retry-capable
        // missing-required-tool path already handles, so no new failure branch is needed.
        if (textChars >= STREAM_TEXT_CHAR_CEILING) {
          this.options.debugLog?.(
            `[AI] stream-ceiling phase=${phase ?? 'unknown'} call=${generation} chars=${textChars}`,
          );
          break;
        }
      }
      if (signal?.aborted) throw cancelledError();
      // A cancelled underlying stream may end through the normal return path instead of throwing.
      if (watchdogFired) throw firstOutputTimeoutError();
      // UAT turns n15/n16 (minimax-m3) answered with a complete, schema-valid tool payload fenced
      // as prose seven times in a row; each drew a synthetic `missing_required_tool_call` rejection
      // because the provider never emitted a native tool-call chunk. Promotion recovers that call
      // before it is measured, so a payload the tool's own schema accepts never pays for the miss.
      const resolvedParts = promoteProseToolCall(parts, definitions);
      if (resolvedParts !== parts) {
        this.options.debugLog?.(
          `[AI] prose-tool-call-promoted phase=${phase ?? 'unknown'} call=${generation}`
          + ` tool=${(resolvedParts[0] as { readonly toolName: string }).toolName}`,
        );
      }
      // One measurement row per completed generation, for all three port entry points. `usage` is
      // omitted rather than zeroed: `vscode.lm` reports no token counts at all, and a zero would be
      // indistinguishable from a provider that genuinely billed nothing.
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason: resolvedParts.some((part) => part.type === 'tool-call') ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return resolvedParts;
    } catch (error) {
      // The watchdog aborts through the shared cancellation token, so the stream surfaces its
      // expiry as a cancellation — reclassify it here so it reaches callers as a provider timeout
      // error, never as a silent user cancel. It is logged and charged to the phase's provider-call
      // budget, and fails the turn: the code is deliberately not transport-classified, so submitted
      // hops are not salvaged behind it.
      const surfaced = watchdogFired && !signal?.aborted && isCancellation(error)
        ? firstOutputTimeoutError(error)
        : error;
      if (emitWire && requestEmitted && !signal?.aborted && !isCancellation(surfaced)) {
        emitWire({
          type: 'wire-error',
          diagnostic: sanitizeProviderErrorDiagnostic(surfaced, phase ?? 'unknown'),
        });
      }
      throw surfaced;
    } finally {
      clearTimeout(watchdog);
      cancellation.dispose();
    }
  }
}

/** A fenced ```json (or bare ```) code block wrapping exactly one JSON value. */
const FENCED_JSON_BLOCK = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * Recovers a tool call a provider described as fenced JSON prose instead of emitting through the
 * native tool-call channel.
 *
 * @remarks
 * Promotion fires only when `parts` carries no real tool-call part already, its concatenated text
 * contains a fenced JSON block, that block parses, and the parsed object validates against one of
 * `definitions`' own input schemas — the same {@link ModelToolDefinition.inputSchema} the native
 * path validates against, so nothing here relaxes what a tool accepts. Any failure at any step
 * returns `parts` unchanged **by reference**, so a caller can test `resolvedParts !== parts` and a
 * generation that does not qualify is byte-identical to today's rejection path.
 *
 * @param parts - The drained generation, in stream order.
 * @param definitions - Tool definitions offered for this generation, already narrowed to the
 * active tool choice.
 * @returns `parts` unchanged, or a single-element array holding the promoted tool-call part.
 */
function promoteProseToolCall(
  parts: readonly PortGenerationPart[],
  definitions: readonly ModelToolDefinition[],
): readonly PortGenerationPart[] {
  if (definitions.length === 0 || parts.some((part) => part.type === 'tool-call')) return parts;
  const text = parts
    .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const match = FENCED_JSON_BLOCK.exec(text);
  if (!match) return parts;
  let candidate: unknown;
  try {
    candidate = JSON.parse(match[1]);
  } catch {
    return parts;
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return parts;
  const definition = definitions.find((entry) => entry.inputSchema.safeParse(candidate).success);
  if (!definition) return parts;
  return [{
    type: 'tool-call',
    callId: 'text-promoted-0',
    toolName: definition.name,
    input: candidate,
  }];
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

/** Timeout raised when a generation produced no output at all within {@link FIRST_OUTPUT_TIMEOUT_MS}. */
function firstOutputTimeoutError(cause?: unknown): ModelPortError {
  return new ModelPortError(
    'provider_error',
    `The language model produced no output within ${FIRST_OUTPUT_TIMEOUT_MS / 1000}s; the request was aborted (first-output timeout).`,
    cause,
  );
}
