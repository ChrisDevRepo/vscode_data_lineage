/**
 * Deterministic, zero-model-call replay of one archived tool-call payload through a tool's real
 * Zod input schema and the production Zod-error reader.
 *
 * @remarks
 * `VscodeModelPort.generateToolTurn` (`src/ai/model/vscodeModelPort.ts`) validates every
 * provider-emitted call the same way: `definition.inputSchema.safeParse(part.input)`, and on
 * failure reads the `ZodError` through `rejectionFromZodError` to derive `code`, `reason`, and
 * `issuePaths`. This module runs that identical pair — the real schema, the real reader — over an
 * archived payload with no provider, session, or graph involved, so a recorded rejection class
 * becomes a failing assertion before it becomes a fixed bug, and stays reproducible after the fix
 * lands.
 */
import { readFileSync } from 'fs';
import type { z } from 'zod';
import { rejectionFromZodError } from '../../../../src/ai/support/toolErrorEnvelope';
import { testPath } from '../../helpers/testUtils';

/** A payload that parsed cleanly against the schema under replay. */
export interface ToolPayloadAccepted<T> {
  readonly accepted: true;
  /** Schema-parsed input, exactly what the model port would hand the dispatcher. */
  readonly input: T;
}

/** A payload the schema rejected, normalized through the same reader the model port uses. */
export interface ToolPayloadRejected {
  readonly accepted: false;
  readonly rejectionCode: string;
  readonly reason: string;
  /** Dotted field paths of every offending field, first-issue-first; empty when none were derivable. */
  readonly issuePaths: readonly string[];
}

export type ToolPayloadVerdict<T> = ToolPayloadAccepted<T> | ToolPayloadRejected;

/**
 * Runs `payload` through `schema.safeParse` and, on failure, {@link rejectionFromZodError} — the
 * same pair `VscodeModelPort.generateToolTurn` applies at dispatch.
 * @param schema - The tool's real Zod input schema, e.g. `SubmitFindingsBbInputSchema`.
 * @param payload - Untrusted tool-call input, typically loaded via {@link loadToolPayloadFixture}.
 * @param rejectionCode - Code stamped on a schema-validation failure. Defaults to the model port's
 * own `'invalid_tool_input'` so a reproduced verdict matches production without the caller repeating it.
 * @returns The structured verdict: accepted with the parsed input, or rejected with
 * code/reason/issuePaths — never a thrown error, matching the port's own non-throwing contract.
 */
export function replayToolPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  rejectionCode = 'invalid_tool_input',
): ToolPayloadVerdict<T> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { accepted: true, input: parsed.data };
  const rejection = rejectionFromZodError(parsed.error, { code: rejectionCode, input: payload });
  return {
    accepted: false,
    rejectionCode: rejection.code,
    reason: rejection.reason,
    issuePaths: rejection.issuePaths ?? [],
  };
}

/**
 * Loads one archived tool-call payload fixture from `tests/fixtures/tool-payloads/`.
 * @param name - Fixture file basename, without the `.json` extension.
 * @returns The parsed JSON payload, exactly as archived.
 */
export function loadToolPayloadFixture(name: string): unknown {
  return JSON.parse(readFileSync(testPath('tool-payloads', `${name}.json`), 'utf8'));
}
