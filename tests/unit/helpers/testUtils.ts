/** Shared test utilities for all unit test files. NOT a test file itself — imported by tests/unit/*.test.ts files. */

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

/** Reads a required SQL scenario from the shared parser catalog so engine tests use the same body. */
export function parserCaseSql(id: string): string {
  const catalog = yaml.load(
    readFileSync(rootPath('tests/cases/parser/exact-edges.yaml'), 'utf8'),
  ) as {
    cases: Array<{ id: string; sql: string }>;
  };
  const row = catalog.cases.find((testCase) => testCase.id === id);
  if (!row) throw new Error(`Parser case not found: ${id}`);
  return row.sql;
}

// ─── End-to-end dacpac helpers ────────────────────────────────────────────────

/** Full end-to-end: dacpac → DatabaseModel (Node.js, no VS Code needed). Uses the AI dacpac (superset of AdventureWorks + [ai] schema). */
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

// ─── Parser Helpers ─────────────────────────────────────────────────────────

/** Check that a list contains a value (case-insensitive partial match on the last part) */
export function hasName(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((s) => {
    const norm = s.replace(/\[|\]/g, '').toLowerCase();
    if (norm === lower) return true;
    const parts = norm.split('.');
    return parts[parts.length - 1] === lower;
  });
}

/** Detail-panel shell for host-boundary tests; messages still pass through the real handlers. */
export function detailPanelStub(
  receive: (listener: (message: unknown) => Promise<void>) => void,
  post: (message: unknown) => void = () => {},
) {
  return {
    title: '',
    reveal: () => {},
    onDidDispose: () => ({ dispose: () => {} }),
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
        receive(listener);
        return { dispose: () => {} };
      },
      postMessage: async (message: unknown) => {
        post(message);
        return true;
      },
    },
  };
}

/** Builds the standard detail-handler host while leaving connection behavior to each test. */
export function detailHandlers(
  create: typeof import('../../../src/bridge/messageHandlers').createMessageHandlers,
  {
    isDbSession = true,
    settings = {},
    outputChannel = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
    },
    extensionUri = 'ext',
    log = () => {},
  }: {
    isDbSession?: boolean;
    settings?: Record<string, unknown>;
    outputChannel?: Pick<
      Parameters<typeof create>[3],
      'info' | 'debug' | 'warn' | 'error' | 'trace'
    >;
    extensionUri?: unknown;
    log?: Parameters<typeof create>[0]['log'];
  } = {},
) {
  return create(
    {
      postMessage: async () => true,
      log,
      getExtensionUri: () => extensionUri,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
          key in settings ? settings[key] : fallback,
      }),
    } as unknown as Parameters<typeof create>[0],
    {
      globalState: { get: () => undefined, update: () => undefined },
      secrets: {},
      extensionUri,
    } as never,
    () => ({ isDbSession }) as never,
    outputChannel as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    async () => {},
    async () => {},
    false,
    () => {},
  );
}
