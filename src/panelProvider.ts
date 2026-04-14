import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { type AiSession } from './ai/session';
import { logInfo, logDebug, logWarn, logError, logTrace, trunc } from './utils/log';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import {
  DEFAULT_CONFIG, type LayoutConfig, type EdgeStyle, type TraceConfig,
  type AnalysisConfig, type TableStatsConfig, type ExternalRefsConfig, type OverviewConfig,
  type DatabaseModel, type XmlElement, type LineageNode, type ColumnDef
} from './engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from './engine/dacpacExtractor';
import {
  isMssqlAvailable, promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
  executeSimpleQuery,
} from './engine/connectionManager';
import type { IConnectionInfo, SimpleExecuteResult } from './types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult, type StatsMode } from './engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview } from './engine/dmvExtractor';
import { loadRules, type ParseRulesConfig } from './engine/sqlBodyParser';
import type { DmvResults } from './engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject, generateProjectName,
  addFilterProfile, deleteFilterProfile, isValidProject,
  type Project, type FilterProfile, type SerializedFilterState, type AIViewMetadata
} from './engine/projectStore';
import { buildBareGraph } from './ai/graphUtils';
import { populateColumnStore } from './engine/modelBuilder';
import { ColumnTraceState } from './ai/columnTraceState';
import { BlackboardState } from './ai/blackboardState';

// ─── Panel State ─────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;
let statsConnectionUri: string | undefined;
let lastRulesLabel = 'built-in rules';
let _lastOverviewMode: 'full' | 'overview' | null = null;
let _lastFilteredCount = 0;
let _lastRenderLimitHit = 0;

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB
const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

export function getActivePanel() { return activePanel; }
export function deactivatePanels(outputChannel: vscode.LogOutputChannel) {
  if (statsConnectionUri) {
    disconnectDatabase(statsConnectionUri, outputChannel).catch(() => {});
    statsConnectionUri = undefined;
  }
}

function getThemeClass(kind: vscode.ColorThemeKind): string {
  return kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' :
    kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' :
    kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' :
    'vscode-light';
}

function isDacpacTooLarge(bytes: number): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  vscode.window.showErrorMessage(`Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
  return true;
}

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
  if (activePanel) {
    activePanel.reveal();
    if (loadDemo) {
      activePanel.webview.postMessage({ type: 'auto-visualize-start' });
      handleLoadDemo(activePanel, context, getSession, outputChannel, true).catch(() => {});
    }
    return;
  }

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

  let detailPanel: vscode.WebviewPanel | undefined;
  let panelDisposed = false;

  panel.onDidDispose(() => {
    panelDisposed = true;
    activePanel = undefined;
    detailPanel?.dispose();
    if (statsConnectionUri) {
      disconnectDatabase(statsConnectionUri, outputChannel).catch(() => {});
      statsConnectionUri = undefined;
    }
    const sess = getSession();
    sess.resetExploration();
    sess.model = null;
    sess.graph = null;
    sess.columnStore.clear();
    vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
  });

  let cachedElements: XmlElement[] | null = null;
  let cachedDspName = '';
  let lastConnectionInfo: IConnectionInfo | undefined;
  let allObjectsCache: SimpleExecuteResult | undefined;
  let platformInfoCache: SimpleExecuteResult | undefined;

  function setCurrentModel(m: DatabaseModel, project?: { id: string; name: string } | null): void {
    const sess = getSession();
    sess.columnStore.clear();
    populateColumnStore(m, sess.columnStore);
    sess.model = m;
    sess.graph = buildBareGraph(m);
    if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
    vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
  }

  function enrichNodeForDetail(node: LineageNode): LineageNode {
    const sess = getSession();
    const cols = sess.columnStore.getColumns(node.id);
    const ddl = sess.columnStore.getDdl(node.id);
    return { ...node, ...(cols && { columns: cols }), ...(ddl && { bodyScript: ddl }) };
  }

  const handlers: Record<string, (msg: any) => Promise<void> | void> = {
    'ready': async () => {
      if (loadDemo) {
        await handleLoadDemo(panel, context, getSession, outputChannel, true, (m) => {
          setCurrentModel(m, null);
          getSession().projectName = 'Demo';
        });
        return;
      }
      if (context.globalState.get(PROJECT_STORE_KEY) === undefined) await migrateFromWorkspaceState(context);
      const config = await readExtensionConfig(outputChannel, context.extensionUri);
      const store = loadProjectStore(context);
      const sess = getSession();
      panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
      if (sess.model && store.lastOpenedId) {
        const project = store.projects.find((p: any) => p.id === store.lastOpenedId);
        if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
        panel.webview.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true });
      }
    },
    'open-dacpac': async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'DACPAC': ['dacpac'] } });
      if (uris && uris.length > 0) {
        const data = await vscode.workspace.fs.readFile(uris[0]);
        if (isDacpacTooLarge(data.byteLength)) return;
        const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
        cachedElements = elements; cachedDspName = dspName;
        panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, sourceName: path.basename(uris[0].fsPath, '.dacpac') });
      }
    },
    'show-detail': (msg) => {
      if (!detailPanel) {
        detailPanel = vscode.window.createWebviewPanel('dataLineageDetail', msg.node.name, vscode.ViewColumn.Beside, { enableScripts: true });
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, context.extensionUri);
        detailPanel.onDidDispose(() => { detailPanel = undefined; });
      }
      detailPanel.webview.postMessage({ type: 'detail-update', node: enrichNodeForDetail(msg.node) });
    },
    'filter-changed': (msg) => {
      const sess = getSession();
      sess.filter = msg.filter;
      sess.views = msg.savedViews;
    },
    'db-connect': () => {
      return withDbProgress(panel, 'Connecting', outputChannel, () => promptForConnection(outputChannel), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1(panel, conn.connectionUri, conn.connectionInfo, outputChannel, context.extensionUri, (r) => { allObjectsCache = r; });
      });
    }
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    const handler = handlers[msg.type];
    if (handler) await handler(msg);
  }, undefined, context.subscriptions);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function handleLoadDemo(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, autoVisualize = false, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(outputChannel, context.extensionUri);
  try {
    const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
    const data = await vscode.workspace.fs.readFile(demoUri);
    const model = await extractDacpac(data.buffer as ArrayBuffer);
    onModelBuilt?.(model);
    panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    logError(outputChannel, 'Dacpac', 'Load demo', err);
  }
}

async function runDbPhase1(panel: vscode.WebviewPanel, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, onCacheAllObjects: (result: SimpleExecuteResult) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  const resultMap = await executeDmvQueries(connectionUri, [previewQuery], outputChannel);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const preview = buildSchemaPreview(result);
  const config = await readExtensionConfig(outputChannel, extensionUri);
  panel.webview.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${connectionInfo.server} / ${connectionInfo.database}` });
}

async function runDbPhase2(panel: vscode.WebviewPanel, connectionUri: string, schemas: string[], progress: vscode.Progress<any>, token: vscode.CancellationToken, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, allObjects?: SimpleExecuteResult, currentDatabase?: string, sourceName?: string, platformInfo?: SimpleExecuteResult, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  const resultMap = await executeDmvQueriesFiltered(connectionUri, queries, schemas, outputChannel, (step, total, label) => {
    panel.webview.postMessage({ type: 'db-progress', step, total, label });
  });
  const dmvResults: DmvResults = { nodes: resultMap.get('nodes')!, columns: resultMap.get('columns')!, dependencies: resultMap.get('dependencies')!, allObjects, platformInfo };
  const config = await readExtensionConfig(outputChannel, extensionUri);
  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, config.maxNodes);
  onModelBuilt?.(model);
  panel.webview.postMessage({ type: 'db-model', model, config, sourceName: sourceName ?? 'Database' });
}

async function withDbProgress(panel: vscode.WebviewPanel, title: string, outputChannel: vscode.LogOutputChannel, connectFn: () => Promise<any>, phaseFn: (res: any, progress: any, token: any) => Promise<void>) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    try {
      const res = await connectFn();
      if (res && !token.isCancellationRequested) await phaseFn(res, progress, token);
    } catch (err) {
      logError(outputChannel, 'DB', title, err);
    }
  });
}

async function readExtensionConfig(outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri): Promise<any> {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  return {
    excludePatterns: cfg.get<string[]>('excludePatterns', []),
    maxNodes: cfg.get<number>('maxNodes', 1000),
    layout: {
      direction: cfg.get<string>('layout.direction', 'TB'),
      rankSeparation: cfg.get<number>('layout.rankSeparation', 50),
      nodeSeparation: cfg.get<number>('layout.nodeSeparation', 50),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', true),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled', true),
      edgeStyle: cfg.get<string>('layout.edgeStyle', 'step'),
    },
    externalRefs: { enabled: cfg.get<boolean>('externalRefs.enabled', true) },
    overview: { enabled: cfg.get<boolean>('overview.enabled', true), threshold: cfg.get<number>('overview.threshold', 50) },
    renderLimit: cfg.get<number>('renderLimit', 1000),
  };
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, loadDemo: boolean): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);
  const nonce = getNonce();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><link rel="stylesheet" type="text/css" href="${stylesUri}"><title>Data Lineage Viz</title></head><body class="vscode-body" ${loadDemo ? 'data-auto-visualize="true"' : ''}><div id="root"></div><script nonce="${nonce}">window.LOGO_URI = "${logoUri}";</script><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function getDetailWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const nonce = getNonce();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><link rel="stylesheet" type="text/css" href="${stylesUri}"><title>Detail</title></head><body class="vscode-body"><div id="root"></div><script nonce="${nonce}">window.__DETAIL_MODE__ = true;</script><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

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
