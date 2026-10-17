#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Root of the layer this step protects. */
const ENGINE_ROOT = path.join('src', 'engine');
/** Layer no file under ENGINE_ROOT may resolve an import into, in POSIX form. */
const FORBIDDEN_ROOT = 'src/components';
/** Source extensions walked; declaration and non-TS files carry no import statements to check. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Recursively lists every `.ts`/`.tsx` file under `dir`. */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

/** Matches an import or re-export specifier on one source line. */
const IMPORT_SPECIFIER_RE = /(?:import|export)(?:[^'";]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/g;

/** Reports whether a relative import specifier, resolved from the importing file's directory, lands inside `src/components`. */
function resolvesIntoComponents(fromFile, specifier) {
  if (!specifier.startsWith('.')) return false;
  const resolved = path
    .normalize(path.join(path.dirname(fromFile), specifier))
    .split(path.sep)
    .join('/');
  return resolved === FORBIDDEN_ROOT || resolved.startsWith(`${FORBIDDEN_ROOT}/`);
}

const offenders = [];
for (const file of listSourceFiles(ENGINE_ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_SPECIFIER_RE.exec(line))) {
      const specifier = match[1];
      if (resolvesIntoComponents(file, specifier)) {
        offenders.push(`${file}:${index + 1}  import '${specifier}'`);
      }
    }
  });
}

if (offenders.length > 0) {
  console.error(`FAIL  src/engine/** imports from ${FORBIDDEN_ROOT}/** — the engine layer must stay independent of the webview layer:\n`);
  for (const offender of offenders) console.error(`  - ${offender}`);
  console.error('\nMove the shared type or helper the import needs out of src/components.');
  process.exit(1);
}

console.log(`PASS  src/engine/** never imports from ${FORBIDDEN_ROOT}/**.`);
