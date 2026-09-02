#!/usr/bin/env node
// Gate step: src/engine/** must never import from src/components/**.
//
// The deterministic core (SQL parsing, graph build, BFS analysis) has to typecheck and run without
// a DOM or React in scope. An engine module importing a webview type couples the core to the UI
// layer it is meant to be reusable without — the defect X1 in the remediation plan fixed by moving
// the shared types engine code actually needs into src/engine/types.ts. This step is the guard
// that keeps the same import direction from being reintroduced unnoticed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Root of the layer this step protects. */
const ENGINE_ROOT = path.join('src', 'engine');
/** Layer no file under ENGINE_ROOT may resolve an import into, in POSIX form. */
const FORBIDDEN_ROOT = 'src/components';
/** Source extensions walked; declaration and non-TS files carry no import statements to check. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Recursively lists every `.ts`/`.tsx` file under `dir`.
 *
 * @param {string} dir - Directory to walk.
 * @returns {string[]} File paths relative to the repo root, OS-native separators.
 */
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

/**
 * Matches an import or re-export specifier on one source line.
 *
 * @remarks
 * Covers `import x from '…'`, `import type {…} from '…'`, bare `import '…'`, and
 * `export … from '…'` re-exports — every form that creates a module dependency. Comments and
 * string literals elsewhere on the line are not distinguished; a false-positive match on a
 * non-import line is vanishingly unlikely given the required `import`/`export` keyword anchor and
 * would still name a real quoted path for a human to dismiss.
 */
const IMPORT_SPECIFIER_RE = /(?:import|export)(?:[^'";]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/g;

/**
 * Reports whether a relative import specifier, resolved from the importing file's directory,
 * lands inside `src/components`.
 *
 * @param {string} fromFile - Path (repo-root-relative) of the file containing the import.
 * @param {string} specifier - The quoted import path.
 * @returns {boolean} True when the specifier resolves into, or literally names, the forbidden layer.
 */
function resolvesIntoComponents(fromFile, specifier) {
  if (!specifier.startsWith('.')) return false;
  const resolved = path
    .normalize(path.join(path.dirname(fromFile), specifier))
    .split(path.sep)
    .join('/');
  if (resolved === FORBIDDEN_ROOT || resolved.startsWith(`${FORBIDDEN_ROOT}/`)) return true;
  // Belt-and-braces for a specifier the join/normalize above fails to place under FORBIDDEN_ROOT
  // (e.g. a symlinked or unconventionally nested engine subdirectory): the two depths named in the
  // gate contract are matched on the literal specifier text too.
  return specifier.includes('../components') || specifier.includes('../../components');
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
  console.error('\nMove the shared type or helper the import needs out of src/components (see X1 in the remediation plan).');
  process.exit(1);
}

console.log(`PASS  src/engine/** never imports from ${FORBIDDEN_ROOT}/**.`);
