import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
}));

vi.mock('vscode', () => ({
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  commands: {
    registerCommand: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      vscodeMocks.handlers.set(name, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vscodeMocks.executeCommand,
  },
  env: { clipboard: { writeText: vi.fn() } },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('\\'),
    }),
  },
  window: {
    showInformationMessage: vscodeMocks.showInformationMessage,
    showWarningMessage: vscodeMocks.showWarningMessage,
    showErrorMessage: vscodeMocks.showErrorMessage,
  },
  workspace: {
    get workspaceFolders() { return vscodeMocks.workspaceFolders; },
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
}));

vi.mock('../../../src/panelProvider', () => ({ getActivePanel: vi.fn() }));
vi.mock('../../../src/bridge/host', () => ({ postToWebview: vi.fn() }));
vi.mock('../../../src/utils/modelSearch', () => ({ searchCatalog: vi.fn() }));
vi.mock('../../../src/bridge/messageHandlers', () => ({
  applyModelToSession: vi.fn(),
  buildExtensionConfig: vi.fn(),
}));

function outputChannel(logLevel = 3) {
  return {
    logLevel,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function registerTraceCommand(
  traceWriter: { enable: ReturnType<typeof vi.fn> },
  logLevel = 3,
) {
  const { registerCommands } = await import('../../../src/commands');
  registerCommands(
    {} as never,
    vi.fn(() => ({})) as never,
    outputChannel(logLevel) as never,
    vi.fn() as never,
    vi.fn() as never,
    traceWriter as never,
  );
  return vscodeMocks.handlers.get('dataLineageViz.enableAiTraceLogging');
}

describe('enable AI trace logging command', () => {
  beforeEach(() => {
    vscodeMocks.handlers.clear();
    vscodeMocks.showInformationMessage.mockReset();
    vscodeMocks.showWarningMessage.mockReset();
    vscodeMocks.showErrorMessage.mockReset();
    vscodeMocks.executeCommand.mockReset();
    vscodeMocks.workspaceFolders.length = 0;
  });

  it('enables immediately under the workspace tmp folder without opening the log-level picker', async () => {
    vscodeMocks.workspaceFolders.push({ uri: { fsPath: 'C:\\workspace' } });
    const tracePath = 'C:\\workspace\\tmp\\lm-trace\\trace-test.ndjson';
    const traceWriter = { enable: vi.fn(async () => tracePath) };
    const command = await registerTraceCommand(traceWriter);

    await command?.();

    expect(vscodeMocks.showWarningMessage).not.toHaveBeenCalled();
    // Origin stays the writer's extension-host default; the trace-open record is the durable stamp.
    expect(traceWriter.enable).toHaveBeenCalledWith('C:\\workspace\\tmp');
    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(
      `Data Lineage: AI trace logging enabled for this session. Writing to ${tracePath}`,
    );
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  });

  it('does not depend on the output channel already being at Debug', async () => {
    vscodeMocks.workspaceFolders.push({ uri: { fsPath: 'C:\\workspace' } });
    const traceWriter = { enable: vi.fn(async () => 'C:\\workspace\\tmp\\lm-trace\\trace-test.ndjson') };
    const command = await registerTraceCommand(traceWriter, 2);

    await command?.();

    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  });

  it('stays disabled and shows a non-modal warning when no workspace folder is open', async () => {
    const traceWriter = { enable: vi.fn() };
    const command = await registerTraceCommand(traceWriter);

    await command?.();

    expect(traceWriter.enable).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(
      'Data Lineage: Open a workspace folder before enabling AI trace logging.',
    );
  });
});
