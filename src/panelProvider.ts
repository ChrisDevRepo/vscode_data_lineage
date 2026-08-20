import * as vscode from 'vscode';
import { type AiSession } from './ai/session/session';
import { Logger } from './utils/log';
import { notifyError } from './utils/notifications';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { createBridgeHost, type BridgeHost } from './bridge/host';
import { summarizeZodError } from './bridge/host';
import { createMessageHandlers, isMssqlAvailable, PROJECT_STORE_KEY } from './bridge/messageHandlers';
import {
  BRIDGE_PROTOCOL_VERSION,
  MainPanelToExtensionMsgSchema,
  type BridgeEnvelope,
  type MainPanelToExtensionMsg,
} from './engine/shared/bridgeContract';

let activePanel: vscode.WebviewPanel | undefined;
let activeTriggerDemo: (() => Promise<void>) | undefined;

export { PROJECT_STORE_KEY };

/**
 * Retrieves the currently active lineage webview panel, if one exists.
 *
 * @returns The active `vscode.WebviewPanel` or `undefined` if no panel is open.
 */
export function getActivePanel() { return activePanel; }

/**
 * Orchestrates the creation, restoration, and lifecycle of the primary Data Lineage Webview.
 *
 * This function handles:
 * - Preventing multiple instances of the same panel (revealing the existing one instead).
 * - Initializing the IPC bridge (BridgeHost) for Extension <-> Webview communication.
 * - Injecting the necessary HTML, scripts, and styles into the webview.
 * - Managing panel-scoped state and ensuring cleanup on disposal.
 *
 * @param context - The extension context.
 * @param title - The display title for the webview tab.
 * @param getSession - Factory to retrieve the current AI session.
 * @param outputChannel - Log channel for bridge and extension events.
 * @param loadProjectStore - Function to retrieve saved projects.
 * @param saveProjectStore - Function to persist project changes.
 * @param migrateFromWorkspaceState - Helper for legacy state migration.
 * @param loadDemo - If true, triggers the "AdventureWorks Demo" load sequence on initialization.
 */
export function openPanel(
  context: vscode.ExtensionContext,
  title: string,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  loadProjectStore: (context: vscode.ExtensionContext) => any,
  saveProjectStore: (context: vscode.ExtensionContext, store: any) => Promise<void>,
  migrateFromWorkspaceState: (context: vscode.ExtensionContext) => Promise<void>,
  loadDemo = false
) {
  const bridgeLogger = Logger.create(outputChannel, 'Bridge');

  if (activePanel) {
    bridgeLogger.info('Revealing existing panel');
    activePanel.reveal();
    if (loadDemo && activeTriggerDemo) {
      bridgeLogger.info('Open Demo invoked on existing panel — loading demo data.');
      activeTriggerDemo().catch(err => bridgeLogger.error(`Failed to trigger demo on active panel`, err));
    } else if (loadDemo) {
      bridgeLogger.info('Open Demo invoked on existing panel, but no trigger function was available.');
    }
    return;
  }

  bridgeLogger.info(`Creating new panel: "${title}"`);
  const panel = vscode.window.createWebviewPanel(
    'dataLineageViz', title, vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'images')],
    }
  );

  activePanel = panel;
  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, loadDemo);

  const host: BridgeHost = createBridgeHost(panel, context, outputChannel);

  let detailPanel: vscode.WebviewPanel | undefined;
  /** Disposables scoped to this panel instance, released when the panel closes. */
  const panelDisposables: vscode.Disposable[] = [];

  panel.onDidDispose(() => {
    bridgeLogger.info('Panel disposed');
    activePanel = undefined;
    activeTriggerDemo = undefined;
    detailPanel?.dispose();
    while (panelDisposables.length > 0) panelDisposables.pop()?.dispose();

    const sess = getSession();
    // Only discard exploration state when there is no active SM.
    // A panel closed mid-exploration preserves the archive for the next panel open.
    if (sess.phase.kind === 'idle' || sess.phase.kind === 'completed') {
      sess.resetExploration();
    }
    sess.model = null;
    sess.graph = null;
    sess.columnStore.clear();
    sess.clearDiscoveryTranscript();
    void vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
  });

  const { handlers, cleanup, triggerDemoLoad } = createMessageHandlers(
    host,
    context,
    getSession,
    outputChannel,
    loadProjectStore,
    saveProjectStore,
    migrateFromWorkspaceState,
    loadDemo,
    (dp) => detailPanel = dp
  );

  activeTriggerDemo = triggerDemoLoad;

  // The webview asks `check-mssql` once, on mount. Installing, enabling or disabling the SQL Server
  // extension while the panel is open would otherwise leave the database entry points stale until
  // the panel is reopened. The listener is panel-scoped, so it is gone before the panel is.
  let mssqlAvailable = isMssqlAvailable();
  vscode.extensions.onDidChange(() => {
    const available = isMssqlAvailable();
    if (available === mssqlAvailable) return;
    mssqlAvailable = available;
    bridgeLogger.info(`SQL Server (mssql) extension is now ${available ? 'available' : 'unavailable'} — re-posting mssql-status.`);
    void host.postMessage({ type: 'mssql-status', available });
  }, undefined, panelDisposables);

  // Ensure that database connections and stats caches are released when the panel is closed.
  panel.onDidDispose(() => {
    cleanup().catch(err => bridgeLogger.warn(`Cleanup failed — next session may reuse stale state: ${err}`));
  });

  panel.webview.onDidReceiveMessage(async (rawMsg) => {
    // Envelope check before the payload union: a frame carrying a *different* protocol version came
    // from a bundle this host cannot speak to, and parsing it would be guesswork. Webview→host
    // frames are unstamped by contract (only the host's send path stamps), so an absent version is
    // normal and only a present-but-wrong one is a skew.
    const inboundVersion = (rawMsg as BridgeEnvelope | undefined)?.protocolVersion;
    if (inboundVersion !== undefined && inboundVersion !== BRIDGE_PROTOCOL_VERSION) {
      notifyError(
        bridgeLogger,
        'Bridge protocol mismatch',
        `Data Lineage: the webview is speaking bridge protocol v${String(inboundVersion)} but this extension expects v${BRIDGE_PROTOCOL_VERSION}. Reload the window to pick up the matching view.`,
      );
      return;
    }
    const parsed = MainPanelToExtensionMsgSchema.safeParse(rawMsg);
    if (!parsed.success) {
      bridgeLogger.warn(`Rejected malformed webview message (type=${rawMsg?.type ?? '?'}): ${summarizeZodError(parsed.error)}`);
      return;
    }
    const msg = parsed.data;
    const handler = handlers[msg.type] as (m: MainPanelToExtensionMsg) => Promise<void> | void;
    try {
      await handler(msg);
    } catch (err) {
      notifyError(
        bridgeLogger,
        `Handler '${msg.type}' threw unexpectedly`,
        'Data Lineage: The requested action failed — see the "Data Lineage Viz" Output channel for details.',
        err,
        { messageType: msg.type },
        host.showErrorMessage,
      );
    }
  }, undefined, panelDisposables);
}

import { buildWebviewCsp } from './utils/cspBuilder';

/**
 * Generates the root HTML for the lineage webview.
 */
function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, loadDemo: boolean): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);
  const nonce = getNonce();
  const csp = buildWebviewCsp({ nonce, cspSource: webview.cspSource });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" type="text/css" href="${stylesUri}">
  <title>Data Lineage Viz</title>
</head>
<body class="vscode-body" ${loadDemo ? 'data-auto-visualize="true"' : ''}>
  <div id="root">
    <div id="bootloader-fallback" style="display: none; padding: 2rem; color: var(--vscode-errorForeground); font-family: var(--vscode-font-family);">
      <h2>UI Failed to Load</h2>
      <p>The extension's user interface encountered a fatal error during initialization.</p>
      <p>Please open the <b>Developer: Toggle Developer Tools</b> command from the Command Palette to view the exact error.</p>
    </div>
  </div>
  <script nonce="${nonce}">
    window.LOGO_URI = "${logoUri}";
    // Display fallback if React hasn't mounted and cleared the root element within 3 seconds
    setTimeout(() => {
      const fallback = document.getElementById('bootloader-fallback');
      if (fallback) fallback.style.display = 'block';
    }, 3000);
  </script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export { buildDebugDump } from './bridge/messageHandlers';
