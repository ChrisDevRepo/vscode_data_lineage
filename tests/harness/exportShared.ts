/** Helpers for the REST OTLP trace exporter (`langfuseExport.ts`). */

import type { GenerationEntry, ParsedRun } from './traceModel';

/** Captured context for one generation, including an existing provider request body but no transport headers or URL; verbose traces only. */
export function verboseContent(run: ParsedRun, generation: Pick<GenerationEntry, 'requestId' | 'generation'>): { input?: unknown; output?: unknown } {
  const request = run.wire.find(
    (entry) => entry.type === 'wire-request'
      && entry.requestId === generation.requestId
      && entry.generation === generation.generation,
  );
  if (!request || request.type !== 'wire-request' || request.system === undefined) return {};
  const provider = run.wire.find(entry => entry.type === 'provider-raw' && entry.direction === 'request'
    && entry.requestId === generation.requestId && entry.generation === generation.generation);
  const response = run.wire.find(
    (entry) => entry.type === 'wire-response'
      && entry.requestId === generation.requestId
      && entry.generation === generation.generation,
  );
  return {
    input: { system: request.system, systemHash: request.systemHash, messages: request.messages,
      tools: request.tools, toolMode: request.toolMode,
      providerRequest: provider?.type === 'provider-raw' ? provider.body : undefined },
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
