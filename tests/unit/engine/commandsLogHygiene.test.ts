/**
 * Pins the log levels of the external project command: the info lines are generic and the file path
 * and project name appear at debug only.
 */
import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('vscode', () => ({
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); return { dispose() {} }; },
    executeCommand: vi.fn(),
  },
  env: { clipboard: { writeText: vi.fn() } },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: vi.fn() }),
    fs: { readFile: vi.fn(async () => new Uint8Array()) },
  },
}));
vi.mock('../../../src/panelProvider', () => ({ getActivePanel: vi.fn(() => undefined) }));
vi.mock('../../../src/bridge/host', () => ({ postToWebview: vi.fn() }));
vi.mock('../../../src/utils/modelSearch', () => ({ searchCatalog: vi.fn() }));
vi.mock('../../../src/engine/db/connectionCommands', () => ({ registerConnectionCommands: () => [] }));
vi.mock('../../../src/engine/connectionManager', () => ({ loadDmvQueries: vi.fn() }));
vi.mock('../../../src/engine/dacpacExtractor', () => ({
  extractDacpac: async () => ({ nodes: [{}, {}], edges: [{}], schemas: [] }),
}));
vi.mock('../../../src/bridge/messageHandlers', () => ({
  applyModelToSession: vi.fn(),
  buildExtensionConfig: () => ({ externalRefs: { enabled: false }, maxNodes: 1000 }),
  isModelOverLimit: () => false,
}));

describe('dataLineageViz.openExternalProject logging', () => {
  it('keeps the file path and project name off the info lines', async () => {
    const channel = { logLevel: 3, info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session: Record<string, unknown> = {};
    const { registerCommands } = await import('../../../src/commands');
    registerCommands({} as never, (() => session) as never, channel as never, vi.fn() as never, vi.fn() as never, {} as never);

    await handlers.get('dataLineageViz.openExternalProject')?.({ fsPath: '/tmp/SentinelDir/SentinelSales.dacpac' });

    const lines = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([line]) => String(line));
    expect(lines(channel.info).filter((line) => /Sentinel/.test(line))).toEqual([]);
    expect(lines(channel.info).some((line) => line.includes('Model forced'))).toBe(true);
    expect(lines(channel.debug).join('\n')).toContain('/tmp/SentinelDir/SentinelSales.dacpac');
    expect(lines(channel.debug).join('\n')).toContain('SentinelSales');
  });
});
