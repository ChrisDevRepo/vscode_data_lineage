// Structural fingerprint of `assets/aiOutputTemplates.yaml` (and any overlay of it).
//
// The schema-version contract protects STRUCTURE: the set of template keys and, per template, the
// set of fields and their value types — the shape `parseAiOutputTemplatesYaml` and the renderer
// read. Prose inside `instruction` / `example` is content: an older overlay carrying different
// wording still parses, still renders, and cannot crash the host, so wording never forces a bump.
//
// Shared by the release gate (`assert-template-schema-version.mjs`) and its unit test so the two
// cannot drift.
import { load } from 'js-yaml';

/** Top-level scalar that is the contract version itself, never part of the structure. */
const VERSION_KEY = 'schemaVersion';

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

/** Canonical JSON of {@link templateStructure}, byte-comparable across revisions. */
export const structureFingerprint = (text) => JSON.stringify(templateStructure(text));

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
    if (!(key in after)) { lines.push(`- ${key} (template removed)`); continue; }
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
