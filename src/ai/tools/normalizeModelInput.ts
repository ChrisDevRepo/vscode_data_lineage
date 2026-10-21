import type { ZodType } from 'zod';

/** One lossless format fix: same data, different spelling, exactly one possible result. */
export interface ModelInputFix {
  readonly path: string;
  readonly before: string;
  readonly after: unknown;
}

/** Upper bound on decode rounds; each round can only open values nested inside the previous round's fixes. */
const MAX_ROUNDS = 8;

/** The single decoded value of `text` when it is exactly the expected type, otherwise `undefined`. */
function decodeExact(text: string, expected: string): unknown {
  if (expected === 'number') return /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : undefined;
  if (expected === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (expected !== 'object' && expected !== 'array') return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return undefined; }
  const isArray = Array.isArray(decoded);
  if (expected === 'array') return isArray ? decoded : undefined;
  return typeof decoded === 'object' && decoded !== null && !isArray ? decoded : undefined;
}

/**
 * The one shared format-normalization step at the model boundary (D-043, D-044), run before the strict
 * checks: text where the schema expects an object, list, number or true/false is decoded once when it
 * yields exactly that type. Anything else stays as sent so the schema rejects it; content is never changed.
 */
export function normalizeModelInput(schema: ZodType, input: unknown): { readonly input: unknown; readonly fixes: ModelInputFix[] } {
  const fixes: ModelInputFix[] = [];
  let current = input;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const parsed = schema.safeParse(current);
    if (parsed.success) break;
    let fixed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;
      const parent = issue.path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<PropertyKey, unknown> | undefined)?.[key], current);
      const key = issue.path[issue.path.length - 1];
      const value = (parent as Record<PropertyKey, unknown> | undefined)?.[key];
      if (typeof value !== 'string') continue;
      const after = decodeExact(value, issue.expected);
      if (after === undefined) continue;
      if (!fixed) current = structuredClone(current);
      const target = issue.path.slice(0, -1).reduce<unknown>((node, step) => (node as Record<PropertyKey, unknown>)[step], current);
      (target as Record<PropertyKey, unknown>)[key] = after;
      fixes.push({ path: issue.path.join('.'), before: value, after });
      fixed = true;
    }
    if (!fixed) break;
  }
  return { input: current, fixes };
}
