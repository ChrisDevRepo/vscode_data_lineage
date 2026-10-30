/** Provider-neutral names and corrective messages for forced structured-output calls. */
import { at, type ToolError } from '../support/toolErrorEnvelope';
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
    /** The faults the correction renders, by path and issue code. */
    public readonly errors: readonly ToolError[] = at('invalid'),
  ) {
    super(`Structured output was rejected: ${reason}.`);
    this.name = 'StructuredOutputError';
  }
}

