/**
 * A webview error message, stack and context are stored for the "Copy Debug Info" report, which the
 * user pastes into an issue. Credential-shaped text in them is removed before it is stored.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';

const { createMessageHandlers, buildDebugDump } = await import('../../../src/bridge/messageHandlers');

const SECRET = 'Zk93mQpL71xv';

function dumpAfterWebviewError(error: Record<string, unknown>): string {
  const session = { phase: { kind: 'idle' }, hopCount: 0, sourceLabel: 'demo', parseRulesLabel: 'default' };
  const host = { log: vi.fn(), showErrorMessage: vi.fn() } as unknown as BridgeHost;
  const context = {
    globalState: { get: vi.fn(), update: vi.fn() },
    extension: { packageJSON: { version: '0.0.0', contributes: { configuration: [] } } },
  };
  const { handlers } = createMessageHandlers(
    host,
    context as never,
    () => session as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    vi.fn(),
    vi.fn(),
    false,
    vi.fn(),
  );
  (handlers['error'] as (msg: unknown) => void)({ type: 'error', source: 'error-boundary', ...error });
  return buildDebugDump(context as never, () => session as never);
}

describe('webview error diagnostics', () => {
  it('keeps the webview error readable in the debug dump', () => {
    const dump = dumpAfterWebviewError({ error: 'Render failed for dbo.Orders' });
    expect(dump).toContain('message:   Render failed for dbo.Orders');
  });

  it('removes credential-shaped text from the stored message, stack and context', () => {
    const dump = dumpAfterWebviewError({
      error: `Fetch failed: password=${SECRET};Server=x`,
      stack: `Error: token: ${SECRET}\n    at fetch (app.js:1:1)`,
      context: { url: `https://u:${SECRET}@host/db`, note: `client_secret=${SECRET}` },
    });
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain('Server=x');
    expect(dump).toContain('at fetch (app.js:1:1)');
  });

  it('removes a credential that the stored length limit would otherwise cut in half', () => {
    const dump = dumpAfterWebviewError({
      error: 'Render failed',
      stack: `Error: ${'x'.repeat(571)} {"password":"${SECRET}"}`,
      context: { pad: 'x'.repeat(772), password: SECRET },
    });
    expect(dump).not.toContain(SECRET.slice(0, 4));
    expect(dump).toContain('message:   Render failed');
  });
});
