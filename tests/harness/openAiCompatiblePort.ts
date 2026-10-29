/** Shared OpenAI-compatible ModelPort: production validation with headless HTTP transport. */
import { retryAfterDelayMs } from './httpRetry';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import {
  classifyToolCall,
  type CompleteTextInput,
  type EmittedToolCall,
  finishStructured,
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
  assertToolCallIds,
  cancelledError,
  cancelledToolTurnResult,
  errorToolTurnResult,
  isPortCancellation,
  messageContentToText,
  modelToolCallMessage,
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
  redactProviderSecrets,
  sanitizeProviderError,
  sanitizeProviderErrorDiagnostic,
} from '../../src/ai/support/text';
import { DEFAULT_TURN_TOKEN_BUDGET, estimateTokens, type TurnTokenBudget } from '../../src/ai/support/tokenBudget';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from '../../src/ai/providers/structuredOutput';
import {
  type OpenAiChatMessage,
  type ResponsesReasoning,
  projectMessages,
  readResponsesUsage,
  readUsage,
  toResponsesInput,
  suspectsToolCallAsText,
  toWireMessages,
} from './openAiWire';

/** Minimal HTTP response surface the port consumes; keeps the module free of DOM/node lib skew. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  /** Standard `Headers.get`; optional so a canned test response need not supply one (DD-4a). */
  readonly headers?: { get(name: string): string | null };
}

/** Request shape handed to {@link FetchLike}; headers exist here and nowhere else. */
export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** Injectable transport for deterministic checks; live runs use explicit HTTP deadlines. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Renders the reasoning tuning into the request-body fields the lane's dialect accepts. */
function reasoningPayload(tuning: OpenAiRequestTuning | undefined): Record<string, unknown> {
  const reasoning = tuning?.reasoning;
  if (!reasoning) return {};
  if (tuning?.reasoningStyle === 'chat_template_kwargs') {
    return 'enabled' in reasoning ? { chat_template_kwargs: { enable_thinking: false } } : {};
  }
  return 'effort' in reasoning ? { reasoning_effort: reasoning.effort } : {};
}

/** Renders an OpenRouter upstream allow-list into the request `provider` object. */
function providerRoutingPayload(routing: OpenRouterProviderRouting | undefined): Record<string, unknown> {
  if (!routing || routing.order.length === 0) return {};
  return { provider: { order: [...routing.order], allow_fallbacks: routing.allowFallbacks } };
}

/** Provider capabilities that change what the port sends or keeps. */
export interface OpenAiLaneCapabilities {
  /** Whether a previous turn's `reasoning_content` is echoed back (DD-3). */
  readonly echoReasoning?: boolean;
  /** Preserve the complete opaque OpenRouter reasoning_details sequence on assistant replay. */
  readonly echoReasoningDetails?: boolean;
  /** Reserved seam. `true` is rejected: the harness captures whole bodies, not deltas (DD-1). */
  readonly stream?: boolean;
  /** A lane without native tool calling is a configuration error, never a runtime fallback. */
  readonly nativeToolCalling?: boolean;
  /** Whether the provider accepts the object form of `tool_choice` (`{ type: 'function', function: { name } }`). Defaults to `true`. */
  readonly namedToolChoice?: boolean;
  /** Whether the provider accepts only `tool_choice: "auto"` (no `none`, `required` or named form). When `true`, every forced choice is sent as `'auto'`; the port already narrows the advertised tool set to the forced tool alone, so the one tool on offer is the forced one. */
  readonly autoToolChoiceOnly?: boolean;
}

/** Provider-specific request-body tuning. Every field lands verbatim in the request body, so a verbose trace's `provider-raw` capture always shows exactly what tuning was active for a run. */
/** The ONLY request knob the harness may set: thinking level, plus which dialect carries it. */
export interface OpenAiRequestTuning {
  /** Thinking level, rendered in the lane's {@link OpenAiRequestTuning.reasoningStyle} dialect. */
  readonly reasoning?: { readonly enabled: false } | { readonly effort: string };
  /** Which request-body dialect carries {@link OpenAiRequestTuning.reasoning}. */
  readonly reasoningStyle?: 'scalar' | 'chat_template_kwargs';
}

/** OpenRouter upstream allow-list. `allowFallbacks: false` keeps the router inside `order`. */
export interface OpenRouterProviderRouting {
  /** Upstream names in try order. */
  readonly order: readonly string[];
  readonly allowFallbacks: false;
}

/** Everything the port needs to reach one endpoint. A resolved lane satisfies this shape. */
export interface OpenAiCompatiblePortConfig {
  /** API root including the version prefix, e.g. `https://api.fireworks.ai/inference/v1`. */
  readonly baseUrl: string;
  /** Request wire: `chat_completions` (default) or the OpenAI Responses API (`/v1/responses`), which reasoning models need to combine function tools with reasoning effort. Same port, same decode, normalize and trace path for both. */
  readonly wire?: 'chat_completions' | 'responses';
  /** Complete request URL, replacing `${baseUrl}/chat/completions` when set. Needed for an endpoint that `baseUrl` cannot express, such as an Azure deployment URL with an `api-version` query. */
  readonly chatCompletionsUrl?: string;
  readonly model: string;
  /** Sent only in the configured authentication header; never logged or traced. */
  readonly apiKey: string;
  /** Lane identifier, surfaced as the identity vendor so a trace names its lane. */
  readonly laneId?: string;
  /** Azure deployment authentication uses api-key instead of Bearer authorization. */
  readonly apiKeyHeader?: 'api-key';
  /** Per-attempt budget including the body read; defaults to two hours. */
  readonly requestTimeoutMs?: number;
  readonly capabilities?: OpenAiLaneCapabilities;
  /** Optional request-body tuning; absent fields send nothing extra. */
  readonly requestTuning?: OpenAiRequestTuning;
  /** OpenRouter upstream allow-list. Absent on every lane except `openrouter`. Spread into the body as `provider`. */
  readonly providerRouting?: OpenRouterProviderRouting;
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
  /** Token budget this port's turn runs under. */
  readonly budget?: TurnTokenBudget;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 7_200_000;

/** DD-4a transient-transport retry, {@link OpenAiCompatiblePort.send} only. */
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET',
  // Connect-phase failures: no request reached the provider, so a retry cannot repeat a generation.
  'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND',
]);
/** Response headers a failed request's verbose trace keeps: rate-limit state and the provider's request id, which a provider's support needs to find the request. None carries a credential. */
const DIAGNOSTIC_RESPONSE_HEADERS = [
  'retry-after',
  'x-request-id',
  'request-id',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
] as const;

function diagnosticHeaders(response: { readonly headers?: { get(name: string): string | null } }): { diagnosticHeaders?: Record<string, string> } {
  const found: Record<string, string> = {};
  for (const name of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = response.headers?.get(name);
    if (value) found[name] = redactProviderSecrets(value);
  }
  return Object.keys(found).length > 0 ? { diagnosticHeaders: found } : {};
}

/** HTTP statuses retried under DD-4a; 429 honors `Retry-After` like every other entry here. */
const TRANSIENT_TRANSPORT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
/** Total attempts including the first, bounded per row early-stop (INSTRUMENT-BATCH-M8). */
const MAX_TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_RETRY_BASE_DELAY_MS = 500;
const TRANSPORT_RETRY_MAX_DELAY_MS = 5_000;
/** Full jitter fraction added on top of the exponential base, avoiding synchronized retry storms. */
const TRANSPORT_RETRY_JITTER_FRACTION = 0.25;

/** The error code a connection-level `fetch` rejection carries, on itself or on `.cause`. */
function transientTransportErrorCode(error: unknown): string | undefined {
  const direct = errorCode(error);
  if (direct) return direct;
  if (error && typeof error === 'object' && 'cause' in error) {
    return errorCode((error as { cause?: unknown }).cause);
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Bounded exponential backoff with full jitter, capped at {@link TRANSPORT_RETRY_MAX_DELAY_MS}. */
/** The transient status of an upstream failure delivered inside HTTP 200: `choices[0].finish_reason` is `"error"`, `choices[0].error.code` is in {@link TRANSIENT_TRANSPORT_HTTP_STATUSES}, and the choice carries no text and no tool call. A choice with any model output is never reported, so a retry cannot replace a measured answer (DD-4). */
function transientEnvelopeStatus(body: unknown): number | undefined {
  const choices = asRecord(body)?.choices;
  const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
  if (choice?.finish_reason !== 'error') return undefined;
  const code = Number(asRecord(choice.error)?.code);
  if (!TRANSIENT_TRANSPORT_HTTP_STATUSES.has(code)) return undefined;
  const message = asRecord(choice.message);
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  return readContentText(message?.content) || hasToolCalls ? undefined : code;
}

function transportRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, TRANSPORT_RETRY_MAX_DELAY_MS);
  const exponential = TRANSPORT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = exponential * TRANSPORT_RETRY_JITTER_FRACTION * Math.random();
  return Math.min(exponential + jitter, TRANSPORT_RETRY_MAX_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(cancelledError());
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

type PortGenerationPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      /** Parsed object arguments; absent when the arguments were empty or no JSON object. */
      readonly input?: Record<string, unknown>;
      /** Content-free JSON syntax category and zero-based character offset. */
      readonly argumentsDiagnostic?: string;
      readonly rawArguments: string;
      /** The call's opaque `extra_content`, verbatim, when the provider sent one. */
      readonly extraContent?: Record<string, unknown>;
    };

interface CollectedGeneration {
  readonly parts: readonly PortGenerationPart[];
  /** Provider `finish_reason`, verbatim. */
  readonly rawFinishReason: string;
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

  /** {@inheritDoc SingleGenerationModelPort.budget} */
  public readonly budget: TurnTokenBudget;

  /** Every completed generation, in call order — the run summary's measurement rows. */
  public readonly generations: OpenAiGenerationSummary[] = [];

  /** Turn-scoped `reasoning_content` cache, keyed by every tool-call id the generation emitted and by its text (DD-3). Port-owned so the provider-specific field never reaches graph history. */
  private readonly reasoning = new Map<string, string>();
  private readonly reasoningDetails = new Map<string, readonly unknown[]>();

  /** Per-call `extra_content` cache, keyed by call id. Port-owned for the same reason as {@link reasoning}: a LangChain `ToolCall` is `{id, name, args, type}` and has nowhere to carry a provider extra, so it is kept beside the message rather than inside it. Instance-scoped, so it lives no longer than the port — one run's captured signature never reaches another run. */
  private readonly toolExtraContent = new Map<string, Record<string, unknown>>();

  /** Per-turn `extra_content` fallback, keyed by every tool-call id one response emitted, holding the FIRST `extra_content` that response carried. A provider that signs only the first call of a parallel tool-call group leaves its siblings with none of their own; when such a sibling is replayed alone, the request still needs a signature for that assistant turn or the provider answers HTTP 400. Populated only for ids that arrived together in one {@link readCompletion} call, so a lookup can never cross into a different turn. */
  private readonly toolExtraContentTurn = new Map<string, Record<string, unknown>>();

  private readonly fetchImpl: FetchLike;
  private closeTransport?: () => Promise<void>;

  /** Close only the transport this port owns; injected fetch implementations remain caller-owned. */
  public async close(): Promise<void> { await this.closeTransport?.(); }

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
    this.budget = options.budget ?? DEFAULT_TURN_TOKEN_BUDGET;
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    } else {
      const { createProviderFetch } = require(
        `${process.cwd()}/tests/fixtures/lm-provider-extension/live-provider-adapter.js`,
      ) as { createProviderFetch: (timeoutMs: number) => FetchLike & { close: () => Promise<void> } };
      const transport = createProviderFetch(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.fetchImpl = transport;
      this.closeTransport = () => transport.close();
    }
    // Record the configured model before any provider request can fail.
    this.options.debugLog?.(
      `[AI] model id=${config.model} vendor=${this.identity.vendor} lane=${config.laneId ?? 'custom'}`,
    );
  }

  /** {@inheritDoc SingleGenerationModelPort.getNumTokens} — no live model to ask off the VS Code host, so this lane keeps LangChain's own chars/4 approximation ({@link estimateTokens}) rather than a second counter implementation. */
  public async getNumTokens(content: MessageContent): Promise<number> {
    return estimateTokens(messageContentToText(content).length);
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
      const replayed: Array<{ callId: string; toolName: string; input: unknown }> = [];
      let text = '';

      for (const part of response.parts) {
        if (part.type === 'text') {
          text += part.text;
          content.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.argumentsDiagnostic && definitionsByName.has(part.toolName)) this.options.debugLog?.(`[AI] tool-arguments ${part.argumentsDiagnostic}`);
        const { call, replayInput } = classifyToolCall(emittedCall(part), definitionsByName, this.options.debugLog);
        toolCalls.push(call);
        replayed.push({ callId: part.callId, toolName: part.toolName, input: replayInput });
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
        + ` tool_calls=${toolCalls.length} duration_ms=${Date.now() - startedAt}`
        + ` provider_finish=${response.rawFinishReason}`
        + ` ${describeUsage(response.usage)}`,
      );
      return {
        status: 'completed',
        message: modelToolCallMessage(replayed, text),
        content,
        text,
        toolCalls,
        finishReason,
      };
    } catch (error) {
      if (input.signal?.aborted || isCancellation(error)) {
        return cancelledToolTurnResult();
      }
      const diagnostic = this.safeDiagnostic(error, input.phase);
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
    const emitted = response.parts.flatMap((part) => (part.type === 'tool-call' ? [emittedCall(part)] : []));
    return finishStructured(emitted, input.schema, this.options.debugLog);
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

    const url = this.config.chatCompletionsUrl ?? `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const messages = projectMessages(
      system,
      history,
      this.config.capabilities?.echoReasoning ? (ids, text) => this.recalledReasoning(ids, text) : undefined,
      (callId, callIds) => this.toolExtraContent.get(callId) ?? this.recalledTurnExtraContent(callIds),
      this.config.capabilities?.echoReasoningDetails || this.config.wire === 'responses' ? (ids, text) => this.recalledReasoningDetails(ids, text) : undefined,
    );
    const tools = definitions.map((definition) => ({
      type: 'function' as const,
      function: {
        name: definition.name,
        description: definition.description,
        parameters: toModelJsonSchema(definition.inputSchema),
      },
    }));
    const responses = this.config.wire === 'responses';
    const toolChoice = this.config.capabilities?.autoToolChoiceOnly ? 'auto' : toOpenAiToolChoice(choice, this.config.capabilities?.namedToolChoice !== false);
    const payload = responses
      ? {
          model: this.config.model,
          input: toResponsesInput(messages),
          store: false,
          ...responsesReasoningPayload(this.config.requestTuning),
          ...(tools.length > 0
            ? { tools: tools.map(({ function: fn }) => ({ type: 'function' as const, ...fn, strict: false })), tool_choice: responsesToolChoice(toolChoice) }
            : {}),
        }
      : {
          model: this.config.model,
          messages,
          stream: false,
          ...reasoningPayload(this.config.requestTuning),
          ...providerRoutingPayload(this.config.providerRouting),
          ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
        };

    const startedAt = Date.now();
    try {
      emitWire?.({
        type: 'wire-request',
        messages: toWireMessages(responses ? messages.map(withoutReasoningPayload) : messages),
        tools: definitions.map((definition) => ({
          name: definition.name,
          descriptionHash: systemPromptHash(definition.description),
          inputSchema: toModelJsonSchema(definition.inputSchema),
        })),
      });
      if (this.options.traceVerbose) {
        emitWire?.({ type: 'provider-raw', direction: 'request', method: 'POST', body: responses ? omitEncrypted(payload) : payload });
      }
      const received = await this.send(url, payload, signal);
      if (signal?.aborted) throw cancelledError();
      if (this.options.traceVerbose) {
        emitWire?.({
          type: 'provider-raw',
          direction: 'response',
          status: received.status,
          ...(received.contentType ? { contentType: received.contentType } : {}),
          ...(received.diagnosticHeaders ? { headers: received.diagnosticHeaders } : {}),
          // Malformed successful responses and HTTP error bodies are kept whole for diagnosis, with
          // credentials, opaque tokens and URLs redacted. Parsed success bodies stay verbatim.
          body: received.ok
            ? (received.body !== undefined
                ? (responses ? omitEncrypted(received.body) : received.body)
                : received.raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'))
            : redactProviderSecrets(received.raw),
        });
      }
      if (!received.ok) throw httpError(received.status, received.statusText, received.raw);
      if (received.body === undefined) {
        throw new ModelPortError(
          'unsupported_response',
          `Provider returned a non-JSON body (${received.raw.length} bytes).`,
        );
      }

      const collected = responses ? readResponse(received.body) : readCompletion(received.body);
      if (collected.reasoning || collected.reasoningDetails) this.rememberReasoning(collected);
      this.rememberToolExtraContent(collected);
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
        // Only meaningful when the model emitted no structured call at all; a text generation stays
        // text, exactly as the product port treats it.
        suspectedToolCallAsText: toolCallParts.length === 0 && suspectsToolCallAsText(text),
        toolCalls: toolCallParts.length,
        textChars: text.length,
      });
      return {
        parts: collected.parts,
        rawFinishReason: collected.rawFinishReason,
        ...(collected.usage ? { usage: collected.usage } : {}),
      };
    } catch (error) {
      if (emitWire && requestEmitted && !signal?.aborted && !isCancellation(error)) {
        emitWire({
          type: 'wire-error',
          diagnostic: this.safeDiagnostic(error, phase ?? 'unknown'),
        });
      }
      throw error;
    }
  }

  /** Performs the HTTP attempt(s) for one generation and returns whatever came back. */
  private async send(
    url: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    /** Response media type only; request headers are never traced. */
    contentType?: string;
    /** {@link DIAGNOSTIC_RESPONSE_HEADERS} present on a non-2xx response; absent when none is. */
    diagnosticHeaders?: Readonly<Record<string, string>>;
    raw: string;
    /** The decoded body, or `undefined` when it was not JSON. */
    body: unknown;
  }> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw cancelledError();
      const controller = new AbortController();
      const forwardAbort = (): void => { controller.abort(); };
      signal?.addEventListener('abort', forwardAbort, { once: true });
      let timedOut = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const canRetry = (): boolean => attempt < MAX_TRANSPORT_ATTEMPTS && !signal?.aborted;
      let retryDelayMs: number | undefined;
      try {
        let response: HttpResponseLike;
        try {
          response = await this.fetchImpl(url, {
            method: 'POST',
            // The only place the credential appears. No record type carries headers, on any lane.
            headers: {
              'content-type': 'application/json',
              ...(this.config.apiKeyHeader === 'api-key'
                ? { 'api-key': this.config.apiKey }
                : { authorization: `Bearer ${this.config.apiKey}` }),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (error) {
          const code = transientTransportErrorCode(error);
          if (code && TRANSIENT_TRANSPORT_ERROR_CODES.has(code) && !controller.signal.aborted && canRetry()) {
            retryDelayMs = transportRetryDelayMs(attempt, undefined);
            this.options.debugLog?.(
              `[AI] transport-retry attempt=${attempt}/${MAX_TRANSPORT_ATTEMPTS} code=${code}`
              + ` delay_ms=${Math.round(retryDelayMs)}`,
            );
          } else {
            throw error;
          }
        }
        if (retryDelayMs === undefined) {
          const responseText = await response!.text();
          const raw = this.config.apiKey ? responseText.split(this.config.apiKey).join('[redacted]') : responseText;
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            body = undefined;
          }
          const transientStatus = response!.ok ? transientEnvelopeStatus(body)
            : TRANSIENT_TRANSPORT_HTTP_STATUSES.has(response!.status) ? response!.status : undefined;
          if (transientStatus !== undefined && canRetry()) {
            retryDelayMs = transportRetryDelayMs(attempt, response!.ok ? undefined : retryAfterDelayMs(response!.headers?.get('retry-after')));
            this.options.debugLog?.(
              `[AI] transport-retry attempt=${attempt}/${MAX_TRANSPORT_ATTEMPTS} status=${transientStatus}`
              + ` delay_ms=${Math.round(retryDelayMs)}`,
            );
          } else {
            return {
              ok: response!.ok,
              status: response!.status,
              statusText: response!.statusText,
              ...(response!.headers?.get('content-type')
                ? { contentType: response!.headers.get('content-type')! } : {}),
              ...(!response!.ok ? diagnosticHeaders(response!) : {}),
              raw,
              body,
            };
          }
        }
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        if (timedOut) {
          // A provider that never answered within this attempt's deadline produced no model output,
          // so it is the same transport failure as a reset connection and is retried like one.
          if (canRetry()) {
            retryDelayMs = transportRetryDelayMs(attempt, undefined);
            this.options.debugLog?.(
              `[AI] transport-retry attempt=${attempt}/${MAX_TRANSPORT_ATTEMPTS} code=ETIMEDOUT`
              + ` timeout_ms=${timeoutMs} delay_ms=${Math.round(retryDelayMs)}`,
            );
          } else {
            throw new ModelPortError(
              'provider_error',
              `Provider request exceeded ${timeoutMs} ms.`,
              Object.assign(new Error('Provider request timed out.'), { code: 'ETIMEDOUT' }),
            );
          }
        } else {
          if (error instanceof ModelPortError) throw error;
          throw new ModelPortError(
            'provider_error',
            sanitizeProviderError(error instanceof Error ? error.message : String(error))
              || 'Provider request failed.',
            error,
          );
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
      }
      await sleep(retryDelayMs, signal);
    }
  }

  /** Removes the configured literal key even when a provider echoes an unfamiliar key format. */
  private safeDiagnostic(error: unknown, phase: string): ReturnType<typeof sanitizeProviderErrorDiagnostic> {
    const diagnostic = sanitizeProviderErrorDiagnostic(error, phase);
    return JSON.parse(JSON.stringify(diagnostic, (_key, value: unknown) =>
      typeof value === 'string' && this.config.apiKey
        ? value.split(this.config.apiKey).join('[redacted]') : value,
    )) as ReturnType<typeof sanitizeProviderErrorDiagnostic>;
  }

  private rememberReasoning(collected: ReadCompletion): void {
    const ids = collected.parts
      .filter((part): part is Extract<PortGenerationPart, { type: 'tool-call' }> => part.type === 'tool-call')
      .map((part) => part.callId);
    for (const id of ids) {
      if (collected.reasoning) this.reasoning.set(`call:${id}`, collected.reasoning);
      if (collected.reasoningDetails) this.reasoningDetails.set(`call:${id}`, collected.reasoningDetails);
    }
    const text = collected.parts
      .filter((part): part is Extract<PortGenerationPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (ids.length === 0 && text) {
      if (collected.reasoning) this.reasoning.set(`text:${text}`, collected.reasoning);
      if (collected.reasoningDetails) this.reasoningDetails.set(`text:${text}`, collected.reasoningDetails);
    }
  }

  /** Any cached reasoning for an assistant turn, matched by call id first and text as fallback. */
  private recalledReasoning(callIds: readonly string[], text: string): string | undefined {
    for (const id of callIds) {
      const hit = this.reasoning.get(`call:${id}`);
      if (hit) return hit;
    }
    return text ? this.reasoning.get(`text:${text}`) : undefined;
  }

  /** Retrieves opaque blocks for this assistant turn without interpreting or reordering them. */
  private recalledReasoningDetails(callIds: readonly string[], text: string): readonly unknown[] | undefined {
    for (const id of callIds) {
      const hit = this.reasoningDetails.get(`call:${id}`);
      if (hit) return hit;
    }
    return text ? this.reasoningDetails.get(`text:${text}`) : undefined;
  }

  /** Caches each tool call's `extra_content`, keyed by its own call id, and separately caches the response's FIRST `extra_content`, keyed by every call id the response emitted, as the per-turn fallback an unsigned sibling resolves through. */
  private rememberToolExtraContent(collected: ReadCompletion): void {
    const calls = collected.parts.filter(
      (part): part is Extract<PortGenerationPart, { type: 'tool-call' }> => part.type === 'tool-call',
    );
    const turnExtraContent = calls.find((call) => call.extraContent)?.extraContent;
    for (const call of calls) {
      if (call.extraContent) this.toolExtraContent.set(call.callId, call.extraContent);
      if (turnExtraContent) this.toolExtraContentTurn.set(call.callId, turnExtraContent);
    }
  }

  /** Any turn-level `extra_content` fallback for these ids, when they arrived together signed. */
  private recalledTurnExtraContent(callIds: readonly string[]): Record<string, unknown> | undefined {
    for (const id of callIds) {
      const hit = this.toolExtraContentTurn.get(id);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface ReadCompletion {
  readonly parts: readonly PortGenerationPart[];
  readonly rawFinishReason: string;
  readonly usage?: TokenUsage;
  readonly reasoning?: string;
  readonly reasoningDetails?: readonly unknown[];
}

/** Decodes one `/chat/completions` body into ordered parts, keeping unusable arguments as evidence. */
function readCompletion(body: unknown): ReadCompletion {
  const root = asRecord(body);
  const choices = Array.isArray(root?.choices) ? root.choices : undefined;
  const choice = asRecord(choices?.[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const error = asRecord(root?.error) ?? asRecord(asRecord(choices?.[0])?.error);
  throwIfErrorEnvelope(error, Boolean(readContentText(message.content)
    || (Array.isArray(message.tool_calls) && message.tool_calls.length) || message.reasoning_content
    || (Array.isArray(message.reasoning_details) && message.reasoning_details.length)));
  if (!choices || choices.length === 0) {
    throw new ModelPortError(
      'unsupported_response',
      'Provider response carried no choices.',
    );
  }
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
    const extraContent = asRecord(call?.extra_content);
    parts.push(toolCallPart(callId, toolName, fn?.arguments, extraContent));
  }
  assertToolCallIds(parts.flatMap(part => part.type === 'tool-call' ? [part.callId] : []));
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content
    : undefined;
  // The HTTP body is parsed JSON owned by this port. Keep every block and extension opaque.
  const reasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined;
  const usage = readUsage(root?.usage);
  return {
    parts,
    rawFinishReason,
    ...(usage ? { usage } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningDetails ? { reasoningDetails } : {}),
  };
}

/** A provider error delivered inside an HTTP 200 body is a provider failure, never an answer. */
function throwIfErrorEnvelope(error: Record<string, unknown> | undefined, replyReceived = false): void {
  if (!error) return;
  const detail = sanitizeProviderError(JSON.stringify({ code: error.code, type: error.type, message: error.message }));
  throw new ModelPortError(
    'provider_error',
    `Provider returned an error envelope${detail ? `: ${detail}` : ''}.`,
    Object.assign(new Error('Provider error envelope.'), { code: error.code }),
    replyReceived,
  );
}

function toolCallPart(callId: string, toolName: string, args: unknown, extraContent?: Record<string, unknown>): PortGenerationPart {
  const rawArguments = typeof args === 'string' ? args : '';
  return {
    type: 'tool-call',
    callId,
    toolName,
    rawArguments,
    ...(extraContent ? { extraContent } : {}),
    ...parseArguments(rawArguments),
  };
}

/** Decodes one `/responses` body into the same ordered parts as {@link readCompletion}. */
function readResponse(body: unknown): ReadCompletion {
  const root = asRecord(body);
  throwIfErrorEnvelope(asRecord(root?.error), Array.isArray(root?.output) && root.output.length > 0);
  if (!Array.isArray(root?.output)) {
    throw new ModelPortError('unsupported_response', 'Provider response carried no output.');
  }
  const parts: PortGenerationPart[] = [];
  const reasoningItems: ResponsesReasoning[] = [];
  let pending: ResponsesReasoning['item'][] = [];
  const flush = (before?: string): void => {
    reasoningItems.push(...pending.map((item) => ({ ...(before ? { before } : {}), item })));
    pending = [];
  };
  for (const entry of root.output) {
    const item = asRecord(entry);
    if (item?.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .map(content => asRecord(content))
        .filter(content => content?.type === 'output_text' && typeof content.text === 'string')
        .map(content => content!.text as string)
        .join('');
      if (text) parts.push({ type: 'text', text });
      flush();
    } else if (item?.type === 'reasoning') {
      // Stateless (`store: false`) turns must hand the encrypted reasoning back verbatim, in order.
      pending.push(item as ResponsesReasoning['item']);
    } else if (item?.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const toolName = typeof item.name === 'string' ? item.name : '';
      if (!callId || !toolName) {
        throw new ModelPortError('unsupported_response', 'Provider returned a tool call without an identifier or name.');
      }
      flush(callId);
      parts.push(toolCallPart(callId, toolName, item.arguments));
    }
  }
  flush();
  assertToolCallIds(parts.flatMap(part => part.type === 'tool-call' ? [part.callId] : []));
  const usage = readResponsesUsage(root.usage);
  const incomplete = asRecord(root.incomplete_details)?.reason;
  return {
    parts,
    rawFinishReason: typeof incomplete === 'string' ? incomplete : typeof root.status === 'string' ? root.status : 'unknown',
    ...(usage ? { usage } : {}),
    ...(reasoningItems.length > 0 ? { reasoningDetails: reasoningItems } : {}),
  };
}

/** Trace copy of a request or response: `encrypted_content` keeps its length, not its payload. */
function omitEncrypted(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) =>
    key === 'encrypted_content' && typeof v === 'string' ? `[omitted ${v.length} chars]` : v)) as unknown;
}

/** Trace view of a projected message: opaque reasoning blocks stay counted, never printed. */
function withoutReasoningPayload(message: OpenAiChatMessage): OpenAiChatMessage {
  return message.reasoning_details
    ? { ...message, reasoning_details: message.reasoning_details.map(() => ({ type: 'reasoning', encrypted_content: '[omitted]' })) }
    : message;
}

function responsesReasoningPayload(tuning: OpenAiRequestTuning | undefined): Record<string, unknown> {
  const reasoning = tuning?.reasoning;
  return reasoning && 'effort' in reasoning ? { reasoning: { effort: reasoning.effort } } : {};
}

/** The Responses API names a forced function as `{ type: 'function', name }`. */
function responsesToolChoice(choice: unknown): unknown {
  const named = asRecord(asRecord(choice)?.function)?.name;
  return typeof named === 'string' ? { type: 'function', name: named } : choice;
}

function parseArguments(serialized: string):
  | { readonly input: Record<string, unknown> }
  | { readonly argumentsDiagnostic?: string } {
  if (!serialized.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    // Parser messages may quote input; expose only a fixed category and numeric offset.
    const message = error instanceof Error ? error.message : '';
    const positionText = /\bposition (\d+)\b/.exec(message)?.[1];
    const position = positionText === undefined
      ? /end of JSON input/i.test(message) ? serialized.length : undefined
      : Number(positionText);
    const offset = position !== undefined && Number.isSafeInteger(position) && position >= 0 && position <= serialized.length
      ? position
      : undefined;
    const category = offset === serialized.length
      ? 'incomplete value'
      : offset !== undefined && /[}\]]/.test(serialized[offset] ?? '') && /,\s*$/.test(serialized.slice(0, offset))
        ? 'trailing comma'
        : 'invalid encoding';
    return {
      argumentsDiagnostic: `Invalid JSON syntax: ${category}${offset === undefined ? '' : ` at character ${offset}`}.`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
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

function toOpenAiToolChoice(choice: ModelToolChoice | undefined, supportsNamedChoice: boolean): unknown {
  if (choice === 'required') return 'required';
  if (choice === 'none') return 'none';
  if (typeof choice === 'object') {
    return supportsNamedChoice
      ? { type: 'function', function: { name: choice.toolName } }
      : 'required';
  }
  return 'auto';
}

function describeUsage(usage: TokenUsage | undefined): string {
  if (!usage) return '(provider usage unavailable)';
  return `in=${usage.inputTokens ?? '-'} out=${usage.outputTokens ?? '-'}`
    + ` total=${usage.totalTokens ?? '-'} reasoning=${usage.reasoningTokens ?? '-'}`;
}

/** The shared model-port view of one decoded call: its object arguments, or the raw text that was none. */
function emittedCall(part: Extract<PortGenerationPart, { type: 'tool-call' }>): EmittedToolCall {
  const { callId, toolName } = part;
  return part.input ? { callId, toolName, args: part.input } : { callId, toolName, malformedArgs: part.rawArguments };
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
