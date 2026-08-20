/**
 * Helpers for the REST trace exporter (`langfuseExport.ts`).
 *
 * @remarks
 * Single home for the verbose-content gating rule and error redaction. Plain data shaping only —
 * no vendor SDK, no network I/O, per the sanctioned plain-HTTP exporter policy in CLAUDE.md.
 */

import type { GenerationEntry, ParsedRun } from './traceModel';

/**
 * Message content for one generation, present only while the trace ran verbose.
 *
 * @remarks
 * `system` on the matching `wire-request` is the verbose signal (see `wireLog.ts` — it is
 * captured only when `AiTraceWriter.isVerbose()`); the non-verbose default carries `systemHash`
 * alone, which is not prompt content and must never be reported to an observability backend as
 * input. Token usage is not gated by this — a token count is a measurement, not reused prompt
 * content, so callers may attach usage metadata unconditionally.
 */
export function verboseContent(run: ParsedRun, generation: GenerationEntry): { input?: unknown; output?: unknown } {
  const request = run.wire.find(
    (entry) => entry.type === 'wire-request'
      && entry.requestId === generation.requestId
      && entry.generation === generation.generation,
  );
  if (!request || request.type !== 'wire-request' || request.system === undefined) return {};
  const response = run.wire.find(
    (entry) => entry.type === 'wire-response'
      && entry.requestId === generation.requestId
      && entry.generation === generation.generation,
  );
  return {
    input: { system: request.system, messages: request.messages },
    output: response && response.type === 'wire-response'
      ? { text: response.text, toolCalls: response.toolCalls }
      : undefined,
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Strips the literal secret from an error string before it can reach a log or a report. */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}
