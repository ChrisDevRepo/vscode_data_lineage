/**
 * Privacy-safe mission-brief diagnostics.
 *
 * @remarks
 * Mission text is never copied into logs. Exact byte preservation is verified by
 * boundary tests instead of adding a production content fingerprint.
 */
/**
 * Replaces mission text with non-content metadata before tool-call diagnostics persist it.
 *
 * @param input - Raw tool input that may carry a mission brief.
 * @returns The original value when no brief exists, otherwise a cloned value with provenance and length only.
 */
export function redactMissionBriefForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.prototype.hasOwnProperty.call(input, 'mission_brief')) {
    return input;
  }
  const brief = (input as Record<string, unknown>).mission_brief;
  return {
    ...(input as Record<string, unknown>),
    mission_brief: {
      provenance: 'tool_payload',
      length: typeof brief === 'string' ? brief.length : null,
    },
  };
}
