/** A webview error message, stack and context are stored for the "Copy Debug Info" report, which the user pastes into an issue. Credential-shaped text in them is removed before it is stored. */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeHost } from '../../../src/bridge/host';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', async () => {
  const actual = await import('../../stubs/vscode');
  return {
    ...actual,
    version: '1.101.0',
    workspace: {
      getConfiguration: () => ({ get: (key: string) => settings.values[key] }),
    },
  };
});

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

  it('keeps counts and the view summary, and leaves script names and connection records out', () => {
    settings.values = {
      maxNodes: 50,
      renderLimit: 750,
      'database.connections': [{ id: '1', server: 'secret-host.example', authenticationType: 'sqlLogin', user: 'sa' }],
      'ai.enabled': false,
      'layout.direction': `password=${SECRET} ${'x'.repeat(180)}`,
    };
    const session = {
      phase: { kind: 'idle' },
      hopCount: 2,
      sourceLabel: 'demo.dacpac',
      parseRulesLabel: 'default',
      projectName: 'Demo',
      model: {
        dbPlatform: 'sqlserver',
        nodes: [
          { id: 'a', schema: 'dbo' },
          { id: 'b', schema: 'dbo' },
          { id: 'e', schema: 'ext' },
        ],
        edges: [{ source: 'a', target: 'b' }],
        schemas: [
          { name: 'dbo', nodeCount: 2, types: { external: 0 } },
          { name: 'ext', nodeCount: 1, types: { external: 1 } },
        ],
      },
      parseStats: {
        parsedRefs: 4,
        resolvedEdges: 1,
        droppedRefs: 1,
        scripts: 1,
        unreadableDefinitions: 1,
        spDetails: [{ name: 'dbo.secret_proc', inCount: 1, outCount: 0, inRefs: ['dbo.secret_table'], unrelated: [] }],
        droppedRefNames: ['cte.hidden'],
        unreadableNames: ['dbo.broken'],
      },
      uiState: {
        graphMode: 'full',
        filteredCount: 2,
        renderLimitHit: 0,
        filter: { schemas: ['dbo'], types: ['table'], hideIsolated: true, focusSchemas: [], showExternalRefs: false, exclusionPatterns: ['^tmp'] },
        trace: { mode: 'none', selectedNodeId: null, upstreamLevels: 1, downstreamLevels: Number.MAX_SAFE_INTEGER },
      },
    };
    const context = {
      extension: { packageJSON: { version: '1.2.6', contributes: { configuration: [{ properties: {
        'dataLineageViz.maxNodes': { default: 2000 },
        'dataLineageViz.renderLimit': { default: 750 },
        'dataLineageViz.database.connections': { default: [] },
        'dataLineageViz.ai.enabled': { default: true },
        'dataLineageViz.layout.direction': { default: 'TB' },
      } }] } } },
    };
    const dump = buildDebugDump(context as never, () => session as never);
    expect(dump).toContain('Nodes total:  3');
    expect(dump).toContain('dbo (2)');
    expect(dump).not.toContain('ext (1)');
    expect(dump).toContain('Parsed refs:            4');
    expect(dump).toContain('Dropped refs:           1');
    expect(dump).toContain('Scripts:                1');
    expect(dump).toContain('Unreadable definitions: 1');
    expect(dump).not.toContain('secret_proc');
    expect(dump).not.toContain('secret_table');
    expect(dump).not.toContain('cte.hidden');
    expect(dump).not.toContain('dbo.broken');
    expect(dump).toContain('Graph mode:   full');
    expect(dump).toContain('hideIsolated true');
    expect(dump).toContain('down All');
    expect(dump).toContain('maxNodes: 50 (default 2000)');
    expect(dump).toContain('layout.direction:');
    expect(dump).toContain('… [+');
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('x'.repeat(160));
    expect(dump).not.toContain('renderLimit');
    expect(dump).toContain('database.connections: 1 connection(s)');
    expect(dump).not.toContain('secret-host.example');
    expect(dump).not.toContain('ai.enabled');
    expect(dump).toContain('Full SM dump: use Data Lineage: Dump AI State Machine');
    expect(dump).toContain('(no render-state reported');
  });
});
