/** Provider-neutral names and corrective messages for forced structured-output calls. */
import type { z } from 'zod';
import { rejectionFromZodError } from '../support/toolErrorEnvelope';

/** Synthetic tool advertised when a provider lacks native JSON-schema output. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/** Model-facing description attached to the synthetic structured-output tool. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  'Return the structured result. Call this tool exactly once with the required fields.';

/** Stable structured-output rejection classifications used by graph recovery policy. */
export type StructuredOutputErrorCode =
  | 'invalid_structured_output'
  | 'empty_structured_output';

/** Bounded semantic failure returned to LangGraph without retaining raw provider output. */
export class StructuredOutputError extends Error {
  constructor(
    public readonly reason: string,
    /** Stable classification used by graph retry policy. */
    public readonly code: StructuredOutputErrorCode = 'invalid_structured_output',
  ) {
    super(`Structured output was rejected: ${reason}.`);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Builds a concise rejection reason for a missing or schema-invalid synthetic tool call.
 *
 * @remarks
 * Routes the schema-invalid case through {@link rejectionFromZodError} — the sole producer of
 * auto-generated Zod reasons — so the model receives the actual violated predicate message
 * (`"<dottedPath>: <message>"`), not a path-only list it cannot self-correct from.
 * @param callPresent - Whether the provider emitted the synthetic tool call.
 * @param error - The Zod validation failure when the emitted input failed schema validation.
 * @returns Bounded reason suitable for graph retry state.
 */
export function structuredRejectReason(
  callPresent: boolean,
  error: z.ZodError | undefined,
): string {
  if (!callPresent) return `missing ${STRUCTURED_OUTPUT_TOOL} tool call`;
  if (!error) return `invalid ${STRUCTURED_OUTPUT_TOOL} fields: schema mismatch`;
  const { reason } = rejectionFromZodError(error, { code: 'invalid_structured_output' });
  return `invalid ${STRUCTURED_OUTPUT_TOOL} fields: ${reason}`;
}
