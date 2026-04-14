import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as os from 'os';
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
    logInfo(outputChannel, 'Bridge', 'Revealing existing panel');
    activePanel.reveal();
    if (loadDemo) {
      activePanel.webview.postMessage({ type: 'auto-visualize-start' });
      handleLoadDemo(activePanel, context, getSession, outputChannel, true).catch(() => {});
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
      logInfo(outputChannel, 'Bridge', 'Webview ready');
      if (loadDemo) {
        await handleLoadDemo(panel, context, getSession, outputChannel, true, (m) => {
          setCurrentModel(m, null);
          getSession().projectName = 'Demo';
        });
        return;
      }
      if (context.globalState.get(PROJECT_STORE_KEY) === undefined) {
        logInfo(outputChannel, 'Bridge', 'No project store found, triggering migration');
        await migrateFromWorkspaceState(context);
      }
      const config = await readExtensionConfig(outputChannel, context.extensionUri);
      const store = loadProjectStore(context);
      const sess = getSession();
      panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
      if (sess.model && store.lastOpenedId) {
        const project = store.projects.find((p: any) => p.id === store.lastOpenedId);
        if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
        logInfo(outputChannel, 'Bridge', `Restoring session for project: ${sess.projectName}`);
        panel.webview.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true });
      }
    },
    'open-dacpac': async () => {
      logInfo(outputChannel, 'Bridge', 'Opening dacpac picker');
      const uris = await vscode.window.showOpenDialog({ 
        canSelectMany: false, 
        filters: { 'DACPAC': ['dacpac'] },
        title: 'Select a .dacpac file'
      });
      if (uris && uris.length > 0) {
        logInfo(outputChannel, 'Bridge', `Selected dacpac: ${uris[0].fsPath}`);
        const data = await vscode.workspace.fs.readFile(uris[0]);
        if (isDacpacTooLarge(data.byteLength)) return;
        const config = await readExtensionConfig(outputChannel, context.extensionUri);
        const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
        cachedElements = elements; cachedDspName = dspName;
        panel.webview.postMessage({ 
          type: 'dacpac-schema-preview', 
          preview, 
          config,
          sourceName: path.basename(uris[0].fsPath, '.dacpac'),
          filePath: uris[0].fsPath 
        });
      } else {
        logInfo(outputChannel, 'Bridge', 'Dacpac picker cancelled');
        panel.webview.postMessage({ type: 'db-cancelled' });
      }
    },
    'load-project': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Loading project: ${msg.id}`);
      if (statsConnectionUri) {
        disconnectDatabase(statsConnectionUri, outputChannel).catch(() => {});
        statsConnectionUri = undefined;
      }
      const store = loadProjectStore(context);
      const project = store.projects.find((p: any) => p.id === msg.id);
      if (!project) {
        logError(outputChannel, 'Bridge', 'Load project', new Error(`Project not found: ${msg.id}`));
        panel.webview.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}`, phase: 'connect' });
        return;
      }

      if (project.connection.type === 'dacpac') {
        try {
          const fileUri = vscode.Uri.file(project.connection.path);
          logInfo(outputChannel, 'Bridge', `Reading dacpac file: ${fileUri.fsPath}`);
          const data = await vscode.workspace.fs.readFile(fileUri);
          if (isDacpacTooLarge(data.byteLength)) return;
          
          const refreshed = { ...project, updatedAt: new Date().toISOString() };
          const updatedStore = updateProject(store, refreshed);
          await saveProjectStore(context, updatedStore);
          panel.webview.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });

          const config = await readExtensionConfig(outputChannel, context.extensionUri);
          const schemas = project.connection.schemas;
          
          if (schemas && schemas.length > 0) {
            logInfo(outputChannel, 'Bridge', `Extracting filtered dacpac for schemas: ${schemas.join(', ')}`);
            if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
            const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            const model = extractDacpacFiltered(elements, new Set(schemas), dspName);
            setCurrentModel(model, { id: project.id, name: project.connection.displayName });
            if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
            panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: project.connection.displayName });
          } else {
            logInfo(outputChannel, 'Bridge', 'No schemas in project, showing preview');
            const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            cachedElements = elements; cachedDspName = dspName;
            panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: project.connection.displayName });
          }
        } catch (err) {
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            logWarn(outputChannel, 'Bridge', `Dacpac file not found: ${project.connection.path}`);
            panel.webview.postMessage({ type: 'last-dacpac-gone' });
          } else {
            throw err;
          }
        }
      } else {
        await withDbProgress(panel, 'Loading project', outputChannel, async () => {
          const result = await connectDirect(project.connection.connectionInfo as IConnectionInfo, outputChannel);
          return result ?? await promptForConnection(outputChannel);
        }, async (dbResult, progress, token) => {
          lastConnectionInfo = dbResult.connectionInfo;
          const schemas = project.connection.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1(panel, dbResult.connectionUri, dbResult.connectionInfo, outputChannel, context.extensionUri, (r) => { allObjectsCache = r; });
          } else {
            await runDbPhase2(panel, dbResult.connectionUri, schemas, progress, token, outputChannel, context.extensionUri, allObjectsCache, project.connection.connectionInfo.database, project.connection.sourceName, platformInfoCache, (m) => {
              setCurrentModel(m, { id: project.id, name: project.name });
            });
            const refreshed = { ...project, updatedAt: new Date().toISOString() };
            const updatedStore = updateProject(store, refreshed);
            await saveProjectStore(context, updatedStore);
            panel.webview.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });
          }
        });
      }
    },
    'save-project': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Saving project: ${msg.project?.name}`);
      if (!isValidProject(msg.project)) return;
      const store = loadProjectStore(context);
      const updated = updateProject(store, msg.project);
      await saveProjectStore(context, updated);
      const sess = getSession();
      sess.currentProjectId = msg.project.id;
      sess.projectName = msg.project.name;
      panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'delete-project': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Deleting project: ${msg.id}`);
      const store = loadProjectStore(context);
      const updated = deleteProject(store, msg.id);
      await saveProjectStore(context, updated);
      panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'load-demo': async () => {
      logInfo(outputChannel, 'Bridge', 'Loading demo');
      await handleLoadDemo(panel, context, getSession, outputChannel, true, (m) => {
        setCurrentModel(m, null);
        getSession().projectName = 'Demo';
      });
    },
    'dacpac-visualize': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Dacpac visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      if (!cachedElements) {
        logError(outputChannel, 'Bridge', 'Dacpac visualize', new Error('Session expired (cachedElements is null)'));
        panel.webview.postMessage({ type: 'db-error', message: 'Session expired. Please reopen the file.', phase: 'extract' });
        return;
      }
      const config = await readExtensionConfig(outputChannel, context.extensionUri);
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
      logInfo(outputChannel, 'Bridge', 'Running extractDacpacFiltered');
      const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName);
      logInfo(outputChannel, 'Bridge', `Extracted ${model.nodes.length} nodes and ${model.edges.length} edges`);
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      setCurrentModel(model, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null);
      if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
      panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: projectName });
    },
    'db-visualize': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Database visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      return withDbProgress(panel, 'Loading selected schemas', outputChannel, async () => {
        if (!lastConnectionInfo) {
          logError(outputChannel, 'Bridge', 'Database visualize', new Error('No stored connection info'));
          panel.webview.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
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

        await runDbPhase2(panel, conn.connectionUri, msg.schemas, progress, token, outputChannel, context.extensionUri, allObjectsCache, conn.connectionInfo.database, sourceName, platformInfoCache, (m) => {
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
          panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        }
      });
    },
    'show-detail': (msg) => {
      logDebug(outputChannel, 'Bridge', `Showing detail for node: ${msg.node?.id}`);
      if (!detailPanel) {
        detailPanel = vscode.window.createWebviewPanel('dataLineageDetail', msg.node.name, vscode.ViewColumn.Beside, { enableScripts: true });
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, context.extensionUri);
        detailPanel.onDidDispose(() => { detailPanel = undefined; });
        detailPanel.webview.onDidReceiveMessage(async (m) => {
          if (m.type === 'table-stats-request') {
            await handleTableStatsRequest(lastConnectionInfo, detailPanel!, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel, context.extensionUri);
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
      logInfo(outputChannel, 'Bridge', 'Database connect requested');
      return withDbProgress(panel, 'Connecting', outputChannel, () => promptForConnection(outputChannel), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1(panel, conn.connectionUri, conn.connectionInfo, outputChannel, context.extensionUri, (r) => { allObjectsCache = r; });
      });
    },
    'check-mssql': () => {
      const available = isMssqlAvailable();
      logDebug(outputChannel, 'Bridge', `MSSQL extension availability check: ${available}`);
      panel.webview.postMessage({ type: 'mssql-status', available });
    },
    'save-view': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Saving filter view: ${msg.profile?.name}`);
      const store = loadProjectStore(context);
      const updated = addFilterProfile(store, msg.projectId, msg.profile as FilterProfile);
      await saveProjectStore(context, updated);
      panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'save-wizard-view': async (msg) => {
      const store = loadProjectStore(context);
      await saveProjectStore(context, { ...store, lastWizardView: msg.view });
    },
    'delete-view': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Deleting filter view: ${msg.profileId}`);
      const store = loadProjectStore(context);
      const updated = deleteFilterProfile(store, msg.projectId, msg.profileId);
      await saveProjectStore(context, updated);
      panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
    },
    'rebuild': async () => {
      logInfo(outputChannel, 'Bridge', 'Rebuild requested');
      const config = await readExtensionConfig(outputChannel, context.extensionUri);
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
      panel.webview.postMessage({ type: 'rebuild-config', config });
    },
    'reload': () => {
      logInfo(outputChannel, 'Bridge', 'Reloading panel');
      panel.dispose();
      openPanel(context, title, getSession, outputChannel, loadProjectStore, saveProjectStore, migrateFromWorkspaceState, loadDemo);
    },
    'request-projects': () => {
      logDebug(outputChannel, 'Bridge', 'Projects list requested');
      const store = loadProjectStore(context);
      panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
    },
    'open-external': async (msg) => {
      if (msg.url) {
        logInfo(outputChannel, 'Bridge', `Opening external URL: ${msg.url}`);
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    },
    'open-settings': () => {
      logInfo(outputChannel, 'Bridge', 'Opening extension settings');
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz');
    },
    'export-file': async (msg) => {
      logInfo(outputChannel, 'Bridge', `Exporting file: ${msg.defaultName}`);
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(msg.defaultName) });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        vscode.commands.executeCommand('revealFileInOS', uri);
      }
    },
    'overview-mode-changed': (msg) => {
      _lastOverviewMode = msg.mode;
    },
    'log': (msg) => {
      const lvl = msg.level ?? 'debug';
      if (lvl === 'info') logInfo(outputChannel, 'Bridge', msg.text);
      else if (lvl === 'warn') logWarn(outputChannel, 'Bridge', msg.text);
      else if (lvl === 'trace') logTrace(outputChannel, 'Bridge', msg.text);
      else logDebug(outputChannel, 'Bridge', msg.text);
    },
    'error': (msg) => {
      logError(outputChannel, 'Bridge', 'Webview error', new Error(msg.error));
      vscode.window.showErrorMessage(`Data Lineage Error: ${msg.error}`);
    }
  };

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

// ─── Helpers ────────────────────────────────────────────────────────────────

async function handleLoadDemo(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, autoVisualize = false, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(outputChannel, context.extensionUri);
  try {
    const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
    logInfo(outputChannel, 'Dacpac', `Loading demo dacpac from: ${demoUri.fsPath}`);
    const data = await vscode.workspace.fs.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength)) return;
    if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
    const model = await extractDacpac(data.buffer as ArrayBuffer);
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, model.nodes.length, model.edges.length, model.schemas.length);
    logInfo(outputChannel, 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    logError(outputChannel, 'Dacpac', 'Load demo', err);
  }
}

async function runDbPhase1(panel: vscode.WebviewPanel, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, onCacheAllObjects: (result: SimpleExecuteResult) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  logInfo(outputChannel, 'DB', 'Running schema preview query');
  const resultMap = await executeDmvQueries(connectionUri, [previewQuery], outputChannel);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const preview = buildSchemaPreview(result);
  const config = await readExtensionConfig(outputChannel, extensionUri);
  panel.webview.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${connectionInfo.server} / ${connectionInfo.database}` });
}

async function runDbPhase2(panel: vscode.WebviewPanel, connectionUri: string, schemas: string[], progress: vscode.Progress<any>, token: vscode.CancellationToken, outputChannel: vscode.LogOutputChannel, extensionUri: vscode.Uri, allObjects?: SimpleExecuteResult, currentDatabase?: string, sourceName?: string, platformInfo?: SimpleExecuteResult, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, extensionUri);
  logInfo(outputChannel, 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
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
      if (res && !token.isCancellationRequested) {
        await phaseFn(res, progress, token);
      } else {
        logInfo(outputChannel, 'DB', `${title} cancelled or failed to connect`);
        panel.webview.postMessage({ type: 'db-cancelled' });
      }
    } catch (err) {
      logError(outputChannel, 'DB', title, err);
      panel.webview.postMessage({ type: 'db-error', message: err instanceof Error ? err.message : String(err), phase: 'connect' });
    }
  });
}

async function handleTableStatsRequest(
  storedConnectionInfo: IConnectionInfo | undefined,
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: ColumnDef[],
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const sampleThreshold = cfg.get<number>('tableStatistics.sampleThreshold', 500000);
  const sampleSize = cfg.get<number>('tableStatistics.sampleSize', 1000);
  const useApprox = cfg.get<boolean>('tableStatistics.useApproxDistinct', true);
  const maxColumns = cfg.get<number>('tableStatistics.maxColumns', 100);

  try {
    if (!statsConnectionUri) {
      logInfo(outputChannel, 'Stats', `Connecting for stats: ${schema}.${objectName}`);
      const result = storedConnectionInfo ? (await connectDirect(storedConnectionInfo, outputChannel) ?? await promptForConnection(outputChannel)) : await promptForConnection(outputChannel);
      if (!result) {
        panel.webview.postMessage({ type: 'table-stats-error', message: 'Connection cancelled.' });
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
    panel.webview.postMessage({ type: 'table-stats-result', stats, mode });
  } catch (err) {
    logError(outputChannel, 'Stats', 'Profiling', err);
    panel.webview.postMessage({ type: 'table-stats-error', message: err instanceof Error ? err.message : String(err) });
  }
}

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
