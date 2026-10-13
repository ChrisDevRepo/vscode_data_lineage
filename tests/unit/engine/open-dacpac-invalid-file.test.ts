/**
 * Pins that a dacpac load which cannot finish — a file that is not a readable .dacpac, or one over
 * the size cap — is reported back to the wizard as a `db-error` status naming the reason, instead of
 * escaping as a generic failure and leaving the loader spinning until its timeout.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMessageHandlers } from '../../../src/bridge/messageHandlers';
import type { BridgeHost } from '../../../src/bridge/host';
import type { ProjectStore } from '../../../src/engine/projectStore';

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  FileSystemError: class FileSystemError extends Error {},
}));

function fakeHost(bytes: Uint8Array): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    getConfiguration: vi.fn().mockReturnValue({ get: () => undefined }),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn().mockResolvedValue([{ fsPath: '/tmp/broken.dacpac' }]),
    showSaveDialog: vi.fn(),
    readFile: vi.fn().mockResolvedValue(bytes),
    writeFile: vi.fn(),
    withProgress: vi.fn(),
    getExtensionUri: vi.fn(),
    getGlobalState: vi.fn(),
  };
}

function handlersFor(host: BridgeHost, store: ProjectStore = { schemaVersion: 1, projects: [] } as never) {
  return createMessageHandlers(
    host,
    { globalState: { get: () => undefined, update: () => Promise.resolve() } } as never,
    () => ({ model: null, uiState: {}, renderState: null }) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() } as never,
    () => store,
    vi.fn().mockResolvedValue(undefined),
    vi.fn(),
    false,
    vi.fn(),
  ).handlers;
}

function postedErrors(host: BridgeHost): string[] {
  return vi.mocked(host.postMessage).mock.calls
    .map(([m]) => m as { type: string; message?: string })
    .filter((m) => m.type === 'db-error')
    .map((m) => m.message ?? '');
}

describe('open-dacpac with a file that is not a .dacpac', () => {
  it('posts a db-error naming the file and the reason, and does not throw', async () => {
    const host = fakeHost(new TextEncoder().encode('not a zip'));
    const handlers = handlersFor(host);

    await expect(handlers['open-dacpac']({ type: 'open-dacpac' } as never)).resolves.toBeUndefined();

    const posted = vi.mocked(host.postMessage).mock.calls.map(([m]) => m as { type: string; message?: string });
    const error = posted.find((m) => m.type === 'db-error');
    expect(error?.message).toMatch(/broken\.dacpac/);
    expect(error?.message).toMatch(/not a valid \.dacpac/i);
    expect(posted.some((m) => m.type === 'dacpac-schema-preview')).toBe(false);
  });
});

describe('dacpac loads that end without a model', () => {
  it('open-dacpac over the size cap posts a db-error', async () => {
    const host = fakeHost({ byteLength: 51 * 1024 * 1024 } as Uint8Array);

    await handlersFor(host)['open-dacpac']({ type: 'open-dacpac' } as never);

    expect(postedErrors(host)).toEqual([expect.stringMatching(/too large/i)]);
  });

  it('load-project with an unreadable saved dacpac posts a db-error instead of throwing', async () => {
    const host = fakeHost(new TextEncoder().encode('not a zip'));
    const store = {
      schemaVersion: 1,
      projects: [{
        id: 'p1',
        name: 'Sales',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        connection: { type: 'dacpac', path: '/tmp/sales.dacpac', displayName: 'Sales', schemas: ['dbo'] },
      }],
    } as never;

    await expect(handlersFor(host, store)['load-project']({ type: 'load-project', id: 'p1' } as never)).resolves.toBeUndefined();

    expect(postedErrors(host)).toEqual([expect.stringMatching(/Could not load Sales/)]);
  });
});
