import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';

const connectDatabase = vi.fn();
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;
const detailPanelPosts: unknown[] = [];

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
    window: {
      createWebviewPanel: () => ({
        title: '',
        reveal: vi.fn(),
        onDidDispose: () => ({ dispose: () => {} }),
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
            detailPanelListener = listener;
            return { dispose: () => {} };
          },
          postMessage: async (message: unknown) => { detailPanelPosts.push(message); return true; },
        },
      }),
    },
  };
});

vi.mock('../../../src/engine/connectionManager', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  connectDatabase: (...args: unknown[]) => connectDatabase(...args),
}));

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

const aiRoot = fileURLToPath(new URL('../../../src/ai', import.meta.url));

/** Every database-execution identifier that must never appear in the production AI tree. */
const DATABASE_EXECUTION_PATTERN =
  /connectionManager|db\/dbSession|builtInProvider|mssqlExtensionProvider|connectDatabase|dmvExtractor|profilingEngine|executeSimpleQuery|executeDmvQueries|promptForConnection|table-stats-request/;

/**
 * A token that provably exists in `src/ai/**`. The negative match below is vacuously true when the
 * scan reads nothing, so the same scan must also find this control before the absence proof counts.
 */
const SCAN_POSITIVE_CONTROL = 'NavigationEngine';

/** Floor for the number of scanned AI sources — a collapsed tree must fail, not silently pass. */
const MIN_SCANNED_AI_SOURCES = 40;

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('AI/database capability boundary', () => {
  it('keeps database execution modules and calls outside the production AI tree', () => {
    const files = sourceFiles(aiRoot);
    const source = files.map(path => readFileSync(path, 'utf8')).join('\n');

    expect(
      files.length,
      'the AI source scan resolved too few files — an empty scan cannot prove absence',
    ).toBeGreaterThanOrEqual(MIN_SCANNED_AI_SOURCES);
    expect(
      source,
      'the scan must actually read AI source text before its negative match proves anything',
    ).toContain(SCAN_POSITIVE_CONTROL);

    expect(source).not.toMatch(DATABASE_EXECUTION_PATTERN);
  });

  it('enforces the profiling disable switch again at the extension-host boundary', async () => {
    const host = {
      postMessage: vi.fn().mockResolvedValue(true),
      log: vi.fn(),
      getExtensionUri: () => 'ext',
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'tableStatistics.enabled' ? false : fallback }),
    } as unknown as BridgeHost;
    const { handlers } = createMessageHandlers(
      host,
      { globalState: { get: vi.fn(), update: vi.fn() } } as never,
      () => ({ isDbSession: true }) as never,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never,
      () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
    );

    await handlers['show-detail']({ type: 'show-detail' });
    expect(detailPanelListener).toBeDefined();
    await detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });

    expect(connectDatabase).not.toHaveBeenCalled();
    expect(detailPanelPosts).toContainEqual(expect.objectContaining({ type: 'table-stats-error' }));
  });
});
