/**
 * A {@link ModelPort} over any OpenAI-compatible `/chat/completions` endpoint, for headless
 * live-provider runs.
 *
 * @remarks
 * This is the harness's only provider transport. It is deliberately a raw `fetch` against one
 * non-streamed endpoint rather than a client library:
 *
 * - **`stream: false` (DD-1).** One JSON body in, one JSON body out, so the trace can hold the
 *   verbatim bytes both ways — the requirement the whole harness exists for. Streamed tool-call
 *   delta reassembly is also the most bug-prone part of any OpenAI client, and it sits exactly where
 *   DeepSeek misbehaves; `usage` is only reliably reported non-streamed. The `stream` capability is
 *   a reserved seam and is rejected rather than silently ignored.
 * - **`/chat/completions` for every lane (DD-2).** OpenRouter and local MLX servers serve only it,
 *   Azure Foundry serves both — one protocol keeps cross-lane traces diffable.
 * - **Exactly one attempt, ever (DD-4).** No retries at any level. A failure is a measurement; a
 *   silent retry would corrupt the latency and token axes and hide the intermittency the harness
 *   exists to expose.
 *
 * **Semantics mirror `VscodeModelPort.generateToolTurn` exactly**, in the same pinned order:
 * pre-abort → narrow by tool choice → one `modelCalls` increment → per-call duplicate → unknown
 * tool → argument parse → schema. Every classification helper is the production one, imported
 * verbatim, so a rejection reason the graph repairs on this lane is the same string it repairs on
 * the native lane. Two documented divergences, both pinned by port-specific tests:
 *
 * 1. **Unparsable `arguments` are a per-call `invalid_tool_input`, not a whole-generation error**
 *    (DD-5). `VscodeModelPort` throws on a malformed tool input because the native API hands it a
 *    parsed object and a malformed one means the host itself is broken. Here empty or non-JSON
 *    `arguments` is a *routine* DeepSeek failure class, and failing the whole generation would
 *    disengage the repair loop that is under measurement.
 * 2. **The provider's `finish_reason` is honoured.** `length` and `content_filter` map onto the
 *    result contract's `'length'`/`'content-filter'`, which engages `toolAttempt.ts`'s existing
 *    truncation guard. `VscodeModelPort` can never produce those because `vscode.lm` reports no
 *    finish reason at all — this is the contract being met, not widened. The verbatim provider
 *    string is always kept in the `generation` and `wire-response` trace records.
 *
 * Credentials (DD-7): the API key is sent as a Bearer header and appears in no record of any kind —
 * headers are never captured, and every error is sanitized before it reaches a sink.
 *
 * No `vscode` import, direct or transitive: the port must be constructible under plain Node and
 * under vitest.
 */
import type { BaseMessage } from '@langchain/core/messages';
import {
  type CompleteTextInput,
  type GeneratedToolCall,
  type GenerateStructuredInput,
  type ModelIdentity,
  type ModelPort,
  ModelPortError,
  type ModelToolChoice,
  type ModelToolDefinition,
  type ToolGenerationContent,
  type ToolGenerationInput,
  type ToolGenerationResult,
  cancelledToolTurnResult,
  errorToolTurnResult,
  isPortCancellation,
} from '../../src/ai/model/modelPort';
import {
  systemPromptHash,
  type TokenUsage,
  type WireEvent,
  type WireRecord,
} from '../../src/ai/observability/wireLog';
import { toModelJsonSchema } from '../../src/ai/tools/jsonSchema';
import {
  formatProviderErrorDiagnostic,
  sanitizeProviderError,
  sanitizeProviderErrorDiagnostic,
} from '../../src/ai/support/text';
import { REJECTION_CODES } from '../../src/ai/support/rejectionCodes';
import { rejectionFromZodError } from '../../src/ai/support/toolErrorEnvelope';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  StructuredOutputError,
  structuredRejectReason,
} from '../../src/ai/providers/structuredOutput';
import {
  projectMessages,
  readUsage,
  suspectsToolCallAsText,
  toWireMessages,
} from './openAiWire';

/** Minimal HTTP response surface the port consumes; keeps the module free of DOM/node lib skew. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

/** Request shape handed to {@link FetchLike}; headers exist here and nowhere else. */
export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** The injectable transport. Production passes global `fetch`; tests pass canned responses. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Provider capabilities that change what the port sends or keeps. */
export interface OpenAiLaneCapabilities {
  /**
   * Whether a previous turn's `reasoning_content` is echoed back (DD-3).
   *
   * @remarks
   * DeepSeek returns `500` for a follow-up request whose assistant turn lost it. The cache is
   * port-owned and turn-scoped; the value never enters LangChain history.
   */
  readonly echoReasoning?: boolean;
  /** Reserved seam. `true` is rejected: the harness captures whole bodies, not deltas (DD-1). */
  readonly stream?: boolean;
  /** A lane without native tool calling is a configuration error, never a runtime fallback. */
  readonly nativeToolCalling?: boolean;
}

/**
 * Provider-specific request-body tuning. Every field lands verbatim in the request body, so a
 * verbose trace's `provider-raw` capture always shows exactly what tuning was active for a run.
 */
export interface OpenAiRequestTuning {
  /**
   * Sent verbatim as the request's `reasoning` field.
   *
   * @remarks
   * DeepSeek-family models reason by default, and with `stream: false` the time-to-first-byte is
   * the full reasoning duration (deepseek-ai/DeepSeek-V3#1464 measured 31.8s → 2.7s for the same
   * call once thinking was disabled). The cancelled T6 run spent 150–182s per late hop generating
   * up to ~2,000 reasoning tokens per call; this field attacks exactly that.
   *
   * Measured on 2026-08-07 (T6, deepseek-v4-flash): `{ enabled: false }` cut per-generation
   * latency ~10x but cost the model its ability to repair strict-schema rejections — two runs in
   * a row burned the 3-failure semantic budget re-sending the same over-length `badge_label`.
   * `{ effort: 'low' }` is the compromise: bounded thinking kept for self-correction.
   */
  readonly reasoning?: { readonly enabled: false } | { readonly effort: 'low' | 'medium' | 'high' };
  /**
   * Sends `provider: { sort: … }` (OpenRouter routing preference).
   *
   * @remarks
   * OpenRouter's default load balancer weights by inverse-square *price*, not speed, and the same
   * DeepSeek model varies ~14x in throughput across its backends. `throughput` pins the run to the
   * fast end so per-generation latency measures the model, not the routing lottery.
   */
  readonly providerSort?: 'throughput' | 'latency' | 'price';
}

/** Everything the port needs to reach one endpoint. A resolved lane satisfies this shape. */
export interface OpenAiCompatiblePortConfig {
  /** API root including the version prefix, e.g. `https://openrouter.ai/api/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as `Authorization: Bearer …`; never logged, traced, or included in an error. */
  readonly apiKey: string;
  /** Lane identifier, surfaced as the identity vendor so a trace names its lane. */
  readonly laneId?: string;
  /** Whole-request budget including the body read; defaults to five minutes. */
  readonly requestTimeoutMs?: number;
  readonly capabilities?: OpenAiLaneCapabilities;
  /** Optional request-body tuning; absent fields send nothing extra. */
  readonly requestTuning?: OpenAiRequestTuning;
}

/** Sinks and seams; all optional, so the port is constructible with configuration alone. */
export interface OpenAiCompatiblePortOptions {
  readonly debugLog?: (message: string) => void;
  /** Native request identifier shared by wire and runtime lifecycle records. */
  readonly requestId?: string;
  /** Debug wire sink, supplied only when session trace logging is enabled. */
  readonly wireLog?: (record: WireRecord) => void;
  /** Whether the active trace captures the system instruction and verbatim provider bodies. */
  readonly traceVerbose?: boolean;
  /** Transport seam. Defaults to the runtime's global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

/** One completed generation, as the run summary records it. */
export interface OpenAiGenerationSummary {
  /** 1-based model-call index within the port. */
  readonly generation: number;
  readonly phase?: string;
  /** The provider's `finish_reason`, verbatim. */
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly usage?: TokenUsage;
  /** DD-5 heuristic flag — a suspicion recorded for analysis, never a status. */
  readonly suspectedToolCallAsText: boolean;
  readonly toolCalls: number;
  readonly textChars: number;
}

/** Default whole-request budget; a reasoning model on a cold route legitimately takes minutes. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

type PortGenerationPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      /** Parsed object arguments; absent when {@link argumentsIssue} is set. */
      readonly input?: Record<string, unknown>;
      /** Why the arguments could not be used, when they could not. */
      readonly argumentsIssue?: 'empty' | 'malformed';
      readonly rawArguments: string;
    };

interface CollectedGeneration {
  readonly parts: readonly PortGenerationPart[];
  /** Provider `finish_reason`, verbatim. */
  readonly rawFinishReason: string;
  /** Contract-vocabulary anomaly, when the provider reported one. */
  readonly anomaly: 'length' | 'content-filter' | null;
  readonly usage?: TokenUsage;
}

/** Request-scoped model port over one OpenAI-compatible endpoint. */
export class OpenAiCompatiblePort implements ModelPort {
  /** Request-scoped adapter identifier naming the lane and model. */
  public readonly id: string;

  /** Metadata for the configured model; this protocol advertises none, so it is lane-declared. */
  public readonly identity: ModelIdentity;

  /** Number of provider requests attempted through this port. */
  public modelCalls = 0;

  /** Every completed generation, in call order — the run summary's measurement rows. */
  public readonly generations: OpenAiGenerationSummary[] = [];

  /**
   * Turn-scoped `reasoning_content` cache, keyed by every tool-call id the generation emitted and
   * by its text (DD-3). Port-owned so the provider-specific field never reaches graph history.
   */
  private readonly reasoning = new Map<string, string>();

  private readonly fetchImpl: FetchLike;

  public constructor(
    private readonly config: OpenAiCompatiblePortConfig,
    private readonly options: OpenAiCompatiblePortOptions = {},
  ) {
    if (config.capabilities?.stream === true) {
      throw new ModelPortError(
        'invalid_request',
        'Streaming is not implemented on the OpenAI-compatible lane; verbatim body capture requires stream:false.',
      );
    }
    if (config.capabilities?.nativeToolCalling === false) {
      throw new ModelPortError(
        'invalid_request',
        'Lane declares nativeToolCalling:false; the lineage runtime requires native tool calling.',
      );
    }
    this.id = `openai-compatible:${config.laneId ?? 'custom'}:${config.model}`;
    this.identity = {
      id: config.model,
      name: config.model,
      vendor: config.laneId ?? 'openai-compatible',
      family: 'openai-compatible',
      version: 'v1',
    };
    const runtimeFetch = (globalThis as unknown as { fetch?: FetchLike }).fetch;
    const injected = options.fetchImpl ?? runtimeFetch;
    if (!injected) {
      throw new ModelPortError(
        'invalid_request',
        'No fetch implementation is available; pass options.fetchImpl.',
      );
    }
    this.fetchImpl = injected;
    // Record the configured model before any provider request can fail.
    this.options.debugLog?.(
      `[AI] model id=${config.model} vendor=${this.identity.vendor} lane=${config.laneId ?? 'custom'}`,
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

      for (const part of response.parts) {
        if (part.type === 'text') {
          text += part.text;
          content.push({ type: 'text', text: part.text });
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
        } else if (part.argumentsIssue) {
          // DIVERGENCE (DD-5): a routine provider failure class on this lane, so it is charged to
          // the call and repaired next round, not raised as a whole-generation provider error.
          call = {
            valid: false,
            callId: part.callId,
            toolName: part.toolName,
            code: 'invalid_tool_input',
            reason: part.argumentsIssue === 'empty'
              ? 'Tool arguments were empty; send the required fields as a JSON object.'
              : 'Tool arguments were not a JSON object.',
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

      if (content.length === 0) {
        this.options.debugLog?.(
          `[AI] empty-generation phase=${input.phase} call=${this.modelCalls}`,
        );
      }

      const finishReason = response.anomaly
        ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop');
      this.options.debugLog?.(
        `[AI] usage phase=${input.phase} outcome=${finishReason} call=${this.modelCalls}`
        + ` observed_parts=${content.length} observed_text_chars=${text.length}`
        + ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}`
        + ` provider_finish=${response.rawFinishReason}`
        + ` ${describeUsage(response.usage)}`,
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
    const response = await this.collectGeneration(
      input.messages,
      input.system,
      definitions,
      { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
      input.signal,
      undefined,
      input.phase,
    );
    const calls = response.parts.filter(
      (part): part is Extract<PortGenerationPart, { type: 'tool-call' }> =>
        part.type === 'tool-call' && part.toolName === STRUCTURED_OUTPUT_TOOL,
    );
    const single = calls.length === 1 ? calls[0] : undefined;
    const parsed = single && !single.argumentsIssue
      ? input.schema.safeParse(single.input)
      : undefined;
    if (parsed?.success) return parsed.data;
    // Empty `arguments` and an empty object mean the same thing here — the model returned no
    // fields — so both classify as `empty_structured_output`, the code graph recovery keys off.
    const emptyRequiredPayload = single !== undefined
      && (single.argumentsIssue === 'empty' || isEmptyRecord(single.input));
    throw new StructuredOutputError(
      emptyRequiredPayload
        ? `${STRUCTURED_OUTPUT_TOOL} arguments were empty`
        : calls.length > 1
        ? `multiple ${STRUCTURED_OUTPUT_TOOL} tool calls`
        : single?.argumentsIssue === 'malformed'
        ? `${STRUCTURED_OUTPUT_TOOL} arguments were not a JSON object`
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
    if (response.parts.some((part) => part.type !== 'text')) {
      throw new ModelPortError(
        'unsupported_response',
        'Text completion returned a tool call.',
      );
    }
    return response.parts
      .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> =>
        part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
  }

  /** Performs the one provider request behind every entry point and records what crossed the wire. */
  private async collectGeneration(
    history: readonly BaseMessage[],
    system: string | undefined,
    definitions: readonly ModelToolDefinition[],
    choice: ModelToolChoice | undefined,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
    phase?: string,
  ): Promise<CollectedGeneration> {
    const wireLog = this.options.wireLog;
    // Captured now rather than read at emit time: concurrent generations would otherwise all stamp
    // whichever call happened to increment the counter last.
    const generation = this.modelCalls;
    let requestEmitted = false;
    const systemFields = system
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

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const messages = projectMessages(
      system,
      history,
      this.config.capabilities?.echoReasoning ? (ids, text) => this.recalledReasoning(ids, text) : undefined,
    );
    const tools = definitions.map((definition) => ({
      type: 'function' as const,
      function: {
        name: definition.name,
        description: definition.description,
        parameters: toModelJsonSchema(definition.inputSchema),
      },
    }));
    const payload = {
      model: this.config.model,
      messages,
      stream: false,
      ...(this.config.requestTuning?.reasoning ? { reasoning: this.config.requestTuning.reasoning } : {}),
      ...(this.config.requestTuning?.providerSort
        ? { provider: { sort: this.config.requestTuning.providerSort } }
        : {}),
      ...(tools.length > 0
        ? { tools, tool_choice: toOpenAiToolChoice(choice) }
        : {}),
    };

    const startedAt = Date.now();
    try {
      emitWire?.({
        type: 'wire-request',
        messages: toWireMessages(messages),
        tools: definitions.map((definition) => ({
          name: definition.name,
          inputSchema: toModelJsonSchema(definition.inputSchema),
        })),
      });
      if (this.options.traceVerbose) {
        emitWire?.({ type: 'provider-raw', direction: 'request', url, method: 'POST', body: payload });
      }
      const received = await this.send(url, payload, signal);
      if (signal?.aborted) throw cancelledError();
      if (this.options.traceVerbose) {
        emitWire?.({
          type: 'provider-raw',
          direction: 'response',
          url,
          status: received.status,
          // A failure body is the one place a provider can echo the Authorization header back, so
          // it is sanitized; a successful body cannot contain it and is captured verbatim (DD-7).
          body: received.ok ? received.body : sanitizeProviderError(received.raw),
        });
      }
      if (!received.ok) throw httpError(received.status, received.statusText, received.raw);
      if (received.body === undefined) {
        throw new ModelPortError(
          'unsupported_response',
          `Provider returned a non-JSON body (${received.raw.length} bytes).`,
        );
      }

      const collected = readCompletion(received.body);
      if (collected.reasoning) this.rememberReasoning(collected);
      const latencyMs = Date.now() - startedAt;
      const text = collected.parts
        .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const toolCallParts = collected.parts.filter(
        (part): part is Extract<PortGenerationPart, { type: 'tool-call' }> => part.type === 'tool-call',
      );
      // Non-streamed: the whole answer arrives at once, so there is exactly one delta.
      if (text) onTextDelta?.(text);

      emitWire?.({
        type: 'wire-response',
        text,
        toolCalls: toolCallParts.map((part) => ({
          callId: part.callId,
          name: part.toolName,
          // The unusable string itself when the arguments would not parse — that IS the evidence.
          input: part.input ?? part.rawArguments,
        })),
        finishReason: collected.rawFinishReason,
        ...(collected.usage ? { usage: collected.usage } : {}),
      });
      emitWire?.({
        type: 'generation',
        modelId: this.config.model,
        finishReason: collected.rawFinishReason,
        latencyMs,
        ...(collected.usage ? { usage: collected.usage } : {}),
      });
      this.generations.push({
        generation,
        ...(phase !== undefined ? { phase } : {}),
        finishReason: collected.rawFinishReason,
        latencyMs,
        ...(collected.usage ? { usage: collected.usage } : {}),
        // Only meaningful when the model emitted no structured call at all.
        suspectedToolCallAsText: toolCallParts.length === 0 && suspectsToolCallAsText(text),
        toolCalls: toolCallParts.length,
        textChars: text.length,
      });
      return {
        parts: collected.parts,
        rawFinishReason: collected.rawFinishReason,
        anomaly: collected.anomaly,
        ...(collected.usage ? { usage: collected.usage } : {}),
      };
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

  /**
   * Performs exactly one HTTP attempt and returns whatever came back.
   *
   * @remarks
   * A non-2xx status and an unparsable body are *returned*, not thrown, so the caller can capture
   * the bytes before classifying them — a trace that loses the body of the failure it is meant to
   * explain is worthless. Only a transport failure (no response at all) throws from here.
   *
   * The timeout covers the body read as well as the response headers: a provider that answers and
   * then stalls mid-body is the same measurement failure as one that never answers. The caller's
   * signal is forwarded rather than composed with `AbortSignal.any`, which is not available in every
   * lib configuration this file compiles under.
   */
  private async send(
    url: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    raw: string;
    /** The decoded body, or `undefined` when it was not JSON. */
    body: unknown;
  }> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    let timedOut = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        // The only place the credential appears. No record type carries headers, on any lane.
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        raw,
        body,
      };
    } catch (error) {
      if (timedOut) {
        throw new ModelPortError(
          'provider_error',
          `Provider request exceeded ${timeoutMs} ms.`,
          Object.assign(new Error('Provider request timed out.'), { code: 'ETIMEDOUT' }),
        );
      }
      if (signal?.aborted) throw cancelledError();
      if (error instanceof ModelPortError) throw error;
      throw new ModelPortError(
        'provider_error',
        sanitizeProviderError(error instanceof Error ? error.message : String(error))
          || 'Provider request failed.',
        error,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private rememberReasoning(collected: ReadCompletion): void {
    if (!collected.reasoning) return;
    const ids = collected.parts
      .filter((part): part is Extract<PortGenerationPart, { type: 'tool-call' }> => part.type === 'tool-call')
      .map((part) => part.callId);
    for (const id of ids) this.reasoning.set(`call:${id}`, collected.reasoning);
    const text = collected.parts
      .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (ids.length === 0 && text) this.reasoning.set(`text:${text}`, collected.reasoning);
  }

  /** Any cached reasoning for an assistant turn, matched by call id first and text as fallback. */
  private recalledReasoning(callIds: readonly string[], text: string): string | undefined {
    for (const id of callIds) {
      const hit = this.reasoning.get(`call:${id}`);
      if (hit) return hit;
    }
    return text ? this.reasoning.get(`text:${text}`) : undefined;
  }
}

interface ReadCompletion {
  readonly parts: readonly PortGenerationPart[];
  readonly rawFinishReason: string;
  readonly anomaly: 'length' | 'content-filter' | null;
  readonly usage?: TokenUsage;
  readonly reasoning?: string;
}

/** Decodes one `/chat/completions` body into ordered parts, keeping unusable arguments as evidence. */
function readCompletion(body: unknown): ReadCompletion {
  const root = asRecord(body);
  const choices = Array.isArray(root?.choices) ? root.choices : undefined;
  if (!choices || choices.length === 0) {
    throw new ModelPortError(
      'unsupported_response',
      'Provider response carried no choices.',
    );
  }
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const rawFinishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
  const parts: PortGenerationPart[] = [];
  const text = readContentText(message.content);
  if (text) parts.push({ type: 'text', text });
  for (const entry of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    const callId = typeof call?.id === 'string' && call.id ? call.id : '';
    const toolName = typeof fn?.name === 'string' ? fn.name : '';
    if (!callId || !toolName) {
      // A call with no id cannot be paired with its result, and one with no name cannot be routed;
      // neither is a repairable model mistake, so it stays a provider-protocol failure.
      throw new ModelPortError(
        'unsupported_response',
        'Provider returned a tool call without an identifier or name.',
      );
    }
    const rawArguments = typeof fn?.arguments === 'string' ? fn.arguments : '';
    parts.push({ type: 'tool-call', callId, toolName, rawArguments, ...parseArguments(rawArguments) });
  }
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content
    : undefined;
  const usage = readUsage(root?.usage);
  return {
    parts,
    rawFinishReason,
    anomaly: rawFinishReason === 'length'
      ? 'length'
      : rawFinishReason === 'content_filter' || rawFinishReason === 'content-filter'
        ? 'content-filter'
        : null,
    ...(usage ? { usage } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function parseArguments(serialized: string):
  | { readonly input: Record<string, unknown> }
  | { readonly argumentsIssue: 'empty' | 'malformed' } {
  if (!serialized.trim()) return { argumentsIssue: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { argumentsIssue: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { argumentsIssue: 'malformed' };
  }
  return { input: parsed as Record<string, unknown> };
}

/** Reads `message.content`, tolerating the array form some servers return. */
function readContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const entry of content) {
    const part = asRecord(entry);
    if (part && typeof part.text === 'string') text += part.text;
  }
  return text;
}

function httpError(status: number, statusText: string, rawBody: string): ModelPortError {
  const code = status === 400
    ? 'invalid_request'
    : status === 401 || status === 403
      ? 'no_permission'
      : status === 404
        ? 'model_not_found'
        : 'provider_error';
  // The body may echo the Authorization header on a 401; `sanitizeProviderError` redacts and caps it.
  const detail = sanitizeProviderError(rawBody);
  return new ModelPortError(
    code,
    `Provider returned ${status} ${statusText || 'error'}${detail ? `: ${detail}` : ''}.`,
    Object.assign(new Error(`HTTP ${status}`), { code: `HTTP_${status}` }),
  );
}

function toOpenAiToolChoice(choice: ModelToolChoice | undefined): unknown {
  if (choice === 'required') return 'required';
  if (choice === 'none') return 'none';
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.toolName } };
  return 'auto';
}

function describeUsage(usage: TokenUsage | undefined): string {
  if (!usage) return '(provider usage unavailable)';
  return `in=${usage.inputTokens ?? '-'} out=${usage.outputTokens ?? '-'}`
    + ` total=${usage.totalTokens ?? '-'} reasoning=${usage.reasoningTokens ?? '-'}`;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isCancellation(error: unknown): boolean {
  // The port-level predicate is the production classifier; the name check covers the raw
  // fetch/AbortController errors this HTTP harness sees before they are wrapped.
  return isPortCancellation(error)
    || (error instanceof Error
      && ['AbortError', 'Canceled', 'Cancelled'].includes(error.name));
}

function cancelledError(): ModelPortError {
  return new ModelPortError('cancelled', 'Language model request was cancelled.');
}
