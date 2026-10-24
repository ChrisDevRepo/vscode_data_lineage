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
type StructuredOutputErrorCode =
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

/** Builds a concise rejection reason and repair hint for a missing or schema-invalid synthetic tool call. */
export function structuredRejectReason(
  callPresent: boolean,
  error: z.ZodError | undefined,
  input?: unknown,
  schema?: z.ZodType,
): { reason: string; hint?: string } {
  if (!callPresent) return { reason: `missing ${STRUCTURED_OUTPUT_TOOL} tool call` };
  if (!error) return { reason: `invalid ${STRUCTURED_OUTPUT_TOOL} fields: schema mismatch` };
  const { reason, hint } = rejectionFromZodError(error, { code: REJECTION_CODES.invalidStructuredOutput, input, schema });
  return { reason: `invalid ${STRUCTURED_OUTPUT_TOOL} fields: ${reason}`, hint };
}
