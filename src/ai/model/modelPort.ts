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
  /** Zod schema validating the call input; also the acceptance test in {@link matchProseToolCall}. */
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

/** A provider tool call that passed registry and input-schema validation. */
export interface ValidGeneratedToolCall {
  /** Literal `true` discriminator for the valid arm. */
  readonly valid: true;
  /** Provider call identifier, echoed into the paired tool-result message. */
  readonly callId: string;
  /** Registry tool name to dispatch. */
  readonly toolName: string;
  /** Call input as the provider sent it, already accepted by the tool's input schema. */
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
    | 'invalid_tool_input'
    | 'unknown_tool'
    // Registry-owned: the value is also taught to the model and drives the non-chargeable set.
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
  return { kind: 'promoted', toolName: accepting[0].name, input: candidate as Record<string, unknown> };
}

/** One degenerate-cycle finding: the repeated normalized line and its occurrence count. */
export interface RepetitionStrike {
  /** How many times the normalized line has repeated. */
  readonly repeats: number;
  /** The repeated normalized line. */
  readonly line: string;
}

// Occurrences of one line that make a generation degenerate: the 3rd identical repeat, not the 50,000th character. Calibrated so every degenerate loop body trips at 3, and no tool-bearing or `stop`-finished response trips at all.
const REPETITION_STRIKE = 3;
// Shortest repeated unit in any recorded loop is 37 chars; noise lines (`</parameter>`, `GO`,
// table rules) are 12 chars or fewer. 32 splits the two, and keeps markdown table rows and DDL
// boilerplate — legitimate text that may repeat — below the counted floor.
const REPETITION_MIN_LINE_CHARS = 32;
// Bounds the counter's memory on adversarial input: past this many distinct substantial lines,
// new distinct lines are no longer admitted (already-counted lines keep counting), so a hostile
// body cannot grow the map without bound while a genuine early repeat still fires.
const REPETITION_MAX_TRACKED_LINES = 2048;
// A line never terminated by a newline is counted whole once it passes this length, so a degenerate
// paragraph cycle with no line breaks at all is still caught instead of buffering forever.
const REPETITION_MAX_BUFFERED_LINE_CHARS = 8192;

/**
 * Counts repeated substantial text lines across ONE streamed generation — the degenerate-repeat
 * sibling of the stream text ceilings.
 *
 * @remarks
 * The ceilings in the ports bound a drain by SIZE; a model oscillating over one undecidable hop
 * choice emits a small cycle tens to hundreds of times (146k-150k chars observed against
 * 4-18k chars of unique content), so the size brake pays nearly the whole bill before reacting.
 * This counter fires when one substantial line reaches its 3rd identical occurrence, which on
 * every recorded loop body lands at 3-17% of the wasted characters. It observes text deltas as
 * they stream, normalizes whitespace (chunk boundaries never split a comparison), and returns the
 * strike exactly once; the caller applies the same protections as its phase ceiling — never after
 * a tool-call delta, per-generation state, and no cut where text is the deliverable. Exported
 * beside {@link matchProseToolCall} so any port, production or harness, stops on the same bytes.
 *
 * @returns An observer whose `observe` returns the first {@link RepetitionStrike}, or `null`.
 */
export function createStreamRepetitionObserver(): {
  readonly observe: (textDelta: string) => RepetitionStrike | null;
} {
  const counts = new Map<string, number>();
  let partial = '';
  const count = (raw: string): RepetitionStrike | null => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (
      line.length < REPETITION_MIN_LINE_CHARS
      || (counts.size >= REPETITION_MAX_TRACKED_LINES && !counts.has(line))
    ) {
      return null;
    }
    const repeats = (counts.get(line) ?? 0) + 1;
    counts.set(line, repeats);
    return repeats === REPETITION_STRIKE ? { repeats, line } : null;
  };
  return {
    observe(textDelta: string): RepetitionStrike | null {
      partial += textDelta;
      let end = partial.indexOf('\n');
      while (end !== -1) {
        const strike = count(partial.slice(0, end));
        partial = partial.slice(end + 1);
        if (strike) return strike;
        end = partial.indexOf('\n');
      }
      if (partial.length > REPETITION_MAX_BUFFERED_LINE_CHARS) {
        const strike = count(partial);
        partial = '';
        if (strike) return strike;
      }
      return null;
    },
  };
}
