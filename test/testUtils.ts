/**
 * Shared test utilities for all test files.
 * NOT a test file itself — imported by test/*.test.ts files.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import Graph from 'graphology';
import { loadRules } from '../src/engine/sqlBodyParser';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser';

// ─── Test directory resolution ───────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a path relative to the test/ directory */
export function testPath(...segments: string[]): string {
  return resolve(__dirname, ...segments);
}

/** Resolve a path relative to the project root */
export function rootPath(...segments: string[]): string {
  return resolve(__dirname, '..', ...segments);
}

// ─── Counters & Assertions ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/** Reset counters (for files that need isolated counting) */
export function resetCounters() {
  passed = 0;
  failed = 0;
}

/** Get current counters */
export function getCounters() {
  return { passed, failed };
}

/** Boolean assertion with pass/fail output */
export function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

/** Equality assertion with "expected X, got Y" on failure */
export function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

/** Try/catch wrapper — catches exceptions and reports them as failures */
export function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

/** Print summary and exit with code 1 if any failures */
export function printSummary(label?: string) {
  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const tag = label ? ` ${label}:` : '';
  console.log(`\n═══${tag} ${passed}/${total} passed  (${pct}%) ═══`);
  if (failed > 0) process.exit(1);
}

// ─── Parse Rules Loading ────────────────────────────────────────────────────

/** Load parse rules from assets/defaultParseRules.yaml (single source of truth) */
export function loadParseRules() {
  const rulesYaml = readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8');
  loadRules(yaml.load(rulesYaml) as ParseRulesConfig);
}

// ─── Graph Helper ───────────────────────────────────────────────────────────

/** Build a directed graphology graph from nodes + edges (for synthetic test graphs) */
export function makeGraph(
  nodes: Array<{ id: string; schema?: string; name?: string; type?: string }>,
  edges: Array<[string, string]>
): Graph {
  const g = new Graph({ type: 'directed', multi: false });
  for (const n of nodes) {
    g.addNode(n.id, {
      schema: n.schema || 'dbo',
      name: n.name || n.id,
      type: n.type || 'table',
    });
  }
  for (const [s, t] of edges) {
    const key = `${s}→${t}`;
    if (!g.hasEdge(key)) {
      g.addEdgeWithKey(key, s, t, { type: 'body' });
    }
  }
  return g;
}

// ─── Parser Helpers ─────────────────────────────────────────────────────────

/** Check that a list contains a value (case-insensitive partial match on the last part) */
export function hasName(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some(s => {
    const norm = s.replace(/\[|\]/g, '').toLowerCase();
    if (norm === lower) return true;
    const parts = norm.split('.');
    return parts[parts.length - 1] === lower;
  });
}
