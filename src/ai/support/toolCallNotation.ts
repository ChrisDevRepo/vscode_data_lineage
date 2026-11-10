/** Detection of tool-call notation inside the text values of one tool call. */
import { escapeRegexLiteral } from '../../utils/sql';
import { walkServedSchema } from './toolValidation';

/** The notation rule, as stated in the rejection. */
const NOTATION_RULE =
  "repeats another argument's or tool's name as markup; a field holds its own value only.";

/** The rejection content for one tool call whose text values carry tool-call notation. */
interface ToolCallNotationFault {
  /** Dotted paths of the values that carry notation, in input order. */
  readonly issuePaths: readonly string[];
  /** One log line per path stating the rule broken. */
  readonly reason: string;
}

/** What one call is checked against: the served names and the served schema of its tool. */
export interface ServedNotation {
  readonly names: ReadonlySet<string>;
  readonly schema: unknown;
}

/** Every property key of a served JSON Schema, however nested. */
function propertyKeys(node: unknown, into: Set<string>): Set<string> {
  if (!node || typeof node !== 'object') return into;
  const { properties } = node as { properties?: unknown };
  if (properties && typeof properties === 'object')
    Object.keys(properties).forEach((key) => into.add(key));
  Object.values(node).forEach((child) => propertyKeys(child, into));
  return into;
}

/**
 * The served names a text value must not carry between markup delimiters: the served tool names
 * and every property key of the served JSON Schema, however nested.
 */
export function servedNotation(
  toolNames: Iterable<string>,
  schema: unknown,
): ServedNotation {
  return { names: propertyKeys(schema, new Set<string>(toolNames)), schema };
}

/** Checks every text value of one tool call's arguments for tool-call notation. */
export function toolCallNotationFault(
  input: unknown,
  served: ServedNotation,
): ToolCallNotationFault | null {
  const paths = new Set<string>();
  walkServedSchema(served.schema, input, '', (node, value, pointer) => {
    if (typeof value !== 'string') return;
    // A value may hold its own key and the keys of its own served subtree (its stringified form).
    const keys = pointer.split('/').filter((key) => !/^\d+$/.test(key));
    const own = propertyKeys(node, new Set(keys.slice(-1)));
    const others = [...served.names].filter((name) => name && !own.has(name));
    if (
      others.length > 0 &&
      new RegExp(
        `(?<=["<=>])(?:${others.map(escapeRegexLiteral).join('|')})(?=[>":<])`,
      ).test(value)
    )
      paths.add(pointer.slice(1).split('/').join('.'));
  });
  if (paths.size === 0) return null;
  const issuePaths = [...paths];
  return {
    issuePaths,
    reason: issuePaths.map((path) => `${path}: ${NOTATION_RULE}`).join('\n'),
  };
}
