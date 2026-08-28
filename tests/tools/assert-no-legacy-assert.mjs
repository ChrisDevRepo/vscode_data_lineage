#!/usr/bin/env node
// Gate step: no NEW test file may assert through the homegrown `assert` / `assertEq` helpers.
//
// `tests/unit/helpers/testUtils.ts` exports `assert(cond, msg)`, which throws a bare Error.
// Vitest cannot see inside it, so such an assertion reports no value diff, carries no case
// name, and — because it throws — aborts every remaining assertion in the same `it()` block.
// A block holding dozens of them surfaces one message and hides the rest, which is the exact
// opposite of what a suite is for.
//
// The helpers are not deleted here: 30 files still use them and rewriting all of them at once
// would touch the whole agent-runtime suite for no user-visible gain. Instead this pins the
// blast radius. The allowlist below is the complete set of files that carried the pattern when
// the gate was introduced; it may only ever shrink. A file migrated to `expect` is removed from
// the list, and when the list empties the helpers and this gate both go.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files still asserting through the testUtils helpers. Shrink-only.
 *
 * @remarks
 * Removing an entry is the migration's last step: once a file is off this list, re-adding a
 * homegrown assert to it fails the gate. Nothing may be added — a new entry means a new test
 * was written against the pattern this gate exists to retire.
 */
const ALLOWLIST = new Set([
  // Agent runtime — the core migrated first; these follow after stabilization.
  'tests/unit/sm/active-scope-budget-guard.test.ts',
  'tests/unit/sm/approval-binds-engine.test.ts',
  'tests/unit/sm/coerced-string-array.test.ts',
  'tests/unit/sm/column-flow-validation.test.ts',
  'tests/unit/sm/completion-envelope-passthrough.test.ts',
  'tests/unit/sm/depth-border-contract.test.ts',
  'tests/unit/sm/discovery-budget-guard.test.ts',
  'tests/unit/sm/discovery-memory.test.ts',
  'tests/unit/sm/navigation-engine-bipartite.test.ts',
  'tests/unit/sm/navigation-engine-cascade.test.ts',
  'tests/unit/sm/navigation-engine-conservation.test.ts',
  'tests/unit/sm/navigation-engine-scope-extend.test.ts',
  'tests/unit/sm/navigation-engine-supplement.test.ts',
  'tests/unit/sm/navigation-engine-task-ledger.test.ts',
  'tests/unit/sm/navigation-engine.test.ts',
  'tests/unit/sm/present-result-carry-verdict.test.ts',
  'tests/unit/sm/present-result-limits.test.ts',
  'tests/unit/sm/present-result-repair-patch-parity.test.ts',
  'tests/unit/sm/refine-loop.test.ts',
  'tests/unit/sm/scope-notes-contract.test.ts',
  'tests/unit/sm/session-turn-epoch.test.ts',
  'tests/unit/sm/start-exploration-schema.test.ts',
  'tests/unit/sm/strict-tool-arrays.test.ts',
  'tests/unit/sm/submit-findings-handler.test.ts',
  'tests/unit/sm/submit-findings-rules.test.ts',
  'tests/unit/sm/submit-findings-schema.test.ts',
  'tests/unit/sm/task-ledger.test.ts',
  'tests/unit/sm/tool-error-envelope.test.ts',
  'tests/unit/sm/toolPolicy.test.ts',
  'tests/unit/sm/traceScope.test.ts',
]);

/** Imports the helpers by name from testUtils, however the specifier is spelled. */
const LEGACY_IMPORT = /import\s*\{[^}]*\b(?:assert|assertEq)\b[^}]*\}\s*from\s*['"][^'"]*testUtils['"]/s;

function testFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return testFiles(full);
    return entry.endsWith('.test.ts') ? [full.replaceAll('\\', '/')] : [];
  });
}

const problems = [];
const found = new Set();

for (const file of testFiles('tests/unit')) {
  if (!LEGACY_IMPORT.test(readFileSync(file, 'utf8'))) continue;
  found.add(file);
  if (ALLOWLIST.has(file)) continue;
  problems.push(
    `${file} asserts through the homegrown testUtils \`assert\`/\`assertEq\`. Use vitest \`expect\`, `
    + 'and give each case its own `it()` (or an `it.each` table) so one failure cannot hide its '
    + 'siblings. See tests/unit/parser/tsql-complex.test.ts for the data-driven form.',
  );
}

// A stale entry means the file was migrated (or deleted) without shrinking the list. Left
// alone, the allowlist would silently re-authorise the pattern for that path later.
for (const stale of [...ALLOWLIST].filter((file) => !found.has(file)).sort()) {
  problems.push(
    `${stale} is on the legacy-assert allowlist but no longer imports the helpers. Delete its `
    + 'entry from ALLOWLIST in tests/tools/assert-no-legacy-assert.mjs — the list is shrink-only.',
  );
}

if (problems.length > 0) {
  console.error('Legacy assertion helpers:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(`OK: no new legacy assertions (${found.size} allowlisted file(s) remaining to migrate).`);
