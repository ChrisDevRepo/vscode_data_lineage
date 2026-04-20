import * as vscode from 'vscode';
import { type AiSession } from './ai/session';
import { Logger } from './utils/log';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { createBridgeHost, type BridgeHost } from './bridge/host';
import { createMessageHandlers, PROJECT_STORE_KEY } from './bridge/messageHandlers';

let activePanel: vscode.WebviewPanel | undefined;

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
    if (loadDemo) {
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
    
    // Clean up the global AI session and reset extension context flags.
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

  // Ensure that database connections and stats caches are released when the panel is closed.
  panel.onDidDispose(() => {
    cleanup().catch(err => bridgeLogger.warn(`Cleanup failed — next session may reuse stale state: ${err}`));
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

/** 
 * Generates the root HTML for the lineage webview.
 */
function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, loadDemo: boolean): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);
  const nonce = getNonce();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><link rel="stylesheet" type="text/css" href="${stylesUri}"><title>Data Lineage Viz</title></head><body class="vscode-body" ${loadDemo ? 'data-auto-visualize="true"' : ''}><div id="root"></div><script nonce="${nonce}">window.LOGO_URI = "${logoUri}";</script><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

/**
 * Provides the "Quick Actions" tree view in the VS Code Sidebar.
 * 
 * This provider registers static entry points for common extension tasks 
 * (Open Wizard, Open Demo, Settings) to improve discoverability.
 */
export class SidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  /** 
   * Returns a tree item representation for a specific element.
   */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /** 
   * Retrieves the top-level items for the sidebar.
   */
  getChildren(): vscode.TreeItem[] {
    return [
      this.item('Open Wizard', 'dataLineageViz.open', 'graph'),
      this.item('Open Demo', 'dataLineageViz.openDemo', 'play'),
      this.item('Settings', 'dataLineageViz.openSettings', 'gear'),
    ];
  }

  /** 
   * Helper to construct a standard `vscode.TreeItem` with a command and icon.
   */
  private item(label: string, commandId: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command: commandId, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }
}

export { buildDebugDump } from './bridge/messageHandlers';
