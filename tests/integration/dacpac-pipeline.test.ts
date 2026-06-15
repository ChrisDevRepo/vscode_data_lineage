import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor } from './helpers/edhUtils';

// L2 — the core "command → panel → webview → host → model" path, verified from
// session state + the captured log trail (no screenshots).
suite('Dacpac → model pipeline (demo)', () => {
  test('openDemo loads the bundled AdventureWorks demo into the session model', async () => {
    const api = await getApi();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');

    const model = await waitFor(() => api.getSession().model, 45000);
    assert.ok(model.nodes.length > 0, `expected nodes, got ${model.nodes.length}`);
    assert.ok(model.edges.length > 0, `expected edges, got ${model.edges.length}`);
    assert.ok(model.schemas.length > 0, `expected schemas, got ${model.schemas.length}`);
    assert.ok(api.getActivePanel(), 'a panel is active after openDemo');
  });

  test('demo load is recorded in the captured log trail', async () => {
    const api = await getApi();
    await waitFor(() => api.getSession().model, 45000); // idempotent if already loaded
    const logs = api.testLogCapture.join('\n');
    assert.ok(/\[(Bridge|Parse|Dacpac|Project|Stats)\]/.test(logs), 'expected category-prefixed load log lines');
  });
});
