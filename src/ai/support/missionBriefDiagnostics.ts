/** Privacy-safe mission-brief diagnostics. */
/** Replaces mission text with non-content metadata before tool-call diagnostics persist it. */
export function redactMissionBriefForLog(input: unknown, decoded: unknown = input): unknown {
  const value = typeof input === 'string' ? decoded : input;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, 'mission_brief')) {
    return input;
  }
  const brief = (value as Record<string, unknown>).mission_brief;
  const redacted = {
    ...(value as Record<string, unknown>),
    mission_brief: {
      provenance: 'tool_payload',
      length: typeof brief === 'string' ? brief.length : null,
    },
  };
  return typeof input === 'string' ? JSON.stringify(redacted) : redacted;
}
