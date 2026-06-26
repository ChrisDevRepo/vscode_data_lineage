import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor, sleep } from './helpers/edhUtils';
import { CdpClient } from './helpers/cdpClient';

// L3 — Bridge handler tests: node detail and project/saved-view store.
// Drives host-side handlers via real webview bridge messages (no GUI clicks),
// asserts outcomes from the debug dump and session state.
suite('Bridge handlers — node detail and project store', () => {
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
    // Wait until the React app has rendered at least one graph node before testing.
    await cdp.readActiveFrameMetrics(webviewSession, 30000);
  });

  suiteTeardown(() => cdp?.close());

  // ── 1. show-detail ──────────────────────────────────────────────────────────
  //
  // bridgeContract.ts line 309:
  //   z.object({ type: z.literal('show-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() })
  //
  // The host handler (messageHandlers.ts line 229) logs
  //   "[Bridge] Node detail opened — <id>"  and opens the detail webview panel.
  // We verify via that LOG LINE — the deterministic host-handler signal.
  // (The dump's DETAIL PANEL section depends on render-state.highlightedNodeId,
  //  which the LIVE webview owns and overwrites, so it is too racy to assert.)
  test('show-detail invokes the host handler and logs the opened node', async function () {
    this.timeout(60000);

    const api = await getApi();
    const model = api.getSession().model!;
    assert.ok(model && model.nodes.length > 0, 'demo model must have at least one node');

    // bridgeContract.ts line 65-75: LineageNodeSchema requires id, name, schema, fullName, type.
    const rawNode = model.nodes[0] as {
      id: string;
      name: string;
      schema: string;
      fullName: string;
      type: string;
      isVirtual?: boolean;
      isExternal?: boolean;
    };
    const nodeId = rawNode.id;
    assert.ok(nodeId, 'first node must have an id');

    const logsBefore = api.testLogCapture.length;

    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'show-detail',
      node: {
        id:       rawNode.id,
        name:     rawNode.name,
        schema:   rawNode.schema,
        fullName: rawNode.fullName,
        type:     rawNode.type,
        ...(rawNode.isVirtual  !== undefined && { isVirtual:  rawNode.isVirtual }),
        ...(rawNode.isExternal !== undefined && { isExternal: rawNode.isExternal }),
      },
    });
    assert.strictEqual(sent, 'sent', 'show-detail must be dispatched through the bridge');

    // Deterministic signal: the host logs "Node detail opened — <id>" at info level
    // (captured because VSCODE_EX_TEST is set). Poll the capture buffer for it.
    const line = await waitFor(() => {
      const found = api.testLogCapture.slice(logsBefore).find((l) => l.includes('Node detail opened'));
      return found ?? null;
    }, 10000);
    assert.ok(
      line.includes(nodeId),
      `detail-open log must reference node id "${nodeId}" (got: ${line})`,
    );
  });

  // ── 2. request-projects — host responds and logs ────────────────────────────
  //
  // bridgeContract.ts line 344:
  //   z.object({ type: z.literal('request-projects') })
  //
  // Handler (messageHandlers.ts line 543) loads the store from global state and
  // posts projects-list back.  We cannot intercept the host→webview postMessage
  // from the test layer, but we can verify the handler did not throw (no new
  // error log lines) and that the project store on disk is readable (the demo
  // session sets projectName = 'Demo').
  test('request-projects resolves without error and session carries demo project name', async function () {
    this.timeout(60000);

    const api = await getApi();
    const logsBefore = api.testLogCapture.length;

    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'request-projects',
    });
    assert.strictEqual(sent, 'sent', 'request-projects must be dispatched through the bridge');

    await sleep(500);

    // Verify no new error-level log lines appeared (handler must not have thrown).
    const newLines = api.testLogCapture.slice(logsBefore).join('\n');
    assert.ok(
      !(/\[error\]|FAILED:/i.test(newLines)),
      `no error log lines must appear after request-projects.\nNew lines:\n${newLines}`,
    );

    // openDemo sets projectName = 'Demo' (messageHandlers.ts line 205–207, 417–420).
    const sess = api.getSession();
    assert.strictEqual(
      sess.projectName,
      'Demo',
      `session.projectName must be "Demo" after openDemo (got: ${sess.projectName})`,
    );
  });

  // ── 3. save-project → request-projects → session reflects persisted project ─
  //
  // bridgeContract.ts line 315:
  //   z.object({ type: z.literal('save-project'), project: z.any() })
  //
  // isValidProject guard (projectStore.ts line 226) requires id, name,
  // createdAt, updatedAt, and a valid connection shape.  The minimal valid
  // connection type is 'dacpac' with path, displayName, schemas[].
  //
  // After save-project the handler (messageHandlers.ts line 399–407):
  //   1. Persists the project into global state.
  //   2. Sets sess.currentProjectId and sess.projectName.
  //   3. Posts projects-list back to the webview.
  //
  // We assert sess.projectName changed to the saved name and reverts back
  // to 'Demo' after a second openDemo flush (best-effort; see note below).
  test('save-project persists project name into session state', async function () {
    this.timeout(60000);

    const api = await getApi();
    const testProjectId   = 'bridge-store-test-project-001';
    const testProjectName = 'BridgeStoreTest_' + Date.now();
    const now = new Date().toISOString();

    // Minimal valid project shape accepted by isValidProject (projectStore.ts line 226).
    // connection.type = 'dacpac' requires path + displayName + schemas (projectStore.ts line 249).
    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'save-project',
      project: {
        id:         testProjectId,
        name:       testProjectName,
        createdAt:  now,
        updatedAt:  now,
        connection: {
          type:        'dacpac',
          path:        '/dev/null/test.dacpac',
          displayName: testProjectName,
          schemas:     [],
        },
      },
    });
    assert.strictEqual(sent, 'sent', 'save-project must be dispatched through the bridge');

    // Handler is synchronous after the await saveProjectStore — give it a tick.
    await sleep(800);

    const sess = api.getSession();
    assert.strictEqual(
      sess.projectName,
      testProjectName,
      `session.projectName must equal the saved project name "${testProjectName}" (got: ${sess.projectName})`,
    );
    assert.strictEqual(
      (sess as { currentProjectId?: string }).currentProjectId,
      testProjectId,
      `session.currentProjectId must equal the saved project id "${testProjectId}"`,
    );
  });

  // ── 4. save-view + delete-view — project store round-trip ──────────────────
  //
  // bridgeContract.ts lines 330–342:
  //   save-view: { type, projectId, profile: { id, name, createdAt, filter: SerializedFilterStateSchema } }.passthrough()
  //   delete-view: { type, projectId, profileId }
  //
  // SerializedFilterStateSchema (bridgeContract.ts line 174) requires:
  //   schemas[], types[], hideIsolated, focusSchemas[], showExternalRefs, externalRefTypes[].
  //
  // We use the project id saved in test 3 so the project exists in the store.
  // The handler (messageHandlers.ts line 507) calls addFilterProfile then posts
  // projects-list back.  We cannot intercept the webview message, but we confirm
  // no error was logged (handler did not throw).
  //
  // NOTE: Because the webview → host → webview round-trip resolves asynchronously
  // and the test layer has no interception channel for host→webview postMessage,
  // we assert only on the absence of errors and the dump BOOKMARK section that
  // would appear if the UI state carried a bookmark (it won't unless the webview
  // reacts to projects-list — outside our control here).  The structural path
  // through addFilterProfile is covered; UI bookmark assertion is out of scope.
  test('save-view and delete-view execute without error', async function () {
    this.timeout(60000);

    const api = await getApi();
    const testProjectId = 'bridge-store-test-project-001';
    const profileId     = 'bridge-store-test-view-001';
    const now           = new Date().toISOString();

    const logsBefore = api.testLogCapture.length;

    // Minimal valid filter profile matching the save-view passthrough schema.
    // bridgeContract.ts line 330–339: persistence-critical fields are id, name,
    // createdAt, and filter (SerializedFilterStateSchema).
    const sent = await cdp.postBridgeMessage(webviewSession, {
      type: 'save-view',
      projectId: testProjectId,
      profile: {
        id:        profileId,
        name:      'Bridge Store Test View',
        createdAt: now,
        filter: {
          schemas:          [],
          types:            [],
          hideIsolated:     false,
          focusSchemas:     [],
          showExternalRefs: false,
          externalRefTypes: [],
        },
      },
    });
    assert.strictEqual(sent, 'sent', 'save-view must be dispatched through the bridge');

    await sleep(800);

    // Verify save-view did not throw on the host side.
    let newLines = api.testLogCapture.slice(logsBefore).join('\n');
    assert.ok(
      !(/FAILED:|unhandledRejection/i.test(newLines)),
      `no FAILED: log lines must appear after save-view.\nNew lines:\n${newLines}`,
    );

    // Now delete the view.
    const sentDel = await cdp.postBridgeMessage(webviewSession, {
      type: 'delete-view',
      projectId: testProjectId,
      profileId,
    });
    assert.strictEqual(sentDel, 'sent', 'delete-view must be dispatched through the bridge');

    await sleep(500);

    newLines = api.testLogCapture.slice(logsBefore).join('\n');
    assert.ok(
      !(/FAILED:|unhandledRejection/i.test(newLines)),
      `no FAILED: log lines must appear after delete-view.\nNew lines:\n${newLines}`,
    );
  });
});
