import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { type AiSession } from '../ai/session';
import { Logger, trunc, sanitizeForLog, logRaw } from '../utils/log';
import { type BridgeHost } from './host';
import {
  type DatabaseModel, type XmlElement, type LineageNode, type ColumnDef, type ParseStats
} from '../engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from '../engine/dacpacExtractor';
import {
  promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
  executeSimpleQuery, getServerInfo, withQueryTimeout,
} from '../engine/connectionManager';
import { type IConnectionInfo, type SimpleExecuteResult } from '../types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult, computeSamplePercent } from '../engine/profilingEngine';
import { type StatsMode } from '../engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview } from '../engine/dmvExtractor';
import { type DmvResults } from '../engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject, isValidProject,
  addFilterProfile, deleteFilterProfile,
  type FilterProfile,
  type ProjectStore,
} from '../engine/projectStore';
import { buildBareGraph } from '../ai/graphUtils';
import { populateColumnStore } from '../engine/modelBuilder';
import {
  DetailPanelToExtensionMsgSchema,
  type MainPanelToExtensionMsg,
} from '../engine/shared/bridgeContract';
import { summarizeZodError } from './host';

/**
 * Maps each main-panel message type to a handler whose `msg` parameter is
 * narrowed to the matching variant of {@link MainPanelToExtensionMsg}.
 */
export type WebviewMessageHandlers = {
  [K in MainPanelToExtensionMsg['type']]: (
    msg: Extract<MainPanelToExtensionMsg, { type: K }>,
  ) => Promise<void> | void;
};

declare const __BUILD_TIMESTAMP__: string;

/** 
 * Storage key for the project store in VS Code's global state.
 */
export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

/**
 * Represents a bundle of message handlers and their associated cleanup logic.
 */
export interface MessageHandlerBundle {
  /** Map of message types to their per-variant handler functions. */
  handlers: WebviewMessageHandlers;
  /** Cleanup function to release resources (e.g., database connections) when the panel is disposed. */
  cleanup: () => Promise<void>;
}

/**
 * Factory for creating the IPC (Inter-Process Communication) bridge between the Extension Host and the Webview.
 */
export function createMessageHandlers(
  host: BridgeHost,
  context: vscode.ExtensionContext,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  loadProjectStore: (context: vscode.ExtensionContext) => ProjectStore,
  saveProjectStore: (context: vscode.ExtensionContext, store: ProjectStore) => Promise<void>,
  migrateFromWorkspaceState: (context: vscode.ExtensionContext) => Promise<void>,
  loadDemoFlag: boolean,
  setDetailPanel: (panel: vscode.WebviewPanel | undefined) => void
): MessageHandlerBundle {

  let cachedElements: XmlElement[] | null = null;
  let cachedDspName = '';
  let lastConnectionInfo: IConnectionInfo | undefined;
  let detailPanel: vscode.WebviewPanel | undefined;
  let lastDetailNode: LineageNode | null = null;

  const statsConnState: { uri: string | undefined } = { uri: undefined };
  let allObjectsCache: SimpleExecuteResult | undefined;
  let platformInfoCache: SimpleExecuteResult | undefined;

  async function cleanupStatsConnection(): Promise<void> {
    if (statsConnState.uri) {
      await disconnectDatabase(statsConnState.uri, outputChannel).catch(err =>
        host.log('debug', 'DB', `Stats disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
      );
      statsConnState.uri = undefined;
    }
  }

  function setCurrentModel(m: DatabaseModel, isDb: boolean, project?: { id: string; name: string } | null): void {
    const sess = getSession();
    sess.columnStore.clear();
    populateColumnStore(m, sess.columnStore);
    sess.model = m;
    sess.graph = buildBareGraph(m);
    sess.isDbSession = isDb;
    if (project) {
      sess.currentProjectId = project.id;
      sess.projectName = project.name;
      const store = loadProjectStore(context);
      const p = store.projects.find((p: any) => p.id === project.id);
      if (isDb) {
        if (p?.connection?.type === 'database') {
          const ci = p.connection.connectionInfo;
          sess.sourceLabel = `database (${ci.server} / ${ci.database})`;
        } else {
          sess.sourceLabel = 'database';
        }
      } else {
        if (p?.connection?.type === 'dacpac') {
          sess.sourceLabel = `dacpac (${path.basename(p.connection.path)})`;
        } else {
          sess.sourceLabel = 'dacpac';
        }
      }
    } else {
      sess.sourceLabel = isDb ? 'database' : 'dacpac';
    }
    host.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
  }

  async function getDetailConfig() {
    const cfg = host.getConfiguration();
    const sess = getSession();
    return {
      isDbMode: sess.isDbSession,
      statsEnabled: cfg.get<boolean>('tableStatistics.enabled', true),
      excludeExternalTables: cfg.get<boolean>('tableStatistics.excludeExternalTables', false),
      standardModeEnabled: cfg.get<boolean>('tableStatistics.standardModeEnabled', true),
    };
  }

  function enrichNodeForDetail(node: LineageNode): LineageNode {
    const sess = getSession();
    const cols = sess.columnStore.getColumns(node.id);
    const ddl = sess.columnStore.getDdl(node.id);
    return { ...node, ...(cols && { columns: cols }), ...(ddl && { bodyScript: ddl }) };
  }

  const handlers: WebviewMessageHandlers = {
    'ready': async () => {
      host.log('info', 'Bridge', 'Webview ready');
      if (loadDemoFlag) {
        await handleLoadDemo(host, getSession, outputChannel, (m) => {
          setCurrentModel(m, false, null);
          getSession().projectName = 'Demo';
        });
        return;
      }
      if (host.getGlobalState().get(PROJECT_STORE_KEY) === undefined) {
        host.log('info', 'Bridge', 'No project store found, triggering migration');
        await migrateFromWorkspaceState(context);
      }
      const config = await readExtensionConfig(host);
      const store = loadProjectStore(context);
      const sess = getSession();
      host.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
      if (sess.model && store.lastOpenedId) {
        const project = store.projects.find((p: any) => p.id === store.lastOpenedId);
        if (project) {
          sess.currentProjectId = project.id;
          sess.projectName = project.name;
          sess.isDbSession = project.connection.type === 'database';
        }
        host.log('info', 'Bridge', `Restoring session for project: ${sess.projectName}`);
        host.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true });
      }
    },
    'show-detail': async (msg) => {
      host.log('debug', 'Bridge', `show-detail: ${msg.node?.id || '(no node)'}`);
      if (msg.node) lastDetailNode = msg.node;

      if (!detailPanel) {
        const title = msg.node ? `Detail: ${msg.node.name}` : 'Detail';
        detailPanel = vscode.window.createWebviewPanel('dataLineageDetail', title, vscode.ViewColumn.Beside, { enableScripts: true });
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, host.getExtensionUri());
        detailPanel.onDidDispose(() => { 
          detailPanel = undefined; 
          setDetailPanel(undefined); 
          host.postMessage({ type: 'detail-closed' });
        });
        setDetailPanel(detailPanel);
        
        detailPanel.webview.onDidReceiveMessage(async (rawM) => {
          const parsed = DetailPanelToExtensionMsgSchema.safeParse(rawM);
          if (!parsed.success) {
            host.log('warn', 'Bridge', `Rejected malformed detail-panel message (type=${rawM?.type ?? '?'}): ${summarizeZodError(parsed.error)}`);
            return;
          }
          const m = parsed.data;
          if (m.type === 'detail-ready') {
            if (lastDetailNode) {
              detailPanel?.webview.postMessage({
                type: 'detail-update',
                node: enrichNodeForDetail(lastDetailNode),
                findQuery: m.findQuery || msg.findQuery,
                config: await getDetailConfig()
              });
            }
          } else if (m.type === 'table-stats-request') {
            await handleTableStatsRequestHost(host, lastConnectionInfo, statsConnState, detailPanel!, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel);
          } else if (m.type === 'close-detail') {
            detailPanel?.dispose();
          }
        });
      } else {
        detailPanel.reveal(vscode.ViewColumn.Beside);
        if (msg.node) {
          detailPanel.title = `Detail: ${msg.node.name}`;
          detailPanel.webview.postMessage({ 
            type: 'detail-update', 
            node: enrichNodeForDetail(msg.node), 
            findQuery: msg.findQuery,
            config: await getDetailConfig()
          });
        }
      }
    },
    'update-detail': async (msg) => {
      if (msg.node) lastDetailNode = msg.node;
      if (detailPanel && msg.node) {
        detailPanel.title = `Detail: ${msg.node.name}`;
        detailPanel.webview.postMessage({
          type: 'detail-update',
          node: enrichNodeForDetail(msg.node),
          findQuery: msg.findQuery,
          config: await getDetailConfig()
        });
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
        const config = await readExtensionConfig(host);
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
      await cleanupStatsConnection();
      
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

          const config = await readExtensionConfig(host);
          const schemas = project.connection.schemas;
          
          if (schemas && schemas.length > 0) {
            host.log('info', 'Bridge', `Extracting filtered dacpac for schemas: ${trunc(schemas, 10)}`);
            const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            const logger = Logger.create(outputChannel, 'Parse');
            const model = extractDacpacFiltered(elements, new Set(schemas), dspName, (msg) => logger.debug(msg));
            setCurrentModel(model, false, { id: project.id, name: project.connection.displayName });
            if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
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
      } else if (project.connection.type === 'database') {
        // Capture narrowed connection — TS loses union narrowing across async closures.
        const dbConn = project.connection;
        await withDbProgressHost(host, 'Loading project', outputChannel, async () => {
          const result = await connectDirect(dbConn.connectionInfo as IConnectionInfo, outputChannel);
          return result ?? await promptForConnection(outputChannel);
        }, async (dbResult, progress, token) => {
          lastConnectionInfo = dbResult.connectionInfo;
          const schemas = dbConn.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1Host(host, dbResult.connectionUri, dbResult.connectionInfo, outputChannel, (r) => { allObjectsCache = r; });
          } else {
            await runDbPhase2Host(host, dbResult.connectionUri, schemas, progress, token, outputChannel, getSession, allObjectsCache, dbResult.connectionInfo.database, dbConn.sourceName, platformInfoCache, (m) => {
              setCurrentModel(m, true, { id: project.id, name: project.name });
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
      await handleLoadDemo(host, getSession, outputChannel, (m) => {
        setCurrentModel(m, false, null);
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
      const config = await readExtensionConfig(host);
      const logger = Logger.create(outputChannel, 'Parse');
      const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName, (msg) => logger.debug(msg));
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      setCurrentModel(model, false, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null);
      if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
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

        await runDbPhase2Host(host, conn.connectionUri, msg.schemas, progress, token, outputChannel, getSession, allObjectsCache, conn.connectionInfo.database, sourceName, platformInfoCache, (m) => {
          if (pendingProject) {
            setCurrentModel(m, true, { id: pendingProject.id, name: pendingProject.name });
          } else {
            setCurrentModel(m, true, null);
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
    'filter-changed': (msg) => {
      const sess = getSession();
      if (msg.uiState) {
        sess.uiState = msg.uiState;
        sess.filter = msg.uiState.filter;
        sess.traceState = msg.uiState.trace;
        sess.graphMode = msg.uiState.graphMode;
        sess.filteredCount = msg.uiState.filteredCount;
        sess.renderLimitHit = msg.uiState.renderLimitHit;
      }
    },
    'db-connect': () => {
      host.log('info', 'Bridge', 'Database connect requested');
      return withDbProgressHost(host, 'Connecting', outputChannel, () => promptForConnection(outputChannel), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1Host(host, conn.connectionUri, conn.connectionInfo, outputChannel, (r) => { allObjectsCache = r; });
      });
    },
    'check-mssql': () => {
      host.postMessage({ type: 'mssql-status', available: vscode.extensions.getExtension('ms-mssql.mssql') !== undefined });
    },
    'save-view': async (msg) => {
      const logger = Logger.create(outputChannel, 'Bridge');
      logger.info(`Saving filter view: "${msg.profile?.name}" (projectId: ${msg.projectId})`);
      try {
        const store = loadProjectStore(context);
        const updated = addFilterProfile(store, msg.projectId, msg.profile as FilterProfile);
        await saveProjectStore(context, updated);
        logger.info(`Successfully saved filter view: "${msg.profile?.name}"`);
        host.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
      } catch (err) {
        logger.error(`Failed to save filter view: "${msg.profile?.name}"`, err);
        throw err;
      }
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
      const config = await readExtensionConfig(host);
      host.postMessage({ type: 'rebuild-config', config });
    },
    'reload': () => {
      host.log('info', 'Bridge', 'Reloading panel');
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
    'log': (msg) => {
      const text = msg.text ?? '';
      const level = msg.level ?? 'debug';
      const hasPrefix = /^\s*\[[A-Za-z][A-Za-z0-9]*\]/.test(text);
      if (hasPrefix) {
        logRaw(outputChannel, level, text);
      } else {
        host.log(level, 'Bridge', text);
      }
    },
    'error': (msg) => {
      host.log('error', 'Bridge', 'Webview error', new Error(msg.error));
      host.showErrorMessage(`Data Lineage Error: ${msg.error}`);
    },
    'show-warning': (msg) => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      host.log('debug', 'Bridge', `show-warning: ${text}`);
      vscode.window.showWarningMessage(`Data Lineage: ${text}`);
    },
    'overview-mode-changed': (msg) => {
      host.log('debug', 'Bridge', `overview-mode-changed: mode=${msg.mode} enteredFocusFromOverview=${msg.enteredFocusFromOverview ?? false}`);
    },
  };

  return {
    handlers,
    cleanup: cleanupStatsConnection,
  };
}

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

function isDacpacTooLarge(bytes: number, host: BridgeHost): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  host.showErrorMessage(`Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
  return true;
}

async function handleLoadDemo(host: BridgeHost, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(host);
  try {
    const demoUri = vscode.Uri.joinPath(host.getExtensionUri(), 'assets', 'demo.dacpac');
    host.log('info', 'Dacpac', `Loading demo dacpac from: ${demoUri.fsPath}`);
    const data = await host.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength, host)) return;
    const logger = Logger.create(outputChannel, 'Parse');
    const model = await extractDacpac(data.buffer as ArrayBuffer, (msg) => logger.debug(msg));
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.log('info', 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    host.log('error', 'Dacpac', 'Load demo', err);
    const msg = err instanceof Error ? err.message : String(err);
    host.showErrorMessage(`Data Lineage: Failed to load demo — ${msg}`);
  }
}

async function runDbPhase1Host(host: BridgeHost, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel, onCacheAllObjects: (result: SimpleExecuteResult) => void) {
  const queries = await loadDmvQueries(outputChannel, host.getExtensionUri());
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  host.log('info', 'DB', 'Running schema preview query');
  const timeoutMs = (host.getConfiguration().get<number>('dmvQueryTimeout') ?? 120) * 1000;
  const resultMap = await executeDmvQueries(connectionUri, [previewQuery], outputChannel, undefined, timeoutMs);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const preview = buildSchemaPreview(result);
  const config = await readExtensionConfig(host);
  host.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${connectionInfo.server} / ${connectionInfo.database}` });
}

async function runDbPhase2Host(host: BridgeHost, connectionUri: string, schemas: string[], progress: vscode.Progress<any>, token: vscode.CancellationToken, outputChannel: vscode.LogOutputChannel, getSession: () => AiSession, allObjects?: SimpleExecuteResult, currentDatabase?: string, sourceName?: string, platformInfo?: SimpleExecuteResult, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, host.getExtensionUri());
  host.log('info', 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
  const timeoutMs = (host.getConfiguration().get<number>('dmvQueryTimeout') ?? 120) * 1000;
  const resultMap = await executeDmvQueriesFiltered(connectionUri, queries, schemas, outputChannel, (step, total, label) => {
    host.postMessage({ type: 'db-progress', step, total, label });
  }, timeoutMs);
  const dmvResults: DmvResults = { nodes: resultMap.get('nodes')!, columns: resultMap.get('columns')!, dependencies: resultMap.get('dependencies')!, allObjects, platformInfo };
  const config = await readExtensionConfig(host);
  const logger = Logger.create(outputChannel, 'Parse');
  logger.info(`Phase 2 Resolution: Starting object parsing for ${dmvResults.nodes.rowCount} nodes...`);
  
  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, config.maxNodes, (msg) => {
    logger.debug(msg);
  });
  
  onModelBuilt?.(model);
  if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
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
  statsConnState: { uri: string | undefined },
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: ColumnDef[],
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Stats');
  const cfg = host.getConfiguration();
  const sampleThreshold = cfg.get('tableStatistics.sampleThreshold', 500000);
  const sampleSize = cfg.get('tableStatistics.sampleSize', 1000);
  const useApprox = cfg.get('tableStatistics.useApproxDistinct', true);
  const maxColumns = cfg.get('tableStatistics.maxColumns', 100);
  const timeoutSec = cfg.get('tableStatistics.queryTimeout', 60);
  const timeoutMs = timeoutSec * 1000;
  const t0 = Date.now();

  try {
    if (!statsConnState.uri) {
      const result = storedConnectionInfo ? (await connectDirect(storedConnectionInfo, outputChannel) ?? await promptForConnection(outputChannel)) : await promptForConnection(outputChannel);
      if (!result) {
        panel.webview.postMessage({ type: 'table-stats-error', message: 'Connection cancelled.' });
        return;
      }
      statsConnState.uri = result.connectionUri;
    }
    const connectionUri = statsConnState.uri!;
    const serverInfo = await getServerInfo(connectionUri, outputChannel);
    const engineEdition = serverInfo.engineEditionId;
    
    const rowCountSql = buildRowCountQuery(schema, objectName);
    const rowCountPromise = executeSimpleQuery(connectionUri, rowCountSql, outputChannel);
    const rowCountResult = await withQueryTimeout(rowCountPromise, timeoutMs, `Row count query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;

    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);
    if (!profilingSql) return;

    let profilingResult;
    try {
      const profilingPromise = executeSimpleQuery(connectionUri, profilingSql, outputChannel);
      profilingResult = await withQueryTimeout(profilingPromise, timeoutMs, `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
    } catch (sampleErr) {
      const needsSampling0 = rowCount > sampleThreshold && sampleThreshold >= 0;
      if (needsSampling0 && /TABLESAMPLE/i.test(sampleErr instanceof Error ? sampleErr.message : String(sampleErr))) {
        const retrySql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, -1, sampleSize);
        if (!retrySql) throw sampleErr;
        const retryPromise = executeSimpleQuery(connectionUri, retrySql, outputChannel);
        profilingResult = await withQueryTimeout(retryPromise, timeoutMs, `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
      } else {
        throw sampleErr;
      }
    }
    const resultRow: Record<string, string> = {};
    for (let i = 0; i < profilingResult.columnInfo.length; i++) {
      resultRow[profilingResult.columnInfo[i].columnName] = profilingResult.rows[0][i].displayValue;
    }

    const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
    const samplePercent = needsSampling ? computeSamplePercent(engineEdition, sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    logger.info(`Table statistics ready (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    panel.webview.postMessage({ type: 'table-stats-result', stats, mode });
  } catch (err) {
    host.log('error', 'Stats', 'Profiling', err);
    panel.webview.postMessage({ type: 'table-stats-error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** 
 * Logs a summary of the SQL parsing results and stores it in the session.
 */
function handleParseStats(stats: ParseStats, outputChannel: vscode.LogOutputChannel, getSession: () => AiSession, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const logger = Logger.create(outputChannel, 'ParseStats');
  const sess = getSession();
  sess.parseStats = {
    resolvedEdges: stats.resolvedEdges,
    parsedRefs: stats.parsedRefs,
    droppedRefs: stats.droppedRefs.length,
  };
  const spCount = stats.spDetails?.length ?? 0;
  if (objectCount !== undefined) {
    logger.info(`Phase 2 Result: Construction Complete — ${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas`);
    logger.info(`Phase 2 Result: Parsing Complete — ${spCount} objects scripted, ${stats.parsedRefs} refs found, ${stats.resolvedEdges} refs resolved`);
    if (stats.droppedRefs.length > 0) {
      logger.info(`Phase 2 Result: Dropped — ${stats.droppedRefs.length} refs unrelated (aliases/built-ins)`);
    }
  }

  // Detailed debug logs for each scripted object
  if (spCount === 0) {
    logger.debug('No scripted objects (procedures/views) with valid definitions found for parsing.');
  }

  for (const sp of stats.spDetails) {
    const inRefs = sp.inRefs?.length ? ` In:[${sp.inRefs.join(', ')}]` : '';
    const outRefs = sp.outRefs?.length ? ` Out:[${sp.outRefs.join(', ')}]` : '';
    logger.debug(`Parsed ${sp.name} — ${sp.inCount + sp.outCount} refs${inRefs}${outRefs}`);
    if (sp.unrelated && sp.unrelated.length > 0) {
      logger.debug(`  Unrelated: ${sp.unrelated.join(', ')}`);
    }
  }
}

async function readExtensionConfig(host: BridgeHost): Promise<any> {
  const cfg = host.getConfiguration();
  return {
    excludePatterns: cfg.get<string[]>('excludePatterns'),
    maxNodes: cfg.get<number>('maxNodes'),
    layout: {
      direction: cfg.get<string>('layout.direction'),
      rankSeparation: cfg.get<number>('layout.rankSeparation'),
      nodeSeparation: cfg.get<number>('layout.nodeSeparation'),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation'),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation'),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled'),
      edgeStyle: cfg.get<string>('layout.edgeStyle'),
    },
    externalRefs: { enabled: cfg.get<boolean>('externalRefs.enabled') },
    overview: { enabled: cfg.get<boolean>('overview.enabled'), threshold: cfg.get<number>('overview.threshold') },
    renderLimit: cfg.get<number>('renderLimit'),
    trace: {
      defaultUpstreamLevels: cfg.get<number>('trace.defaultUpstreamLevels'),
      defaultDownstreamLevels: cfg.get<number>('trace.defaultDownstreamLevels'),
    },
    analysis: {
      hubMinDegree: cfg.get<number>('analysis.hubMinDegree'),
      islandMaxSize: cfg.get<number>('analysis.islandMaxSize'),
      longestPathMinNodes: cfg.get<number>('analysis.longestPathMinNodes'),
    },
  };
}

function getDetailWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "assets", "index.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "assets", "index.js"));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><link rel="stylesheet" type="text/css" href="${stylesUri}"><title>Detail</title></head><body class="vscode-body"><div id="root"></div><script>window.__DETAIL_MODE__ = true;</script><script type="module" src="${scriptUri}"></script></body></html>`;
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

  // ── ENVIRONMENT ──
  add('ENVIRONMENT');
  add(`  Extension:    ${version}`);
  add(`  Build Stamp:  ${buildStamp}`);
  add(`  VS Code:      ${vscode.version}`);
  add(`  OS:           ${os.type()} ${os.release()} (${os.arch()})`);
  add('');

  // ── DATA SOURCE ──
  add('DATA SOURCE');
  add(`  Project:      ${sess.projectName ?? 'N/A'}`);
  add(`  Source:       ${sess.sourceLabel}`);
  add(`  Platform:     ${sess.model?.dbPlatform ?? 'N/A'}`);
  add(`  Parse rules:  ${sess.parseRulesLabel}`);
  add('');

  // ── MODEL ──
  if (sess.model) {
    add('MODEL');
    add(`  Nodes total:  ${sess.model.nodes.length}`);
    add(`  Edges total:  ${sess.model.edges.length}`);
    add(`  Schemas:      ${sess.model.schemas.length}`);
    add('');
    add('  Schemas:');
    add(JSON.stringify(sess.model.schemas, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');
  }

  // ── PARSE STATS ──
  if (sess.parseStats) {
    add('PARSE STATS');
    add(JSON.stringify(sess.parseStats, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');
  }

  // ── GUI STATE ──
  if (sess.uiState) {
    add('GUI STATE');
    add(JSON.stringify(sess.uiState, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');
  }

  // ── AI SESSION ──
  add('AI SESSION');
  add(`  Model:          ${sess.modelName || '(none)'}`);
  add(`  Session ID:     ${sess.id}`);
  add(`  Status:         ${sess.stateMachine?.status ?? 'idle'}`);
  add(`  Hops:           ${sess.hopCount}`);
  if (sess.stateMachine) {
    add('');
    add('STATE MACHINE DUMP (JSON)');
    try {
      add(JSON.stringify(sess.stateMachine.toJSON(), null, 2));
    } catch (err) {
      add(`  Error dumping SM: ${err}`);
    }
  }
  add('');

  // ── SETTINGS ──
  add('SETTINGS (dataLineageViz.*)');
  try {
    const cfg = vscode.workspace.getConfiguration('dataLineageViz');
    const pkg = context.extension.packageJSON;
    const allSettings: Record<string, any> = {};
    const configSections = pkg.contributes?.configuration || [];
    for (const section of configSections) {
      for (const key of Object.keys(section.properties || {})) {
        const shortKey = key.replace('dataLineageViz.', '');
        allSettings[shortKey] = cfg.get(shortKey);
      }
    }
    add(JSON.stringify(allSettings, null, 2));
  } catch (err) {
    add(`  Error reading settings: ${err}`);
  }
  add('');

  return lines.join('\n');
}
