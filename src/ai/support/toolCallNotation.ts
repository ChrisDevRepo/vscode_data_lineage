/**
 * Detection of tool-call notation inside one tool call. A model reply can deliver a text argument
 * (or an argument name) with the arguments that follow it still attached in the provider's call
 * notation; the text is checked, never split or rewritten, and the call is rejected at the field
 * carrying the notation. A closing tag counts only where an argument or the call ends there, so the
 * same tag inside quoted XML is ordinary text.
 */
import { jsonPointer } from './toolErrorEnvelope';

/**
 * One provider's tool-call notation inside a text: the start of a named argument or call, the end of
 * a call, or the end of an argument followed by one of those or by the end of the text; with the
 * argument name it attaches and the rule stated in the rejection.
 */
interface Notation {
  readonly pattern: RegExp;
  readonly attached: RegExp;
  readonly rule: string;
}

const NOTATIONS: readonly Notation[] = [
  {
    pattern: /<parameter\s+name="[A-Za-z_]\w*"\s*>|<invoke\s+name="[^"]*"\s*>|<\/invoke>|<\/parameter>(?=\s*(?:<parameter\s+name="|<\/invoke>|$))/,
    attached: /<parameter\s+name="([A-Za-z_]\w*)"\s*>/,
    rule: 'contains tool-call notation (`<parameter name=…>`, `</parameter>`, `<invoke name=…>`, `</invoke>`); a field holds its own value only.',
  },
  {
    pattern: /<arg_key>[A-Za-z_]\w*<\/arg_key>|<\/arg_key>(?=\s*<arg_value>)|<\/arg_value>(?=\s*(?:<arg_key>|<\/tool_call>|$))/,
    attached: /<arg_key>([A-Za-z_]\w*)<\/arg_key>/,
    rule: 'contains tool-call notation (`<arg_key>`, `</arg_key>`, `<arg_value>`, `</arg_value>`); a field holds its own value only.',
  },
];

/**
 * The rejection content for one tool call whose argument names or text values carry tool-call
 * notation.
 */
export interface ToolCallNotationFault {
  /** Dotted paths of the argument names or values that carry notation, in input order. */
  readonly issuePaths: readonly string[];
  /** One line per path stating the rule broken. */
  readonly reason: string;
  /** One repair sentence per path. */
  readonly hint: string;
}

interface Found {
  readonly path: readonly PropertyKey[];
  readonly text: string;
  readonly notation: Notation;
  /** The notation sits in the argument name at `path`, not in its value. */
  readonly inKey: boolean;
}

/** Repair sentence for one finding at its JSON Pointer: names the argument attached after a value's text, if any. */
function repairSentence(path: string, { text, notation, inKey }: Found): string {
  if (inKey) return 'Send each argument under its own field name, without the notation.';
  const first = notation.pattern.exec(text)!;
  const attached = notation.attached.exec(text)?.[1];
  return attached && text.slice(0, first.index).trim() !== ''
    ? `End \`${path}\` before the notation and send \`${attached}\` as its own argument.`
    : `Send \`${path}\` as its own value only, without the notation.`;
}

function notationIn(text: string): Notation | undefined {
  return NOTATIONS.find(notation => notation.pattern.test(text));
}

function collect(value: unknown, path: readonly PropertyKey[], found: Found[]): void {
  if (typeof value === 'string') {
    const notation = notationIn(value);
    if (notation) found.push({ path, text: value, notation, inKey: false });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, [...path, index], found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const notation = notationIn(key);
      if (notation) found.push({ path: [...path, key], text: key, notation, inKey: true });
      else collect(item, [...path, key], found);
    }
  }
}

/**
 * Checks every argument name and text value of one tool call's arguments (as received, after the
 * JSON-text decode) for tool-call notation; returns the rejection content naming each offending path, or `null`.
 */
export function toolCallNotationFault(input: unknown): ToolCallNotationFault | null {
  const found: Found[] = [];
  collect(input, [], found);
  if (found.length === 0) return null;
  return {
    issuePaths: found.map(item => item.path.join('.')),
    reason: found.map(item => `${jsonPointer(item.path)}: ${item.notation.rule}`).join('\n'),
    hint: found.map(item => repairSentence(jsonPointer(item.path), item)).join(' '),
  };
}
