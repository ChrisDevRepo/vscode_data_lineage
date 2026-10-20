/** Helpers for the REST OTLP trace exporter (`langfuseExport.ts`). */

import type { GenerationEntry, ParsedRun } from './traceModel';

/** Message content for one generation, present only while the trace ran verbose. */
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
