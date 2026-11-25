import { load } from 'js-yaml';

/** Top-level scalar that is the contract version itself, never part of the structure. */
const VERSION_KEY = 'schemaVersion';

/** Suffix of the diff line for a whole template that disappeared. */
const TEMPLATE_REMOVED = '(template removed)';

/** Value type as the structure sees it — collections by kind, scalars by primitive. */
function valueType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Structure of a templates document: `{ templateKey: { field: valueType } }` with keys sorted,
 * `schemaVersion` excluded, prose ignored.
 *
 * @param {string} text - Raw YAML.
 * @returns {Record<string, Record<string, string>>}
 */
export function templateStructure(text) {
  const doc = load(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('templates document must be a YAML mapping');
  }
  const structure = {};
  for (const key of Object.keys(doc).sort()) {
    if (key === VERSION_KEY) continue;
    const template = doc[key];
    if (template === null || typeof template !== 'object' || Array.isArray(template)) {
      structure[key] = { '': valueType(template) };
      continue;
    }
    const fields = {};
    for (const field of Object.keys(template).sort()) fields[field] = valueType(template[field]);
    structure[key] = fields;
  }
  return structure;
}

/**
 * Human-readable list of structural differences, one line per changed template or field.
 *
 * @param {Record<string, Record<string, string>>} before
 * @param {Record<string, Record<string, string>>} after
 * @returns {string[]} Empty when the structures are identical.
 */
export function structureDiff(before, after) {
  const lines = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)].sort())) {
    if (!(key in before)) { lines.push(`+ ${key} (new template)`); continue; }
    if (!(key in after)) { lines.push(`- ${key} ${TEMPLATE_REMOVED}`); continue; }
    const b = before[key];
    const a = after[key];
    for (const field of new Set([...Object.keys(b), ...Object.keys(a)].sort())) {
      if (!(field in b)) lines.push(`+ ${key}.${field}: ${a[field]}`);
      else if (!(field in a)) lines.push(`- ${key}.${field}: ${b[field]}`);
      else if (b[field] !== a[field]) lines.push(`~ ${key}.${field}: ${b[field]} → ${a[field]}`);
    }
  }
  return lines;
}

/**
 * Whether a {@link structureDiff} line is one an old custom overlay would be read against silently.
 * A new template or field falls back to the built-in, and a removed template is skipped by the
 * loader's unknown-key warning (`extensionRuntime.ts`). A retyped field, or a field removed inside
 * a template (the loader reads only `instruction` and `sections` and ignores any other field
 * without a warning), changes how an old overlay is read with no warning, so it needs a version bump.
 *
 * @param {string} line - One line from `structureDiff`.
 * @returns {boolean}
 */
export function needsVersionBump(line) {
  if (line.startsWith('~ ')) return true;
  return line.startsWith('- ') && !line.endsWith(TEMPLATE_REMOVED);
}
