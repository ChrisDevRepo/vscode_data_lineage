/** Privacy-safe mission-brief diagnostics. */
/** Replaces mission text with non-content metadata before tool-call diagnostics persist it. */
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
