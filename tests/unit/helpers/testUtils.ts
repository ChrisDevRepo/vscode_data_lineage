/**
 * Shared test utilities for all unit test files. NOT a test file itself — imported by
 * tests/unit/*.test.ts files.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { loadRules } from '../../../src/engine/sqlBodyParser';
import type { RawParseRulesConfig } from '../../../src/engine/sqlBodyParser';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import type { DatabaseModel } from '../../../src/engine/types';

// ─── Directory resolution ────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const FIXTURES = resolve(ROOT, 'tests', 'fixtures');

/** Resolve a path relative to tests/fixtures/ (dacpacs, baselines, sql files) */
export function testPath(...segments: string[]): string {
  return resolve(FIXTURES, ...segments);
}

/** Resolve a path relative to the project root */
export function rootPath(...segments: string[]): string {
  return resolve(ROOT, ...segments);
}

// ─── End-to-end dacpac helpers ────────────────────────────────────────────────

/**
 * Full end-to-end: dacpac → DatabaseModel (Node.js, no VS Code needed). Uses the AI dacpac
 * (superset of AdventureWorks + [ai] schema).
 */
export async function loadAdventureWorksModel(): Promise<DatabaseModel> {
  loadParseRules();
  const buffer = readFileSync(testPath('AdventureWorks2025_AI.dacpac'));
  return extractDacpac(buffer);
}

// ─── Parse Rules Loading ────────────────────────────────────────────────────

/** Load parse rules from assets/defaultParseRules.yaml (single source of truth) */
export function loadParseRules() {
  const rulesYaml = readFileSync(
    rootPath('assets/defaultParseRules.yaml'),
    'utf-8',
  );
  loadRules(yaml.load(rulesYaml) as RawParseRulesConfig);
}
