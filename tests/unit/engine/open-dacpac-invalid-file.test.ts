/**
 * Pins that a picked file which is not a readable .dacpac is reported back to the wizard as a
 * `db-error` status naming the file and the reason, instead of escaping as a generic failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMessageHandlers } from '../../../src/bridge/messageHandlers';
import type { BridgeHost } from '../../../src/bridge/host';

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
    getWorkspaceState: vi.fn(),
  };
}

describe('open-dacpac with a file that is not a .dacpac', () => {
  it('posts a db-error naming the file and the reason, and does not throw', async () => {
    const host = fakeHost(new TextEncoder().encode('not a zip'));
    const { handlers } = createMessageHandlers(
      host,
      { globalState: { get: () => undefined, update: () => Promise.resolve() } } as never,
      () => ({ model: null, uiState: {}, renderState: null }) as never,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() } as never,
      () => ({ schemaVersion: 1, projects: [] }) as never,
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
    );

    await expect(handlers['open-dacpac']({ type: 'open-dacpac' } as never)).resolves.toBeUndefined();

    const posted = vi.mocked(host.postMessage).mock.calls.map(([m]) => m as { type: string; message?: string });
    const error = posted.find((m) => m.type === 'db-error');
    expect(error?.message).toMatch(/broken\.dacpac/);
    expect(error?.message).toMatch(/not a valid \.dacpac/i);
    expect(posted.some((m) => m.type === 'dacpac-schema-preview')).toBe(false);
  });
});
