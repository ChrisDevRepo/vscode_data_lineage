import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import type { ZodType } from 'zod';
import { REJECTION_CODES } from '../support/rejectionCodes';
import {
  describeProviderErrorForUser,
  type ProviderErrorDiagnostic,
} from '../support/text';
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
 * held as the original objects in stream order.
 *
 * @remarks
 * The array rides exactly one stream chunk: `AIMessageChunk.concat` keeps that array's objects and
 * order untouched, whereas two chunks each carrying the key would have their items merged by `id`
 * into plain objects.
 */
export const PROVIDER_PARTS_KEY = 'providerParts';

/**
 * Reads a message's provider stream parts ({@link PROVIDER_PARTS_KEY}); empty when it carries none.
 */
export function messageProviderParts(message: BaseMessage): readonly unknown[] {
  const parts = message.additional_kwargs?.[PROVIDER_PARTS_KEY];
  return Array.isArray(parts) ? parts : [];
}

/**
 * Creates an assistant message containing validated JSON-object tool calls.
 *
 * @param providerParts - The provider stream parts of the generation that emitted these calls,
 * replayed verbatim before them so a provider that signs its own turn receives it unchanged.
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelPortError(
      'invalid_request',
      'Tool-call input must be a JSON object.',
    );
  }
  return input as Record<string, unknown>;
}

/**
 * Creates the tool-result message paired with a preceding tool call.
 * @param status - Standard tool-result outcome: `'success'` for an executed call, `'error'`
 * otherwise. Omitted only by a caller with no outcome to report (e.g. replayed chat history).
 * @param artifact - Machine-only facts riding `@langchain/core`'s documented `ToolMessage.artifact`
 * side channel — kept on the message for a reader that needs the full structured record, never sent
 * to the provider. Omitted when the caller has none.
 */
export function modelToolResultMessage(
  callId: string,
  toolName: string,
  text: string,
  status?: 'success' | 'error',
  artifact?: unknown,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: callId,
    name: toolName,
    content: text,
    ...(status !== undefined ? { status } : {}),
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
 * Bounded provider-neutral error safe to retain in graph state.
 *
 * @remarks
 * `cause` retains the original provider exception when one exists. It is what
 * `sanitizeProviderErrorDiagnostic` walks to recover the connection-level `code`
 * (`ECONNRESET`/`ETIMEDOUT`/…) that transport classification keys off. It is
 * declared here rather than relying on the ES2022
 * `Error(message, { cause })` overload because this project compiles against `lib: ES2020`.
 * Every sink sanitizes before emitting, so the raw exception never reaches a log or the UI.
 */
export class ModelPortError extends Error {
  public constructor(
    public readonly code: ModelPortErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelPortError';
  }
}

/**
 * Whether a thrown value is a port-level cancellation ({@link ModelPortError}
 * with code `'cancelled'`).
 *
 * @remarks
 * The one predicate callers above the port use for this case — pair it with
 * `support/cancellation.ts`'s `isCancellationOutcome` for signal/transport
 * aborts instead of re-rolling the `instanceof` + code check per caller.
 */
export function isPortCancellation(error: unknown): boolean {
  return error instanceof ModelPortError && error.code === 'cancelled';
}

/**
 * Error names the VS Code language-model host raises when a request is cancelled.
 *
 * @remarks
 * `Canceled` is the platform spelling (`vscode.CancellationError`), `Cancelled` appears from
 * providers that spell it with two `l`s, and `AbortError` is the fetch-level abort surfaced
 * through the same call. Declared once here because the bridge and the port both classify the
 * raw transport error and a byte-for-byte copy of the list drifts silently.
 */
const HOST_CANCELLATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'Canceled',
  'Cancelled',
]);

/**
 * Whether a thrown value carries one of the host's cancellation error names.
 *
 * @remarks
 * Name-based by necessity: the host raises a plain `Error` with no code for this case. Pair it
 * with {@link isPortCancellation} for an already-normalized port error, and with
 * `support/cancellation.ts`'s `isCancellationOutcome` for the `ABORT_ERR`/`20` code forms.
 *
 * @param error - The thrown value to classify.
 * @returns `true` when the error name is one the host uses for cancellation.
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
  /** Tool name the model must address the call by. */
  readonly name: string;
  /** Natural-language description of what the tool does. */
  readonly description: string;
  /** Zod schema validating the call input. */
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
  /** Tool definitions offered to the model. */
  readonly tools: readonly ModelToolDefinition[];
  /** Optional policy narrowing which tools the model may call. */
  readonly toolChoice?: ModelToolChoice;
  /** Optional abort signal cancelling the generation. */
  readonly signal?: AbortSignal;
  /** Graph phase label carried into diagnostics and trace records. */
  readonly phase: string;
  /** Optional audit context naming which instruction fragments reached this generation. */
  readonly instructionContext?: InstructionContext;
  /** Optional streaming callback invoked with each incremental text fragment. */
  readonly onTextDelta?: (text: string) => void;
}

/** A registered native tool call ready for argument validation at its execution boundary. */
export interface ValidGeneratedToolCall {
  /** Literal `true` discriminator for the valid arm. */
  readonly valid: true;
  /** Provider call identifier, echoed into the paired tool-result message. */
  readonly callId: string;
  /** Registry tool name to dispatch. */
  readonly toolName: string;
  /** Transport-decoded arguments, preserved for the receiving tool's schema admission. */
  readonly input: unknown;
}

/** A provider tool call rejected before dispatch. */
export interface InvalidGeneratedToolCall {
  /** Literal `false` discriminator for the invalid arm. */
  readonly valid: false;
  /** Provider call identifier exactly as the provider emitted it. */
  readonly callId: string;
  /** Tool name as the provider spelled it; it may name no registered tool. */
  readonly toolName: string;
  /**
   * The rejected payload exactly as the provider sent it. Kept so retry-budget guards can compare
   * a follow-up call against the just-rejected one (by fingerprint, never by retaining it) and
   * distinguish a genuine repair attempt from an unproductive resend; without it every reject of
   * the same tool would be indistinguishable. Never dispatched, replayed, or logged raw.
   */
  readonly input?: unknown;
  /** Rejection category — schema-invalid input, unknown tool, or a duplicate call id. */
  readonly code:
    | typeof REJECTION_CODES.invalidToolInput
    | typeof REJECTION_CODES.unknownTool
    | typeof REJECTION_CODES.duplicateCallId;
  /** Human-readable rejection prose returned to the model for repair. */
  readonly reason: string;
  /**
   * Repair instruction naming the fix for this specific rejection, when the producer derived one
   * from the issue shape (e.g. an `unrecognized_keys` Zod issue names removal, never the standing
   * resend-unchanged instruction). Absent for shapes with no producer-derived hint, in which case
   * the dispatcher applies its own fixed per-code hint.
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
  /** Human-readable model name. */
  readonly name: string;
  /** Vendor that serves the model. */
  readonly vendor: string;
  /** Model family the platform groups it under. */
  readonly family: string;
  /** Model version string. */
  readonly version: string;
}

/** Terminal result of a single tool-capable generation. */
export type ToolGenerationResult =
  | {
      readonly status: 'completed';
      /**
       * The model's own turn exactly as the provider returned it — text, every tool call with its
       * own arguments, and the provider stream parts ({@link PROVIDER_PARTS_KEY}) — appended to the
       * transcript unchanged. {@link text} and {@link toolCalls} are views of it (`toolCalls` adds
       * each call's validation outcome).
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
      readonly error: string;
      readonly providerError: ProviderErrorDiagnostic;
    };

/** Input contract for one schema-constrained generation. */
export interface GenerateStructuredInput<T> {
  /** Provider-neutral conversation history for this generation. */
  readonly messages: readonly ModelMessage[];
  /** Optional system instruction prepended ahead of `messages`. */
  readonly system?: string;
  /** Zod schema the model output must parse against; the parsed value is the returned result. */
  readonly schema: ZodType<T>;
  /** Optional abort signal cancelling the generation. */
  readonly signal?: AbortSignal;
  /** Optional graph phase label for diagnostics. */
  readonly phase?: string;
  /** Optional audit context for this generation. */
  readonly instructionContext?: InstructionContext;
}

/** Input contract for one text-only completion. */
export interface CompleteTextInput {
  /** Provider-neutral conversation history for this completion. */
  readonly messages: readonly ModelMessage[];
  /** Optional system instruction prepended ahead of `messages`. */
  readonly system?: string;
  /** Optional abort signal cancelling the completion. */
  readonly signal?: AbortSignal;
  /** Optional graph phase label for diagnostics. */
  readonly phase?: string;
  /** Optional audit context for this completion. */
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
   * Token budget this request runs under, fixed when the turn built the port.
   *
   * @remarks
   * Rides the port because the port is the object every generation path already receives, and the
   * window half of the budget is a property of the exact model the port wraps. A superseded turn
   * still executing therefore keeps measuring against its own model's window and caps.
   */
  readonly budget: TurnTokenBudget;
  /** Runs one tool-capable generation and validates emitted calls against the supplied tools. */
  generateToolTurn(input: ToolGenerationInput): Promise<ToolGenerationResult>;
  /**
   * Counts tokens for one message's content on the exact model this port wraps — the same
   * provider-reported count `trimMessages` uses to bound the retry transcript.
   */
  getNumTokens(content: MessageContent): Promise<number>;
}

/** Flattens LangChain `MessageContent` (a string or a list of content blocks) into plain text for a provider token counter. */
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
 * @param diagnostic - Sanitized provider diagnostic retained for classification.
 * @param userMessage - Optional user-facing message; derived from `diagnostic` when omitted.
 */
export function errorToolTurnResult(
  diagnostic: ProviderErrorDiagnostic,
  userMessage?: string,
): ToolGenerationResult {
  return {
    status: 'error',
    content: [],
    text: '',
    toolCalls: [],
    error: userMessage ?? describeProviderErrorForUser(diagnostic),
    providerError: diagnostic,
  };
}
