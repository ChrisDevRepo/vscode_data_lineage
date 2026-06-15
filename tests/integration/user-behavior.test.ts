import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor, sleep } from './helpers/edhUtils';
import { CdpClient } from './helpers/cdpClient';

// L3 — simulate user behavior by sending REAL bridge messages (no clicks), then
// verify the outcome from the debug dump (no screenshots). Demonstrates the
// "programmatic-first, state-driven" pattern from docs/E2E_TESTING.md.
suite('User behavior via bridge → verify via debug dump', () => {
  let cdp: CdpClient;
  let webviewSession: string;

  suiteSetup(async function () {
    this.timeout(90000);
    const api = await getApi();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await waitFor(() => api.getSession().model, 45000);
    cdp = await CdpClient.connect(9222);
    await cdp.attachWorkbench();
    webviewSession = await cdp.findWebviewSession(30000);
    await cdp.readActiveFrameMetrics(webviewSession, 30000); // ensure the app frame is live
  });

  suiteTeardown(() => cdp?.close());

  /** Runs copyDebugInfo and returns the dump read back from the clipboard. */
  async function captureDump(): Promise<string> {
    await vscode.env.clipboard.writeText('__cleared__');
    await vscode.commands.executeCommand('dataLineageViz.copyDebugInfo');
    for (let i = 0; i < 30; i++) {
      const t = await vscode.env.clipboard.readText();
      if (t && t.includes('Debug Info')) return t;
      await sleep(200);
    }
    throw new Error('debug dump was not captured from clipboard');
  }

  test('a filter-changed action sent through the bridge round-trips into GUI STATE', async function () {
    this.timeout(60000);
    const marker = 'BRIDGE_SIM_FILTER_MARKER';
    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'filter-changed',
      uiState: { e2eMarker: marker, schemas: ['Sales'] },
    });
    assert.strictEqual(sent, 'sent', 'message dispatched via the real active-frame window.vscode bridge');

    await sleep(1000);
    const dump = await captureDump();
    assert.ok(dump.includes('GUI STATE'), 'dump has a GUI STATE section');
    assert.ok(dump.includes(marker), 'simulated filter uiState reached the host and appears in the dump');
  });

  test('a trace render-state sent through the bridge surfaces the origin in the dump', async function () {
    this.timeout(60000);
    const api = await getApi();
    const model = api.getSession().model!;
    const originId = (model.nodes[0] as { id: string }).id;
    assert.ok(originId, 'demo model has at least one node');

    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'render-state',
      renderState: {
        highlightedNodeId: originId,
        traceScope: {
          mode: 'trace',
          origin: originId,
          baseNodeIds: [originId],
          manualAddedNodeIds: [],
          manualPrunedNodeIds: [],
          tracedNodeIds: [originId],
        },
      },
    });
    assert.strictEqual(sent, 'sent');

    await sleep(1000);
    const dump = await captureDump();
    assert.ok(/TRACE SCOPE|SELECTION & AFFORDANCES|RENDER STATE/.test(dump), 'a render/trace section is present');
    assert.ok(dump.includes(originId), 'simulated trace origin node id surfaced in the dump');
  });
});
