/**
 * Privacy-safe mission-brief diagnostics: mission text is never copied into logs, and exact byte
 * preservation is verified by boundary tests rather than a production content fingerprint.
 */
/**
 * Replaces mission text with non-content metadata (provenance and length only) before tool-call
 * diagnostics persist it; returns the original value when no brief exists.
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
