import { detailHandlers } from '../helpers/testUtils';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const connectDatabase = vi.fn();
let detailPanelListener: ((message: unknown) => Promise<void>) | undefined;
const detailPanelPosts: unknown[] = [];

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { detailPanelStub } = await import('../helpers/testUtils');
  return {
    ...actual,
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
    ViewColumn: { Beside: -2 },
    window: {
      createWebviewPanel: () => detailPanelStub(listener => { detailPanelListener = listener; }, message => { detailPanelPosts.push(message); }),
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
  /connectionManager|db\/dbSession|builtInProvider|connectDatabase|dmvExtractor|profilingEngine|executeSimpleQuery|executeDmvQueries|table-stats-request/;

/** A token that provably exists in `src/ai/**`. The negative match below is vacuously true when the scan reads nothing, so the same scan must also find this control before the absence proof counts. */
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
    const { handlers } = detailHandlers(createMessageHandlers, { settings: { 'tableStatistics.enabled': false } });

    await handlers['show-detail']({ type: 'show-detail' });
    expect(detailPanelListener).toBeDefined();
    await detailPanelListener!({ type: 'table-stats-request', schema: 'dbo', objectName: 'Orders', mode: 'quick', columns: [] });

    expect(connectDatabase).not.toHaveBeenCalled();
    expect(detailPanelPosts).toContainEqual(expect.objectContaining({ type: 'table-stats-error' }));
  });
});
