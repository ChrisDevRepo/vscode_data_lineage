import * as vscode from 'vscode';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import {
  type CompleteTextInput,
  type GeneratedToolCall,
  type GenerateStructuredInput,
  type ModelPort,
  type ModelIdentity,
  ModelPortError,
  matchProseToolCall,
  PROSE_PROMOTED_CALL_ID,
  createStreamRepetitionObserver,
  type ModelToolChoice,
  type ModelToolDefinition,
  type RepetitionStrike,
  type ToolGenerationContent,
  type ToolGenerationInput,
  type ToolGenerationResult,
  cancelledToolTurnResult,
  errorToolTurnResult,
  isHostCancellationError,
  isPortCancellation,
} from './modelPort';
import type { InstructionPhase } from '../agent/instructionPlan';
import { VscodeLangChainBridge } from './vscodeLangChainBridge';
import { systemPromptHash, type WireEvent, type WireRecord } from '../observability/wireLog';
import { toModelJsonSchema } from '../tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
} from '../support/text';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../support/tokenBudget';
import { rejectionFromZodError } from '../support/toolErrorEnvelope';
import { droppedKeyPaths } from '../support/inputNormalization';
import { sanitizeForLog, trunc } from '../../utils/log';
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

const STREAM_TEXT_CHAR_CEILING = 200_000;

/**
 * Streamed-text ceiling per {@link InstructionPhase}, calibrating
 * {@link STREAM_TEXT_CHAR_CEILING} instead of adding a second guard site.
 *
 * Each cap is anchored on the ~33.6 KB global legitimate maximum documented on
 * {@link STREAM_TEXT_CHAR_CEILING}, never on a phase's own observed maximum alone:
 *
 * - `detect_entry`, `sm_entry`, `visual_preview`, `synthesis` 100,000 — legitimate text on these
 *   phases is a few hundred chars at most, far too thin to tighten below the legitimate envelope,
 *   so each is anchored at 3x the global maximum.
 * - `discover`, `active` 50,000 — the two phases that legitimately stream prose, at ~1.5x the
 *   global maximum, which is still an order of magnitude above their own legitimate maxima.
 * - `compose` 200,000 — the text channel IS the deliverable there (`completeText` discards
 *   `hitCeiling`), so a cut would be delivered silently with no retry behind it; it keeps the
 *   outer bound.
 * - `completed` 200,000 — no model call is issued under the label; outer bound.
 *
 * Total over {@link InstructionPhase} by construction: a new phase member fails to compile until
 * it is mapped here. An unrecognized phase string resolves through {@link streamTextCharCeiling}
 * to the outer bound, never to a smaller cap.
 */
const PHASE_STREAM_TEXT_CHAR_CEILINGS: Readonly<Record<InstructionPhase, number>> = {
  detect_entry: 100_000,
  discover: 50_000,
  visual_preview: 100_000,
  sm_entry: 100_000,
  active: 50_000,
  compose: STREAM_TEXT_CHAR_CEILING,
  synthesis: 100_000,
  completed: STREAM_TEXT_CHAR_CEILING,
};

/** Resolves the streamed-text ceiling for one call: its phase cap, or the outer bound when unknown. */
function streamTextCharCeiling(phase: string | undefined): number {
  if (phase === undefined) return STREAM_TEXT_CHAR_CEILING;
  const mapped = PHASE_STREAM_TEXT_CHAR_CEILINGS[phase as InstructionPhase];
  return typeof mapped === 'number' ? mapped : STREAM_TEXT_CHAR_CEILING;
}

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
      const { parts: response, hitCeiling, nonTextChars } = await this.collectGeneration(
        input.messages,
        input.system,
        definitions,
        input.toolChoice,
        input.signal,
        input.onTextDelta,
        input.phase,
        input.requiresToolCall === true,
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
            input: part.input,
            code: REJECTION_CODES.duplicateCallId,
            reason: 'The provider repeated a tool call identifier.',
          };
        } else if (!definition) {
          call = {
            valid: false,
            callId: part.callId,
            toolName: part.toolName,
            input: part.input,
            code: REJECTION_CODES.unknownTool,
            reason: 'Tool is not available in this phase.',
          };
        } else {
          const parsed = definition.inputSchema.safeParse(part.input);
          const dropped = parsed.success ? droppedKeyPaths(part.input, parsed.data) : [];
          if (dropped.length > 0) {
            this.options.debugLog?.(
              `[AI] tool-input-keys-dropped tool=${part.toolName} paths=${trunc(sanitizeForLog(dropped.join(',')), 200)}`,
            );
          }
          if (parsed.success) {
            call = {
              valid: true,
              callId: part.callId,
              toolName: part.toolName,
              input: parsed.data,
            };
          } else {
            const rejection = rejectionFromZodError(
              parsed.error,
              { code: REJECTION_CODES.invalidToolInput, input: part.input },
            );
            call = {
              valid: false,
              callId: part.callId,
              toolName: part.toolName,
              input: part.input,
              code: REJECTION_CODES.invalidToolInput,
              reason: rejection.reason,
              hint: rejection.hint,
              issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
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

      const finishReason = hitCeiling ? 'length' : toolCalls.length > 0 ? 'tool-calls' : 'stop';
      this.options.debugLog?.(
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}`
        + ` observed_parts=${content.length} observed_text_chars=${text.length}`
        + ` observed_nontext_chars=${nonTextChars}`
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
    if (input.signal?.aborted) throw cancelledError();
    const definitions: ModelToolDefinition[] = [{
      name: STRUCTURED_OUTPUT_TOOL,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      inputSchema: input.schema,
    }];
    this.modelCalls += 1;
    const { parts: response } = await this.collectGeneration(
      input.messages,
      input.system,
      definitions,
      { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
      input.signal,
      undefined,
      input.phase,
      true,
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
      emptyRequiredPayload ? REJECTION_CODES.emptyStructuredOutput : REJECTION_CODES.invalidStructuredOutput,
    );
  }

  /** Completes text without exposing tools. */
  public async completeText(input: CompleteTextInput): Promise<string> {
    if (input.signal?.aborted) throw cancelledError();
    this.modelCalls += 1;
    const { parts: response } = await this.collectGeneration(
      input.messages,
      input.system,
      [],
      'none',
      input.signal,
      undefined,
      input.phase,
      false,
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
    requiresToolCall = false,
  ): Promise<{ parts: readonly PortGenerationPart[]; hitCeiling: boolean; nonTextChars: number }> {
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
      let nonTextChars = 0;
      let hitCeiling = false;
      let sawToolCallDelta = false;
      const textCeiling = streamTextCharCeiling(phase);
      const repetition = requiresToolCall ? createStreamRepetitionObserver() : undefined;
      let repetitionStrike: RepetitionStrike | null = null;
      const stream = await runnable.stream(messages, { signal });
      for await (const chunk of stream) {
        clearTimeout(watchdog);
        if (signal?.aborted) throw cancelledError();
        if (typeof chunk.content === 'string' && chunk.content) {
          onTextDelta?.(chunk.content);
          parts.push({ type: 'text', text: chunk.content });
          textChars += chunk.content.length;
          if (!sawToolCallDelta && repetitionStrike === null) {
            repetitionStrike = repetition?.observe(chunk.content) ?? null;
          }
        }
        const streamedNonText = chunk.response_metadata?.nonTextChars;
        if (typeof streamedNonText === 'number') nonTextChars += streamedNonText;
        for (const call of chunk.tool_call_chunks ?? []) {
          sawToolCallDelta = true;
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
        if (
          textChars >= STREAM_TEXT_CHAR_CEILING
          || (textChars >= textCeiling && !sawToolCallDelta)
          || (repetitionStrike !== null && !sawToolCallDelta)
        ) {
          hitCeiling = true;
          this.options.debugLog?.(
            repetitionStrike
              ? `[AI] stream-repetition phase=${phase ?? 'unknown'} call=${generation}`
                + ` chars=${textChars} repeats=${repetitionStrike.repeats}`
                + ` line=${trunc(sanitizeForLog(repetitionStrike.line), 120)}`
              : `[AI] stream-ceiling phase=${phase ?? 'unknown'} call=${generation} chars=${textChars} nontext=${nonTextChars} cap=${textCeiling}`,
          );
          break;
        }
      }
      if (signal?.aborted) throw cancelledError();
      if (watchdogFired) throw firstOutputTimeoutError();
      const promotion = hitCeiling || parts.some((part) => part.type === 'tool-call')
        ? { kind: 'none' as const }
        : matchProseToolCall(
            parts
              .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> => part.type === 'text')
              .map((part) => part.text)
              .join(''),
            definitions,
          );
      const resolvedParts: readonly PortGenerationPart[] = promotion.kind === 'promoted'
        ? [{
            type: 'tool-call',
            callId: PROSE_PROMOTED_CALL_ID,
            toolName: promotion.toolName,
            input: promotion.input,
          }]
        : parts;
      if (promotion.kind === 'promoted') {
        this.options.debugLog?.(
          `[AI] prose-tool-call-promoted phase=${phase ?? 'unknown'} call=${generation}`
          + ` tool=${promotion.toolName}`,
        );
      } else if (promotion.kind === 'ambiguous') {
        this.options.debugLog?.(
          `[AI] prose-tool-call-ambiguous phase=${phase ?? 'unknown'} call=${generation}`
          + ` tools=${promotion.tools.join(',')}`,
        );
      }
      emitWire?.({
        type: 'generation',
        modelId: this.model.id,
        finishReason: hitCeiling
          ? 'length'
          : resolvedParts.some((part) => part.type === 'tool-call') ? 'tool-calls' : 'stop',
        latencyMs: Date.now() - startedAt,
      });
      return { parts: resolvedParts, hitCeiling, nonTextChars };
    } catch (error) {
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
  return isPortCancellation(error) || isHostCancellationError(error);
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
