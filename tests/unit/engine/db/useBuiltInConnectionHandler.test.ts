/**
 * Pins the wizard's switch to the built-in connection: the host handler writes the provider setting
 * globally and answers with the refreshed connection status.
 */
import { describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    sections: [] as string[],
  };
});

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      getConfiguration: (section: string) => {
        cfg.sections.push(section);
        return { get: (k: string, d: unknown) => cfg.values[k] ?? d, update: cfg.update, inspect: () => ({}) };
      },
    },
    extensions: { getExtension: () => undefined },
  };
});

const { createMessageHandlers } = await import('../../../../src/bridge/messageHandlers');

function handlers() {
  const posted: Array<Record<string, unknown>> = [];
  const host = {
    postMessage: vi.fn((m: Record<string, unknown>) => { posted.push(m); return Promise.resolve(true); }),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: () => undefined }),
  };
  const bundle = createMessageHandlers(
    host as never,
    { globalState: { get: () => undefined, update: () => Promise.resolve() }, secrets: {} } as never,
    () => ({ model: null, uiState: {}, renderState: null }) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() } as never,
    () => ({ schemaVersion: 1, projects: [] }) as never,
    vi.fn().mockResolvedValue(undefined),
    vi.fn(),
    false,
    vi.fn(),
  );
  return { handlers: bundle.handlers, posted };
}

describe('use-builtin-connection', () => {
  it('sets dataLineageViz.database.connectionProvider to builtIn at global scope and re-posts the status', async () => {
    const { handlers: h, posted } = handlers();

    await h['use-builtin-connection']({ type: 'use-builtin-connection' } as never);

    expect(cfg.sections).toContain('dataLineageViz.database');
    expect(cfg.update).toHaveBeenCalledTimes(1);
    expect(cfg.update).toHaveBeenCalledWith('connectionProvider', 'builtIn', 1);
    expect(posted.find((m) => m.type === 'mssql-status')).toMatchObject({ type: 'mssql-status', available: true });
  });
});
