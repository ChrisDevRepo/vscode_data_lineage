import type { ToolError } from './toolErrorEnvelope';

/** Reports a whitespace-only summary on a fresh finding. */
export function findingShapeIssues(
  value: Record<string, unknown>,
  fresh: boolean,
): ToolError[] {
  return fresh &&
    typeof value.summary === 'string' &&
    value.summary.trim() === ''
    ? [{ path: 'summary', code: 'missing' }]
    : [];
}
