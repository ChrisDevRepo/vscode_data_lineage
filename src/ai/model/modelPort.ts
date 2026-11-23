import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import type { ZodType } from 'zod';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { causeCodes, isTransportProviderError, type ProviderErrorDiagnostic, type TurnStop } from '../support/text';
import type { TurnTokenBudget } from '../support/tokenBudget';

/** LangChain's provider-neutral message hierarchy is the graph's sole history type. */
export type ModelMessage = BaseMessage;

/** Creates a user message in the graph's provider-neutral message format. */
export function modelUserMessage(text: string): HumanMessage {
  return new HumanMessage(text);
}

/** Creates an assistant message in the graph's provider-neutral message format. */
export function modelAssistantMessage(text: string): AIMessage {
  return new AIMessage(text);
}

/**
 * `AIMessage.additional_kwargs` key carrying a generation's provider stream parts: every part the
 * bridge does not interpret as text or a tool call (reasoning, thought signatures, provider data),
 * as the original objects in stream order. The array rides exactly one stream chunk:
 * `AIMessageChunk.concat` keeps it untouched, whereas two chunks carrying the key would have their
 * items merged by `id` into plain objects.
 */
export const PROVIDER_PARTS_KEY = 'providerParts';

/** Reads a message's provider stream parts ({@link PROVIDER_PARTS_KEY}); empty if none. */
export function messageProviderParts(message: BaseMessage): readonly unknown[] {
  const parts = message.additional_kwargs?.[PROVIDER_PARTS_KEY];
  return Array.isArray(parts) ? parts : [];
}

/**
 * The assistant turn to append for one generation: its message unchanged, plus each call it lacks
 * (a call whose input was no JSON object) with empty arguments, so every call keeps the tool result
 * that answers it.
 */
export function transcriptTurn(message: AIMessage, calls: readonly GeneratedToolCall[]): AIMessage {
  const kept = message.tool_calls ?? [];
  const keptIds = new Set(kept.map((call) => call.id));
  const missing = calls.filter((call) => !keptIds.has(call.callId));
  if (missing.length === 0) return message;
  return new AIMessage({
    content: message.content,
    additional_kwargs: message.additional_kwargs,
    tool_calls: [
      ...kept,
      ...missing.map((call) => ({ id: call.callId, name: call.toolName, args: {}, type: 'tool_call' as const })),
    ].sort((a, b) => calls.findIndex((call) => call.callId === a.id) - calls.findIndex((call) => call.callId === b.id)),
  });
}

/**
 * Creates an assistant message containing validated JSON-object tool calls.
 *
 * @param providerParts - Provider stream parts of the generation that emitted these calls, replayed
 *   verbatim before them so a provider that signs its own turn receives it unchanged.
 * @throws {@link ModelPortError} when a call input is not a JSON object.
 */
export function modelToolCallMessage(
  calls: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly input: unknown;
  }[],
  text = '',
  providerParts: readonly unknown[] = [],
): AIMessage {
  return new AIMessage({
    content: text,
    tool_calls: calls.map((call) => ({
      id: call.callId,
      name: call.toolName,
      args: modelToolArgs(call.input),
      type: 'tool_call' as const,
    })),
    ...(providerParts.length > 0 ? { additional_kwargs: { [PROVIDER_PARTS_KEY]: [...providerParts] } } : {}),
  });
}

function modelToolArgs(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ModelPortError(
      'invalid_request',
      'Tool-call input must be a JSON object.',
    );
  }
  return input;
}

/** Whether a value is a JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Creates the tool-result message paired with a preceding tool call.
 *
 * @param status - `'success'` for an executed call, `'error'` otherwise.
 * @param artifact - Machine-only facts on `ToolMessage.artifact`: kept for a reader needing the
 *   full structured record, never sent to the provider.
 */
export function modelToolResultMessage(
  callId: string,
  toolName: string,
  text: string,
  status: 'success' | 'error',
  artifact?: unknown,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: callId,
    name: toolName,
    content: text,
    status,
    ...(artifact !== undefined ? { artifact } : {}),
  });
}

/** Stable error categories exposed by provider-neutral model ports. */
export type ModelPortErrorCode =
  | 'cancelled'
  | 'no_permission'
  | 'blocked'
  | 'model_not_found'
  | 'invalid_request'
  | 'unsupported_response'
  | 'provider_error';

/**
 * Bounded provider-neutral error safe to retain in graph state. `cause` retains the original
 * provider exception; `sanitizeProviderErrorDiagnostic` walks it to recover the connection-level
 * `code` (`ECONNRESET`/`ETIMEDOUT`/...) transport classification keys off. Declared here, not via
 * the ES2022 `Error(message, { cause })` overload, because the project compiles against
 * `lib: ES2020`. Every sink sanitizes before emitting, so the raw exception never reaches a log or
 * the UI.
 */
export class ModelPortError extends Error {
  public constructor(
    public readonly code: ModelPortErrorCode,
    message: string,
    public readonly cause?: unknown,
    /** True once the provider emitted any reply part, including buffered or opaque output. */
    public readonly replyReceived = false,
  ) {
    super(message);
    this.name = 'ModelPortError';
  }
}

/** The port-level cancellation error every model boundary raises. */
export function cancelledError(): ModelPortError {
  return new ModelPortError('cancelled', 'Language model request was cancelled.');
}

/**
 * Whether a thrown value is a port-level cancellation ({@link ModelPortError} with code
 * `'cancelled'`). The one predicate callers above the port use; pair it with
 * `isCancellationOutcome` (`support/cancellation.ts`) for signal/transport aborts instead of
 * re-rolling the check per caller.
 */
export function isPortCancellation(error: unknown): boolean {
  return error instanceof ModelPortError && error.code === 'cancelled';
}

/**
 * Error names the VS Code language-model host raises on cancellation: `Canceled` (platform
 * spelling, `vscode.CancellationError`), `Cancelled` (providers using two `l`s) and `AbortError`
 * (fetch-level abort). Declared once because the bridge and the port both classify the raw
 * transport error and a copy of the list drifts silently.
 */
const HOST_CANCELLATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'Canceled',
  'Cancelled',
]);

/**
 * Whether a thrown value carries one of the host's cancellation error names. Name-based by
 * necessity: the host raises a plain `Error` with no code. Pair with {@link isPortCancellation} for
 * a normalized port error, and with `isCancellationOutcome` for the `ABORT_ERR`/`20` code forms.
 */
export function isHostCancellationError(error: unknown): boolean {
  return error instanceof Error && HOST_CANCELLATION_ERROR_NAMES.has(error.name);
}

/** Model-facing context used to audit which instruction fragments reached a generation. */
export interface InstructionContext {
  /** Which generation shape the audit describes — structured, converse (tool-capable), or text. */
  readonly kind: 'structured' | 'converse' | 'text';
  /** Approved engine analysis mode: `'bb'` whole-object exploration or `'ct'` column trace. */
  readonly analysisMode?: 'bb' | 'ct';
  /** Locked question classification in force for the turn. */
  readonly classification?: 'business' | 'technical' | 'both';
  /** Origin columns being traced; present only in `'ct'` mode. */
  readonly targetColumns?: readonly string[];
  /** Shipped output-template keys rendered into the instruction. */
  readonly templateKeys: readonly string[];
  /** Memory section identifiers included in the prompt context. */
  readonly memorySections: readonly string[];
  /** Names of tools offered to this generation; empty for structured and text kinds. */
  readonly toolNames: readonly string[];
  /** Identifier of the structured-output contract, present for structured generations. */
  readonly schemaId?: string;
}

/** Provider-neutral tool metadata supplied to a tool-capable generation. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType;
}

/** Provider-neutral tool-selection policy for one generation. */
export type ModelToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { readonly type: 'tool'; readonly toolName: string };

/** Input contract for one tool-capable model generation. */
export interface ToolGenerationInput {
  /** Provider-neutral conversation history for this generation, oldest first. */
  readonly messages: readonly ModelMessage[];
  /** Optional system instruction prepended ahead of `messages`. */
  readonly system?: string;
  readonly tools: readonly ModelToolDefinition[];
  /** Optional policy narrowing which tools the model may call. */
  readonly toolChoice?: ModelToolChoice;
  readonly signal?: AbortSignal;
  /** Graph phase label carried into diagnostics and trace records. */
  readonly phase: string;
  /** Optional audit context naming which instruction fragments reached this generation. */
  readonly instructionContext?: InstructionContext;
  /** Optional streaming callback invoked with each incremental text fragment. */
  readonly onTextDelta?: (text: string) => void;
}

/** A registered native tool call ready for argument validation at its execution boundary. @internal */
export interface ValidGeneratedToolCall {
  readonly valid: true;
  /** Provider call identifier, echoed into the paired tool-result message. */
  readonly callId: string;
  /** Registry tool name to dispatch. */
  readonly toolName: string;
  /** Transport-decoded arguments, preserved for the receiving tool's schema admission. */
  readonly input: unknown;
}

/** A provider tool call rejected before dispatch. @internal */
export interface InvalidGeneratedToolCall {
  readonly valid: false;
  /** Provider call identifier exactly as the provider emitted it. */
  readonly callId: string;
  /** Tool name as the provider spelled it; it may name no registered tool. */
  readonly toolName: string;
  /**
   * The rejected payload exactly as the provider sent it, so retry-budget guards can compare a
   * follow-up call against it (by fingerprint, never retained) and tell a genuine repair from an
   * unproductive resend. Never dispatched, replayed or logged raw.
   */
  readonly input?: unknown;
  /** Rejection category: invalid schema, tool-call notation in text, unknown tool, duplicate id. */
  readonly code:
    | typeof REJECTION_CODES.invalidToolInput
    | typeof REJECTION_CODES.toolCallNotation
    | typeof REJECTION_CODES.unknownTool
    | typeof REJECTION_CODES.duplicateCallId;
  /** Human-readable rejection prose returned to the model for repair. */
  readonly reason: string;
  /**
   * Repair instruction naming the fix for this rejection, when the producer derived one from the
   * issue shape (e.g. an `unrecognized_keys` issue names removal, not the standing resend-unchanged
   * instruction). Absent otherwise; the dispatcher then applies its own fixed per-code hint.
   */
  readonly hint?: string;
  /** Paths of the schema issues that rejected the input, when known. */
  readonly issuePaths?: readonly string[];
  /** Offending key(s) when the rejection carries a Zod `unrecognized_keys` issue. */
  readonly unrecognizedKeys?: readonly string[];
}

/** Validation result for a provider-emitted tool call. */
export type GeneratedToolCall =
  | ValidGeneratedToolCall
  | InvalidGeneratedToolCall;

/** Ordered content item returned by a tool-capable generation. */
export type ToolGenerationContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: GeneratedToolCall };

/** Stable metadata copied from the exact model selected for the native request. */
export interface ModelIdentity {
  /** Model identifier as the hosting platform reports it. */
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  /** Model family the platform groups it under. */
  readonly family: string;
  readonly version: string;
}

/** Terminal result of a single tool-capable generation. */
export type ToolGenerationResult =
  | {
      readonly status: 'completed';
      /**
       * The model's own turn exactly as the provider returned it (text, every tool call with its
       * own arguments, and the provider stream parts {@link PROVIDER_PARTS_KEY}), appended to the
       * transcript unchanged, except that a call whose input is no JSON object is recorded with
       * `{}` (tool-call arguments must be an object; its paired rejection names the input kind).
       * {@link text} and {@link toolCalls} are views of it (`toolCalls` adds each call's outcome).
       */
      readonly message: AIMessage;
      readonly content: readonly ToolGenerationContent[];
      readonly text: string;
      readonly toolCalls: readonly GeneratedToolCall[];
      readonly finishReason: string;
    }
  | {
      readonly status: 'cancelled';
      readonly content: readonly [];
      readonly text: '';
      readonly toolCalls: readonly [];
    }
  | {
      readonly status: 'error';
      readonly content: readonly [];
      readonly text: '';
      readonly toolCalls: readonly [];
      /**
       * Source, code and sanitized chain of the failure, decided once by
       * {@link classifyTurnStop}.
       */
      readonly turnStop: TurnStop;
    };

/** Input contract for one schema-constrained generation. */
export interface GenerateStructuredInput<T> {
  /** Provider-neutral conversation history for this generation. */
  readonly messages: readonly ModelMessage[];
  /** Optional system instruction prepended ahead of `messages`. */
  readonly system?: string;
  /** Zod schema the model output must parse against; the parsed value is the returned result. */
  readonly schema: ZodType<T>;
  readonly signal?: AbortSignal;
  /** Optional graph phase label for diagnostics. */
  readonly phase?: string;
  readonly instructionContext?: InstructionContext;
}

/** Input contract for one text-only completion. */
export interface CompleteTextInput {
  /** Provider-neutral conversation history for this completion. */
  readonly messages: readonly ModelMessage[];
  /** Optional system instruction prepended ahead of `messages`. */
  readonly system?: string;
  readonly signal?: AbortSignal;
  /** Optional graph phase label for diagnostics. */
  readonly phase?: string;
  readonly instructionContext?: InstructionContext;
}

/** Request-scoped model port that permits exactly one tool-capable generation at a time. */
export interface SingleGenerationModelPort {
  /** Request-scoped port identifier derived from the wrapped model. */
  readonly id: string;
  /** Metadata copied from the exact model this port wraps. */
  readonly identity: ModelIdentity;
  /** Provider requests attempted through this port so far. */
  readonly modelCalls: number;
  /**
   * Token budget this request runs under, fixed when the turn built the port. It rides the port
   * because every generation path already receives it and the window half is a property of the
   * exact model the port wraps, so a superseded turn still executing keeps measuring against its
   * own model's window and caps.
   */
  readonly budget: TurnTokenBudget;
  /** Runs one tool-capable generation and validates emitted calls against the supplied tools. */
  generateToolTurn(input: ToolGenerationInput): Promise<ToolGenerationResult>;
  /**
   * Counts tokens for one message's content on the exact model this port wraps; the same
   * provider-reported count `trimMessages` uses to bound the retry transcript.
   */
  getNumTokens(content: MessageContent): Promise<number>;
}

/** Flattens LangChain `MessageContent` (string or content blocks) into text for a token counter. */
export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (typeof block === 'string' ? block : 'text' in block && typeof block.text === 'string' ? block.text : '')).join('');
}

/** Full provider-neutral model boundary used by the lineage runtime. */
export interface ModelPort extends SingleGenerationModelPort {
  /** Runs one schema-constrained generation and returns the parsed value. */
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
  /** Runs one text-only completion and returns its concatenated text. */
  completeText(input: CompleteTextInput): Promise<string>;
}

/** Creates the canonical cancellation result for a tool-capable generation. */
export function cancelledToolTurnResult(): ToolGenerationResult {
  return {
    status: 'cancelled',
    content: [],
    text: '',
    toolCalls: [],
  };
}

/**
 * Creates the canonical provider-error result without retaining raw provider output.
 *
 * @param error - The thrown value, classified once by {@link classifyTurnStop}.
 * @param diagnostic - Its sanitized chain, as the caller's sink already redacted it.
 */
export function errorToolTurnResult(error: unknown, diagnostic: ProviderErrorDiagnostic): ToolGenerationResult {
  return {
    status: 'error',
    content: [],
    text: '',
    toolCalls: [],
    turnStop: classifyTurnStop(error, diagnostic),
  };
}

/**
 * Classifies a turn-ending error once, by class, keeping the error untouched (the
 * `DbConnectionError`/`describeConnectionError` split; the text is added by `describeTurnStop`).
 * Every provider failure reaches the runtime as a {@link ModelPortError}: a transport code on its
 * chain makes it a network error, `unsupported_response` rejected model replies, `invalid_request`
 * a malformed request of Data Lineage. Any other throw is Data Lineage's own code: internal.
 */
export function classifyTurnStop(error: unknown, diagnostic: ProviderErrorDiagnostic): TurnStop {
  const base = { phase: diagnostic.phase, diagnostic };
  if (!(error instanceof ModelPortError)) return { ...base, source: 'internal', code: diagnostic.code ?? diagnostic.name };
  if (isTransportProviderError(diagnostic)) return { ...base, source: 'network', code: causeCodes(diagnostic)[0] ?? error.code };
  if (error.code === 'unsupported_response') {
    return { ...base, source: 'model_replies', code: error.code, detail: `(${error.message.replace(/\.$/, '')})` };
  }
  if (error.code === 'invalid_request') return { ...base, source: 'internal', code: error.code, detail: error.message };
  return { ...base, source: 'provider', code: error.code };
}
