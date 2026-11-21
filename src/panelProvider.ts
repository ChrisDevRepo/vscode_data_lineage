import * as vscode from 'vscode';
import { type AiSession } from './ai/session/session';
import { Logger, OUTPUT_CHANNEL_NAME } from './utils/log';
import { notifyErrorOnce } from './utils/notifications';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { createBridgeHost, type BridgeHost } from './bridge/host';
import { postToWebview, summarizeZodError } from './bridge/host';
import { createMessageHandlers, PROJECT_STORE_KEY, type ReportDocumentRef } from './bridge/messageHandlers';
import {
  MainPanelToExtensionMsgSchema,
  type MainPanelToExtensionMsg,
} from './engine/shared/bridgeContract';

let activePanel: vscode.WebviewPanel | undefined;
let activeTriggerDemo: (() => Promise<void>) | undefined;
/**
 * Outlives every panel: handlers are re-created per panel, the AI report document is one per
 * session.
 */
const reportDocumentRef: ReportDocumentRef = {};

export { PROJECT_STORE_KEY };

/** Retrieves the currently active lineage webview panel, if one exists. */
export function getActivePanel() { return activePanel; }

/**
 * Creates, restores and manages the lifecycle of the primary Data Lineage Webview: reveals the
 * existing panel instead of opening a second, initializes the IPC bridge (BridgeHost), injects
 * HTML, scripts and styles, and cleans panel-scoped state on disposal.
 *
 * @param loadDemo - Start the "AdventureWorks Demo" load on initialization.
 * @param replace - Close a panel with a loaded graph and open a new one (the webview reload);
 *   without it, a loaded panel is revealed and asked to go back.
 */
export function openPanel(
  context: vscode.ExtensionContext,
  title: string,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  loadProjectStore: (context: vscode.ExtensionContext) => any,
  saveProjectStore: (context: vscode.ExtensionContext, store: any) => Promise<void>,
  migrateFromWorkspaceState: (context: vscode.ExtensionContext) => Promise<void>,
  loadDemo = false,
  replace = false
) {
  const bridgeLogger = Logger.create(outputChannel, 'Bridge');

  if (activePanel) {
    if (!loadDemo && getSession().graph) {
      if (replace) {
        const existing = activePanel;
        bridgeLogger.info('Reload requested — replacing the existing panel.');
        const disposed = new Promise<void>((resolve) => existing.onDidDispose(() => resolve()));
        existing.dispose();
        void disposed.then(() => openPanel(context, title, getSession, outputChannel, loadProjectStore, saveProjectStore, migrateFromWorkspaceState));
        return;
      }
      bridgeLogger.info('Open Wizard invoked with a panel open — asking the view to go back.');
      activePanel.reveal();
      void postToWebview(activePanel, { type: 'request-back' }, bridgeLogger);
      return;
    }
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
    (dp) => detailPanel = dp,
    reportDocumentRef
  );

  activeTriggerDemo = triggerDemoLoad;

  panel.onDidDispose(() => {
    cleanup().catch(err => bridgeLogger.warn(`Cleanup failed — next session may reuse stale state: ${err}`));
  });

  panel.webview.onDidReceiveMessage(async (rawMsg) => {
    const parsed = MainPanelToExtensionMsgSchema.safeParse(rawMsg);
    if (!parsed.success) {
      bridgeLogger.error('Rejected malformed webview message', new Error(`type=${rawMsg?.type ?? '?'}: ${summarizeZodError(parsed.error)}`));
      return;
    }
    const msg = parsed.data;
    const handler = handlers[msg.type] as (m: MainPanelToExtensionMsg) => Promise<void> | void;
    try {
      await handler(msg);
    } catch (err) {
      notifyErrorOnce(
        bridgeLogger,
        `Handler '${msg.type}' threw unexpectedly`,
        `Data Lineage: The requested action failed — see the "${OUTPUT_CHANNEL_NAME}" Output channel for details.`,
        err,
        { messageType: msg.type },
        host.showErrorMessage,
      );
    }
  }, undefined, panelDisposables);
}

import { buildWebviewCsp } from './utils/cspBuilder';

/** Generates the root HTML for the lineage webview. */
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
