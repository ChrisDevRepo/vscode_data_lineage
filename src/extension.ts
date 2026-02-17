import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import type { LayoutConfig, EdgeStyle, TraceConfig, AnalysisConfig } from './engine/types';
import {
  isMssqlAvailable, promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
} from './engine/connectionManager';
import type { IConnectionInfo } from './types/mssql';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult } from './engine/dmvExtractor';
import type { DmvResults } from './engine/dmvExtractor';

// ─── Logging ────────────────────────────────────────────────────────────────

let outputChannel: vscode.LogOutputChannel;
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

function formatDdlContent(message: { objectName: string; schema: string; sqlBody?: string }): string {
  const { objectName, schema, sqlBody } = message;
  return sqlBody || `-- No DDL available for [${schema}].[${objectName}]`;
}

async function showDdl(ddlUri: vscode.Uri, message: { objectName: string; schema: string; sqlBody?: string }) {
  const key = ddlUri.toString();
  const content = formatDdlContent(message);
  ddlContentMap.set(key, content);
  ddlProvider.fire(ddlUri);

  try {
    const doc = await vscode.workspace.openTextDocument(ddlUri);
    if (doc.languageId !== 'dacpac-sql') {
      await vscode.languages.setTextDocumentLanguage(doc, 'dacpac-sql');
    }
    // Re-set: setTextDocumentLanguage fires onDidCloseTextDocument which deletes the key
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

function updateDdlIfOpen(ddlUri: vscode.Uri, message: { objectName: string; schema: string; sqlBody?: string }) {
  const key = ddlUri.toString();
  if (!ddlContentMap.has(key)) return;
  ddlContentMap.set(key, formatDdlContent(message));
  ddlProvider.fire(ddlUri);
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
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

  // Command: Create Parse Rules YAML scaffold
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.createParseRules', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const targetUri = vscode.Uri.joinPath(folder.uri, 'parseRules.yaml');
      
      try {
        // Check if file exists
        await vscode.workspace.fs.stat(targetUri);
        // File exists, just open it
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        return;
      } catch {
        // File doesn't exist, create it
      }

      // Copy the bundled default YAML as a starting point
      const sourceUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'defaultParseRules.yaml');
      const defaultYaml = await vscode.workspace.fs.readFile(sourceUri);
      await vscode.workspace.fs.writeFile(targetUri, defaultYaml);

      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        'Created parseRules.yaml in workspace root. Set "dataLineageViz.parseRulesFile" to "parseRules.yaml" to use it.'
      );
    })
  );

  // Command: Create DMV Queries YAML scaffold
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const targetUri = vscode.Uri.joinPath(folder.uri, 'dmvQueries.yaml');

      try {
        await vscode.workspace.fs.stat(targetUri);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        return;
      } catch {
        // File doesn't exist, create it
      }

      // Copy the bundled default YAML as a starting point
      const sourceUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'dmvQueries.yaml');
      const sourceData = await vscode.workspace.fs.readFile(sourceUri);
      await vscode.workspace.fs.writeFile(targetUri, sourceData);

      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        'Created dmvQueries.yaml in workspace root. Set "dataLineageViz.dmvQueriesFile" to "dmvQueries.yaml" to use it.'
      );
    })
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
  // Migration: if lastSourceType not set, prefer dacpac if available
  const dacpacName = context.workspaceState.get<string>('lastDacpacName');
  if (dacpacName) return { type: 'dacpac', name: dacpacName };
  const dbName = context.workspaceState.get<string>('lastDbSourceName');
  if (dbName) return { type: 'database', name: dbName };
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

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        try {
        switch (message.type) {
          case 'ready': {
            if (loadDemo) {
              await handleLoadDemo(panel, context, true);
            } else {
              const config = await readExtensionConfig();
              const lastSource = getLastSource(context);
              panel.webview.postMessage({ type: 'config-only', config, lastSource });
            }
            break;
          }
          case 'open-dacpac': {
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
                if (isDacpacTooLarge(data.byteLength)) break;
                await context.workspaceState.update('lastDacpacPath', fileUri.fsPath);
                await context.workspaceState.update('lastDacpacName', fileName);
                await context.workspaceState.update('lastSourceType', 'dacpac');
                const config = await readExtensionConfig();
                panel.webview.postMessage({
                  type: 'dacpac-data',
                  data: Array.from(data),
                  fileName,
                  config,
                });
                outputChannel.info(`── Opening ${fileName} ──`);
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                outputChannel.error(`Failed to read file: ${errorMsg}`);
                vscode.window.showErrorMessage(`Failed to read file: ${errorMsg}`);
              }
            }
            break;
          }
          case 'save-schemas': {
            await context.workspaceState.update('lastSelectedSchemas', message.schemas);
            break;
          }
          case 'load-last-dacpac': {
            const lastPath = context.workspaceState.get<string>('lastDacpacPath');
            if (!lastPath) return;
            try {
              const fileUri = vscode.Uri.file(lastPath);
              const data = await vscode.workspace.fs.readFile(fileUri);
              if (isDacpacTooLarge(data.byteLength)) break;
              const config = await readExtensionConfig();
              const lastSelectedSchemas = context.workspaceState.get<string[]>('lastSelectedSchemas');
              panel.webview.postMessage({
                type: 'dacpac-data',
                data: Array.from(data),
                fileName: context.workspaceState.get<string>('lastDacpacName') || path.basename(lastPath),
                config,
                lastSelectedSchemas,
              });
              outputChannel.info(`── Reopening ${path.basename(lastPath)} ──`);
            } catch {
              await context.workspaceState.update('lastDacpacPath', undefined);
              await context.workspaceState.update('lastDacpacName', undefined);
              await context.workspaceState.update('lastSourceType', undefined);
              panel.webview.postMessage({ type: 'last-dacpac-gone' });
              outputChannel.warn(`Last dacpac no longer available: ${lastPath}`);
            }
            break;
          }
          case 'load-demo': {
            await handleLoadDemo(panel, context);
            break;
          }
          case 'parse-rules-result':
            handleParseRulesResult(message);
            break;
          case 'parse-stats':
            handleParseStats(message.stats, message.objectCount, message.edgeCount, message.schemaCount);
            break;
          case 'log':
            outputChannel.info(message.text);
            break;
          case 'error':
            outputChannel.error(message.error);
            if (message.stack) outputChannel.debug(message.stack);
            vscode.window.showErrorMessage(`Data Lineage Error: ${message.error}`);
            break;
          case 'open-external':
            if (message.url) {
              await vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            break;
          case 'open-settings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz');
            break;
          case 'show-ddl':
            await showDdl(ddlUri, message);
            break;
          case 'update-ddl':
            updateDdlIfOpen(ddlUri, message);
            break;
          case 'check-mssql': {
            const available = isMssqlAvailable();
            panel.webview.postMessage({ type: 'mssql-status', available });
            break;
          }
          case 'db-connect': {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'Data Lineage: Connecting to database',
                cancellable: true,
              },
              async (progress, token) => {
                let connectionUri: string | undefined;
                try {
                  const result = await promptForConnection(outputChannel);
                  if (!result || token.isCancellationRequested) {
                    panel.webview.postMessage({ type: 'db-cancelled' });
                    return;
                  }
                  connectionUri = result.connectionUri;
                  await runDbPhase1(panel, context, connectionUri, result.connectionInfo, progress, token);
                } catch (err) {
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  outputChannel.error(`[DB] Phase 1 failed: ${errorMsg}`);
                  panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'connect' });
                } finally {
                  if (connectionUri) {
                    await disconnectDatabase(connectionUri, outputChannel).catch(err => {
                      outputChannel.warn(`[DB] Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
                    });
                  }
                }
              },
            );
            break;
          }
          case 'db-reconnect': {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'Data Lineage: Reconnecting to database',
                cancellable: true,
              },
              async (progress, token) => {
                let connectionUri: string | undefined;
                try {
                  const storedInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
                  let result: { connectionUri: string; connectionInfo: IConnectionInfo } | undefined;

                  if (storedInfo) {
                    result = await connectDirect(storedInfo as IConnectionInfo, outputChannel);
                  }

                  // Fall back to picker if direct connect failed or no stored info
                  if (!result) {
                    outputChannel.info('[DB] Falling back to connection picker');
                    result = await promptForConnection(outputChannel);
                  }

                  if (!result || token.isCancellationRequested) {
                    panel.webview.postMessage({ type: 'db-cancelled' });
                    return;
                  }
                  connectionUri = result.connectionUri;
                  await runDbPhase1(panel, context, connectionUri, result.connectionInfo, progress, token);
                } catch (err) {
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  outputChannel.error(`[DB] Phase 1 failed: ${errorMsg}`);
                  panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'connect' });
                } finally {
                  if (connectionUri) {
                    await disconnectDatabase(connectionUri, outputChannel).catch(err => {
                      outputChannel.warn(`[DB] Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
                    });
                  }
                }
              },
            );
            break;
          }
          case 'db-visualize': {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'Data Lineage: Loading selected schemas',
                cancellable: true,
              },
              async (progress, token) => {
                let connectionUri: string | undefined;
                try {
                  // Reconnect using stored connectionInfo from Phase 1
                  const storedInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
                  if (!storedInfo) {
                    panel.webview.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
                    return;
                  }

                  let result = await connectDirect(storedInfo as IConnectionInfo, outputChannel);
                  if (!result) {
                    outputChannel.info('[DB] Direct reconnect failed for Phase 2 — falling back to picker');
                    result = await promptForConnection(outputChannel);
                  }
                  if (!result || token.isCancellationRequested) {
                    panel.webview.postMessage({ type: 'db-cancelled' });
                    return;
                  }
                  connectionUri = result.connectionUri;
                  await runDbPhase2(panel, context, connectionUri, message.schemas, progress, token);
                } catch (err) {
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  outputChannel.error(`[DB] Phase 2 extraction failed: ${errorMsg}`);
                  panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'build' });
                } finally {
                  if (connectionUri) {
                    await disconnectDatabase(connectionUri, outputChannel).catch(err => {
                      outputChannel.warn(`[DB] Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
                    });
                  }
                }
              },
            );
            break;
          }
          default:
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
  | { type: 'save-schemas'; schemas: string[] }
  | { type: 'load-last-dacpac' }
  | { type: 'load-demo' }
  | { type: 'parse-rules-result'; loaded: number; skipped: string[]; errors: string[]; usedDefaults: boolean; categoryCounts?: Record<string, number> }
  | { type: 'parse-stats'; stats: { parsedRefs: number; resolvedEdges: number; droppedRefs: string[]; spDetails?: { name: string; inCount: number; outCount: number; unrelated: string[] }[] }; objectCount?: number; edgeCount?: number; schemaCount?: number }
  | { type: 'log'; text: string }
  | { type: 'error'; error: string; stack?: string }
  | { type: 'open-external'; url?: string }
  | { type: 'open-settings' }
  | { type: 'show-ddl'; objectName: string; schema: string; sqlBody?: string }
  | { type: 'update-ddl'; objectName: string; schema: string; sqlBody?: string }
  | { type: 'check-mssql' }
  | { type: 'db-connect' }
  | { type: 'db-reconnect' }
  | { type: 'db-visualize'; schemas: string[] };

// ─── Read Extension Config ──────────────────────────────────────────────────

interface ExtensionConfigMessage {
  parseRules?: unknown;
  excludePatterns: string[];
  maxNodes: number;
  layout: LayoutConfig;
  edgeStyle: EdgeStyle;
  trace: TraceConfig;
  analysis: AnalysisConfig;
}

function clamp(val: number, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || isNaN(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

async function readExtensionConfig(): Promise<ExtensionConfigMessage> {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');

  const config: ExtensionConfigMessage = {
    excludePatterns: cfg.get<string[]>('excludePatterns', []).filter(p => {
      try { new RegExp(p); return true; } catch {
        outputChannel.warn(`[Config] Invalid excludePattern "${p}" — not a valid regex. Pattern removed.`);
        return false;
      }
    }),
    maxNodes: clamp(cfg.get<number>('maxNodes', 500), 10, 1000, 500),
    layout: {
      direction: cfg.get<'TB' | 'LR'>('layout.direction', 'LR')!,
      rankSeparation: clamp(cfg.get<number>('layout.rankSeparation', 120), 20, 300, 120),
      nodeSeparation: clamp(cfg.get<number>('layout.nodeSeparation', 30), 10, 200, 30),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', true),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation', false),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled', true),
    },
    edgeStyle: cfg.get<EdgeStyle>('edgeStyle', 'default')!,
    trace: {
      defaultUpstreamLevels: clamp(cfg.get<number>('trace.defaultUpstreamLevels', 3), 0, 99, 3),
      defaultDownstreamLevels: clamp(cfg.get<number>('trace.defaultDownstreamLevels', 3), 0, 99, 3),
      hideCoWriters: cfg.get<boolean>('trace.hideCoWriters', true),
    },
    analysis: {
      hubMinDegree: clamp(cfg.get<number>('analysis.hubMinDegree', 8), 1, 50, 8),
      islandMaxSize: clamp(cfg.get<number>('analysis.islandMaxSize', 2), 2, 500, 2),
      longestPathMinNodes: clamp(cfg.get<number>('analysis.longestPathMinNodes', 5), 2, 50, 5),
    },
  };

  // Load YAML parse rules if configured
  const rulesPath = cfg.get<string>('parseRulesFile', '');
  if (!rulesPath) {
    lastRulesLabel = 'built-in rules';
    outputChannel.info('[ParseRules] Using built-in defaults (11 rules)');
  } else {
    const resolved = resolveWorkspacePath(rulesPath);
    if (!resolved) {
      outputChannel.warn(`[ParseRules] Cannot resolve "${rulesPath}" — no workspace folder open`);
      vscode.window.showWarningMessage(
        `Parse rules: cannot resolve "${rulesPath}" — open a workspace folder or use an absolute path.`
      );
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
      }
    }
  }

  return config;
}

// ─── Two-Phase DB Extraction ─────────────────────────────────────────────────

/**
 * Phase 1: Connect, run lightweight schema-preview query, send SchemaPreview
 * to webview for schema selection. Disconnects after sending.
 */
async function runDbPhase1(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  connectionUri: string,
  connectionInfo: IConnectionInfo,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
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
  panel.webview.postMessage({ type: 'db-progress', step: 1, total: 1, label: 'schema-preview' });

  const previewResult = await executeDmvQueries(connectionUri, [previewQuery], outputChannel);

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

  const preview = buildSchemaPreview(result!);
  outputChannel.info(`[DB] Schema preview: ${preview.schemas.length} schemas, ${preview.totalObjects} total objects`);

  await context.workspaceState.update('lastDbSourceName', sourceName);
  await context.workspaceState.update('lastDbConnectionInfo', stripSensitiveFields(connectionInfo));
  await context.workspaceState.update('lastSourceType', 'database');

  const config = await readExtensionConfig();
  const lastSelectedSchemas = context.workspaceState.get<string[]>('lastSelectedSchemas');
  panel.webview.postMessage({
    type: 'db-schema-preview',
    preview,
    config,
    sourceName,
    lastSelectedSchemas,
  });
}

/**
 * Phase 2: Reconnect, run filtered DMV queries for selected schemas,
 * build full model, send to webview.
 */
async function runDbPhase2(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  connectionUri: string,
  schemas: string[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
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
  };

  progress.report({ message: 'Building model...' });
  outputChannel.info('[DB] Building model from DMV results...');
  const start = Date.now();
  const model = buildModelFromDmv(dmvResults);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  outputChannel.info(`[DB] Model built: ${model.nodes.length} nodes, ${model.edges.length} edges, ${model.schemas.length} schemas (${elapsed}s)`);

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
  };

  progress.report({ message: 'Building model...' });
  const model = buildModelFromDmv(dmvResults);

  await context.workspaceState.update('lastDbSourceName', sourceName);
  await context.workspaceState.update('lastDbConnectionInfo', stripSensitiveFields(connectionInfo));
  await context.workspaceState.update('lastSourceType', 'database');
  const config = await readExtensionConfig();
  const lastSelectedSchemas = context.workspaceState.get<string[]>('lastSelectedSchemas');
  panel.webview.postMessage({
    type: 'db-model',
    model,
    config,
    sourceName,
    lastSelectedSchemas,
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
  spDetails?: { name: string; inCount: number; outCount: number; unrelated: string[] }[];
}, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const spDetails = stats.spDetails || [];
  const spCount = spDetails.length;

  // Debug level: one line per SP with details
  for (const sp of spDetails) {
    const parts = [`In: ${sp.inCount}`, `Out: ${sp.outCount}`];
    if (sp.unrelated.length > 0) {
      parts.push(`Unrelated: ${sp.unrelated.join(', ')}`);
    }
    outputChannel.debug(`[Parse] ${sp.name} — ${parts.join(', ')}`);
  }

  // Warn: SPs with no inputs and no outputs
  const empty = spDetails.filter(sp => sp.inCount === 0 && sp.outCount === 0);
  if (empty.length > 0) {
    outputChannel.warn(`[Parse] ${empty.length} procedure(s) with no dependencies found: ${empty.map(sp => sp.name).join(', ')}`);
  }

  // Info level: canonical summary (last line — contains everything the user needs)
  if (objectCount !== undefined) {
    outputChannel.info(`[Import] ${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas — ${lastRulesLabel}, ${spCount} procedures parsed, ${stats.resolvedEdges} refs resolved, ${stats.droppedRefs.length} unrelated refs dropped`);
  } else {
    outputChannel.info(`[Import] ${lastRulesLabel}, ${spCount} procedures parsed, ${stats.resolvedEdges} refs resolved, ${stats.droppedRefs.length} unrelated refs removed`);
  }
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
