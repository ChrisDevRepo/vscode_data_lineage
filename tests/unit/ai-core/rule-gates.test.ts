import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';

/**
 * Executable form of three written architecture rules.
 *
 * @remarks
 * Each rule below is stated in prose (`docs/ARCHITECTURE.md`, `.github/copilot-instructions.md`).
 * The scans run inside the normal unit suite — and therefore inside `npm run gate` — so a
 * violation fails the build.
 *
 * The scans run over the source tree behind a file-count floor and a positive-control token per
 * tree, because a scan that silently matches nothing would otherwise "prove" every absence.
 */

const srcRoot = fileURLToPath(new URL('../../../src', import.meta.url));
const aiRoot = join(srcRoot, 'ai');

/** Floors for each scan — a collapsed or mis-rooted walk must fail, not silently pass. */
const MIN_SCANNED_SOURCES = 120;
const MIN_SCANNED_AI_SOURCES = 60;

/** Tokens that provably exist in the scanned trees, proving the scan read real text. */
const SRC_POSITIVE_CONTROL = 'registerTool';
const AI_POSITIVE_CONTROL = 'NavigationEngine';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split('\\').join('/');
}

/**
 * Removes line and block comments while preserving string and template literals.
 *
 * @remarks
 * The rules below are about calls, not prose: a doc comment that names `showErrorMessage` to
 * explain why it is banned must not trip its own gate. String literals are preserved because a
 * URL (`'https://…'`) is not a comment and dropping it would corrupt the surrounding call text.
 * Regular-expression literals are not tracked; no scanned rule token can appear inside one.
 *
 * @param source - TypeScript source text.
 * @returns The same text with comment bodies removed.
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === '\\') {
        out += char + (next ?? '');
        index += 2;
        continue;
      }
      if (char === quote) quote = undefined;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Returns the argument text of the call whose opening parenthesis follows `from`.
 *
 * @param source - Comment-stripped source text.
 * @param from - Index just past the callee identifier.
 * @returns Argument text, or an empty string when the identifier is not a call.
 */
function callArguments(source: string, from: number): string {
  let index = from;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '(') return '';
  let depth = 0;
  let quote: string | undefined;
  const start = index + 1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  return source.slice(start);
}

/** Direct user-notification and console calls banned inside `src/ai/**`. */
const NOTIFICATION_PATTERN = /\b(showErrorMessage|showWarningMessage|console\.[A-Za-z]+)\s*\(/g;

/** The consent-dialog escape hatch: a *modal* warning is a deliberate user prompt, not logging. */
const MODAL_ARGUMENT = /\bmodal\s*:\s*true\b/;

/**
 * Finds banned notification/console calls in one AI source file.
 *
 * @param source - Raw TypeScript source text.
 * @returns Callee names of the offending calls, in source order.
 */
function forbiddenNotificationCalls(source: string): string[] {
  const stripped = stripComments(source);
  const found: string[] = [];
  for (const match of stripped.matchAll(NOTIFICATION_PATTERN)) {
    const callee = match[1];
    const argumentsEnd = (match.index ?? 0) + match[0].length - 1;
    if (callee === 'showWarningMessage' && MODAL_ARGUMENT.test(callArguments(stripped, argumentsEnd))) {
      continue;
    }
    found.push(callee);
  }
  return found;
}

/** Static imports, re-exports, dynamic imports and requires alike. */
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Resolves every relative module specifier of a file to a `src`-relative module path.
 *
 * @param file - Absolute path of the importing file.
 * @param source - Raw TypeScript source text.
 * @returns `src`-relative POSIX module paths, without extensions.
 */
function importedModules(file: string, source: string): string[] {
  const stripped = stripComments(source);
  return [...stripped.matchAll(MODULE_SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => posixRelative(srcRoot, resolve(dirname(file), specifier)));
}

/**
 * Engine imports in `src/ai/**` that bypass `src/engine/shared/*`.
 *
 * @remarks
 * Frozen inventory of the violations that existed when the layering rule became executable. It
 * exists to block **new** coupling without demanding an unrelated refactor first, so the list may
 * only ever shrink: delete an entry when the import is removed or moved behind
 * `src/engine/shared/*`, never add one. The stale-entry test below fails if a fixed violation is
 * left listed.
 */
const GRANDFATHERED_ENGINE_IMPORTS: readonly string[] = [
  'prompting/hostPrompts.ts -> engine/projectStore',
  'prompting/hostPrompts.ts -> engine/types',
  'session/memoryManager.ts -> engine/types',
  'session/session.ts -> engine/columnStore',
  'session/session.ts -> engine/projectStore',
  'session/session.ts -> engine/types',
  'session/types.ts -> engine/projectStore',
  'sm/columnTracer.ts -> engine/columnStore',
  'sm/columnTracer.ts -> engine/types',
  'sm/smBase.ts -> engine/columnStore',
  'sm/smBase.ts -> engine/graphGuards',
  'sm/smBase.ts -> engine/projectStore',
  'sm/smBase.ts -> engine/types',
  'support/aiPresenter.ts -> engine/projectStore',
  'support/aiPresenter.ts -> engine/types',
  'support/engineLog.ts -> engine/graphGuards',
  'support/graphUtils.ts -> engine/types',
  'tools/handlers/toolServices.ts -> engine/projectStore',
  'tools/handlers/toolServices.ts -> engine/types',
  'tools/toolProvider.ts -> engine/projectStore',
  'tools/toolProvider.ts -> engine/types',
  'tools/tools.ts -> engine/columnStore',
  'tools/tools.ts -> engine/graphAnalysis',
  'tools/tools.ts -> engine/modelBuilder',
  'tools/tools.ts -> engine/projectStore',
  'tools/tools.ts -> engine/types',
];

/** `<ai-relative file> -> <src-relative engine module>` for every non-shared engine import. */
function engineLayeringViolations(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(aiRoot)) {
    for (const module of importedModules(file, readFileSync(file, 'utf8'))) {
      if (!module.startsWith('engine/') || module.startsWith('engine/shared/')) continue;
      found.add(`${posixRelative(aiRoot, file)} -> ${module}`);
    }
  }
  return [...found].sort();
}

describe('architecture rule gates', () => {
  it('scans a real, non-empty source tree before proving any absence', () => {
    const src = sourceFiles(srcRoot);
    const ai = sourceFiles(aiRoot);

    expect(src.length, 'the src scan resolved too few files to prove absence').toBeGreaterThanOrEqual(
      MIN_SCANNED_SOURCES,
    );
    expect(ai.length, 'the src/ai scan resolved too few files to prove absence').toBeGreaterThanOrEqual(
      MIN_SCANNED_AI_SOURCES,
    );
    expect(src.map((path) => readFileSync(path, 'utf8')).join('\n')).toContain(SRC_POSITIVE_CONTROL);
    expect(ai.map((path) => readFileSync(path, 'utf8')).join('\n')).toContain(AI_POSITIVE_CONTROL);
  });

  it('never routes a production call through vscode.lm.invokeTool', () => {
    const offenders = sourceFiles(srcRoot).filter((file) =>
      /\binvokeTool\b/.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders.map((file) => posixRelative(srcRoot, file))).toEqual([]);
  });

  it('routes AI notifications and logging through the shared helpers only', () => {
    const offenders = sourceFiles(aiRoot)
      .map((file) => ({
        file: posixRelative(aiRoot, file),
        calls: forbiddenNotificationCalls(readFileSync(file, 'utf8')),
      }))
      .filter((entry) => entry.calls.length > 0)
      .map((entry) => `${entry.file}: ${entry.calls.join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('adds no engine import outside src/engine/shared', () => {
    const introduced = engineLayeringViolations().filter(
      (entry) => !GRANDFATHERED_ENGINE_IMPORTS.includes(entry),
    );

    expect(
      introduced,
      'new src/ai -> src/engine coupling: import through src/engine/shared/* instead',
    ).toEqual([]);
  });

  it('keeps the grandfathered engine-import list free of entries that no longer exist', () => {
    const current = engineLayeringViolations();
    const stale = GRANDFATHERED_ENGINE_IMPORTS.filter((entry) => !current.includes(entry));

    expect(
      stale,
      'these imports were fixed — delete them from GRANDFATHERED_ENGINE_IMPORTS; the list may only shrink',
    ).toEqual([]);
    expect(current.length).toBeGreaterThan(0);
  });
});

/**
 * Codes with more than one emission site; every site must interpolate `REJECTION_CODES`
 * (`src/ai/support/rejectionCodes.ts`) rather than hand-typing the literal, so a rename cannot
 * drift between the emitting guard, the prompt that teaches the recovery, and the schema that
 * types the envelope.
 */
const MULTI_SITE_REJECTION_CODES = [
  REJECTION_CODES.staleTurn,
  REJECTION_CODES.invalidInput,
  REJECTION_CODES.notFound,
  REJECTION_CODES.supplementRequiresCompleteEngine,
  REJECTION_CODES.invalidRegex,
] as const;

describe('rejection codes — one home per multi-site code', () => {
  it('leaves no hand-typed literal for a multi-site code anywhere in src/ai', () => {
    const REJECTION_CODES_OWNER = join(aiRoot, 'support', 'rejectionCodes.ts');
    const offenders: string[] = [];
    for (const file of sourceFiles(aiRoot)) {
      if (file === REJECTION_CODES_OWNER) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const code of MULTI_SITE_REJECTION_CODES) {
          if (line.includes(`error: '${code}'`) || line.includes(`error: "${code}"`)) {
            offenders.push(`${posixRelative(aiRoot, file)}:${index + 1} ${code}`);
          }
        }
      });
    }
    expect(offenders, 'every emission site interpolates REJECTION_CODES').toEqual([]);
  });

  it('keeps the five codes exported with their wire values unchanged', () => {
    expect(MULTI_SITE_REJECTION_CODES).toEqual([
      'stale_turn',
      'invalid_input',
      'not_found',
      'supplement_requires_complete_engine',
      'invalid_regex',
    ]);
  });
});
