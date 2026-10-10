import * as assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Keeps a real Extension Development Host alive with the MCP server enabled so an EXTERNAL process
 * can connect to it and test it from outside, the way a real MCP client does.
 *
 * @remarks
 * The orchestrator (`tests/tools/mcp-live.mjs`) prepares an isolated user-data directory whose
 * settings enable the server, launches this lane, and waits for `ready.json`. This test loads the
 * public AdventureWorks AI fixture into the live host, publishes the connection facts an external
 * client needs (discovery file, the Electron binary and stdio-proxy path for the proxy case), then
 * serves a small command channel until the orchestrator writes `done` or a bounded deadline passes:
 *
 * - `cmd-<n>.json` holds `{ "action": ... }`; the host answers in `res-<n>.json`.
 * - Actions are limited to what a user can do from the UI: toggle the kill switch, change the port,
 *   load the demo or the fixture project, and report the loaded model's size.
 *
 * Nothing here asserts MCP behavior; the external client does. This lane only proves the host
 * stays up and reacts to those user-level actions. It calls no model.
 */
suite('MCP live host — external client connects to a running Extension Development Host', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';
  const controlDir = process.env.MCP_LIVE_DIR ?? '';
  const userDataDir = process.env.MCP_LIVE_USER_DATA ?? '';
  const port = Number(process.env.MCP_LIVE_PORT ?? '39372');
  const MAX_SERVE_MS = Number(process.env.MCP_LIVE_MAX_MS ?? 15 * 60_000);

  const write = (name: string, value: unknown): void => {
    const tmp = join(controlDir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, join(controlDir, name));
  };
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  suiteSetup(function () {
    // `npm run test:edh` runs every lane; without the orchestrator there is no external client to wait for.
    if (!controlDir || !userDataDir) {
      console.log('\n  ── LANE mcp-live skipped: it is driven by `npm run test:mcp:live` (tests/tools/mcp-live.mjs) ──\n');
      this.skip();
    }
    announceLaneTier(
      'mcp-live',
      'none',
      'a running host with the MCP server on stays up and reacts to user-level actions while an external client drives it',
    );
  });

  test('serves an external MCP client until told to stop', async function () {
    this.timeout(0);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'product extension must be present');
    const exports = await extension.activate() as { getSession(): { model?: { nodes: Array<{ id: string }>; edges: unknown[] } | null } };
    const nodeCount = () => exports.getSession().model?.nodes.length ?? 0;
    const waitForModel = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) { if (predicate()) return; await sleep(500); }
      assert.fail(`${label} did not load within 90s`);
    };

    // Open the demo first: it creates the panel the render tool needs. Then swap in the fixture.
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await waitForModel(() => nodeCount() > 0, 'demo project');
    const fixture = vscode.Uri.file(join(extension.extensionPath, 'tests/fixtures/AdventureWorks2025_AI.dacpac'));
    const loadFixture = async (): Promise<void> => {
      await vscode.commands.executeCommand('dataLineageViz.openExternalProject', fixture);
      await waitForModel(() => !!exports.getSession().model?.nodes.some(node => node.id.toLowerCase() === '[ai].[spimportorders]'), 'fixture project');
    };
    await loadFixture();

    const config = vscode.workspace.getConfiguration('dataLineageViz.mcp');
    assert.strictEqual(config.get<boolean>('enabled'), true, 'the seeded user settings must enable the server');
    assert.ok((await vscode.commands.getCommands(true)).includes('dataLineageViz.copyMcpConfig'), 'the deferred MCP bundle must register its command');
    const globalStorage = join(userDataDir, 'User/globalStorage', EXTENSION_ID);
    const discoveryDeadline = Date.now() + 30_000;
    let sessionPath: string | undefined;
    while (!sessionPath && Date.now() < discoveryDeadline) {
      const session = existsSync(globalStorage) ? readdirSync(globalStorage).find(name =>
        name.startsWith('mcp-session-') && existsSync(join(globalStorage, name, 'mcp-server.json')),
      ) : undefined;
      if (session) sessionPath = join(globalStorage, session);
      else await sleep(100);
    }
    assert.ok(sessionPath, 'the session endpoint must publish its discovery file');
    write('ready.json', {
      discoveryPath: join(sessionPath, 'mcp-server.json'),
      proxyPath: join(sessionPath, 'mcp-stdio-proxy.js'),
      execPath: process.execPath,
      port,
      nodes: nodeCount(),
    });

    const handled = new Set<string>();
    const deadline = Date.now() + MAX_SERVE_MS;
    while (Date.now() < deadline && !existsSync(join(controlDir, 'done'))) {
      for (let n = 1; n <= 200; n++) {
        const file = join(controlDir, `cmd-${n}.json`);
        if (handled.has(file) || !existsSync(file)) continue;
        handled.add(file);
        const command = JSON.parse(readFileSync(file, 'utf8')) as { action: string; enabled?: boolean; port?: number };
        try {
          switch (command.action) {
            case 'toggle': await config.update('enabled', command.enabled, vscode.ConfigurationTarget.Global); break;
            case 'setPort': await config.update('port', command.port, vscode.ConfigurationTarget.Global); break;
            case 'loadDemo':
              await vscode.commands.executeCommand('dataLineageViz.openDemo');
              await waitForModel(() => nodeCount() > 0 && !exports.getSession().model?.nodes.some(node => node.id.toLowerCase() === '[ai].[spimportorders]'), 'demo project');
              break;
            case 'loadAI': await loadFixture(); break;
            case 'status': break;
            default: throw new Error(`unknown action ${command.action}`);
          }
          write(`res-${n}.json`, { ok: true, nodes: nodeCount(), enabled: vscode.workspace.getConfiguration('dataLineageViz.mcp').get('enabled'), port: vscode.workspace.getConfiguration('dataLineageViz.mcp').get('port') });
        } catch (error) {
          write(`res-${n}.json`, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await sleep(250);
    }
    assert.ok(existsSync(join(controlDir, 'done')), `the orchestrator did not finish within ${MAX_SERVE_MS} ms`);
    rmSync(join(controlDir, 'ready.json'), { force: true });
    mkdirSync(controlDir, { recursive: true });
  });
});
