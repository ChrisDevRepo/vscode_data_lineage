import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
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

/** Creates a system instruction in the graph's provider-neutral message format. */
export function modelSystemMessage(text: string): SystemMessage {
  return new SystemMessage(text);
}

/** Creates a user message in the graph's provider-neutral message format. */
export function modelUserMessage(text: string): HumanMessage {
  return new HumanMessage(text);
}

/** Creates an assistant message in the graph's provider-neutral message format. */
export function modelAssistantMessage(text: string): AIMessage {
  return new AIMessage(text);
}

/**
 * Creates an assistant message containing validated JSON-object tool calls.
 *
 * @throws {@link ModelPortError} when a call input is not a JSON object.
 */
export function modelToolCallMessage(
  calls: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly input: unknown;
  }[],
  text = '',
): AIMessage {
  return new AIMessage({
    content: text,
    tool_calls: calls.map((call) => ({
      id: call.callId,
      name: call.toolName,
      args: modelToolArgs(call.input),
      type: 'tool_call' as const,
    })),
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

/** Creates the tool-result message paired with a preceding tool call. */
export function modelToolResultMessage(
  callId: string,
  toolName: string,
  text: string,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: callId,
    name: toolName,
    content: text,
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
  readonly kind: 'structured' | 'converse' | 'text';
  readonly analysisMode?: 'bb' | 'ct';
  readonly classification?: 'business' | 'technical' | 'both';
  readonly targetColumns?: readonly string[];
  readonly templateKeys: readonly string[];
  readonly memorySections: readonly string[];
  readonly toolNames: readonly string[];
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
  readonly messages: readonly ModelMessage[];
  readonly system?: string;
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: ModelToolChoice;
  readonly signal?: AbortSignal;
  readonly phase: string;
  readonly instructionContext?: InstructionContext;
  readonly onTextDelta?: (text: string) => void;
}

/** A provider tool call that passed registry and input-schema validation. */
export interface ValidGeneratedToolCall {
  readonly valid: true;
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** A provider tool call rejected before dispatch. */
export interface InvalidGeneratedToolCall {
  readonly valid: false;
  readonly callId: string;
  readonly toolName: string;
  /**
   * The rejected payload exactly as the provider sent it. Kept so retry-budget guards can compare
   * a follow-up call against the just-rejected one (by fingerprint, never by retaining it) and
   * distinguish a genuine repair attempt from an unproductive resend; without it every reject of
   * the same tool would be indistinguishable. Never dispatched, replayed, or logged raw.
   */
  readonly input?: unknown;
  readonly code:
    | 'invalid_tool_input'
    | 'unknown_tool'
    // Registry-owned: the value is also taught to the model and drives the non-chargeable set.
    | typeof REJECTION_CODES.duplicateCallId;
  readonly reason: string;
  readonly issuePaths?: readonly string[];
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
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
}

/** Terminal result of a single tool-capable generation. */
export type ToolGenerationResult =
  | {
      readonly status: 'completed';
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
  readonly messages: readonly ModelMessage[];
  readonly system?: string;
  readonly schema: ZodType<T>;
  readonly signal?: AbortSignal;
  readonly phase?: string;
  readonly instructionContext?: InstructionContext;
}

/** Input contract for one text-only completion. */
export interface CompleteTextInput {
  readonly messages: readonly ModelMessage[];
  readonly system?: string;
  readonly signal?: AbortSignal;
  readonly phase?: string;
  readonly instructionContext?: InstructionContext;
}

/** Request-scoped model port that permits exactly one tool-capable generation at a time. */
export interface SingleGenerationModelPort {
  readonly id: string;
  readonly identity: ModelIdentity;
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
  generateToolTurn(input: ToolGenerationInput): Promise<ToolGenerationResult>;
}

/** Full provider-neutral model boundary used by the lineage runtime. */
export interface ModelPort extends SingleGenerationModelPort {
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
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

/** A fenced ```json (or bare ```) code block wrapping exactly one JSON value. */
const FENCED_JSON_BLOCK = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * One `<parameter=name>` pair of the Hermes/XML tool-call envelope — the second recorded spelling
 * of the same miss. Global: a call carries one pair per field, and the closing tag is the bare
 * `</parameter>`, never a named or balanced `</tool_call>` form.
 */
const XML_TOOL_PARAMETER = /<parameter=([A-Za-z0-9_]+)>\n?([\s\S]*?)\n?<\/parameter>/g;

/** Synthetic call identifier every promoted prose tool call carries, on every lane. */
export const PROSE_PROMOTED_CALL_ID = 'text-promoted-0';

/** Outcome of reading a text-only generation as a tool call. */
export type ProseToolCallMatch =
  | { readonly kind: 'promoted'; readonly toolName: string; readonly input: Record<string, unknown> }
  | { readonly kind: 'ambiguous'; readonly tools: readonly string[] }
  | { readonly kind: 'none' };

/**
 * Reads a text-only generation as the record a tool call would carry, without judging it.
 *
 * @remarks
 * Three recorded spellings of one miss: a fenced JSON block, the payload as the entire message body
 * with no fence at all, and the Hermes/XML `<parameter=…>` envelope. The per-value parse of the
 * envelope is best-effort so a bare id like `[ai].[x]` stays the string it is. Zero
 * `<parameter=…>` pairs is not this envelope — matching none must not manufacture an empty `{}` a
 * permissive schema could accept. Reading is not acceptance: what a tool accepts is decided by its
 * own schema in {@link matchProseToolCall}.
 *
 * @param text - The generation's concatenated text.
 * @returns The record read from `text`, or `null` when `text` carries none of the three shapes.
 */
export function readProseToolCandidate(text: string): Record<string, unknown> | null {
  const match = FENCED_JSON_BLOCK.exec(text);
  let candidate: unknown;
  try {
    candidate = JSON.parse(match ? match[1] : text.trim());
  } catch {
    const xmlParameters = [...text.matchAll(XML_TOOL_PARAMETER)];
    if (xmlParameters.length === 0) return null;
    candidate = Object.fromEntries(
      xmlParameters.map(([, name, raw]): [string, unknown] => {
        const value = raw.trim();
        try {
          return [name, JSON.parse(value) as unknown];
        } catch {
          return [name, value];
        }
      }),
    );
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

/**
 * Recovers a tool call a provider described in prose instead of emitting through the native
 * tool-call channel.
 *
 * @remarks
 * The single recognizer both ports call, so the harness measures what production would have done.
 * Callers apply it only to a generation that carries no native tool-call part — a real call is
 * never second-guessed. Acceptance is the tool's own {@link ModelToolDefinition.inputSchema}, the
 * same schema the native path validates against, so nothing here relaxes what a tool accepts. A
 * prose payload names no tool, so its identity is the one schema that accepts it; two accepting
 * schemas leave the tool undetermined and the generation stays a text finish, which the attempt
 * policy then charges as it would any other text-only answer.
 *
 * @param text - The generation's concatenated text.
 * @param definitions - Tool definitions offered for this generation, already narrowed to the active
 * tool choice.
 * @returns The promoted call, the ambiguous tool names, or `none`.
 */
export function matchProseToolCall(
  text: string,
  definitions: readonly ModelToolDefinition[],
): ProseToolCallMatch {
  if (definitions.length === 0) return { kind: 'none' };
  const candidate = readProseToolCandidate(text);
  if (!candidate) return { kind: 'none' };
  const accepting = definitions.filter((entry) => entry.inputSchema.safeParse(candidate).success);
  if (accepting.length === 0) return { kind: 'none' };
  if (accepting.length > 1) {
    return { kind: 'ambiguous', tools: accepting.map((entry) => entry.name) };
  }
  return { kind: 'promoted', toolName: accepting[0].name, input: candidate };
}
