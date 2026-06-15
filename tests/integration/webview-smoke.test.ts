import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor } from './helpers/edhUtils';
import { CdpClient } from './helpers/cdpClient';

// L3 — the blank-screen / CSP regression. Opens the demo PROGRAMMATICALLY, then
// uses CDP only to READ the rendered webview (DOM metrics + console). No clicks,
// no screenshots: a blank webview has no #root / no React Flow nodes.
suite('Webview render smoke (CSP / blank-screen regression)', () => {
  test('demo graph renders in the real webview with no console errors', async function () {
    this.timeout(120000);
    const api = await getApi();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await waitFor(() => api.getSession().model, 45000); // host has the model

    const cdp = await CdpClient.connect(9222);
    try {
      await cdp.attachWorkbench();
      const wv = await cdp.findWebviewSession(30000);
      const metrics = await cdp.readActiveFrameMetrics(wv, 45000);

      assert.ok(metrics.hasRoot, 'webview #root present (not blank)');
      assert.ok(metrics.nodeCount > 0, `React Flow nodes rendered (got ${metrics.nodeCount})`);
      assert.ok(metrics.bodyLen > 0, 'webview body has content');

      const errors = cdp.getConsoleErrors();
      assert.deepStrictEqual(errors, [], `webview console errors: ${errors.join(' | ')}`);
    } finally {
      cdp.close();
    }
  });
});
