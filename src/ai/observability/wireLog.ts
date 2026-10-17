/** Full-fidelity capture of what the language model receives and returns, plus sanitized provider diagnostics for requests that fail before a response is available. */
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
  /** Preserve unknown result-part variants so wire capture remains total across VS Code API changes. */
  | { readonly type: 'other'; readonly json: string };

/** One converted message as handed to the provider. */
export interface WireMessage {
  /** The role exactly as the lane spells it, never normalized. */
  readonly role: number | string;
  /** Message content parts, shaped exactly as they sit on the wire. */
  readonly parts: readonly WirePart[];
}

/** Provider-reported token accounting for one generation. */
export interface TokenUsage {
  /** Provider-reported prompt (input) token count; absent when not reported. */
  readonly inputTokens?: number;
  /** Provider-reported completion (output) token count; absent when not reported. */
  readonly outputTokens?: number;
  /** Provider-reported total token count; absent when not reported. */
  readonly totalTokens?: number;
  /** Reasoning tokens billed separately by reasoning models, when the provider itemizes them. */
  readonly reasoningTokens?: number;
}

/** One captured moment of a generation, before the port stamps it with its context. */
export type WireEvent =
  | {
      readonly type: 'wire-request';
      readonly messages: readonly WireMessage[];
      /** Tools offered on the request. */
      readonly tools: ReadonlyArray<{ readonly name: string; readonly descriptionHash: string; readonly inputSchema: unknown }>;
      /** `LanguageModelChatToolMode` integer, absent when the request carries no tools. */
      readonly toolMode?: number;
      /** The verbatim system instruction, captured only while the trace runs verbose. */
      readonly system?: string;
      /** SHA-256 of the system instruction ({@link systemPromptHash}); always present when one was sent. */
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
      /** Stream parts that are neither text nor a tool call (reasoning, signatures). */
      readonly otherParts?: readonly WirePart[];
    }
  | {
      /** Sanitized provider failure paired with the request that did not produce a response. */
      readonly type: 'wire-error';
      readonly diagnostic: ProviderErrorDiagnostic;
    }
  | {
      /** One completed generation, summarized: which model answered, how it stopped, how long it took, and what it cost. */
      readonly type: 'generation';
      readonly modelId: string;
      readonly finishReason: string;
      readonly latencyMs: number;
      readonly usage?: TokenUsage;
    }
  | {
      /** One verbatim provider HTTP body, captured only while the trace runs verbose. */
      readonly type: 'provider-raw';
      readonly direction: 'request' | 'response';
      readonly url: string;
      readonly method?: string;
      readonly status?: number;
      /** Response media type, without exposing the response's other headers. */
      readonly contentType?: string;
      /** Allowlisted diagnostic headers of a failed response (rate limit, request id); never request headers. */
      readonly headers?: Readonly<Record<string, string>>;
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

/** The per-generation measurement row: model identity, stop reason, latency, and usage. */
export type GenerationRecord = Extract<WireRecord, { readonly type: 'generation' }>;

/** One verbatim provider HTTP body, emitted only while the trace runs verbose. */
export type ProviderRawRecord = Extract<WireRecord, { readonly type: 'provider-raw' }>;

/** Digests one system instruction into the stable identifier the non-verbose trace records. */
export function systemPromptHash(system: string): string {
  return createHash('sha256').update(system, 'utf8').digest('hex');
}

/** Serializes trace-only diagnostic content without throwing or truncating it. */
export function safeTraceStringify(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafeValue(value, new Set<object>())) ?? 'null';
  } catch (error) {
    return JSON.stringify({
      serializationFailure: error instanceof Error ? error.name : 'Error',
    });
  }
}

/** Rewrites one value into a JSON-safe shape, degrading only the part that cannot be represented. */
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
