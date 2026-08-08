#!/usr/bin/env node
/**
 * Regenerates `contributes.languageModelTools` in `package.json` from the Zod tool catalog.
 *
 * The catalog (`src/ai/tools/toolDefs.ts`) is the single source of truth for tool names,
 * descriptions, tags, and input schemas; `package.json` is the static copy VS Code reads before the
 * extension activates. Hand-editing two copies of the same facts is what the drift test in
 * `tests/unit/sm/ai-tool-registration.test.ts` keeps catching, so this script makes the manifest a
 * derived artifact and leaves the test as the CI guard.
 *
 * Two rules shape the output:
 *
 * 1. **Read-only subset.** A `vscode.lm` registration is invokable by any extension in the window,
 *    so `registerAiTools` binds only `effect: 'read'` tools. A contributed entry with no
 *    `registerTool` binding is a broken tool, not an unused one — the manifest therefore carries
 *    exactly the tools that get bound.
 * 2. **Presentation fields are manifest-owned.** `toolReferenceName`, `displayName`,
 *    `canBeReferencedInPrompt`, `icon`, and `when` exist only in the manifest; they are carried over
 *    from the current entry (in its existing key order) so regeneration is a no-op diff.
 *
 * Usage:
 *   node scripts/generate-tool-manifest.mjs           # rewrite package.json in place
 *   node scripts/generate-tool-manifest.mjs --check   # exit 1 if the manifest is stale
 */
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJsonPath = join(repoRoot, 'package.json');
const check = process.argv.includes('--check');

/** Manifest keys this script owns; everything else on an entry is preserved verbatim. */
const CATALOG_OWNED_KEYS = ['name', 'userDescription', 'modelDescription', 'tags', 'inputSchema'];

/** Key order used for a tool that has no manifest entry yet. */
const NEW_ENTRY_KEY_ORDER = [
  'name', 'toolReferenceName', 'displayName', 'userDescription', 'modelDescription',
  'canBeReferencedInPrompt', 'tags', 'when', 'inputSchema',
];

/**
 * Loads the catalog by bundling the TypeScript sources with esbuild and importing the result.
 *
 * The repository has no `tsx`/`ts-node`, and adding a second TypeScript execution path just for a
 * codegen script would be a new thing to keep in sync. esbuild is already the extension bundler
 * (`esbuild.config.mjs`), so the script reuses it: one self-contained ESM bundle in a temp dir,
 * imported once, deleted afterwards.
 */
async function loadCatalog() {
  const outDir = mkdtempSync(join(tmpdir(), 'lineage-tool-manifest-'));
  const outfile = join(outDir, 'catalog.mjs');
  try {
    await esbuild.build({
      stdin: {
        contents: [
          "export { TOOL_DEFS } from './src/ai/tools/toolDefs';",
          "export { toModelJsonSchema } from './src/ai/tools/jsonSchema';",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'generate-tool-manifest-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      outfile,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // The catalog is VS Code-free by contract; keep `vscode` external so an accidental import
      // fails loudly here instead of being silently bundled.
      external: ['vscode'],
      logLevel: 'warning',
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Title-cases a catalog name for a tool that has no manifest entry to inherit a display name from. */
function deriveDisplayName(name) {
  return name
    .replace(/^lineage_/, '')
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Finds the `[ ... ]` text span of a top-level array value, honouring strings and escapes.
 *
 * Splicing the raw text (rather than re-serializing the whole file) keeps every unrelated byte —
 * including the working tree's line endings — exactly as it was.
 */
function findArrayValueRange(source, key) {
  const keyIndex = source.indexOf(`"${key}"`);
  if (keyIndex === -1) throw new Error(`generate-tool-manifest: "${key}" not found in package.json`);
  const start = source.indexOf('[', keyIndex);
  if (start === -1) throw new Error(`generate-tool-manifest: "${key}" is not an array`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`generate-tool-manifest: unterminated array for "${key}"`);
}

/** Builds one manifest entry, preserving the existing key order and manifest-only fields. */
function buildEntry(contract, existing, toModelJsonSchema) {
  const generated = {
    name: contract.name,
    userDescription: contract.userDescription,
    modelDescription: contract.modelDescription,
    tags: contract.tags ? [...contract.tags] : undefined,
    inputSchema: toModelJsonSchema(contract.inputSchema),
  };

  if (!existing) {
    const fresh = {
      ...generated,
      toolReferenceName: contract.name,
      displayName: deriveDisplayName(contract.name),
      canBeReferencedInPrompt: true,
      when: 'dataLineageViz.modelLoaded',
    };
    return Object.fromEntries(
      NEW_ENTRY_KEY_ORDER
        .filter(key => fresh[key] !== undefined)
        .map(key => [key, fresh[key]]),
    );
  }

  const ordered = {};
  for (const key of Object.keys(existing)) {
    if (CATALOG_OWNED_KEYS.includes(key)) {
      if (generated[key] !== undefined) ordered[key] = generated[key];
    } else {
      ordered[key] = existing[key];
    }
  }
  for (const key of CATALOG_OWNED_KEYS) {
    if (!(key in ordered) && generated[key] !== undefined) ordered[key] = generated[key];
  }
  return ordered;
}

/** Renders the entry array at the manifest's nesting depth, using the file's own line endings. */
function renderBlock(entries, eol) {
  return JSON.stringify(entries, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `    ${line}`))
    .join(eol);
}

const { TOOL_DEFS, toModelJsonSchema } = await loadCatalog();
const source = readFileSync(packageJsonPath, 'utf8');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const existingEntries = JSON.parse(source).contributes?.languageModelTools ?? [];

const readOnlyDefs = TOOL_DEFS.filter(def => def.effect === 'read');
const entries = readOnlyDefs.map(def =>
  buildEntry(def, existingEntries.find(entry => entry.name === def.name), toModelJsonSchema));

const created = readOnlyDefs
  .filter(def => !existingEntries.some(entry => entry.name === def.name))
  .map(def => def.name);
const dropped = existingEntries
  .filter(entry => !readOnlyDefs.some(def => def.name === entry.name))
  .map(entry => entry.name);

const { start, end } = findArrayValueRange(source, 'languageModelTools');
const updated = `${source.slice(0, start)}${renderBlock(entries, eol)}${source.slice(end)}`;

if (check) {
  if (updated === source) {
    process.stdout.write(`languageModelTools is in sync with the catalog (${entries.length} read-only tools).\n`);
    process.exit(0);
  }
  process.stderr.write(
    'package.json contributes.languageModelTools is stale.\n'
    + `  expected ${entries.length} read-only tools: ${readOnlyDefs.map(def => def.name).join(', ')}\n`
    + (dropped.length ? `  entries to remove: ${dropped.join(', ')}\n` : '')
    + (created.length ? `  entries to add: ${created.join(', ')}\n` : '')
    + '  run: npm run generate:tool-manifest\n',
  );
  process.exit(1);
}

if (updated === source) {
  process.stdout.write(`languageModelTools already up to date (${entries.length} read-only tools).\n`);
} else {
  writeFileSync(packageJsonPath, updated);
  process.stdout.write(
    `Regenerated languageModelTools — ${entries.length} read-only tools.\n`
    + (dropped.length ? `  removed: ${dropped.join(', ')}\n` : '')
    + (created.length ? `  added (review displayName/icon/when): ${created.join(', ')}\n` : ''),
  );
}
