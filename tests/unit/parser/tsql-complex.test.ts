/**
 * SQL Pattern Test Suite
 *
 * Loads every .sql file from tests/fixtures/sql/targeted/ and verifies the parser against
 * expectations embedded in the file as an `-- EXPECT` comment:
 *
 *   -- EXPECT  sources:[dbo].[T1],[dbo].[T2]  targets:[dbo].[Out]  exec:[dbo].[usp_Log]
 *
 * Fields:
 *   sources:  schema.object names the parser must find in result.sources
 *   targets:  schema.object names the parser must find in result.targets
 *   exec:     schema.object names the parser must find in result.execCalls
 *   absent:   names that must NOT appear in any result (verifies comments/strings are cleaned)
 *
 * A file with no `-- EXPECT` line is a stability case: the parser must not crash or run away,
 * and nothing is asserted about its content.
 *
 * @remarks
 * This is the cheapest place to add a parser case — one .sql file, no TypeScript — and each
 * fixture reports as its own named test. `assert-core-cases-complete.mjs` requires every rule
 * in assets/defaultParseRules.yaml to be matched by this corpus or by a parser test.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules, testPath } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

/** Runaway guards: a rule that over-matches produces hundreds of spurious references. */
const MAX_SOURCES = 500;
const MAX_TARGETS = 200;

interface Expectation {
  sources: string[];
  targets: string[];
  exec: string[];
  absent: string[];
}

function parseExpectation(sql: string): Expectation | null {
  for (const line of sql.split(/\r?\n/)) {
    const match = /--\s*EXPECT\b(.*)/i.exec(line);
    if (!match) continue;

    const body = match[1];
    const field = (name: string): string[] => {
      const found = new RegExp(`\\b${name}:(.*?)(?=\\s+(?:sources|targets|exec|absent):|$)`, 'i').exec(body);
      if (!found || !found[1].trim()) return [];
      return found[1].split(',').map(entry => entry.trim()).filter(Boolean);
    };

    return { sources: field('sources'), targets: field('targets'), exec: field('exec'), absent: field('absent') };
  }
  return null;
}

/** Strips brackets and case so `[dbo].[T1]` and `dbo.t1` compare equal. */
const norm = (value: string) => value.replace(/\[|\]/g, '').toLowerCase().trim();
const includes = (list: string[], item: string) => list.some(entry => norm(entry) === norm(item));

const targetedDir = testPath('sql/targeted');
if (!existsSync(targetedDir)) throw new Error(`${targetedDir} not found`);
const files = readdirSync(targetedDir).filter(name => name.endsWith('.sql')).sort();

describe('SQL fixture corpus', () => {
  // A count floor, not an exact match: fixtures are expected to be added, never to disappear.
  // `length > 0` would still pass if the glob broke and matched a single file.
  it('is not empty — the corpus is what makes this suite meaningful', () => {
    expect(files.length).toBeGreaterThanOrEqual(55);
  });

  // parseExpectation returning null downgrades a fixture to stability-only, so a deleted or
  // mistyped EXPECT line silently removes its assertions while the suite stays green.
  it('keeps an EXPECT annotation on every fixture that carries one today', () => {
    const annotated = files.filter(
      file => parseExpectation(readFileSync(testPath('sql/targeted', file), 'utf-8')) !== null,
    );
    expect(annotated).toHaveLength(files.length);
  });

  it.each(files)('%s', (file) => {
    const fileName = basename(file);
    const sql = readFileSync(testPath('sql/targeted', file), 'utf-8');

    const result = parseSqlBody(sql);

    expect(result.sources.length, `${fileName}: source count ran away`).toBeLessThan(MAX_SOURCES);
    expect(result.targets.length, `${fileName}: target count ran away`).toBeLessThan(MAX_TARGETS);

    const expectation = parseExpectation(sql);
    if (!expectation) return; // Stability-only fixture: parsing without crashing is the assertion.

    // Collected, then asserted once, so a failure lists every miss in the fixture rather
    // than stopping at the first — the whole point of driving the corpus from one place.
    const misses: string[] = [];
    for (const name of expectation.sources) {
      if (!includes(result.sources, name)) misses.push(`source ${name} not found`);
    }
    for (const name of expectation.targets) {
      if (!includes(result.targets, name)) misses.push(`target ${name} not found`);
    }
    for (const name of expectation.exec) {
      if (!includes(result.execCalls, name)) misses.push(`exec ${name} not found`);
    }
    const all = [...result.sources, ...result.targets, ...result.execCalls];
    for (const name of expectation.absent) {
      if (includes(all, name)) misses.push(`${name} was extracted but must be absent`);
    }

    expect(misses, [
      `${fileName} did not match its -- EXPECT line.`,
      `  sources: [${result.sources.join(', ')}]`,
      `  targets: [${result.targets.join(', ')}]`,
      `  exec:    [${result.execCalls.join(', ')}]`,
    ].join('\n')).toEqual([]);
  });
});
