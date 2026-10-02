/** Shared OpenAI-compatible ModelPort: production validation with headless HTTP transport. */
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
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
  messageContentToText,
  modelToolCallMessage,
} from '../../src/ai/model/modelPort';
import * as modelPortModule from '../../src/ai/model/modelPort';
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
import { DEFAULT_TURN_TOKEN_BUDGET, estimateTokens, type TurnTokenBudget } from '../../src/ai/support/tokenBudget';
import { rejectionFromZodError, zodFieldRepairHint, zodUnrecognizedKeys } from '../../src/ai/support/toolErrorEnvelope';
import * as inputNormalization from '../../src/ai/support/inputNormalization';
import { coerceStringifiedArguments } from '../../src/ai/support/inputNormalization';
import { sanitizeForLog, trunc } from '../../src/utils/log';
import {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  StructuredOutputError,
  structuredRejectReason,
} from '../../src/ai/providers/structuredOutput';
import {
  projectMessages,
  readUsage,
  FENCED_JSON_BLOCK,
  suspectsToolCallAsText,
  toWireMessages,
} from './openAiWire';

/** Outcome of reading a text-only generation as a tool call on a tree whose product port promoted one. */
type ProseToolCallMatch =
  | { readonly kind: 'promoted'; readonly toolName: string; readonly input: Record<string, unknown> }
  | { readonly kind: 'ambiguous'; readonly tools: readonly string[] }
  | { readonly kind: 'none' };

/** Call id the pinned tree's product port gives a prose-promoted call. */
const PROSE_PROMOTED_CALL_ID: string =
  (modelPortModule as { readonly PROSE_PROMOTED_CALL_ID?: string }).PROSE_PROMOTED_CALL_ID ?? 'text-promoted-0';

/**
 * The pinned tree's prose-tool behaviour.
 *
 * @remarks
 * A capture worktree pins `src/` at the measured sha while this harness is copied in from the source
 * repo, so the mirror is chosen by what that tree exports. Three generations exist:
 * - exports `matchProseToolCall` — that recognizer promotes (the testing branches before its removal);
 * - exports `PROVIDER_PARTS_KEY` but no recognizer — the product port promotes nothing: a call exists
 *   only on the native tool-call channel, and a text generation stays text;
 * - exports neither — `main` (`20356737e`), whose product port promoted privately
 *   (`vscodeModelPort.ts` `promoteProseToolCall`): the first fenced JSON block whose object one
 *   offered schema accepts.
 */
type ProseToolCallRecognizer = (text: string, definitions: readonly ModelToolDefinition[]) => ProseToolCallMatch;
const pinnedRecognizer = (modelPortModule as { readonly matchProseToolCall?: ProseToolCallRecognizer }).matchProseToolCall;
const matchProseToolCall: ProseToolCallRecognizer =
  typeof pinnedRecognizer === 'function'
    ? pinnedRecognizer
    : typeof (modelPortModule as { readonly PROVIDER_PARTS_KEY?: unknown }).PROVIDER_PARTS_KEY === 'string'
      ? () => ({ kind: 'none' })
      : (text, definitions) => {
        if (definitions.length === 0) return { kind: 'none' };
        const match = FENCED_JSON_BLOCK.exec(text);
        if (!match) return { kind: 'none' };
        let candidate: unknown;
        try {
          candidate = JSON.parse(match[1]);
        } catch {
          return { kind: 'none' };
        }
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { kind: 'none' };
        const definition = definitions.find((entry) => entry.inputSchema.safeParse(candidate).success);
        return definition
          ? { kind: 'promoted', toolName: definition.name, input: candidate as Record<string, unknown> }
          : { kind: 'none' };
      };

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
  /** Undici `Agent` dispatcher when the transport upgrade resolved; ignored by fake transports. */
  readonly dispatcher?: unknown;
}

/**
 * Resolves the transport provider requests are issued through.
 *
 * @remarks
 * Node's global `fetch` is undici's, and undici aborts a request whose response **headers** have
 * not arrived within its own hard-coded 300 s `headersTimeout` — invisible to the port's own
 * `requestTimeoutMs` deadline and fatal for local thinking models whose single non-streamed
 * generation legitimately runs longer (measured 2026-08-30: Qwen3.8-27B via LM Studio needed
 * ~280 s of decode for one planning turn, and the 300 s header cap fired exactly as the model
 * finished, surfacing as `UND_ERR_HEADERS_TIMEOUT`). When the `undici` package is resolvable
 * (transitively present via tooling dependencies), the port uses undici's own `fetch` with an
 * `Agent` whose `headersTimeout` and `bodyTimeout` equal the lane deadline, so the ONLY deadline
 * is the port's. Without undici, global `fetch` is kept and the 300 s header cap applies — the
 * warning names it.
 */
function resolveTransport(
  timeoutMs: number,
  debugLog: ((message: string) => void) | undefined,
): { fetchImpl: FetchLike; dispatcher: unknown } {
  try {
    // Lazy, optional transport upgrade: undici is not a direct dependency, so resolve it at
    // runtime and fall back to global fetch when it is not installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require('undici') as {
      fetch: (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;
      Agent: new (options: { headersTimeout: number; bodyTimeout: number }) => unknown;
    };
    const agent = new undici.Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    return {
      fetchImpl: (url, init) => undici.fetch(url, { ...init, dispatcher: agent }),
      dispatcher: agent,
    };
  } catch {
    debugLog?.(
      '[AI] undici is not resolvable; using global fetch — undici\'s built-in 300s headers timeout will abort long non-streamed generations.',
    );
    return { fetchImpl: (url, init) => globalThis.fetch(url, init as RequestInit) as Promise<HttpResponseLike>, dispatcher: undefined };
  }
}

/** The injectable transport. Production passes global `fetch`; tests pass canned responses. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/**
 * Renders the reasoning tuning into the request-body fields the lane's dialect accepts.
 *
 * @param tuning - The lane's declared tuning, if any.
 * @returns A body fragment to spread: `reasoning_effort`, `chat_template_kwargs`, or nothing.
 */
function reasoningPayload(tuning: OpenAiRequestTuning | undefined): Record<string, unknown> {
  const reasoning = tuning?.reasoning;
  if (!reasoning) return {};
  if (tuning?.reasoningStyle === 'chat_template_kwargs') {
    return 'enabled' in reasoning ? { chat_template_kwargs: { enable_thinking: false } } : {};
  }
  return 'effort' in reasoning ? { reasoning_effort: reasoning.effort } : {};
}

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
  /**
   * Whether the provider accepts the object form of `tool_choice`
   * (`{ type: 'function', function: { name } }`). Defaults to `true`.
   *
   * @remarks
   * Some local servers (LM Studio's OpenAI-compatible endpoint) only accept the string values
   * `none` / `auto` / `required` and answer `400 Invalid tool_choice type` for the object form.
   * When this is `false`, a forced named tool degrades to `'required'`; the port already narrows
   * the advertised tool set to the forced tool alone, so `'required'` forces the same tool under
   * a server that cannot name it.
   */
  readonly namedToolChoice?: boolean;
  /**
   * Whether the provider accepts only `tool_choice: "auto"` (no `none`, `required` or named form).
   * When `true`, every forced choice is sent as `'auto'`; the port already narrows the advertised
   * tool set to the forced tool alone, so the one tool on offer is the forced one.
   */
  readonly autoToolChoiceOnly?: boolean;
}

/**
 * Provider-specific request-body tuning. Every field lands verbatim in the request body, so a
 * verbose trace's `provider-raw` capture always shows exactly what tuning was active for a run.
 */
/**
 * The ONLY request knob the harness may set: thinking level, plus which dialect carries it.
 *
 * @remarks
 * The harness exists to reproduce what the extension does inside Copilot Chat, where the model is
 * `ChatRequest.model` and the host sends no tuning of its own. Every knob added here is a variable
 * that shows up in a measured answer and gets attributed to whatever prompt edit was under test, so
 * the interface is deliberately closed to everything except thinking level.
 *
 * Removed rather than left unused, each for the same reason: `maxTokens` (an output cap truncates
 * the answer depth this project measures) and `providerSort` (a provider routing preference has
 * no Copilot counterpart). Do not reintroduce either, and do not add a sampling, penalty, or
 * routing field — if a provider needs one to function at all, that is a dialect concern and belongs
 * in {@link OpenAiRequestTuning.reasoningStyle}, not a new tuning axis.
 */
export interface OpenAiRequestTuning {
  /**
   * Thinking level, rendered in the lane's {@link OpenAiRequestTuning.reasoningStyle} dialect.
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
   * Which request-body dialect carries {@link OpenAiRequestTuning.reasoning}.
   *
   * @remarks
   * The measured lanes do not share a schema. Azure Foundry and Fireworks answer
   * `400 Unknown parameter: 'reasoning'` for an object-shaped field and take a scalar
   * `reasoning_effort` instead, which is why this seam exists rather than a single field name.
   *
   * `scalar` (the default) sends `reasoning_effort: <effort>` and sends nothing for
   * `{ enabled: false }`, which has no scalar spelling.
   * `chat_template_kwargs` is the Qwen3 template switch that oMLX honours
   * (`chat_template_kwargs: { enable_thinking: false }`); it has no effort levels, so it sends
   * only `{ enabled: false }` and nothing for an effort.
   */
  readonly reasoningStyle?: 'scalar' | 'chat_template_kwargs';
}

/** Everything the port needs to reach one endpoint. A resolved lane satisfies this shape. */
export interface OpenAiCompatiblePortConfig {
  /** API root including the version prefix, e.g. `https://api.fireworks.ai/inference/v1`. */
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
  /**
   * Forces every `lineage_start_exploration` call to `analysisMode:'bb'` with `targetColumns`
   * dropped, regardless of what the model requested.
   *
   * @remarks
   * Mode is chosen by the model, not the harness — `smBase.ts` infers `bb`/`ct` from whether
   * `targetColumns` is non-empty and rejects a mismatched pair. So a forced call must rewrite both
   * fields together, or the engine rejects it. This exists so a CT question can be measured as BB
   * without rewording it: the PM wants the byte-identical question run once under each mode so the
   * BFS is comparable. Each rewrite logs one `[ForceBB]` debug line naming what changed.
   */
  readonly forceBb?: boolean;
  /** Transport seam. Defaults to the runtime's global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /**
   * Token budget this port's turn runs under.
   *
   * @remarks
   * Mirrors the production model port: absent for a lane that never calibrates one, in which case
   * {@link DEFAULT_TURN_TOKEN_BUDGET} applies — the shipped ceilings, no model window.
   */
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
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * DD-4a transient-transport retry, {@link OpenAiCompatiblePort.send} only.
 *
 * @remarks
 * Node's global `fetch` (and undici's) surface a connection-level failure as
 * `TypeError: fetch failed` with the real error on `.cause`; these codes never reached a provider
 * response at all, so retrying them cannot corrupt a measured model answer (DD-4).
 */
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET',
]);
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

/** `Retry-After` in ms when present and valid (seconds or an HTTP-date), else `undefined`. */
function retryAfterDelayMs(response: HttpResponseLike): number | undefined {
  const header = response.headers?.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Bounded exponential backoff with full jitter, capped at {@link TRANSPORT_RETRY_MAX_DELAY_MS}. */
function transportRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, TRANSPORT_RETRY_MAX_DELAY_MS);
  const exponential = TRANSPORT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = exponential * TRANSPORT_RETRY_JITTER_FRACTION * Math.random();
  return Math.min(exponential + jitter, TRANSPORT_RETRY_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  /**
   * Turn-scoped `reasoning_content` cache, keyed by every tool-call id the generation emitted and
   * by its text (DD-3). Port-owned so the provider-specific field never reaches graph history.
   */
  private readonly reasoning = new Map<string, string>();

  /**
   * Per-call `extra_content` cache, keyed by call id. Port-owned for the same reason as
   * {@link reasoning}: a LangChain `ToolCall` is `{id, name, args, type}` and has nowhere to carry
   * a provider extra, so it is kept beside the message rather than inside it. Instance-scoped, so
   * it lives no longer than the port — one run's captured signature never reaches another run.
   */
  private readonly toolExtraContent = new Map<string, Record<string, unknown>>();

  /**
   * Per-turn `extra_content` fallback, keyed by every tool-call id one response emitted, holding
   * the FIRST `extra_content` that response carried. A provider that signs only
   * the first call of a parallel tool-call group leaves its siblings with none of their own; when
   * such a sibling is replayed alone, the request still needs a signature for that assistant turn
   * or the provider answers HTTP 400. Populated only for ids that arrived together in one
   * {@link readCompletion} call, so a lookup can never cross into a different turn.
   */
  private readonly toolExtraContentTurn = new Map<string, Record<string, unknown>>();

  private readonly fetchImpl: FetchLike;

  /** Undici `Agent` aligning header/body deadlines with {@link OpenAiCompatiblePortConfig.requestTimeoutMs}. */
  private readonly dispatcher: unknown;

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
      // Injected transports (tests, custom integrations) are used verbatim; no dispatcher is
      // attached because the caller owns the transport behavior end to end.
      this.fetchImpl = options.fetchImpl;
      this.dispatcher = undefined;
    } else {
      const transport = resolveTransport(
        config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        options.debugLog,
      );
      this.fetchImpl = transport.fetchImpl;
      this.dispatcher = transport.dispatcher;
    }
    // Record the configured model before any provider request can fail.
    this.options.debugLog?.(
      `[AI] model id=${config.model} vendor=${this.identity.vendor} lane=${config.laneId ?? 'custom'}`,
    );
  }

  /**
   * {@inheritDoc SingleGenerationModelPort.getNumTokens} — no live model to ask off the VS Code
   * host, so this lane keeps LangChain's own chars/4 approximation ({@link estimateTokens}) rather
   * than a second counter implementation.
   */
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
        let replayInput: unknown = part.input;
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
            code: 'unknown_tool',
            reason: 'Tool is not available in this phase.',
          };
        } else if (part.argumentsIssue) {
          // DIVERGENCE (DD-5): a routine provider failure class on this lane, so it is charged to
          // the call and repaired next round, not raised as a whole-generation provider error.
          // `input` carries the raw `arguments` text here — never a parsed object, since none
          // exists — the same "payload exactly as the provider sent it" contract every other arm
          // below observes; the replayed assistant call carries `{}`, the only object this
          // genuinely unparseable case has to offer.
          replayInput = {};
          call = {
            valid: false,
            callId: part.callId,
            toolName: part.toolName,
            input: part.rawArguments,
            code: 'invalid_tool_input',
            reason: part.argumentsIssue === 'empty'
              ? 'Tool arguments were empty; send the required fields as a JSON object.'
              : 'Tool arguments were not a JSON object.',
          };
        } else {
          let effectiveInput: unknown = part.input;
          if (
            this.options.forceBb
            && part.toolName === 'lineage_start_exploration'
            && typeof effectiveInput === 'object'
            && effectiveInput !== null
            && !Array.isArray(effectiveInput)
          ) {
            const original = effectiveInput as Record<string, unknown>;
            const was = typeof original.analysisMode === 'string' ? original.analysisMode : 'unset';
            const droppedTargetColumns = Array.isArray(original.targetColumns)
              ? original.targetColumns
              : [];
            const rewritten: Record<string, unknown> = { ...original, analysisMode: 'bb' };
            delete rewritten.targetColumns;
            effectiveInput = rewritten;
            this.options.debugLog?.(
              `[AI] [ForceBB] phase=${input.phase} call=${this.modelCalls} lineage_start_exploration `
              + `analysisMode=${was}->bb droppedTargetColumns=[${droppedTargetColumns.join(',')}]`,
            );
          }
          const decoded = coerceStringifiedArguments(effectiveInput, toModelJsonSchema(definition.inputSchema));
          if (decoded.paths.length > 0) {
            effectiveInput = decoded.value;
            this.options.debugLog?.(
              `[AI] provider-port decoded stringified arguments tool=${part.toolName} paths=${trunc(sanitizeForLog(decoded.paths.join(',')), 200)}`,
            );
          }
          const parsed = definition.inputSchema.safeParse(effectiveInput);
          const droppedKeyPaths = (inputNormalization as Record<string, unknown>).droppedKeyPaths as
            ((raw: unknown, parsedValue: unknown) => string[]) | undefined;
          const dropped = parsed.success && droppedKeyPaths ? droppedKeyPaths(effectiveInput, parsed.data) : [];
          if (dropped.length > 0) {
            this.options.debugLog?.(
              `[AI] tool-input-keys-dropped tool=${part.toolName} paths=${trunc(sanitizeForLog(dropped.join(',')), 200)}`,
            );
          }
          replayInput = effectiveInput;
          const fieldHint = parsed.success ? undefined : zodFieldRepairHint(parsed.error, effectiveInput, definition.inputSchema);
          const rejection = parsed.success ? undefined : rejectionFromZodError(
            parsed.error,
            { code: 'invalid_tool_input', input: effectiveInput, schema: definition.inputSchema },
          );
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
                input: effectiveInput,
                code: 'invalid_tool_input',
                reason: rejection!.reason,
                ...(fieldHint !== undefined ? { hint: fieldHint } : {}),
                ...(rejection!.issuePaths ? { issuePaths: rejection!.issuePaths } : {}),
                ...(zodUnrecognizedKeys(parsed.error).length > 0
                  ? { unrecognizedKeys: zodUnrecognizedKeys(parsed.error) }
                  : {}),
              };
        }
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
    const calls = response.parts.filter(
      (part): part is Extract<PortGenerationPart, { type: 'tool-call' }> =>
        part.type === 'tool-call' && part.toolName === STRUCTURED_OUTPUT_TOOL,
    );
    const single = calls.length === 1 ? calls[0] : undefined;
    let structuredInput: unknown = single?.input;
    if (single && !single.argumentsIssue) {
      const decoded = coerceStringifiedArguments(single.input, toModelJsonSchema(input.schema));
      if (decoded.paths.length > 0) {
        structuredInput = decoded.value;
        this.options.debugLog?.(
          `[AI] provider-port decoded stringified arguments tool=${STRUCTURED_OUTPUT_TOOL} paths=${trunc(sanitizeForLog(decoded.paths.join(',')), 200)}`,
        );
      }
    }
    const parsed = single && !single.argumentsIssue
      ? input.schema.safeParse(structuredInput)
      : undefined;
    if (parsed?.success) return parsed.data;
    // Empty `arguments` and an empty object mean the same thing here — the model returned no
    // fields — so both classify as `empty_structured_output`, the code graph recovery keys off.
    const emptyRequiredPayload = single !== undefined
      && (single.argumentsIssue === 'empty' || isEmptyRecord(single.input));
    if (emptyRequiredPayload) {
      throw new StructuredOutputError(`${STRUCTURED_OUTPUT_TOOL} arguments were empty`, 'empty_structured_output');
    }
    if (calls.length > 1) throw new StructuredOutputError(`multiple ${STRUCTURED_OUTPUT_TOOL} tool calls`);
    if (single?.argumentsIssue === 'malformed') {
      throw new StructuredOutputError(`${STRUCTURED_OUTPUT_TOOL} arguments were not a JSON object`);
    }
    const { reason, hint } = structuredRejectReason(calls.length === 1, parsed?.error, structuredInput, input.schema);
    throw new StructuredOutputError(reason, 'invalid_structured_output', hint);
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
      (callId, callIds) => this.toolExtraContent.get(callId) ?? this.recalledTurnExtraContent(callIds),
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
      ...reasoningPayload(this.config.requestTuning),
      ...(tools.length > 0
        ? { tools, tool_choice: this.config.capabilities?.autoToolChoiceOnly ? 'auto' : toOpenAiToolChoice(choice, this.config.capabilities?.namedToolChoice !== false) }
        : {}),
    };

    const startedAt = Date.now();
    try {
      emitWire?.({
        type: 'wire-request',
        messages: toWireMessages(messages),
        tools: definitions.map((definition) => ({
          name: definition.name,
          descriptionHash: systemPromptHash(definition.description),
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
          ...(received.contentType ? { contentType: received.contentType } : {}),
          // Malformed successful responses need their full body for diagnosis, with credentials
          // redacted. Parsed success bodies stay verbatim; HTTP error diagnostics stay sanitized.
          body: received.ok
            ? (received.body !== undefined
                ? received.body
                : received.raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'))
            : sanitizeProviderError(received.raw),
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
      // MIRROR: a pinned tree whose production port promoted a prose-written tool call is mirrored
      // here; on a tree that does not, the match is always `none`. Applied after every record is written,
      // so `wire-response` and `provider-raw` still hold the provider's verbatim text — the harness
      // records what the provider did and classifies what production would have accepted.
      const promotion = toolCallParts.length === 0
        ? matchProseToolCall(text, definitions)
        : { kind: 'none' as const };
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
      this.generations.push({
        generation,
        ...(phase !== undefined ? { phase } : {}),
        finishReason: collected.rawFinishReason,
        latencyMs,
        ...(collected.usage ? { usage: collected.usage } : {}),
        // Only meaningful when the model emitted no structured call at all. A payload the recognizer
        // read is a tool call written as text whether or not a schema accepted it, so the reader
        // answers first and the marker heuristic covers the rest.
        suspectedToolCallAsText: toolCallParts.length === 0 && suspectsToolCallAsText(text),
        toolCalls: toolCallParts.length,
        textChars: text.length,
      });
      return {
        parts: promotion.kind === 'promoted'
          ? [{
              type: 'tool-call',
              callId: PROSE_PROMOTED_CALL_ID,
              toolName: promotion.toolName,
              input: promotion.input,
              // Never emitted: promotion happens after `wire-response`. Kept as the prose the call
              // was read from, so a part carries its own evidence.
              rawArguments: text,
            }]
          : collected.parts,
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

  /**
   * Performs the HTTP attempt(s) for one generation and returns whatever came back.
   *
   * @remarks
   * A non-2xx status and an unparsable body are *returned*, not thrown, so the caller can capture
   * the bytes before classifying them — a trace that loses the body of the failure it is meant to
   * explain is worthless. Only a transport failure (no response at all, and not transient-retried
   * away) throws from here.
   *
   * The timeout covers the body read as well as the response headers: a provider that answers and
   * then stalls mid-body is the same measurement failure as one that never answers. The caller's
   * signal is forwarded rather than composed with `AbortSignal.any`, which is not available in every
   * lib configuration this file compiles under. DD-4a (module remarks) retries a connection-level
   * failure, an attempt that exceeded its deadline, or a 429/502/503/504 up to
   * {@link MAX_TRANSPORT_ATTEMPTS} times. The deadline is per attempt, as in the OpenAI SDKs: one
   * whole-request deadline let a single provider stall consume the budget every retry needed, so a
   * stall was never retried at all. Every other outcome — including every status this method
   * returns rather than throws — is exactly one attempt, unchanged from DD-4.
   */
  private async send(
    url: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    /** Response media type only; request and other response headers are never traced. */
    contentType?: string;
    raw: string;
    /** The decoded body, or `undefined` when it was not JSON. */
    body: unknown;
  }> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    for (let attempt = 1; ; attempt += 1) {
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
              authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
            ...(this.dispatcher !== undefined ? { dispatcher: this.dispatcher } : {}),
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
          if (!response!.ok && TRANSIENT_TRANSPORT_HTTP_STATUSES.has(response!.status) && canRetry()) {
            retryDelayMs = transportRetryDelayMs(attempt, retryAfterDelayMs(response!));
            this.options.debugLog?.(
              `[AI] transport-retry attempt=${attempt}/${MAX_TRANSPORT_ATTEMPTS} status=${response!.status}`
              + ` delay_ms=${Math.round(retryDelayMs)}`,
            );
          } else {
            return {
              ok: response!.ok,
              status: response!.status,
              statusText: response!.statusText,
              ...(response!.headers?.get('content-type')
                ? { contentType: response!.headers.get('content-type')! } : {}),
              raw,
              body,
            };
          }
        }
      } catch (error) {
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
          if (signal?.aborted) throw cancelledError();
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
      await sleep(retryDelayMs);
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

  /**
   * Caches each tool call's `extra_content`, keyed by its own call id, and separately
   * caches the response's FIRST `extra_content`, keyed by every call id the response emitted, as
   * the per-turn fallback an unsigned sibling resolves through.
   */
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
    const extraContent = asRecord(call?.extra_content);
    parts.push({
      type: 'tool-call',
      callId,
      toolName,
      rawArguments,
      ...(extraContent ? { extraContent } : {}),
      ...parseArguments(rawArguments),
    });
  }
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content
    : undefined;
  const usage = readUsage(root?.usage);
  return {
    parts,
    rawFinishReason,
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
