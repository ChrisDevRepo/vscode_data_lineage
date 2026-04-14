import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as os from 'os';
import { type AiSession } from './ai/session';
import { logInfo, logDebug, logWarn, logError, logTrace, trunc, type LogCategory } from './utils/log';
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
  executeSimpleQuery, getServerInfo,
} from './engine/connectionManager';
import type { IConnectionInfo, SimpleExecuteResult } from './types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult, computeSamplePercent } from './engine/profilingEngine';
import type { StatsMode } from './engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult } from './engine/dmvExtractor';
import { loadRules, type ParseRulesConfig } from './engine/sqlBodyParser';
import type { DmvResults } from './engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject, generateProjectName,
  addFilterProfile, deleteFilterProfile, isValidProject,
  type Project, type FilterProfile, type SerializedFilterState, type AIViewMetadata
} from './engine/projectStore';
import { buildBareGraph } from './ai/graphUtils';
import { populateColumnStore } from './engine/modelBuilder';

// ─── Types & Interfaces ──────────────────────────────────────────────────────

/** 
 * BridgeHost abstracts the VS Code specific parts of the bridge
 * allowing the logic to be unit tested in a pure Node.js environment.
 */
export interface BridgeHost {
  postMessage(msg: any): Thenable<boolean>;
  log(level: 'info' | 'debug' | 'warn' | 'error' | 'trace', cat: LogCategory, text: string, err?: any): void;
  showErrorMessage(msg: string): void;
  executeCommand(command: string, ...args: any[]): Thenable<any>;
  openExternal(url: string): Thenable<boolean>;
  showOpenDialog(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  withProgress<R>(options: vscode.ProgressOptions, task: (progress: vscode.Progress<any>, token: vscode.CancellationToken) => Thenable<R>): Thenable<R>;
  getConfiguration(): vscode.WorkspaceConfiguration;
  getExtensionUri(): vscode.Uri;
  getGlobalState(): vscode.Memento;
  getWorkspaceState(): vscode.Memento;
}

// ─── Panel State ─────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;
let statsConnectionUri: string | undefined;
let lastRulesLabel = 'built-in rules';
let _lastOverviewMode: 'full' | 'overview' | null = null;
let _lastFilteredCount = 0;
let _lastRenderLimitHit = 0;

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB
export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

declare const __BUILD_TIMESTAMP__: string;

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

function isDacpacTooLarge(bytes: number, host: BridgeHost): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  host.showErrorMessage(`Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
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
    logInfo(outputChannel, 'Bridge', 'Revealing existing panel');
    activePanel.reveal();
    if (loadDemo) {
      activePanel.webview.postMessage({ type: 'auto-visualize-start' });
      // Wrapped in a dummy host for handleLoadDemo compatibility
      const dummyHost: BridgeHost = {
        postMessage: (msg) => activePanel!.webview.postMessage(msg),
        log: (level, cat, text, err) => {
          if (level === 'info') logInfo(outputChannel, cat, text);
          else if (level === 'warn') logWarn(outputChannel, cat, text);
          else if (level === 'error') logError(outputChannel, cat, text, err);
          else if (level === 'trace') logTrace(outputChannel, cat, text);
          else logDebug(outputChannel, cat, text);
        },
        showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
        executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        showOpenDialog: (opts) => vscode.window.showOpenDialog(opts),
        showSaveDialog: (opts) => vscode.window.showSaveDialog(opts),
        readFile: (uri) => vscode.workspace.fs.readFile(uri),
        writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
        withProgress: (opts, task) => vscode.window.withProgress(opts, task),
        getConfiguration: () => vscode.workspace.getConfiguration('dataLineageViz'),
        getExtensionUri: () => context.extensionUri,
        getGlobalState: () => context.globalState,
        getWorkspaceState: () => context.workspaceState,
      };
      handleLoadDemo(dummyHost, context, getSession, outputChannel, true).catch(() => {});
    }
    return;
  }

  logInfo(outputChannel, 'Bridge', `Creating new panel: "${title}"`);
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

  const host: BridgeHost = {
    postMessage: (msg) => panel.webview.postMessage(msg),
    log: (level, cat, text, err) => {
      if (level === 'info') logInfo(outputChannel, cat, text);
      else if (level === 'warn') logWarn(outputChannel, cat, text);
      else if (level === 'error') logError(outputChannel, cat, text, err);
      else if (level === 'trace') logTrace(outputChannel, cat, text);
      else logDebug(outputChannel, cat, text);
    },
    showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
    executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    showOpenDialog: (opts) => vscode.window.showOpenDialog(opts),
    showSaveDialog: (opts) => vscode.window.showSaveDialog(opts),
    readFile: (uri) => vscode.workspace.fs.readFile(uri),
    writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
    withProgress: (opts, task) => vscode.window.withProgress(opts, task),
    getConfiguration: () => vscode.workspace.getConfiguration('dataLineageViz'),
    getExtensionUri: () => context.extensionUri,
    getGlobalState: () => context.globalState,
    getWorkspaceState: () => context.workspaceState,
  };

  let detailPanel: vscode.WebviewPanel | undefined;
  let panelDisposed = false;

  panel.onDidDispose(() => {
    logInfo(outputChannel, 'Bridge', 'Panel disposed');
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

  const handlers = createMessageHandlers(host, context, getSession, outputChannel, loadProjectStore, saveProjectStore, migrateFromWorkspaceState, loadDemo, (dp) => detailPanel = dp);

  panel.webview.onDidReceiveMessage(async (msg) => {
    logDebug(outputChannel, 'Bridge', `Incoming: ${msg.type}`);
    const handler = handlers[msg.type];
    if (handler) {
      try {
        await handler(msg);
      } catch (err) {
        logError(outputChannel, 'Bridge', `Handler ${msg.type}`, err);
        panel.webview.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      logWarn(outputChannel, 'Bridge', `No handler for message type: ${msg.type}`);
    }
  }, undefined, context.subscriptions);
}

// ─── Core Handler Logic ──────────────────────────────────────────────────────

export function createMessageHandlers(
  host: BridgeHost,
  context: vscode.ExtensionContext,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  loadProjectStore: (context: vscode.ExtensionContext) => any,
  saveProjectStore: (context: vscode.ExtensionContext, store: any) => Promise<void>,
  migrateFromWorkspaceState: (context: vscode.ExtensionContext) => Promise<void>,
  loadDemoFlag: boolean,
  setDetailPanel: (panel: vscode.WebviewPanel | undefined) => void
): Record<string, (msg: any) => Promise<void> | void> {

  let cachedElements: XmlElement[] | null = null;
  let cachedDspName = '';
  let lastConnectionInfo: IConnectionInfo | undefined;
  let allObjectsCache: SimpleExecuteResult | undefined;
  let platformInfoCache: SimpleExecuteResult | undefined;
  let detailPanel: vscode.WebviewPanel | undefined;

  function setCurrentModel(m: DatabaseModel, project?: { id: string; name: string } | null): void {
    const sess = getSession();
    sess.columnStore.clear();
    populateColumnStore(m, sess.columnStore);
    sess.model = m;
    sess.graph = buildBareGraph(m);
    if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
    host.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
  }

  function enrichNodeForDetail(node: LineageNode): LineageNode {
    const sess = getSession();
    const cols = sess.columnStore.getColumns(node.id);
    const ddl = sess.columnStore.getDdl(node.id);
    return { ...node, ...(cols && { columns: cols }), ...(ddl && { bodyScript: ddl }) };
  }

  return {
    'ready': async () => {
      host.log('info', 'Bridge', 'Webview ready');
      if (loadDemoFlag) {
        await handleLoadDemo(host, context, getSession, outputChannel, true, (m) => {
          setCurrentModel(m, null);
          getSession().projectName = 'Demo';
        });
        return;
      }
      if (host.getGlobalState().get(PROJECT_STORE_KEY) === undefined) {
        host.log('info', 'Bridge', 'No project store found, triggering migration');
        await migrateFromWorkspaceState(context);
      }
      const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
      const store = loadProjectStore(context);
      const sess = getSession();
      host.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
      if (sess.model && store.lastOpenedId) {
        const project = store.projects.find((p: any) => p.id === store.lastOpenedId);
        if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
        host.log('info', 'Bridge', `Restoring session for project: ${sess.projectName}`);
        host.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true });
      }
    },
    'open-dacpac': async () => {
      host.log('info', 'Bridge', 'Opening dacpac picker');
      const uris = await host.showOpenDialog({ 
        canSelectMany: false, 
        filters: { 'DACPAC': ['dacpac'] },
        title: 'Select a .dacpac file'
      });
      if (uris && uris.length > 0) {
        host.log('info', 'Bridge', `Selected dacpac: ${uris[0].fsPath}`);
        const data = await host.readFile(uris[0]);
        if (isDacpacTooLarge(data.byteLength, host)) return;
        const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
        const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
        cachedElements = elements; cachedDspName = dspName;
        host.postMessage({ 
          type: 'dacpac-schema-preview', 
          preview, 
          config,
          sourceName: path.basename(uris[0].fsPath, '.dacpac'),
          filePath: uris[0].fsPath 
        });
      } else {
        host.log('info', 'Bridge', 'Dacpac picker cancelled');
        host.postMessage({ type: 'db-cancelled' });
      }
    },
    'load-project': async (msg) => {
      host.log('info', 'Bridge', `Loading project: ${msg.id}`);
      if (statsConnectionUri) {
        disconnectDatabase(statsConnectionUri, outputChannel).catch(() => {});
        statsConnectionUri = undefined;
      }
      const store = loadProjectStore(context);
      const project = store.projects.find((p: any) => p.id === msg.id);
      if (!project) {
        host.log('error', 'Bridge', 'Load project', new Error(`Project not found: ${msg.id}`));
        host.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}`, phase: 'connect' });
        return;
      }

      if (project.connection.type === 'dacpac') {
        try {
          const fileUri = vscode.Uri.file(project.connection.path);
          host.log('info', 'Bridge', `Reading dacpac file: ${fileUri.fsPath}`);
          const data = await host.readFile(fileUri);
          if (isDacpacTooLarge(data.byteLength, host)) return;
          
          const refreshed = { ...project, updatedAt: new Date().toISOString() };
          const updatedStore = updateProject(store, refreshed);
          await saveProjectStore(context, updatedStore);
          host.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });

          const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
          const schemas = project.connection.schemas;
          
          if (schemas && schemas.length > 0) {
            host.log('info', 'Bridge', `Extracting filtered dacpac for schemas: ${schemas.join(', ')}`);
            if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
            const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            const model = extractDacpacFiltered(elements, new Set(schemas), dspName);
            setCurrentModel(model, { id: project.id, name: project.connection.displayName });
            if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
            host.postMessage({ type: 'dacpac-model', model, config, sourceName: project.connection.displayName });
          } else {
            host.log('info', 'Bridge', 'No schemas in project, showing preview');
            const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            cachedElements = elements; cachedDspName = dspName;
            host.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: project.connection.displayName });
          }
        } catch (err) {
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            host.log('warn', 'Bridge', `Dacpac file not found: ${project.connection.path}`);
            host.postMessage({ type: 'last-dacpac-gone' });
          } else {
            throw err;
          }
        }
      } else {
        await withDbProgressHost(host, 'Loading project', outputChannel, async () => {
          const result = await connectDirect(project.connection.connectionInfo as IConnectionInfo, outputChannel);
          return result ?? await promptForConnection(outputChannel);
        }, async (dbResult, progress, token) => {
          lastConnectionInfo = dbResult.connectionInfo;
          const schemas = project.connection.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1Host(host, dbResult.connectionUri, dbResult.connectionInfo, outputChannel, host.getExtensionUri(), (r) => { allObjectsCache = r; });
          } else {
            await runDbPhase2Host(host, dbResult.connectionUri, schemas, progress, token, outputChannel, host.getExtensionUri(), allObjectsCache, project.connection.connectionInfo.database, project.connection.sourceName, platformInfoCache, (m) => {
              setCurrentModel(m, { id: project.id, name: project.name });
            });
            const refreshed = { ...project, updatedAt: new Date().toISOString() };
            const updatedStore = updateProject(store, refreshed);
            await saveProjectStore(context, updatedStore);
            host.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });
          }
        });
      }
    },
    'save-project': async (msg) => {
      host.log('info', 'Bridge', `Saving project: ${msg.project?.name}`);
      if (!isValidProject(msg.project)) return;
      const store = loadProjectStore(context);
      const updated = updateProject(store, msg.project);
      await saveProjectStore(context, updated);
      const sess = getSession();
      sess.currentProjectId = msg.project.id;
      sess.projectName = msg.project.name;
      host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'delete-project': async (msg) => {
      host.log('info', 'Bridge', `Deleting project: ${msg.id}`);
      const store = loadProjectStore(context);
      const updated = deleteProject(store, msg.id);
      await saveProjectStore(context, updated);
      host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'load-demo': async () => {
      host.log('info', 'Bridge', 'Loading demo');
      await handleLoadDemo(host, context, getSession, outputChannel, true, (m) => {
        setCurrentModel(m, null);
        getSession().projectName = 'Demo';
      });
    },
    'dacpac-visualize': async (msg) => {
      host.log('info', 'Bridge', `Dacpac visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      if (!cachedElements) {
        host.log('error', 'Bridge', 'Dacpac visualize', new Error('Session expired (cachedElements is null)'));
        host.postMessage({ type: 'db-error', message: 'Session expired. Please reopen the file.', phase: 'extract' });
        return;
      }
      const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
      host.log('info', 'Bridge', 'Running extractDacpacFiltered');
      const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName);
      host.log('info', 'Bridge', `Extracted ${model.nodes.length} nodes and ${model.edges.length} edges`);
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      setCurrentModel(model, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null);
      if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
      host.postMessage({ type: 'dacpac-model', model, config, sourceName: projectName });
    },
    'db-visualize': async (msg) => {
      host.log('info', 'Bridge', `Database visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      return withDbProgressHost(host, 'Loading selected schemas', outputChannel, async () => {
        if (!lastConnectionInfo) {
          host.log('error', 'Bridge', 'Database visualize', new Error('No stored connection info'));
          host.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
          return undefined;
        }
        return (await connectDirect(lastConnectionInfo, outputChannel)) ?? await promptForConnection(outputChannel);
      }, async (conn, progress, token) => {
        const sourceName = `${conn.connectionInfo.server} / ${conn.connectionInfo.database}`;
        const pendingProject = msg.projectName ? createProject(msg.projectName, {
          type: 'database',
          connectionInfo: stripSensitiveFields(conn.connectionInfo),
          sourceName,
          schemas: msg.schemas,
        }) : null;

        await runDbPhase2Host(host, conn.connectionUri, msg.schemas, progress, token, outputChannel, host.getExtensionUri(), allObjectsCache, conn.connectionInfo.database, sourceName, platformInfoCache, (m) => {
          if (pendingProject) {
            setCurrentModel(m, { id: pendingProject.id, name: pendingProject.name });
          } else {
            setCurrentModel(m);
            getSession().projectName = sourceName;
          }
        });

        if (pendingProject && !token.isCancellationRequested) {
          const store = loadProjectStore(context);
          const updated = updateProject(store, pendingProject);
          await saveProjectStore(context, updated);
          host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        }
      });
    },
    'show-detail': (msg) => {
      host.log('debug', 'Bridge', `Showing detail for node: ${msg.node?.id}`);
      if (!detailPanel) {
        detailPanel = vscode.window.createWebviewPanel('dataLineageDetail', msg.node.name, vscode.ViewColumn.Beside, { enableScripts: true });
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, host.getExtensionUri());
        detailPanel.onDidDispose(() => { detailPanel = undefined; setDetailPanel(undefined); });
        setDetailPanel(detailPanel);
        detailPanel.webview.onDidReceiveMessage(async (m) => {
          if (m.type === 'table-stats-request') {
            await handleTableStatsRequestHost(host, lastConnectionInfo, detailPanel!, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel, host.getExtensionUri());
          } else if (m.type === 'close-detail') {
            detailPanel?.dispose();
          }
        });
      }
      detailPanel.webview.postMessage({ type: 'detail-update', node: enrichNodeForDetail(msg.node) });
    },
    'filter-changed': (msg) => {
      const sess = getSession();
      sess.filter = msg.filter;
      sess.views = msg.savedViews;
      if (msg.filteredCount !== undefined) _lastFilteredCount = msg.filteredCount;
      if (msg.renderLimitHit !== undefined) _lastRenderLimitHit = msg.renderLimitHit;
    },
    'db-connect': () => {
      host.log('info', 'Bridge', 'Database connect requested');
      return withDbProgressHost(host, 'Connecting', outputChannel, () => promptForConnection(outputChannel), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1Host(host, conn.connectionUri, conn.connectionInfo, outputChannel, host.getExtensionUri(), (r) => { allObjectsCache = r; });
      });
    },
    'check-mssql': () => {
      const available = isMssqlAvailable();
      host.log('debug', 'Bridge', `MSSQL extension availability check: ${available}`);
      host.postMessage({ type: 'mssql-status', available });
    },
    'save-view': async (msg) => {
      host.log('info', 'Bridge', `Saving filter view: ${msg.profile?.name}`);
      const store = loadProjectStore(context);
      const updated = addFilterProfile(store, msg.projectId, msg.profile as FilterProfile);
      await saveProjectStore(context, updated);
      host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'save-wizard-view': async (msg) => {
      const store = loadProjectStore(context);
      await saveProjectStore(context, { ...store, lastWizardView: msg.view });
    },
    'delete-view': async (msg) => {
      host.log('info', 'Bridge', `Deleting filter view: ${msg.profileId}`);
      const store = loadProjectStore(context);
      const updated = deleteFilterProfile(store, msg.projectId, msg.profileId);
      await saveProjectStore(context, updated);
      host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'rebuild': async () => {
      host.log('info', 'Bridge', 'Rebuild requested');
      const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
      host.postMessage({ type: 'rebuild-config', config });
    },
    'reload': () => {
      host.log('info', 'Bridge', 'Reloading panel');
      // This remains slightly coupled to VS Code UI via OpenPanel call
      host.executeCommand('dataLineageViz.open');
    },
    'request-projects': () => {
      host.log('debug', 'Bridge', 'Projects list requested');
      const store = loadProjectStore(context);
      host.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
    },
    'open-external': async (msg) => {
      if (msg.url) {
        host.log('info', 'Bridge', `Opening external URL: ${msg.url}`);
        await host.openExternal(msg.url);
      }
    },
    'open-settings': () => {
      host.log('info', 'Bridge', 'Opening extension settings');
      host.executeCommand('workbench.action.openSettings', 'dataLineageViz');
    },
    'export-file': async (msg) => {
      host.log('info', 'Bridge', `Exporting file: ${msg.defaultName}`);
      const uri = await host.showSaveDialog({ defaultUri: vscode.Uri.file(msg.defaultName) });
      if (uri) {
        await host.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        host.executeCommand('revealFileInOS', uri);
      }
    },
    'overview-mode-changed': (msg) => {
      _lastOverviewMode = msg.mode;
    },
    'log': (msg) => {
      host.log(msg.level ?? 'debug', 'Bridge', msg.text);
    },
    'error': (msg) => {
      host.log('error', 'Bridge', 'Webview error', new Error(msg.error));
      host.showErrorMessage(`Data Lineage Error: ${msg.error}`);
    }
  };
}

// ─── Helpers (Host-Aware) ───────────────────────────────────────────────────

async function handleLoadDemo(host: BridgeHost, context: vscode.ExtensionContext, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, autoVisualize = false, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(outputChannel, host.getExtensionUri());
  try {
    const demoUri = vscode.Uri.joinPath(host.getExtensionUri(), 'assets', 'demo.dacpac');
    host.log('info', 'Dacpac', `Loading demo dacpac from: ${demoUri.fsPath}`);
    const data = await host.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength, host)) return;
    if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
    const model = await extractDacpac(data.buffer as ArrayBuffer);
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
    host.log('info', 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    host.log('error', 'Dacpac', 'Load demo', err);
  }
}

async function runDbPhase1Host(host: BridgeHost, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, onCacheAllObjects: (result: SimpleExecuteResult) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  host.log('info', 'DB', 'Running schema preview query');
  const resultMap = await executeDmvQueries(connectionUri, [previewQuery], outputChannel);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const preview = buildSchemaPreview(result);
  const config = await readExtensionConfig(outputChannel, extensionUri);
  host.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${connectionInfo.server} / ${connectionInfo.database}` });
}

async function runDbPhase2Host(host: BridgeHost, connectionUri: string, schemas: string[], progress: vscode.Progress<any>, token: vscode.CancellationToken, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, allObjects?: SimpleExecuteResult, currentDatabase?: string, sourceName?: string, platformInfo?: SimpleExecuteResult, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  host.log('info', 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
  const resultMap = await executeDmvQueriesFiltered(connectionUri, queries, schemas, outputChannel, (step, total, label) => {
    host.postMessage({ type: 'db-progress', step, total, label });
  });
  const dmvResults: DmvResults = { nodes: resultMap.get('nodes')!, columns: resultMap.get('columns')!, dependencies: resultMap.get('dependencies')!, allObjects, platformInfo };
  const config = await readExtensionConfig(outputChannel, extensionUri);
  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, config.maxNodes);
  onModelBuilt?.(model);
  host.postMessage({ type: 'db-model', model, config, sourceName: sourceName ?? 'Database' });
}

async function withDbProgressHost(host: BridgeHost, title: string, outputChannel: vscode.LogOutputChannel, connectFn: () => Promise<any>, phaseFn: (res: any, progress: any, token: any) => Promise<void>) {
  await host.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    try {
      const res = await connectFn();
      if (res && !token.isCancellationRequested) {
        await phaseFn(res, progress, token);
      } else {
        host.log('info', 'DB', `${title} cancelled or failed to connect`);
        host.postMessage({ type: 'db-cancelled' });
      }
    } catch (err) {
      host.log('error', 'DB', title, err);
      host.postMessage({ type: 'db-error', message: err instanceof Error ? err.message : String(err), phase: 'connect' });
    }
  });
}

async function handleTableStatsRequestHost(
  host: BridgeHost,
  storedConnectionInfo: IConnectionInfo | undefined,
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: ColumnDef[],
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri
): Promise<void> {
  const cfg = host.getConfiguration();
  const sampleThreshold = cfg.get('tableStatistics.sampleThreshold', 500000);
  const sampleSize = cfg.get('tableStatistics.sampleSize', 1000);
  const useApprox = cfg.get('tableStatistics.useApproxDistinct', true);
  const maxColumns = cfg.get('tableStatistics.maxColumns', 100);

  try {
    if (!statsConnectionUri) {
      host.log('info', 'Stats', `Connecting for stats: ${schema}.${objectName}`);
      const result = storedConnectionInfo ? (await connectDirect(storedConnectionInfo, outputChannel) ?? await promptForConnection(outputChannel)) : await promptForConnection(outputChannel);
      if (!result) {
        host.postMessage({ type: 'table-stats-error', message: 'Connection cancelled.' });
        return;
      }
      statsConnectionUri = result.connectionUri;
    }
    const connectionUri = statsConnectionUri!;
    const serverInfo = await getServerInfo(connectionUri, outputChannel);
    const engineEdition = serverInfo.engineEditionId;

    const rowCountSql = buildRowCountQuery(schema, objectName);
    const rowCountResult = await executeSimpleQuery(connectionUri, rowCountSql, outputChannel);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;

    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);
    if (!profilingSql) return;

    const profilingResult = await executeSimpleQuery(connectionUri, profilingSql, outputChannel);
    const resultRow: Record<string, string> = {};
    for (let i = 0; i < profilingResult.columnInfo.length; i++) {
      resultRow[profilingResult.columnInfo[i].columnName] = profilingResult.rows[0][i].displayValue;
    }

    const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
    const samplePercent = needsSampling ? computeSamplePercent(engineEdition, sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    host.postMessage({ type: 'table-stats-result', stats, mode });
  } catch (err) {
    host.log('error', 'Stats', 'Profiling', err);
    host.postMessage({ type: 'table-stats-error', message: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Shared UI Helpers (Stateless) ──────────────────────────────────────────

function handleParseRulesResult(message: {
  loaded: number;
  skipped: string[];
  errors: string[];
  usedDefaults: boolean;
  categoryCounts?: Record<string, number>;
}, outputChannel: vscode.LogOutputChannel) {
  for (const err of message.errors) logDebug(outputChannel, 'Config', err);
  if (message.usedDefaults) {
    logWarn(outputChannel, 'Config', 'YAML invalid — using built-in defaults');
  } else if (message.skipped.length > 0) {
    logWarn(outputChannel, 'Config', `${message.loaded} loaded, ${message.skipped.length} skipped: ${message.skipped.join(', ')}`);
  } else {
    logInfo(outputChannel, 'Config', `${message.loaded} rules loaded`);
  }
}

function handleParseStats(stats: {
  parsedRefs: number;
  resolvedEdges: number;
  droppedRefs: string[];
  spDetails?: { name: string; inCount: number; outCount: number; unrelated: string[]; skippedRefs?: string[] }[];
}, outputChannel: vscode.LogOutputChannel, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const spCount = stats.spDetails?.length ?? 0;
  if (objectCount !== undefined) {
    logInfo(outputChannel, 'Parse', `${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas — ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved`);
  }
}

export function buildDebugDump(context: vscode.ExtensionContext, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel): string {
  const sess = getSession();
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);
  const version = (context.extension.packageJSON as { version: string }).version ?? 'unknown';
  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';

  add(`Data Lineage Viz — Debug Info`);
  add(`Generated: ${new Date().toISOString()}`);
  add('');
  add('ENVIRONMENT');
  add(`  Extension:    ${version} (built ${buildStamp})`);
  add(`  VS Code:      ${vscode.version}`);
  add(`  OS:           ${process.platform} ${process.arch} (${os.release()})`);
  add('');
  add('DATA SOURCE');
  if (!sess.model) {
    add('  Model loaded: No');
  } else {
    add('  Model loaded: Yes');
    add(`  Project:      ${sess.projectName ?? 'N/A'}`);
    add(`  Platform:     ${sess.model.dbPlatform ?? 'N/A'}`);
  }
  return lines.join('\n');
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
    parseRules: cfg.get<string>('parseRulesFile', ''),
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
