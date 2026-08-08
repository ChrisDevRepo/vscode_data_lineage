/**
 * Full-fidelity capture of what the language model actually receives and returns, plus sanitized
 * provider diagnostics for requests that fail before a response is available.
 *
 * @remarks
 * The bridge is the only point where the converted messages, the tool definitions (with their
 * input schemas) and the tool mode all exist at once, and it is the only place the wire is
 * observable at all: `@lineage` calls `vscode.lm.sendRequest` directly, so VS Code's own
 * `chat.agentDebugLog.*` panels — which instrument Copilot's agent sessions — record nothing for
 * it. Every record carries schema, table and column names and SQL, which is why the sink exists
 * only after the user explicitly enables AI trace logging for the current extension-host session.
 * Wire and lifecycle records then share the same diagnostic NDJSON file.
 *
 * The module is deliberately free of `vscode` imports so every model port — the native
 * `vscode.lm` lane and any plain-Node lane — emits the same record surface. The VS Code specific
 * message projection lives next door in [`vscodeWireLog.ts`](./vscodeWireLog.ts).
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
  // Preserve unknown result-part variants so wire capture remains total across VS Code API changes.
  | { readonly type: 'other'; readonly json: string };

/** One converted message as handed to the provider. */
export interface WireMessage {
  /**
   * The role exactly as the lane spells it — never a normalized label.
   *
   * @remarks
   * The `vscode.lm` lane records the raw `LanguageModelChatMessageRole` integer; that API exposes
   * user and assistant roles but no system role, so the port projects system instructions onto the
   * supported request shape before capture. Lanes speaking an OpenAI-compatible protocol record the
   * wire string (`'system'`/`'user'`/`'assistant'`/`'tool'`) instead. Both are kept verbatim so a
   * trace never claims a role its provider never saw.
   */
  readonly role: number | string;
  readonly parts: readonly WirePart[];
}

/**
 * Provider-reported token accounting for one generation.
 *
 * @remarks
 * Every field is optional because usage is provider-reported, not port-guaranteed: `vscode.lm`
 * exposes none at all. An absent field means "not reported", never zero.
 */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Reasoning tokens billed separately by reasoning models, when the provider itemizes them. */
  readonly reasoningTokens?: number;
}

/** One captured moment of a generation, before the port stamps it with its context. */
export type WireEvent =
  | {
      readonly type: 'wire-request';
      readonly messages: readonly WireMessage[];
      /** The tool input schema is the field no other capture surface exposes. */
      readonly tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>;
      /** `LanguageModelChatToolMode` integer, absent when the request carries no tools. */
      readonly toolMode?: number;
      /**
       * The verbatim system instruction, captured only while the trace runs verbose.
       *
       * @remarks
       * The system prompt is the largest single payload in a turn and it is the same text on every
       * generation, so the default trace records {@link systemHash} alone. Verbose mode exists for
       * the case the hash cannot answer: proving *which* prompt revision a bad answer came from.
       */
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
    }
  | {
      /** Sanitized provider failure paired with the request that did not produce a response. */
      readonly type: 'wire-error';
      readonly diagnostic: ProviderErrorDiagnostic;
    }
  | {
      /**
       * One completed generation, summarized: which model answered, how it stopped, how long it
       * took, and what it cost.
       *
       * @remarks
       * Deliberately separate from `wire-response`, which is the payload. This is the row a
       * measurement reads, and it is the only record naming the model in CLEAR TEXT — the lifecycle
       * `turn-start` record carries a `modelFingerprint` hash, which cannot answer "which model
       * misbehaved" when comparing lanes. A model id is a public product identifier, never a
       * credential.
       */
      readonly type: 'generation';
      readonly modelId: string;
      readonly finishReason: string;
      readonly latencyMs: number;
      readonly usage?: TokenUsage;
    }
  | {
      /**
       * One verbatim provider HTTP body, captured only while the trace runs verbose.
       *
       * @remarks
       * Bodies only. Request headers are never captured on any lane and no field of this record may
       * ever hold them: the Authorization header is where the credential lives, and a trace the user
       * is invited to attach to a bug report must be safe to attach.
       */
      readonly type: 'provider-raw';
      readonly direction: 'request' | 'response';
      readonly url: string;
      readonly method?: string;
      readonly status?: number;
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

/**
 * Digests one system instruction into the stable identifier the non-verbose trace records.
 *
 * @remarks
 * SHA-256 rather than a shorter digest so two prompt revisions can never collide in a comparison
 * across runs, and hex rather than base64 so the value is inert in every consumer — a 64-character
 * lowercase hex run carries none of the character classes the trace-security guard treats as
 * possible key material.
 */
export function systemPromptHash(system: string): string {
  return createHash('sha256').update(system, 'utf8').digest('hex');
}

/**
 * Serializes trace-only diagnostic content without throwing or truncating it.
 *
 * Unlike Output-channel serialization, the opt-in wire trace must retain complete
 * prompts and payloads. Cycles, bigint values, throwing getters, and exotic
 * objects are therefore represented with explicit string markers while the rest
 * of the record remains valid JSON.
 */
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
 * Rewrites one value into a JSON-safe shape, degrading only the part that cannot be represented.
 *
 * @remarks
 * `ancestors` holds the objects on the *current path*, not every object ever seen, and each entry
 * is removed again in the `finally`. Two siblings pointing at the same object are a shared
 * reference, not a cycle, so both must serialize their real content; a `JSON.stringify` replacer
 * cannot make that distinction because it is never told when a subtree ends. The per-key try/catch
 * is the second half of the same contract: one throwing getter degrades to `[Unserializable:…]`
 * while its siblings survive, because a wire trace exists to be read after a failure.
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
  // `JSON.stringify` drops these silently; the trace records them so the reader sees what was sent.
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafeValue(entry, ancestors));
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
