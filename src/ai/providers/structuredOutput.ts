/** Provider-neutral names and corrective messages for forced structured-output calls. */
import type { z } from 'zod';
import { rejectionFromZodError } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';

/** Synthetic tool advertised when a provider lacks native JSON-schema output. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/** Model-facing description attached to the synthetic structured-output tool. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  'Return the structured result. Call this tool exactly once with the required fields.';

/** Stable structured-output rejection classifications used by graph recovery policy. */
export type StructuredOutputErrorCode =
  | typeof REJECTION_CODES.invalidStructuredOutput
  | typeof REJECTION_CODES.emptyStructuredOutput;

/** Bounded semantic failure returned to LangGraph without retaining raw provider output. */
export class StructuredOutputError extends Error {
  constructor(
    public readonly reason: string,
    /** Stable classification used by graph retry policy. */
    public readonly code: StructuredOutputErrorCode = REJECTION_CODES.invalidStructuredOutput,
    /** Schema-derived repair instruction; absent when the failure has no field-level repair. */
    public readonly hint?: string,
  ) {
    super(`Structured output was rejected: ${reason}.`);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Builds a concise rejection reason and repair hint for a missing or schema-invalid synthetic tool call.
 *
 * @remarks
 * Routes the schema-invalid case through {@link rejectionFromZodError} — the sole producer of
 * auto-generated Zod reasons and of the field repair chain — so the model receives the violated
 * predicate (`"<dottedPath>: <message>"`) and the schema-derived repair, as on the tool path.
 * @param callPresent - Whether the provider emitted the synthetic tool call.
 * @param error - The Zod validation failure when the emitted input failed schema validation.
 * @param input - The parsed payload that failed validation; enables measured-size and type-mismatch text.
 * @returns Bounded reason for graph retry state; `hint` only for a schema-invalid payload.
 */
export function structuredRejectReason(
  callPresent: boolean,
  error: z.ZodError | undefined,
  input?: unknown,
): { reason: string; hint?: string } {
  if (!callPresent) return { reason: `missing ${STRUCTURED_OUTPUT_TOOL} tool call` };
  if (!error) return { reason: `invalid ${STRUCTURED_OUTPUT_TOOL} fields: schema mismatch` };
  const { reason, hint } = rejectionFromZodError(error, { code: REJECTION_CODES.invalidStructuredOutput, input });
  return { reason: `invalid ${STRUCTURED_OUTPUT_TOOL} fields: ${reason}`, hint };
}
