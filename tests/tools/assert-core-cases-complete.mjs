#!/usr/bin/env node
// Gate step: every parse rule and every exported core symbol is exercised by the suite.
//
// Line coverage answers "was this line run", which is not the same question as "is this case
// tested". A single fixture can walk most of `parseSqlBody` while leaving a whole rule — an
// entire class of T-SQL the product claims to understand — matched by nothing at all. That gap
// reads as covered on a coverage report and is invisible in a green suite.
//
// Two structural checks, both necessary-not-sufficient. Passing does not prove a rule is tested
// well; failing proves it is not tested at all.
//
//   1. Every enabled rule in assets/defaultParseRules.yaml matches at least one .sql fixture in
//      tests/fixtures/sql/targeted/.
//   2. Every exported symbol of the deterministic core modules is named by at least one test.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/** The deterministic core: SQL parsing and graph/BFS. Same set the coverage floors guard. */
const CORE_MODULES = [
  'src/engine/sqlBodyParser.ts',
  'src/engine/graphAnalysis.ts',
  'src/engine/graphBuilder.ts',
  'src/engine/shared/sqlRegex.ts',
  'src/engine/shared/nodeIdResolution.ts',
];

const FIXTURE_DIR = 'tests/fixtures/sql/targeted';

/**
 * Exported symbols reached only through another exported entry point, never named directly.
 *
 * @remarks
 * An entry here is a claim that the symbol is covered transitively. It is not a way to retire a
 * genuinely untested export — that is what the failure is for.
 */
const COVERED_INDIRECTLY = new Set([
  // Layout geometry constants consumed by the webview, asserted through rendered node positions.
  'NODE_WIDTH',
  'NODE_HEIGHT',
  'SCHEMA_NODE_WIDTH',
  'SCHEMA_NODE_HEIGHT',

  // Regex fragments composed into the parse rules and consumed only by sqlBodyParser. The
  // targeted-fixture corpus drives all of them: sqlRegex.ts measures 100% on every metric.
  // Asserting a raw pattern here would test the regex against itself rather than against SQL.
  'ANY_IDENT',
  'QUALIFIED_NAME',
  'KEYWORDS_RE',
  'PASS1_CLEANSE_RE',
  'TABLE_REF_WITH_ALIAS',
  'FROM_TERMINATOR_RE',
]);

const problems = [];

// ─── 1. Every enabled parse rule matches at least one fixture ─────────────────
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => readFileSync(join(FIXTURE_DIR, file), 'utf8'));

if (fixtures.length === 0) problems.push(`${FIXTURE_DIR} holds no .sql fixtures.`);

// A rule may also be exercised by SQL written inline in a parser test rather than by a fixture
// file. Both are real coverage, so both count — the check is "is this rule reached by anything",
// not "is it reached the preferred way".
const corpus = [
  ...fixtures,
  ...readdirSync('tests/unit/parser')
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => readFileSync(join('tests/unit/parser', file), 'utf8')),
];

const rules = yaml.load(readFileSync('assets/defaultParseRules.yaml', 'utf8')).rules ?? [];
for (const rule of rules) {
  if (rule.enabled === false) continue;
  // `clean_sql` documents the built-in TypeScript cleansing pipeline; its pattern is read-only
  // and is not applied as an extraction rule. See assets/defaultParseRules.yaml.
  if (rule.category === 'preprocessing') continue;

  let pattern;
  try {
    pattern = new RegExp(rule.pattern, rule.flags.replace('g', ''));
  } catch (error) {
    problems.push(`parse rule "${rule.name}" has an uncompilable pattern: ${error.message}`);
    continue;
  }
  if (!corpus.some((sql) => pattern.test(sql))) {
    problems.push(
      `parse rule "${rule.name}" (${rule.category}) matches nothing in the ${fixtures.length} `
      + `fixtures in ${FIXTURE_DIR} nor in any tests/unit/parser test. The rule claims support for `
      + 'a class of T-SQL that no test exercises. Add a .sql fixture with a `-- EXPECT` line naming '
      + 'the objects it must extract — tests/unit/parser/tsql-complex.test.ts picks it up automatically.',
    );
  }
}

// ─── 2. Every exported core symbol is named by a test ─────────────────────────
function testSources() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.test\.ts$|\.ts$/.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
  });
  return walk('tests/unit').join('\n');
}

const allTestText = testSources();

for (const modulePath of CORE_MODULES) {
  const source = readFileSync(modulePath, 'utf8');
  const exported = [
    ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm),
  ].map(([, name]) => name);

  for (const name of exported) {
    if (COVERED_INDIRECTLY.has(name)) continue;
    if (new RegExp(`\\b${name}\\b`).test(allTestText)) continue;
    problems.push(
      `${modulePath} exports \`${name}\`, which no test under tests/unit/ names. Add a test, or — `
      + 'if it is genuinely reached only through another export - record that in '
      + 'COVERED_INDIRECTLY in tests/tools/assert-core-cases-complete.mjs with the reason.',
    );
  }
}

if (problems.length > 0) {
  console.error('Core case completeness:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `OK: ${rules.length} parse rule(s) matched against ${fixtures.length} fixture(s); `
  + `every export of ${CORE_MODULES.length} core module(s) is named by a test.`,
);
