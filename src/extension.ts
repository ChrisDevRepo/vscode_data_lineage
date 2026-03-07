import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import { DEFAULT_CONFIG, type LayoutConfig, type EdgeStyle, type TraceConfig, type AnalysisConfig, type TableStatsConfig, type ObjectType } from './engine/types';
import {
  isMssqlAvailable, promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
  getServerInfo, executeSimpleQuery,
} from './engine/connectionManager';
import type { IConnectionInfo, SimpleExecuteResult } from './types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult } from './engine/profilingEngine';
import type { StatsMode } from './engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult } from './engine/dmvExtractor';
import type { DmvResults } from './engine/dmvExtractor';

// ─── Logging ────────────────────────────────────────────────────────────────

let outputChannel: vscode.LogOutputChannel;
let extensionUri: vscode.Uri;
let lastRulesLabel = 'built-in rules';

function getThemeClass(kind: vscode.ColorThemeKind): string {
  return kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' :
    kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' :
    kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' :
    'vscode-light';
}

// ─── DDL Virtual Document Provider ──────────────────────────────────────────

const DDL_SCHEME = 'dacpac-ddl';
const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

function isDacpacTooLarge(bytes: number): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  vscode.window.showErrorMessage(`Dacpac too large (${mb} MB). Maximum supported size is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
  return true;
}
let panelCounter = 0;
let activePanel: vscode.WebviewPanel | undefined;
const ddlContentMap = new Map<string, string>();

const ddlProvider = new class implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this._onDidChange.event;
  provideTextDocumentContent(uri: vscode.Uri): string {
    return ddlContentMap.get(uri.toString()) || '';
  }
  fire(uri: vscode.Uri) { this._onDidChange.fire(uri); }
};

type DdlMessage = { objectName: string; schema: string; objectType?: ObjectType; sqlBody?: string; bodyHtml?: string; columns?: import('./engine/types').ColumnDef[] };

function isTableType(objectType?: ObjectType): boolean {
  return objectType === 'table' || objectType === 'external';
}

// ─── DDL Table Webview ──────────────────────────────────────────────────────

let ddlWebviewPanel: vscode.WebviewPanel | undefined;
let ddlWebviewContext: vscode.ExtensionContext | undefined;
let ddlWebviewColumns: import('./engine/types').ColumnDef[] | undefined;
let tableDesignTemplate: string | undefined;

async function getDdlWebviewHtml(
  contentHtml: string, isDbMode: boolean, statsEnabled: boolean, schema: string, objectName: string,
): Promise<string> {
  if (!tableDesignTemplate) {
    const tplUri = vscode.Uri.joinPath(extensionUri, 'assets', 'tableDesign.html');
    tableDesignTemplate = new TextDecoder().decode(await vscode.workspace.fs.readFile(tplUri));
  }
  return tableDesignTemplate
    .replace('{{content}}', contentHtml)
    .replace('{{schema}}', JSON.stringify(schema))
    .replace('{{objectName}}', JSON.stringify(objectName))
    .replace('{{statsDisplay}}', isDbMode && statsEnabled ? '' : 'style="display:none"');
}

// ─── DDL Text Editor (SPs, Views, Functions) ───────────────────────────────

async function showDdlTextEditor(ddlUri: vscode.Uri, message: DdlMessage) {
  // Close table webview when switching to text editor
  if (ddlWebviewPanel) { ddlWebviewPanel.dispose(); }

  const key = ddlUri.toString();
  const content = message.sqlBody || `-- No DDL available for [${message.schema}].[${message.objectName}]`;
  ddlContentMap.set(key, content);
  ddlProvider.fire(ddlUri);

  try {
    const doc = await vscode.workspace.openTextDocument(ddlUri);
    if (doc.languageId !== 'dacpac-sql') {
      await vscode.languages.setTextDocumentLanguage(doc, 'dacpac-sql');
    }
    ddlContentMap.set(key, content);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: true,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    outputChannel.error(`Failed to show DDL: ${errorMsg}`);
    vscode.window.showErrorMessage(`Failed to open SQL Viewer: ${errorMsg}`);
  }
}

function updateDdlTextEditor(ddlUri: vscode.Uri, message: DdlMessage) {
  const key = ddlUri.toString();
  if (!ddlContentMap.has(key)) return;
  ddlContentMap.set(key, message.sqlBody || `-- No DDL available for [${message.schema}].[${message.objectName}]`);
  ddlProvider.fire(ddlUri);
}

// ─── DDL Table Webview (Tables, External Tables) ───────────────────────────

async function showOrUpdateTableWebview(context: vscode.ExtensionContext, message: DdlMessage, createIfMissing: boolean): Promise<void> {
  if (!createIfMissing && !ddlWebviewPanel) return;

  // Close text editor tabs when opening table webview (symmetric with showDdlTextEditor closing webview)
  if (createIfMissing) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === DDL_SCHEME) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  const isDbMode = sourceType === 'database';
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const statsEnabled = cfg.get<boolean>('tableStatistics.enabled', true);
  ddlWebviewColumns = message.columns;

  const html = await getDdlWebviewHtml(message.bodyHtml!, isDbMode, statsEnabled, message.schema, message.objectName);
  const title = `Table: [${message.schema}].[${message.objectName}]`;

  if (ddlWebviewPanel) {
    ddlWebviewPanel.webview.html = html;
    if (createIfMissing) ddlWebviewPanel.reveal(undefined, true);
  } else {
    ddlWebviewPanel = vscode.window.createWebviewPanel(
      'dataLineageDdlViewer',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false },
    );
    ddlWebviewPanel.webview.html = html;
    ddlWebviewContext = context;

    ddlWebviewPanel.webview.onDidReceiveMessage(
      async (msg: { type: string; schema?: string; objectName?: string; mode?: string }) => {
        if (msg.type === 'table-stats-request') {
          await handleTableStatsRequest(context, msg.schema!, msg.objectName!, msg.mode as 'quick' | 'detail');
        }
      },
      undefined,
      context.subscriptions
    );

    ddlWebviewPanel.onDidDispose(() => {
      ddlWebviewPanel = undefined;
      ddlWebviewContext = undefined;
      ddlWebviewColumns = undefined;
    }, undefined, context.subscriptions);
  }
  ddlWebviewPanel.title = title;
}

// ─── DDL Router ─────────────────────────────────────────────────────────────

async function showDdl(context: vscode.ExtensionContext, ddlUri: vscode.Uri, message: DdlMessage) {
  if (isTableType(message.objectType) && message.bodyHtml) {
    await showOrUpdateTableWebview(context, message, true);
  } else {
    await showDdlTextEditor(ddlUri, message);
  }
}

async function updateDdlIfOpen(ddlUri: vscode.Uri, message: DdlMessage) {
  if (isTableType(message.objectType) && message.bodyHtml) {
    if (ddlWebviewContext) await showOrUpdateTableWebview(ddlWebviewContext, message, false);
  } else {
    updateDdlTextEditor(ddlUri, message);
  }
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DDL_SCHEME, ddlProvider)
  );

  // Clean up DDL content when virtual document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === DDL_SCHEME) {
        ddlContentMap.delete(doc.uri.toString());
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!activePanel) return;

      if (e.affectsConfiguration('dataLineageViz.parseRulesFile') || e.affectsConfiguration('dataLineageViz.excludePatterns')) {
        const label = e.affectsConfiguration('dataLineageViz.parseRulesFile') ? 'Parse rules' : 'Exclude patterns';
        const action = await vscode.window.showInformationMessage(
          `${label} changed. Reload your data source to apply.`,
          'Reload'
        );
        if (action === 'Reload') {
          vscode.commands.executeCommand('dataLineageViz.open');
        }
        return;
      }

      // All other settings: auto-push to webview → triggers rebuild
      if (e.affectsConfiguration('dataLineageViz')) {
        const config = await readExtensionConfig();
        activePanel.webview.postMessage({ type: 'config-only', config });
        outputChannel.debug('[Config] Settings changed — pushed to webview');
      }
    })
  );
  outputChannel.info('Activated');

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.open', () => openPanel(context, 'Data Lineage Viz')),
    vscode.commands.registerCommand('dataLineageViz.openDemo', () => openPanel(context, 'Data Lineage Viz', true)),
    vscode.commands.registerCommand('dataLineageViz.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz')
    ),
  );

  // Commands: Create YAML scaffold files (parse rules + DMV queries)
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.createParseRules', () =>
      createYamlScaffold(context, 'parseRules.yaml', 'defaultParseRules.yaml', 'parseRulesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', () =>
      createYamlScaffold(context, 'dmvQueries.yaml', 'dmvQueries.yaml', 'dmvQueriesFile')
    ),
  );
}

async function createYamlScaffold(
  context: vscode.ExtensionContext, fileName: string, sourceAsset: string, settingName: string
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return;
  }

  const targetUri = vscode.Uri.joinPath(folder.uri, fileName);

  try {
    await vscode.workspace.fs.stat(targetUri);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc);
    return;
  } catch (err) {
    if (!(err instanceof vscode.FileSystemError) || err.code !== 'FileNotFound') throw err;
  }

  const sourceUri = vscode.Uri.joinPath(context.extensionUri, 'assets', sourceAsset);
  const sourceData = await vscode.workspace.fs.readFile(sourceUri);
  await vscode.workspace.fs.writeFile(targetUri, sourceData);

  const doc = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    `Created ${fileName} in workspace root. Set "dataLineageViz.${settingName}" to "${fileName}" to use it.`
  );
}

function getLastSource(context: vscode.ExtensionContext): { type: 'dacpac' | 'database'; name: string } | undefined {
  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  if (sourceType === 'database') {
    const name = context.workspaceState.get<string>('lastDbSourceName');
    return name ? { type: 'database', name } : undefined;
  }
  if (sourceType === 'dacpac') {
    const name = context.workspaceState.get<string>('lastDacpacName');
    return name ? { type: 'dacpac', name } : undefined;
  }
  return undefined;
}

// ─── Open Panel ─────────────────────────────────────────────────────────────

function openPanel(context: vscode.ExtensionContext, title: string, loadDemo = false) {
  try {
    const panelId = ++panelCounter;
    const ddlUri = vscode.Uri.parse(`${DDL_SCHEME}:panel-${panelId}/DDL`);

    const panel = vscode.window.createWebviewPanel(
      'dataLineageViz',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'images'),
        ],
      }
    );

    activePanel = panel;
    panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, loadDemo);

    let panelDisposed = false;
    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme((theme) => {
      if (panelDisposed) return;
      panel.webview.postMessage({ type: 'themeChanged', kind: getThemeClass(theme.kind) });
    });

    panel.onDidDispose(() => {
      panelDisposed = true;
      activePanel = undefined;
      themeChangeListener.dispose();
      ddlContentMap.delete(ddlUri.toString());
    });

    // ─── Message Handler Map ──────────────────────────────────────────────
    type MessageHandlerMap = {
      [K in WebviewMessage['type']]?: (msg: Extract<WebviewMessage, { type: K }>) => Promise<void> | void;
    };
    // Cache the Phase 1 all-objects result for use in Phase 2 (cross-schema resolution).
    // Scoped to this panel so multiple panels don’t share state.
    let allObjectsCache: SimpleExecuteResult | undefined;
    const handlers: MessageHandlerMap = {
      'ready': async () => {
        if (loadDemo) {
          await handleLoadDemo(panel, context, true);
        } else {
          const config = await readExtensionConfig();
          const lastSource = getLastSource(context);
          panel.webview.postMessage({ type: 'config-only', config, lastSource });
        }
      },
      'open-dacpac': async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'DACPAC': ['dacpac'] },
          title: 'Select a .dacpac file',
        });
        if (uris && uris.length > 0) {
          const fileUri = uris[0];
          const fileName = path.basename(fileUri.fsPath);
          try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            if (isDacpacTooLarge(data.byteLength)) return;
            await context.workspaceState.update('lastDacpacPath', fileUri.fsPath);
            await context.workspaceState.update('lastDacpacName', fileName);
            await context.workspaceState.update('lastSourceType', 'dacpac');
            const config = await readExtensionConfig();
            const lastDeselectedSchemas = context.workspaceState.get<string[]>('lastDeselectedSchemas');
            panel.webview.postMessage({ type: 'dacpac-data', data: Array.from(data), fileName, config, lastDeselectedSchemas });
            outputChannel.info(`── Opening ${fileName} ──`);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            outputChannel.error(`Failed to read file: ${errorMsg}`);
            vscode.window.showErrorMessage(`Failed to read file: ${errorMsg}`);
          }
        }
      },
      'save-schemas': async (msg) => {
        await context.workspaceState.update('lastDeselectedSchemas', msg.deselected);
      },
      'load-last-dacpac': async () => {
        const lastPath = context.workspaceState.get<string>('lastDacpacPath');
        if (!lastPath) return;
        try {
          const fileUri = vscode.Uri.file(lastPath);
          const data = await vscode.workspace.fs.readFile(fileUri);
          if (isDacpacTooLarge(data.byteLength)) return;
          const config = await readExtensionConfig();
          const lastDeselectedSchemas = context.workspaceState.get<string[]>('lastDeselectedSchemas');
          panel.webview.postMessage({
            type: 'dacpac-data',
            data: Array.from(data),
            fileName: context.workspaceState.get<string>('lastDacpacName') || path.basename(lastPath),
            config,
            lastDeselectedSchemas,
          });
          outputChannel.info(`── Reopening ${path.basename(lastPath)} ──`);
        } catch {
          await context.workspaceState.update('lastDacpacPath', undefined);
          await context.workspaceState.update('lastDacpacName', undefined);
          await context.workspaceState.update('lastSourceType', undefined);
          await context.workspaceState.update('lastDeselectedSchemas', undefined);
          panel.webview.postMessage({ type: 'last-dacpac-gone' });
          outputChannel.warn(`Last dacpac no longer available: ${lastPath}`);
        }
      },
      'load-demo': async () => { await handleLoadDemo(panel, context); },
      'parse-rules-result': (msg) => { handleParseRulesResult(msg); },
      'parse-stats': (msg) => { handleParseStats(msg.stats, msg.objectCount, msg.edgeCount, msg.schemaCount); },
      'log': (msg) => { outputChannel.info(msg.text); },
      'error': (msg) => {
        outputChannel.error(msg.error);
        if (msg.stack) outputChannel.debug(msg.stack);
        vscode.window.showErrorMessage(`Data Lineage Error: ${msg.error}`);
      },
      'open-external': async (msg) => {
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      },
      'open-settings': () => { vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz'); },
      'show-ddl': async (msg) => { await showDdl(context, ddlUri, msg as DdlMessage); },
      'update-ddl': async (msg) => { await updateDdlIfOpen(ddlUri, msg as DdlMessage); },
      'check-mssql': () => {
        panel.webview.postMessage({ type: 'mssql-status', available: isMssqlAvailable() });
      },
      'db-connect': () => withDbProgress(
        panel, 'Data Lineage: Connecting to database',
        () => promptForConnection(outputChannel),
        (conn, progress, token) => runDbPhase1(panel, context, conn.connectionUri, conn.connectionInfo, progress, token,
          (result) => { allObjectsCache = result; }),
      ),
      'db-reconnect': () => withDbProgress(
        panel, 'Data Lineage: Reconnecting to database',
        async () => {
          const storedInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
          if (storedInfo) {
            const result = await connectDirect(storedInfo, outputChannel);
            if (result) return result;
            outputChannel.info('[DB] Falling back to connection picker');
          }
          return promptForConnection(outputChannel);
        },
        (conn, progress, token) => runDbPhase1(panel, context, conn.connectionUri, conn.connectionInfo, progress, token,
          (result) => { allObjectsCache = result; }),
      ),
      'db-visualize': (msg) => withDbProgress(
        panel, 'Data Lineage: Loading selected schemas',
        async () => {
          const storedInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
          if (!storedInfo) {
            panel.webview.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
            return undefined;
          }
          const result = await connectDirect(storedInfo, outputChannel);
          if (result) return result;
          outputChannel.info('[DB] Direct reconnect failed for Phase 2 — falling back to picker');
          return promptForConnection(outputChannel);
        },
        (conn, progress, token) => runDbPhase2(panel, context, conn.connectionUri, msg.schemas, progress, token, allObjectsCache),
      ),
      'reload': () => {
        panel.dispose();
        openPanel(context, title, loadDemo);
      },
    };

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        try {
          const handler = handlers[message.type] as ((msg: WebviewMessage) => Promise<void> | void) | undefined;
          if (handler) {
            await handler(message);
          } else {
            outputChannel.debug(`Unknown webview message type: ${(message as { type: string }).type}`);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          outputChannel.error(`Message handler failed for "${message.type}": ${errorMsg}`);
          vscode.window.showErrorMessage(`Data Lineage Error: ${errorMsg}`);
        }
      },
      undefined,
      context.subscriptions
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    outputChannel.error(errorMsg);
    vscode.window.showErrorMessage(`Failed to open Data Lineage: ${errorMsg}`);
  }
}

// ─── Webview Message Types ──────────────────────────────────────────────────

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open-dacpac' }
  | { type: 'save-schemas'; deselected: string[] }
  | { type: 'load-last-dacpac' }
  | { type: 'load-demo' }
  | { type: 'parse-rules-result'; loaded: number; skipped: string[]; errors: string[]; usedDefaults: boolean; categoryCounts?: Record<string, number> }
  | { type: 'parse-stats'; stats: { parsedRefs: number; resolvedEdges: number; droppedRefs: string[]; spDetails?: { name: string; inCount: number; outCount: number; inRefs?: string[]; outRefs?: string[]; unrelated: string[]; skippedRefs?: string[] }[] }; objectCount?: number; edgeCount?: number; schemaCount?: number }
  | { type: 'log'; text: string }
  | { type: 'error'; error: string; stack?: string }
  | { type: 'open-external'; url?: string }
  | { type: 'open-settings' }
  | { type: 'show-ddl'; objectName: string; schema: string; objectType?: import('./engine/types').ObjectType; sqlBody?: string; bodyHtml?: string; columns?: import('./engine/types').ColumnDef[] }
  | { type: 'update-ddl'; objectName: string; schema: string; objectType?: import('./engine/types').ObjectType; sqlBody?: string; bodyHtml?: string; columns?: import('./engine/types').ColumnDef[] }
  | { type: 'check-mssql' }
  | { type: 'db-connect' }
  | { type: 'db-reconnect' }
  | { type: 'reload' }
  | { type: 'db-visualize'; schemas: string[] };

// ─── DB Progress Helper ─────────────────────────────────────────────────────

interface DbConnectionResult { connectionUri: string; connectionInfo: IConnectionInfo }

async function withDbProgress(
  panel: vscode.WebviewPanel,
  title: string,
  connectFn: () => Promise<DbConnectionResult | undefined>,
  phaseFn: (result: DbConnectionResult, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      let connectionUri: string | undefined;
      try {
        const result = await connectFn();
        if (!result || token.isCancellationRequested) {
          panel.webview.postMessage({ type: 'db-cancelled' });
          return;
        }
        connectionUri = result.connectionUri;
        await phaseFn(result, progress, token);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const phase = title.includes('Loading') ? 'build' : 'connect';
        outputChannel.error(`[DB] ${phase} failed: ${errorMsg}`);
        panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase });
      } finally {
        if (connectionUri) {
          await disconnectDatabase(connectionUri, outputChannel).catch(err => {
            outputChannel.warn(`[DB] Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    },
  );
}

// ─── Read Extension Config ──────────────────────────────────────────────────

interface ExtensionConfigMessage {
  parseRules?: unknown;
  excludePatterns: string[];
  maxNodes: number;
  layout: LayoutConfig;
  edgeStyle: EdgeStyle;
  trace: TraceConfig;
  analysis: AnalysisConfig;
  tableStatistics: TableStatsConfig;
}

function clamp(val: number, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || isNaN(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

async function loadBuiltInParseRules(): Promise<Record<string, unknown>> {
  const yamlUri = vscode.Uri.joinPath(extensionUri, 'assets', 'defaultParseRules.yaml');
  const data = await vscode.workspace.fs.readFile(yamlUri);
  const content = new TextDecoder().decode(data);
  const parsed = yaml.load(content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    throw new Error('Built-in defaultParseRules.yaml is invalid — missing "rules" array');
  }
  return parsed;
}

async function readExtensionConfig(): Promise<ExtensionConfigMessage> {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');

  const maxNodes = clamp(cfg.get<number>('maxNodes', DEFAULT_CONFIG.maxNodes), 10, 1000, DEFAULT_CONFIG.maxNodes);

  const config: ExtensionConfigMessage = {
    excludePatterns: cfg.get<string[]>('excludePatterns', []).filter(p => {
      try { new RegExp(p); return true; } catch {
        outputChannel.warn(`[Config] Invalid excludePattern "${p}" — not a valid regex. Pattern removed.`);
        return false;
      }
    }),
    maxNodes,
    layout: {
      direction: cfg.get<'TB' | 'LR'>('layout.direction', DEFAULT_CONFIG.layout.direction)!,
      rankSeparation: clamp(cfg.get<number>('layout.rankSeparation', DEFAULT_CONFIG.layout.rankSeparation), 20, 300, DEFAULT_CONFIG.layout.rankSeparation),
      nodeSeparation: clamp(cfg.get<number>('layout.nodeSeparation', DEFAULT_CONFIG.layout.nodeSeparation), 10, 200, DEFAULT_CONFIG.layout.nodeSeparation),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', DEFAULT_CONFIG.layout.edgeAnimation),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation', DEFAULT_CONFIG.layout.highlightAnimation),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled', DEFAULT_CONFIG.layout.minimapEnabled),
    },
    edgeStyle: cfg.get<EdgeStyle>('edgeStyle', DEFAULT_CONFIG.edgeStyle)!,
    trace: {
      defaultUpstreamLevels: clamp(cfg.get<number>('trace.defaultUpstreamLevels', DEFAULT_CONFIG.trace.defaultUpstreamLevels), 0, 99, DEFAULT_CONFIG.trace.defaultUpstreamLevels),
      defaultDownstreamLevels: clamp(cfg.get<number>('trace.defaultDownstreamLevels', DEFAULT_CONFIG.trace.defaultDownstreamLevels), 0, 99, DEFAULT_CONFIG.trace.defaultDownstreamLevels),
      hideCoWriters: cfg.get<boolean>('trace.hideCoWriters', DEFAULT_CONFIG.trace.hideCoWriters),
    },
    analysis: {
      hubMinDegree: clamp(cfg.get<number>('analysis.hubMinDegree', DEFAULT_CONFIG.analysis.hubMinDegree), 1, 50, DEFAULT_CONFIG.analysis.hubMinDegree),
      islandMaxSize: clamp(cfg.get<number>('analysis.islandMaxSize', DEFAULT_CONFIG.analysis.islandMaxSize), 2, maxNodes, DEFAULT_CONFIG.analysis.islandMaxSize),
      longestPathMinNodes: clamp(cfg.get<number>('analysis.longestPathMinNodes', DEFAULT_CONFIG.analysis.longestPathMinNodes), 2, 50, DEFAULT_CONFIG.analysis.longestPathMinNodes),
    },
    tableStatistics: {
      enabled: cfg.get<boolean>('tableStatistics.enabled', DEFAULT_CONFIG.tableStatistics.enabled),
      sampleThreshold: clamp(cfg.get<number>('tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold), 0, 999999999, DEFAULT_CONFIG.tableStatistics.sampleThreshold),
      sampleSize: clamp(cfg.get<number>('tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize), 100, 1000000, DEFAULT_CONFIG.tableStatistics.sampleSize),
      useApproxDistinct: cfg.get<boolean>('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct),
      queryTimeout: clamp(cfg.get<number>('tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout), 10, 600, DEFAULT_CONFIG.tableStatistics.queryTimeout),
    },
  };

  // Load YAML parse rules — custom file if configured, otherwise built-in defaults.
  // Single source of truth: assets/defaultParseRules.yaml (same pattern as DMV queries).
  const rulesPath = cfg.get<string>('parseRulesFile', '');
  if (!rulesPath) {
    try {
      config.parseRules = await loadBuiltInParseRules();
      lastRulesLabel = 'built-in rules';
      outputChannel.info(`[ParseRules] Using built-in defaults (${(config.parseRules as Record<string, unknown[]>).rules.length} rules)`);
    } catch (err) {
      outputChannel.error(`[ParseRules] Failed to load built-in rules: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const resolved = resolveWorkspacePath(rulesPath);
    if (!resolved) {
      outputChannel.warn(`[ParseRules] Cannot resolve "${rulesPath}" — no workspace folder open`);
      vscode.window.showWarningMessage(
        `Parse rules: cannot resolve "${rulesPath}" — open a workspace folder or use an absolute path.`
      );
      config.parseRules = await loadBuiltInParseRules().catch(() => undefined);
    } else {
      try {
        const fileUri = vscode.Uri.file(resolved);
        const data = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder().decode(data);
        const parsed = yaml.load(content) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
          outputChannel.warn(`[ParseRules] Invalid YAML in ${rulesPath} — missing "rules" array`);
          vscode.window.showWarningMessage(
            `Parse rules YAML invalid: missing "rules" array. Using built-in defaults.`
          );
          config.parseRules = await loadBuiltInParseRules().catch(() => undefined);
        } else {
          config.parseRules = parsed;
          lastRulesLabel = `${parsed.rules.length} rules from ${path.basename(rulesPath)}`;
          outputChannel.debug(`[ParseRules] Read ${parsed.rules.length} rules from ${rulesPath}`);
          await persistAbsolutePath('parseRulesFile', rulesPath, resolved);
        }
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
          outputChannel.warn(`[ParseRules] File not found: ${rulesPath} — using built-in defaults`);
          vscode.window.showWarningMessage(
            `Parse rules file not found: ${rulesPath}. Using built-in defaults.`
          );
        } else {
          vscode.window.showWarningMessage(
            `Failed to load parse rules: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        config.parseRules = await loadBuiltInParseRules().catch(() => undefined);
      }
    }
  }

  return config;
}

// ─── Table Statistics ────────────────────────────────────────────────────────

async function handleTableStatsRequest(
  context: vscode.ExtensionContext,
  schema: string,
  objectName: string,
  mode: StatsMode,
): Promise<void> {
  if (!ddlWebviewPanel) return;
  const panel = ddlWebviewPanel;

  const cols = ddlWebviewColumns;
  if (!cols || cols.length === 0) {
    panel.webview.postMessage({ type: 'table-stats-error', message: 'No column metadata available for profiling.' });
    return;
  }

  const storedInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
  if (!storedInfo) {
    panel.webview.postMessage({ type: 'table-stats-error', message: 'No stored connection. Please reconnect via the graph panel.' });
    return;
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const sampleThreshold = cfg.get<number>('tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold);
  const sampleSize = cfg.get<number>('tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize);
  const useApprox = cfg.get<boolean>('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct);
  const queryTimeout = cfg.get<number>('tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout) * 1000;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Profiling [${schema}].[${objectName}]...`, cancellable: true },
    async (progress, token) => {
      let connectionUri: string | undefined;
      try {
        // Connect
        progress.report({ message: 'Connecting...' });
        const result = await connectDirect(storedInfo, outputChannel);
        if (!result) {
          panel.webview.postMessage({ type: 'table-stats-error', message: 'Failed to reconnect. Please reconnect via the graph panel.' });
          return;
        }
        connectionUri = result.connectionUri;

        if (token.isCancellationRequested) return;

        // Get server info for platform detection
        const serverInfo = await getServerInfo(connectionUri, outputChannel);
        const engineEdition = serverInfo.engineEditionId;
        outputChannel.info(`[Stats] Platform: engineEditionId=${engineEdition}, server=${serverInfo.serverVersion}`);

        // Row count from DMV
        progress.report({ message: 'Getting row count...' });
        const rowCountSql = buildRowCountQuery(schema, objectName);
        outputChannel.info(`[Stats] Row count query:\n${rowCountSql}`);
        const rowCountResult = await withTimeout(executeSimpleQuery(connectionUri, rowCountSql, outputChannel), queryTimeout);
        const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;
        outputChannel.info(`[Stats] Row count: ${rowCount.toLocaleString()}`);

        if (token.isCancellationRequested) return;

        // Build profiling query
        progress.report({ message: `Running ${mode} profiling...` });
        const aggregations = buildColumnAggregations(cols, useApprox, mode);
        const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);

        if (!profilingSql) {
          panel.webview.postMessage({ type: 'table-stats-error', message: 'No profilable columns found.' });
          return;
        }

        outputChannel.info(`[Stats] Profiling query (${mode}):\n${profilingSql}`);
        const start = Date.now();

        let profilingResult: SimpleExecuteResult;
        try {
          profilingResult = await withTimeout(executeSimpleQuery(connectionUri, profilingSql, outputChannel), queryTimeout);
        } catch (err) {
          // Retry without sampling on TABLESAMPLE failure (e.g., Fabric DWH)
          if (String(err).includes('TABLESAMPLE') && engineEdition !== 11) {
            outputChannel.warn(`[Stats] TABLESAMPLE failed, retrying without sampling...`);
            const fallbackSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, 0, sampleThreshold, sampleSize);
            profilingResult = await withTimeout(executeSimpleQuery(connectionUri, fallbackSql, outputChannel), queryTimeout);
          } else {
            throw err;
          }
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        outputChannel.info(`[Stats] Profiling completed in ${elapsed}s (${profilingResult.rowCount} rows returned)`);

        if (profilingResult.rowCount === 0 || profilingResult.rows.length === 0) {
          panel.webview.postMessage({ type: 'table-stats-error', message: 'Profiling query returned no results. Table may be empty.' });
          return;
        }

        // Parse result: map column aliases to values
        const resultRow: Record<string, string> = {};
        for (let i = 0; i < profilingResult.columnInfo.length; i++) {
          const colName = profilingResult.columnInfo[i].columnName;
          const value = profilingResult.rows[0][i].displayValue;
          resultRow[colName] = value;
        }

        const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
        const samplePercent = needsSampling
          ? (engineEdition === 11 ? Math.round((sampleSize / rowCount) * 100) : Math.min(100, Math.ceil((sampleSize / rowCount) * 100)))
          : undefined;

        const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
        panel.webview.postMessage({ type: 'table-stats-result', stats, mode });

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        outputChannel.error(`[Stats] Failed: ${errorMsg}`);
        panel.webview.postMessage({ type: 'table-stats-error', message: errorMsg });
        vscode.window.showErrorMessage(`Table Statistics Error: ${errorMsg}`);
      } finally {
        if (connectionUri) {
          await disconnectDatabase(connectionUri, outputChannel).catch(err => {
            outputChannel.warn(`[Stats] Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    }
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Query timed out after ${ms / 1000}s. Increase dataLineageViz.tableStatistics.queryTimeout if needed.`)), ms)),
  ]);
}

// ─── Two-Phase DB Extraction ─────────────────────────────────────────────────

/**
 * Phase 1: Connect, run schema-preview + all-objects queries.
 * Sends SchemaPreview to webview for schema selection.
 * Caches the all-objects result via onCacheAllObjects for Phase 2 cross-schema resolution.
 * Disconnects after sending.
 */
async function runDbPhase1(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  connectionUri: string,
  connectionInfo: IConnectionInfo,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  onCacheAllObjects: (result: SimpleExecuteResult) => void,
): Promise<void> {
  const sourceName = `${connectionInfo.server} / ${connectionInfo.database}`;

  progress.report({ message: 'Loading queries...' });
  const queries = await loadDmvQueries(outputChannel, context.extensionUri);

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  // Find schema-preview query; fall back to full extraction if missing
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) {
    outputChannel.warn('[DB] No schema-preview query found — falling back to full extraction');
    await runDbFullExtraction(panel, context, connectionUri, connectionInfo, queries, progress, token);
    return;
  }

  progress.report({ message: 'Querying schema overview...' });
  // Run schema-preview (always) and all-objects (if available) in parallel
  const allObjectsQuery = queries.find(q => q.name === 'all-objects');

  panel.webview.postMessage({ type: 'db-progress', step: 1, total: allObjectsQuery ? 2 : 1, label: 'schema-preview' });
  const phase1Queries = allObjectsQuery ? [previewQuery, allObjectsQuery] : [previewQuery];

  const previewResult = await executeDmvQueries(connectionUri, phase1Queries, outputChannel);

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  const result = previewResult.get('schema-preview');
  if (result) {
    const missing = validateQueryResult('schema-preview', result);
    if (missing.length > 0) {
      throw new Error(`Schema preview query is missing required columns: ${missing.join(', ')}.`);
    }
  }

  // Cache the all-objects result for Phase 2 cross-schema resolution
  if (allObjectsQuery) {
    const allObjectsResult = previewResult.get('all-objects');
    if (allObjectsResult) {
      onCacheAllObjects(allObjectsResult);
      outputChannel.info(`[DB] Full catalog: ${allObjectsResult.rowCount} objects loaded for cross-schema resolution`);
    } else {
      outputChannel.warn('[DB] all-objects query returned no result — cross-schema resolution disabled');
    }
  } else {
    outputChannel.warn('[DB] No all-objects query found in YAML — cross-schema resolution disabled');
  }

  if (!result) {
    throw new Error('Schema preview query returned no result.');
  }
  const preview = buildSchemaPreview(result);
  const etPreviewTotal = preview.schemas.reduce((sum, s) => sum + (s.types.external ?? 0), 0);
  outputChannel.info(`[DB] Schema preview: ${preview.schemas.length} schemas, ${preview.totalObjects} total objects${etPreviewTotal > 0 ? ` (${etPreviewTotal} external ⬡)` : ''}`);
  if (etPreviewTotal > 0) {
    for (const s of preview.schemas.filter(s => s.types.external > 0)) {
      outputChannel.debug(`[DB] Schema '${s.name}': ${s.types.external} external table(s) detected`);
    }
  }

  await context.workspaceState.update('lastDbSourceName', sourceName);
  await context.workspaceState.update('lastDbConnectionInfo', stripSensitiveFields(connectionInfo));
  await context.workspaceState.update('lastSourceType', 'database');

  const config = await readExtensionConfig();
  const lastDeselectedSchemas = context.workspaceState.get<string[]>('lastDeselectedSchemas');
  panel.webview.postMessage({
    type: 'db-schema-preview',
    preview,
    config,
    sourceName,
    lastDeselectedSchemas,
  });
}

/**
 * Phase 2: Reconnect, run filtered DMV queries for selected schemas,
 * build full model (with cross-schema catalog from Phase 1 allObjects), send to webview.
 */
async function runDbPhase2(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  connectionUri: string,
  schemas: string[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  allObjects?: SimpleExecuteResult,
): Promise<void> {
  progress.report({ message: 'Loading queries...' });
  const queries = await loadDmvQueries(outputChannel, context.extensionUri);

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  const resultMap = await executeDmvQueriesFiltered(
    connectionUri,
    queries,
    schemas,
    outputChannel,
    (step, total, label) => {
      progress.report({ message: `Query ${step}/${total}: ${label}`, increment: Math.round(100 / total) });
      panel.webview.postMessage({ type: 'db-progress', step, total, label });
    },
  );

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  for (const [name, queryResult] of resultMap) {
    const missing = validateQueryResult(name, queryResult);
    if (missing.length > 0) {
      throw new Error(`Query '${name}' is missing required columns: ${missing.join(', ')}.`);
    }
  }

  const dmvResults: DmvResults = {
    nodes: resultMap.get('nodes')!,
    columns: resultMap.get('columns')!,
    dependencies: resultMap.get('dependencies')!,
    allObjects,
    constraints: resultMap.get('constraints'),
  };

  progress.report({ message: 'Building model...' });
  outputChannel.info('[DB] Building model from DMV results...');
  const start = Date.now();
  const model = buildModelFromDmv(dmvResults);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const extNodes = model.nodes.filter(n => n.type === 'external');
  const extSuffix = extNodes.length > 0 ? `, incl. ${extNodes.length} external (⬡)` : '';
  outputChannel.info(`[DB] Model built: ${model.nodes.length} nodes${extSuffix}, ${model.edges.length} edges, ${model.schemas.length} schemas (${elapsed}s)`);
  if (extNodes.length > 0) {
    outputChannel.debug(`[DB] External nodes: ${extNodes.map(n => n.fullName).join(', ')}`);
  }

  const sourceName = context.workspaceState.get<string>('lastDbSourceName') || 'Database';
  const config = await readExtensionConfig();
  panel.webview.postMessage({
    type: 'db-model',
    model,
    config,
    sourceName,
  });
}

/**
 * Fallback: full extraction in one shot (used when schema-preview query is missing
 * from custom YAML).
 */
async function runDbFullExtraction(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  connectionUri: string,
  connectionInfo: IConnectionInfo,
  queries: import('./engine/connectionManager').DmvQuery[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  const sourceName = `${connectionInfo.server} / ${connectionInfo.database}`;
  const dataQueries = queries.filter(q => q.name !== 'schema-preview');

  const resultMap = await executeDmvQueries(
    connectionUri,
    dataQueries,
    outputChannel,
    (step, total, label) => {
      progress.report({ message: `Query ${step}/${total}: ${label}`, increment: Math.round(100 / total) });
      panel.webview.postMessage({ type: 'db-progress', step, total, label });
    },
  );

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  for (const [name, queryResult] of resultMap) {
    const missing = validateQueryResult(name, queryResult);
    if (missing.length > 0) {
      throw new Error(`Query '${name}' is missing required columns: ${missing.join(', ')}.`);
    }
  }

  const dmvResults: DmvResults = {
    nodes: resultMap.get('nodes')!,
    columns: resultMap.get('columns')!,
    dependencies: resultMap.get('dependencies')!,
    constraints: resultMap.get('constraints'),
  };

  progress.report({ message: 'Building model...' });
  const model = buildModelFromDmv(dmvResults);

  await context.workspaceState.update('lastDbSourceName', sourceName);
  await context.workspaceState.update('lastDbConnectionInfo', stripSensitiveFields(connectionInfo));
  await context.workspaceState.update('lastSourceType', 'database');
  const config = await readExtensionConfig();
  const lastDeselectedSchemas = context.workspaceState.get<string[]>('lastDeselectedSchemas');
  panel.webview.postMessage({
    type: 'db-model',
    model,
    config,
    sourceName,
    lastDeselectedSchemas,
  });
}

// ─── Parse Rules Validation Feedback ─────────────────────────────────────────

function formatCategoryCounts(counts?: Record<string, number>): string {
  if (!counts || Object.keys(counts).length === 0) return '';
  const order = ['preprocessing', 'source', 'target', 'exec'];
  const parts = order.filter(c => counts[c]).map(c => `${counts[c]} ${c}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

async function handleLoadDemo(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, autoVisualize = false) {
  const config = await readExtensionConfig();
  try {
    const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
    const data = await vscode.workspace.fs.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength)) return;
    panel.webview.postMessage({
      type: 'dacpac-data',
      data: Array.from(data),
      fileName: 'AdventureWorks (Demo)',
      config,
      autoVisualize,
    });
    outputChannel.info('── Opening AdventureWorks (Demo) ──');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    outputChannel.error(`Failed to load demo: ${errorMsg}`);
    vscode.window.showErrorMessage(`Failed to load demo: ${errorMsg}`);
  }
}

function handleParseRulesResult(message: {
  loaded: number;
  skipped: string[];
  errors: string[];
  usedDefaults: boolean;
  categoryCounts?: Record<string, number>;
}) {
  // Detail per-rule errors at debug level
  for (const err of message.errors) {
    outputChannel.debug(`[ParseRules] ${err}`);
  }

  const breakdown = formatCategoryCounts(message.categoryCounts);

  // Summary at info level + VS Code notification for problems
  if (message.usedDefaults) {
    outputChannel.warn('[ParseRules] YAML invalid — using built-in defaults');
    vscode.window.showWarningMessage(
      'Parse rules YAML invalid — using built-in defaults. Check Output channel for details.'
    );
  } else if (message.skipped.length > 0) {
    outputChannel.warn(`[ParseRules] ${message.loaded} loaded${breakdown}, ${message.skipped.length} skipped: ${message.skipped.join(', ')}`);
    vscode.window.showWarningMessage(
      `Parse rules: ${message.loaded} loaded, ${message.skipped.length} skipped (${message.skipped.join(', ')}). Check Output channel for details.`
    );
  } else {
    outputChannel.info(`[ParseRules] Custom rules loaded: ${message.loaded} rules${breakdown}`);
  }
}

function handleParseStats(stats: {
  parsedRefs: number;
  resolvedEdges: number;
  droppedRefs: string[];
  spDetails?: { name: string; inCount: number; outCount: number; inRefs?: string[]; outRefs?: string[]; unrelated: string[]; skippedRefs?: string[] }[];
}, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const spDetails = stats.spDetails || [];
  const spCount = spDetails.length;

  // Debug level: opener + one line per object + closer
  // spDetails covers SPs (full regex parse) and views/functions (parser supplement — delta only).
  if (spCount > 0) {
    outputChannel.debug(`[Parse] Starting — ${spCount} object(s) with ${lastRulesLabel}`);
  }
  for (const sp of spDetails) {
    const inLabel = sp.inRefs && sp.inRefs.length > 0 ? sp.inRefs.join(', ') : String(sp.inCount);
    const outLabel = sp.outRefs && sp.outRefs.length > 0 ? sp.outRefs.join(', ') : String(sp.outCount);
    const parts = [`In(${sp.inCount}): ${inLabel}`, `Out(${sp.outCount}): ${outLabel}`];
    if (sp.unrelated.length > 0) {
      parts.push(`Unrelated: ${sp.unrelated.join(', ')}`);
    }
    if (sp.skippedRefs && sp.skippedRefs.length > 0) {
      parts.push(`Skipped: ${sp.skippedRefs.join(', ')}`);
    }
    outputChannel.debug(`[Parse] ${sp.name} — ${parts.join(' | ')}`);
  }
  if (spCount > 0) {
    const distinctDroppedCount = new Set(stats.droppedRefs.map(r => r.split(' → ')[1])).size;
    outputChannel.debug(`[Parse] Done — ${stats.resolvedEdges} resolved, ${stats.droppedRefs.length} dropped (${distinctDroppedCount} distinct unrelated)`);
  }

  // Warn: procedures with no inputs and no outputs AND no unresolved catalog refs.
  // Exclude entries that have body refs but they were all skipped (e.g. XML method calls for views).
  // Exclude SPs that do have body refs but they fall outside the selected schemas.
  const empty = spDetails.filter(sp =>
    sp.inCount === 0 && sp.outCount === 0 && sp.unrelated.length === 0 &&
    !(sp.skippedRefs && sp.skippedRefs.length > 0)
  );
  if (empty.length > 0) {
    outputChannel.warn(`[Parse] ${empty.length} procedure(s) with no dependencies found: ${empty.map(sp => sp.name).join(', ')}`);
  }

  // Info level: canonical summary (last line — contains everything the user needs)
  const distinctDropped = new Set(stats.droppedRefs.map(r => r.split(' → ')[1])).size;
  if (objectCount !== undefined && objectCount > 0) {
    outputChannel.info(`[Summary] ${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas — ${lastRulesLabel}, ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved, ${distinctDropped} distinct unrelated refs dropped`);
  } else if (objectCount === undefined) {
    outputChannel.info(`[Summary] ${lastRulesLabel}, ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved, ${distinctDropped} distinct unrelated refs removed`);
  }
  // objectCount === 0: no [Summary] line — UI already shows a warning
}

// ─── Webview HTML ───────────────────────────────────────────────────────────

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, loadDemo = false): string {
  // Get URIs for the CSS and JS files from the React build output
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);

  const nonce = getNonce();

  const themeClass = getThemeClass(vscode.window.activeColorTheme.kind);

  return /*html*/ `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
        <link rel="stylesheet" type="text/css" href="${stylesUri}">
        <title>Data Lineage Viz</title>
      </head>
      <body class="vscode-body" data-vscode-theme-kind="${themeClass}"${loadDemo ? ' data-auto-visualize="true"' : ''}>
        <div id="root"></div>
        <script nonce="${nonce}">
          window.LOGO_URI = "${logoUri}";
        </script>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>
  `;
}

// ─── Sidebar TreeView ────────────────────────────────────────────────────────

class SidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    return [
      sidebarItem('Open Wizard', 'dataLineageViz.open', 'graph'),
      sidebarItem('Open Demo', 'dataLineageViz.openDemo', 'play'),
      sidebarItem('Settings', 'dataLineageViz.openSettings', 'gear'),
    ];
  }
}

function sidebarItem(label: string, commandId: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = { command: commandId, title: label };
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

export function deactivate() {
  ddlContentMap.clear();
}
