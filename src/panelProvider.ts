import * as vscode from 'vscode';
import { type AiSession } from './ai/session';
import { Logger } from './utils/log';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { createBridgeHost, type BridgeHost } from './bridge/host';
import { createMessageHandlers, PROJECT_STORE_KEY } from './bridge/messageHandlers';

// ─── Panel State ─────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;

export { PROJECT_STORE_KEY };
export function getActivePanel() { return activePanel; }

/**
 * Ensures clean disconnection from background DB processes when the extension is deactivated
 * or all panels are closed.
 */
export function deactivatePanels(outputChannel: vscode.LogOutputChannel) {
  // Logic now handled via cleanup calls in messageHandlers.ts state, 
  // but we can add a global hook here if needed for extension deactivation.
}

/**
 * Main entry point for the Webview UI.
 * Orchestrates the creation, reveal, and lifecycle management of the React-based lineage graph.
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
    if (loadDemo) {
      // When Open Demo is invoked on an already-open panel, we reveal it but
      // do not reload demo data (the panel may be showing a different project).
      // To reload the demo, close the panel first, then Open Demo.
      bridgeLogger.info('Open Demo invoked on existing panel — reveal only; close the panel first to reload demo data.');
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

  panel.onDidDispose(() => {
    bridgeLogger.info('Panel disposed');
    activePanel = undefined;
    detailPanel?.dispose();
    
    const sess = getSession();
    sess.resetExploration();
    sess.model = null;
    sess.graph = null;
    sess.columnStore.clear();
    vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
  });

  const { handlers, cleanup } = createMessageHandlers(
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

  // Panel-scoped cleanup: stats connection dies with the panel
  panel.onDidDispose(() => {
    cleanup().catch(err => bridgeLogger.debug(`Cleanup failed: ${err}`));
  });

  panel.webview.onDidReceiveMessage(async (rawMsg) => {
    const handler = handlers[rawMsg.type];
    if (handler) {
      await handler(rawMsg);
    } else {
      bridgeLogger.warn(`No handler for message type: ${rawMsg.type}`);
    }
  }, undefined, context.subscriptions);
}

// ─── UI Rendering ───────────────────────────────────────────────────────────

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, loadDemo: boolean): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);
  const nonce = getNonce();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><link rel="stylesheet" type="text/css" href="${stylesUri}"><title>Data Lineage Viz</title></head><body class="vscode-body" ${loadDemo ? 'data-auto-visualize="true"' : ''}><div id="root"></div><script nonce="${nonce}">window.LOGO_URI = "${logoUri}";</script><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

// ─── Sidebar Provider ───────────────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }
  getChildren(): vscode.TreeItem[] {
    return [
      this.item('Open Wizard', 'dataLineageViz.open', 'graph'),
      this.item('Open Demo', 'dataLineageViz.openDemo', 'play'),
      this.item('Settings', 'dataLineageViz.openSettings', 'gear'),
    ];
  }
  private item(label: string, commandId: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command: commandId, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }
}

// Re-export debug dump for extension.ts
export { buildDebugDump } from './bridge/messageHandlers';
