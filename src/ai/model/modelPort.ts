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
