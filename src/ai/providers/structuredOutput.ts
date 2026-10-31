/** Provider-neutral names and corrective messages for forced structured-output calls. */
import { at, type ToolError } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';

/** Synthetic tool advertised when a provider lacks native JSON-schema output. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/** Model-facing description attached to the synthetic structured-output tool. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  'Return the structured result. Call this tool exactly once with the required fields.';

/** Bounded semantic failure returned to LangGraph without retaining raw provider output. */
export class StructuredOutputError extends Error {
  /** Every structured-output fault is a correctable input fault; its issue codes classify it. */
  public readonly code = REJECTION_CODES.invalidInput;

  constructor(
    public readonly reason: string,
    /** The faults the correction renders, by path and issue code. */
    public readonly errors: readonly ToolError[] = at('invalid'),
  ) {
    super(`Structured output was rejected: ${reason}.`);
    this.name = 'StructuredOutputError';
  }
}
