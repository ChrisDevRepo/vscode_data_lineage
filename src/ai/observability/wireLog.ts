/**
 * Full-fidelity capture of what the language model receives and returns, plus sanitized provider
 * diagnostics for requests that fail before a response is available. Every record carries schema,
 * table and column names and SQL, so the sink exists only after the user enables AI trace logging
 * for the current extension-host session. Free of `vscode` imports so every model port emits the
 * same records; the VS Code projection is in [`vscodeWireLog.ts`](./vscodeWireLog.ts).
 */
import { createHash } from 'node:crypto';
import type { ProviderErrorDiagnostic } from '../support/text';

/** One message part, shaped exactly as it sits on the wire. */
export type WirePart =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly callId: string;
      readonly content: readonly WirePart[];
    }
  /** Unknown result-part variants, kept so capture stays total across VS Code API changes. */
  | { readonly type: 'other'; readonly json: string };

/** One converted message as handed to the provider. */
export interface WireMessage {
  /** The role exactly as the lane spells it: the `vscode.lm` role integer or the wire string. */
  readonly role: number | string;
  /** Message content parts, shaped exactly as they sit on the wire. */
  readonly parts: readonly WirePart[];
}

/** Provider-reported token accounting for one generation; an absent field means not reported. */
export interface TokenUsage {
  /** Provider-reported prompt (input) token count; absent when not reported. */
  readonly inputTokens?: number;
  /** Provider-reported completion (output) token count; absent when not reported. */
  readonly outputTokens?: number;
  /** Provider-reported total token count; absent when not reported. */
  readonly totalTokens?: number;
  /** Reasoning tokens billed separately by reasoning models, when the provider itemizes them. */
  readonly reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache, when the provider itemizes them. */
  readonly cachedTokens?: number;
}

/** One captured moment of a generation, before the port stamps it with its context. */
export type WireEvent =
  | {
      readonly type: 'wire-request';
      readonly messages: readonly WireMessage[];
      /** Tools offered on the request; the description rides as its {@link systemPromptHash}. */
      readonly tools: ReadonlyArray<{ readonly name: string; readonly descriptionHash: string; readonly inputSchema: unknown }>;
      /** `LanguageModelChatToolMode` integer, absent when the request carries no tools. */
      readonly toolMode?: number;
      /** The verbatim system instruction, captured only while the trace runs verbose. */
      readonly system?: string;
      /** SHA-256 of the system instruction; present whenever one was sent. */
      readonly systemHash?: string;
    }
  | {
      readonly type: 'wire-response';
      readonly text: string;
      readonly toolCalls: ReadonlyArray<{
        readonly callId: string;
        readonly name: string;
        readonly input: unknown;
      }>;
      /** Raw provider stop reason, on lanes whose protocol reports one. */
      readonly finishReason?: string;
      readonly usage?: TokenUsage;
      /** Stream parts that are neither text nor a tool call (reasoning, signatures, usage). */
      readonly otherParts?: readonly WirePart[];
    }
  | {
      /** Sanitized provider failure paired with the request that did not produce a response. */
      readonly type: 'wire-error';
      readonly diagnostic: ProviderErrorDiagnostic;
    }
  | {
      /**
       * One completed generation, summarized. `finishReason` is `unknown` when the provider gave
       * none and sent no usage part (the stream may have been cut).
       */
      readonly type: 'generation';
      readonly modelId: string;
      readonly finishReason: string;
      readonly latencyMs: number;
      readonly usage?: TokenUsage;
    }
  | {
      /** One verbatim provider HTTP body, verbose only; request headers are never captured. */
      readonly type: 'provider-raw';
      readonly direction: 'request' | 'response';
      readonly url: string;
      readonly method?: string;
      readonly status?: number;
      /** Response media type, without exposing the response's other headers. */
      readonly contentType?: string;
      readonly body: unknown;
    };

/** One JSONL line: a captured event plus the generation it belongs to. */
export type WireRecord = WireEvent & {
  /** Native request identifier shared with lifecycle and tool records. */
  readonly requestId: string;
  /** 1-based model-call index within the port, matching `[AI] usage call=N`. */
  readonly generation: number;
  /** Graph phase, when the calling layer knows one. */
  readonly phase?: string;
};

/** The per-generation measurement row. */
export type GenerationRecord = Extract<WireRecord, { readonly type: 'generation' }>;

/** One verbatim provider HTTP body, emitted only while the trace runs verbose. */
export type ProviderRawRecord = Extract<WireRecord, { readonly type: 'provider-raw' }>;

/** Digests a system instruction into the stable identifier the trace records; hex, not base64, so the trace-security guard never reads it as key material. */
export function systemPromptHash(system: string): string {
  return createHash('sha256').update(system, 'utf8').digest('hex');
}

/** Serializes trace content without throwing or truncating; unrepresentable parts become markers. */
export function safeTraceStringify(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafeValue(value, new Set<object>())) ?? 'null';
  } catch (error) {
    return JSON.stringify({
      serializationFailure: error instanceof Error ? error.name : 'Error',
    });
  }
}

/**
 * Rewrites a value into a JSON-safe shape. `ancestors` holds only the objects on the current path,
 * so a shared reference serializes in full and only a true cycle becomes `[Circular]`.
 */
function toJsonSafeValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'bigint') return `[BigInt:${value.toString()}]`;
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || value === undefined
  ) {
    return value;
  }
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafeValue(entry, ancestors));
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
    }
    if (value instanceof Map) {
      return {
        '[Map]': [...value.entries()].map(([key, entry]) => [
          toJsonSafeValue(key, ancestors),
          toJsonSafeValue(entry, ancestors),
        ]),
      };
    }
    if (value instanceof Set) {
      return { '[Set]': [...value].map((entry) => toJsonSafeValue(entry, ancestors)) };
    }

    const result: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable:${error instanceof Error ? error.name : 'Error'}]`;
    }
    for (const key of keys) {
      try {
        result[key] = toJsonSafeValue((value as Record<string, unknown>)[key], ancestors);
      } catch (error) {
        result[key] = `[Unserializable:${error instanceof Error ? error.name : 'Error'}]`;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
