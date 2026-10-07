/**
 * Detection of tool-call notation inside the text values of one tool call.
 *
 * @remarks
 * A model reply can deliver a text argument with the arguments that follow it still attached in
 * the provider's call notation. The value is checked, never split or rewritten: the call is
 * rejected at the field that carries the notation. A closing `</parameter>` counts only where an
 * argument or the call ends there, so the same tag inside quoted XML is ordinary text.
 */

/** Tool-call notation inside a text value: the start of a named argument or call, the end of a call, or the end of an argument followed by one of those or by the end of the value. */
const NOTATION = /<parameter\s+name="[A-Za-z_]\w*"\s*>|<invoke\s+name="[^"]*"\s*>|<\/invoke>|<\/parameter>(?=\s*(?:<parameter\s+name="|<\/invoke>|$))/;

/** The notation {@link NOTATION} matches, as stated in the rejection. */
const NOTATION_RULE = 'contains tool-call notation (`<parameter name=…>`, `</parameter>`, `<invoke name=…>`, `</invoke>`); a field holds its own value only.';

/** The rejection content for one tool call whose text values carry tool-call notation. */
export interface ToolCallNotationFault {
  /** Dotted paths of the values that carry notation, in input order. */
  readonly issuePaths: readonly string[];
  /** One line per path stating the rule broken. */
  readonly reason: string;
  /** One repair sentence per path. */
  readonly hint: string;
}

/** Repair sentence for one value: names the argument attached after the value's own text, when there is one. */
function repairSentence(path: string, value: string): string {
  const first = NOTATION.exec(value)!;
  const attached = /<parameter\s+name="([A-Za-z_]\w*)"\s*>/.exec(value)?.[1];
  return attached && value.slice(0, first.index).trim() !== ''
    ? `End \`${path}\` before the notation and send \`${attached}\` as its own argument.`
    : `Send \`${path}\` as its own value only, without the notation.`;
}

function collect(value: unknown, path: string, found: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') {
    if (NOTATION.test(value)) found.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, path ? `${path}.${index}` : String(index), found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collect(item, path ? `${path}.${key}` : key, found);
  }
}

/**
 * Checks every text value of one tool call's arguments for tool-call notation.
 *
 * @param input - The call's arguments as received, after the JSON-text decode.
 * @returns The rejection content naming each offending path, or `null` when no value carries notation.
 */
export function toolCallNotationFault(input: unknown): ToolCallNotationFault | null {
  const found: Array<{ path: string; value: string }> = [];
  collect(input, '', found);
  if (found.length === 0) return null;
  return {
    issuePaths: found.map(item => item.path),
    reason: found.map(item => `${item.path}: ${NOTATION_RULE}`).join('\n'),
    hint: found.map(item => repairSentence(item.path, item.value)).join(' '),
  };
}
