import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Executable form of three written architecture rules.
 *
 * @remarks
 * Each rule below exists in prose (`docs/ARCHITECTURE.md`, `.github/copilot-instructions.md`,
 * `CLAUDE.md`) and was previously enforced by review alone. The scans here run inside the normal
 * unit suite — and therefore inside `npm run gate` — so a regression fails a build instead of
 * surviving until someone re-reads the document.
 *
 * The scan primitives are plain functions over source text and are exercised against inline
 * fixtures as well as against the tree, because a scan that silently matches nothing would
 * otherwise "prove" every absence.
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

  // Rule: production `@lineage` dispatches through the local canonical registry and strict Zod
  // dispatcher. Routing its own calls through `vscode.lm.invokeTool` would hand another extension's
  // tool surface the active turn lease.
  it('never routes a production call through vscode.lm.invokeTool', () => {
    const offenders = sourceFiles(srcRoot).filter((file) =>
      /\binvokeTool\b/.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders.map((file) => posixRelative(srcRoot, file))).toEqual([]);
  });

  // Rule: user-facing errors and warnings go through `notifyError`/`notifyWarning`, and diagnostics
  // through the `src/utils/log.ts` helpers, so redaction and the output channel stay on one path.
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

  // Rule: `src/ai/**` reaches the engine only through the shared contracts in `src/engine/shared/*`.
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
    // Positive control: an empty scan would make the "no new violations" assertion vacuous.
    expect(current.length).toBeGreaterThan(0);
  });
});

describe('rule-gate scan primitives', () => {
  it('allows a modal warning and rejects every other notification or console call', () => {
    const source = `
      const url = 'https://example.test//not-a-comment';
      vscode.window.showWarningMessage('Delete everything?', { modal: true }, 'Yes', 'No');
      vscode.window.showWarningMessage(
        localize('confirm'),
        { modal: true, detail: 'irreversible' },
      );
    `;

    expect(forbiddenNotificationCalls(source)).toEqual([]);
  });

  it('flags non-modal warnings, error messages and console calls', () => {
    // The first warning must stay flagged even though a *later* call in the same file is modal:
    // the exception is per call, not per file.
    const source = `
      vscode.window.showWarningMessage('just a warning');
      vscode.window.showWarningMessage('confirm', { modal: true });
      vscode.window.showErrorMessage('boom', { modal: true });
      console.warn('debug');
      console.log(1);
    `;

    expect(forbiddenNotificationCalls(source)).toEqual([
      'showWarningMessage',
      'showErrorMessage',
      'console.warn',
      'console.log',
    ]);
  });

  it('ignores banned identifiers that appear only in prose', () => {
    const source = `
      /** Never call showErrorMessage or console.log here — use notifyError. */
      // vscode.window.showWarningMessage('commented out');
      notifyError('real path');
    `;

    expect(forbiddenNotificationCalls(source)).toEqual([]);
  });

  it('resolves relative import specifiers to src-relative module paths', () => {
    const file = join(aiRoot, 'tools', 'tools.ts');
    const source = `
      import type { DatabaseModel } from '../../engine/types';
      import { AI_MAX_SCOPE_NODE_IDS } from '../../engine/shared/bridgeContract';
      export { helper } from './handlers/toolServices';
      const late = await import('../../engine/columnStore');
      import * as vscode from 'vscode';
    `;

    expect(importedModules(file, source)).toEqual([
      'engine/types',
      'engine/shared/bridgeContract',
      'ai/tools/handlers/toolServices',
      'engine/columnStore',
    ]);
  });
});

/**
 * Extracts one `- **Label**: …` bullet from a `general`-style YAML instruction block.
 *
 * @param instruction - The raw block-scalar text of the template instruction.
 * @param label - The bold bullet label to pull, without asterisks.
 * @returns The bullet text with line breaks folded to single spaces.
 */
function renderRuleBullet(instruction: string, label: string): string {
  const start = instruction.indexOf(`- **${label}**`);
  if (start < 0) return '';
  const rest = instruction.slice(start + 1);
  const next = rest.search(/\n\s*- \*\*|\n[ \t]*\n/);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ').trim();
}

describe('output-template rendering rules — captured ⚠️ callouts are delivered, not re-judged', () => {
  const asset = readFileSync('assets/aiOutputTemplates.yaml', 'utf8');
  const general = asset.slice(asset.indexOf('\ngeneral:'), asset.indexOf('\nloading_pattern:'));

  /** Placement shape the Formulas bullet already uses: mandatory carry-through, one occurrence, best section. */
  const placementRule = /every .*present in the captured bodies.*appears exactly once.*in its most relevant section/i;

  it('reads the shipped general template and its Formulas placement rule as the positive control', () => {
    expect(general).toContain('- **Risks / data-quality flags**');
    expect(renderRuleBullet(general, 'Formulas')).toMatch(placementRule);
  });

  it('states the risk bullet as a placement rule, never as a permission gate', () => {
    const risks = renderRuleBullet(general, 'Risks / data-quality flags');

    expect(risks).toMatch(placementRule);
    expect(risks).not.toMatch(/⚠️ only for|include ⚠️ only|only for material/i);
  });

  it('does not let the scope bullet delete a captured ⚠️ on a side branch', () => {
    const scope = renderRuleBullet(general, 'Scope');

    expect(scope).toMatch(/audit, logging, retention, error-handling/);
    expect(scope).toMatch(/captured ⚠️ on such a branch is that one line, never a deletion/i);
  });
});
