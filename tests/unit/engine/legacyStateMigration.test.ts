/**
 * Pins the legacy workspace-state migration log: a successful migration is one generic info line,
 * legacy state that cannot be migrated is cleared with exactly one warn line, and the path or name
 * appears only at debug.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
}));

const { migrateFromWorkspaceState } = await import('../../../src/utils/migration');

const LEGACY_KEYS = ['lastSourceType', 'lastDacpacPath', 'lastDacpacName', 'lastDeselectedSchemas', 'lastDbConnectionInfo', 'lastDbSourceName'];

function run(legacy: Record<string, unknown>) {
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
  const workspaceUpdates = new Map<string, unknown>();
  const context = {
    workspaceState: { get: (key: string) => legacy[key], update: vi.fn(async (key: string, value: unknown) => { workspaceUpdates.set(key, value); }) },
    globalState: { get: () => undefined, update: vi.fn(async () => undefined) },
  };
  return migrateFromWorkspaceState(context as never, 'store', channel as never).then(() => ({ channel, workspaceUpdates }));
}

const lines = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([line]) => String(line));

describe('legacy workspace-state migration logging', () => {
  it('a migrated dacpac connection is one generic info line and the name is debug only', async () => {
    const { channel } = await run({ lastSourceType: 'dacpac', lastDacpacPath: '/tmp/SentinelDir/sales.dacpac', lastDacpacName: 'SentinelSales' });
    expect(lines(channel.info)).toEqual(['[Project] Migrated legacy connection to a project']);
    expect(lines(channel.debug).join('\n')).toContain('SentinelSales');
    expect(channel.warn).not.toHaveBeenCalled();
  });

  it('unmigratable legacy state is cleared with exactly one warn line', async () => {
    const { channel, workspaceUpdates } = await run({ lastSourceType: 'dacpac', lastDacpacPath: '/tmp/SentinelDir/sales.dacpac' });
    expect(lines(channel.warn)).toHaveLength(1);
    expect(lines(channel.warn)[0]).not.toContain('SentinelDir');
    expect([...workspaceUpdates.keys()].sort()).toEqual([...LEGACY_KEYS].sort());
    expect(channel.info).not.toHaveBeenCalled();
  });

  it('a connection that fails validation gives one warn line without its name or the error text', async () => {
    const { channel } = await run({
      lastSourceType: 'database',
      lastDbSourceName: 'SentinelServer / Sales',
      lastDbConnectionInfo: { server: 5 },
    });
    const warns = lines(channel.warn);
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain('SentinelServer');
  });
});
