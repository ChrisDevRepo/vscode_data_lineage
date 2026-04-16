import * as vscode from 'vscode';
import * as path from 'path';
import { type AiSession } from '../ai/session';
import { Logger } from '../utils/log';
import { type BridgeHost } from './host';
import {
  type DatabaseModel, type XmlElement, type LineageNode, type ColumnDef
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
import { loadRules, type ParseRulesConfig } from '../engine/sqlBodyParser';
import { type DmvResults } from '../engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject, isValidProject,
  addFilterProfile, deleteFilterProfile,
  type FilterProfile
} from '../engine/projectStore';
import { buildBareGraph } from '../ai/graphUtils';
import { populateColumnStore } from '../engine/modelBuilder';

export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

// State shared between handlers but isolated from the panel lifecycle
let statsConnectionUri: string | undefined;
let allObjectsCache: SimpleExecuteResult | undefined;
let platformInfoCache: SimpleExecuteResult | undefined;

/**
 * Factory for creating message handlers that process requests from the Webview.
 * This is the primary IPC (Inter-Process Communication) bridge.
 */
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
  let detailPanel: vscode.WebviewPanel | undefined;
  let lastDetailNode: any = null;

  function setCurrentModel(m: DatabaseModel, isDb: boolean, project?: { id: string; name: string } | null): void {
    const sess = getSession();
    sess.columnStore.clear();
    populateColumnStore(m, sess.columnStore);
    sess.model = m;
    sess.graph = buildBareGraph(m);
    sess.isDbSession = isDb;
    if (project) { sess.currentProjectId = project.id; sess.projectName = project.name; }
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

  return {
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
    'detail-ready': async (msg) => {
      if (detailPanel && lastDetailNode) {
        detailPanel.webview.postMessage({ 
          type: 'detail-update', 
          node: enrichNodeForDetail(lastDetailNode), 
          findQuery: msg.findQuery,
          config: await getDetailConfig()
        });
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
        
        detailPanel.webview.onDidReceiveMessage(async (m) => {
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
            await handleTableStatsRequestHost(host, lastConnectionInfo, detailPanel!, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel);
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
        host.log('debug', 'Bridge', `update-detail: ${msg.node.id}`);
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
      await cleanupStatsConnection(outputChannel);
      
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
            host.log('info', 'Bridge', `Extracting filtered dacpac for schemas: ${schemas.join(', ')}`);
            if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
            const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            const model = extractDacpacFiltered(elements, new Set(schemas), dspName);
            setCurrentModel(model, false, { id: project.id, name: project.connection.displayName });
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
            await runDbPhase1Host(host, dbResult.connectionUri, dbResult.connectionInfo, outputChannel, (r) => { allObjectsCache = r; });
          } else {
            await runDbPhase2Host(host, dbResult.connectionUri, schemas, progress, token, outputChannel, allObjectsCache, project.connection.connectionInfo.database, project.connection.sourceName, platformInfoCache, (m) => {
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
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
      host.log('info', 'Bridge', 'Running extractDacpacFiltered');
      const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName);
      host.log('info', 'Bridge', `Extracted ${model.nodes.length} nodes and ${model.edges.length} edges`);
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      setCurrentModel(model, false, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null);
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

        await runDbPhase2Host(host, conn.connectionUri, msg.schemas, progress, token, outputChannel, allObjectsCache, conn.connectionInfo.database, sourceName, platformInfoCache, (m) => {
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
      sess.filter = msg.filter;
      sess.views = msg.savedViews;
      host.log('debug', 'Filter', `Active filter updated: ${msg.filter?.schemas?.length || 0} schemas, ${msg.filter?.types?.length || 0} types, ${msg.savedViews?.length || 0} views`);
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
      if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig), outputChannel);
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
      host.log(msg.level ?? 'debug', 'Bridge', msg.text);
    },
    'error': (msg) => {
      host.log('error', 'Bridge', 'Webview error', new Error(msg.error));
      host.showErrorMessage(`Data Lineage Error: ${msg.error}`);
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

function isDacpacTooLarge(bytes: number, host: BridgeHost): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  host.showErrorMessage(`Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
  return true;
}

async function cleanupStatsConnection(outputChannel: vscode.LogOutputChannel) {
  if (statsConnectionUri) {
    await disconnectDatabase(statsConnectionUri, outputChannel).catch(() => {});
    statsConnectionUri = undefined;
  }
}

async function handleLoadDemo(host: BridgeHost, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(host);
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

async function runDbPhase1Host(host: BridgeHost, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel, onCacheAllObjects: (result: SimpleExecuteResult) => void) {
  const queries = await loadDmvQueries(outputChannel, host.getExtensionUri());
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  host.log('info', 'DB', 'Running schema preview query');
  const resultMap = await executeDmvQueries(connectionUri, [previewQuery], outputChannel);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const preview = buildSchemaPreview(result);
  const config = await readExtensionConfig(host);
  host.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${connectionInfo.server} / ${connectionInfo.database}` });
}

async function runDbPhase2Host(host: BridgeHost, connectionUri: string, schemas: string[], progress: vscode.Progress<any>, token: vscode.CancellationToken, outputChannel: vscode.LogOutputChannel, allObjects?: SimpleExecuteResult, currentDatabase?: string, sourceName?: string, platformInfo?: SimpleExecuteResult, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, host.getExtensionUri());
  host.log('info', 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
  const resultMap = await executeDmvQueriesFiltered(connectionUri, queries, schemas, outputChannel, (step, total, label) => {
    host.postMessage({ type: 'db-progress', step, total, label });
  });
  const dmvResults: DmvResults = { nodes: resultMap.get('nodes')!, columns: resultMap.get('columns')!, dependencies: resultMap.get('dependencies')!, allObjects, platformInfo };
  const config = await readExtensionConfig(host);
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
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const cfg = host.getConfiguration();
  const sampleThreshold = cfg.get('tableStatistics.sampleThreshold', 500000);
  const sampleSize = cfg.get('tableStatistics.sampleSize', 1000);
  const useApprox = cfg.get('tableStatistics.useApproxDistinct', true);
  const maxColumns = cfg.get('tableStatistics.maxColumns', 100);
  const timeoutSec = cfg.get('tableStatistics.queryTimeout', 60);
  const timeoutMs = timeoutSec * 1000;

  try {
    if (!statsConnectionUri) {
      host.log('info', 'Stats', `Connecting for stats: ${schema}.${objectName}`);
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
    const rowCountPromise = executeSimpleQuery(connectionUri, rowCountSql, outputChannel);
    const rowCountResult = await withQueryTimeout(rowCountPromise, timeoutMs, `Row count query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;

    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);
    if (!profilingSql) return;

    const profilingPromise = executeSimpleQuery(connectionUri, profilingSql, outputChannel);
    const profilingResult = await withQueryTimeout(profilingPromise, timeoutMs, `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
    const resultRow: Record<string, string> = {};
    for (let i = 0; i < profilingResult.columnInfo.length; i++) {
      resultRow[profilingResult.columnInfo[i].columnName] = profilingResult.rows[0][i].displayValue;
    }

    const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
    const samplePercent = needsSampling ? computeSamplePercent(engineEdition, sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    panel.webview.postMessage({ type: 'table-stats-result', stats, mode });
  } catch (err) {
    host.log('error', 'Stats', 'Profiling', err);
    panel.webview.postMessage({ type: 'table-stats-error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleParseRulesResult(message: {
  loaded: number; skipped: string[]; errors: string[]; usedDefaults: boolean;
}, outputChannel: vscode.LogOutputChannel) {
  const logger = Logger.create(outputChannel, 'Config');
  for (const err of message.errors) logger.debug(err);
  if (message.usedDefaults) logger.warn('YAML invalid — using built-in defaults');
  else if (message.skipped.length > 0) logger.warn(`${message.loaded} loaded, ${message.skipped.length} skipped: ${message.skipped.join(', ')}`);
  else logger.info(`${message.loaded} rules loaded`);
}

function handleParseStats(stats: {
  resolvedEdges: number; spDetails?: { name: string }[];
}, outputChannel: vscode.LogOutputChannel, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const logger = Logger.create(outputChannel, 'Parse');
  const spCount = stats.spDetails?.length ?? 0;
  if (objectCount !== undefined) {
    logger.info(`${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas — ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved`);
  }
}

async function readExtensionConfig(host: BridgeHost): Promise<any> {
  const cfg = host.getConfiguration();
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

  add(`Data Lineage Viz — Debug Info`);
  add(`Generated: ${new Date().toISOString()}`);
  add('');
  add('ENVIRONMENT');
  add(`  Extension:    ${version}`);
  add(`  VS Code:      ${vscode.version}`);
  add('');
  add('DATA SOURCE');
  if (!sess.model) {
    add('  Model loaded: No');
  } else {
    add('  Model loaded: Yes');
    add(`  Project:      ${sess.projectName ?? 'N/A'}`);
    add(`  Platform:     ${sess.model.dbPlatform ?? 'N/A'}`);
    add(`  Nodes:        ${sess.model.nodes.length}`);
    add(`  Edges:        ${sess.model.edges.length}`);
  }
  add('');
  add('AI SESSION');
  add(`  Session ID:   ${sess.id}`);
  add(`  Status:       ${sess.stateMachine?.status ?? 'idle'}`);
  add(`  Hops:         ${sess.hopCount}`);
  if (sess.stateMachine) {
    add('');
    add('STATE MACHINE DUMP (JSON)');
    try {
      add(JSON.stringify(sess.stateMachine.toJSON(), null, 2));
    } catch (err) {
      add(`  Error dumping SM: ${err}`);
    }
  }

  return lines.join('\n');
}
