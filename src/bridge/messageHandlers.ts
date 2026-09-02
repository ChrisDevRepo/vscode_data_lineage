import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { type AiSession } from '../ai/session/session';
import {
  Logger,
  trunc,
  sanitizeForLog,
  safeStringifyForLog,
  LOG_TRUNC_JSON,
  type LogCategory,
} from '../utils/log';
import { notifyError, notifyWarning } from '../utils/notifications';
import { type BridgeHost } from './host';
import {
  type DatabaseModel, type XmlElement, type LineageNode, type ColumnDef, type ParseStats, DEFAULT_CONFIG,
  UNKNOWN_DB_PLATFORM,
} from '../engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from '../engine/dacpacExtractor';
import {
  promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
  executeSimpleQuery, getServerInfo, withQueryTimeout, isPhase2Query, MSSQL_EXTENSION_ID, type DmvQuery,
} from '../engine/connectionManager';
import { type IConnectionInfo, type SimpleExecuteResult } from '../types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult, computeSamplePercent } from '../engine/profilingEngine';
import { type StatsMode } from '../engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview, mapServerInfoPlatform, validateQueryResult, type DmvResults } from '../engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject,
  addFilterProfile, deleteFilterProfile,
  type ProjectStore,
} from '../engine/projectStore';
import { buildBareGraph } from '../ai/support/graphUtils';
import { buildStoredRun, clearStoredRun, writeStoredRun } from '../ai/session/runStore';
import { populateColumnStore } from '../engine/modelBuilder';
import { summarizeModelConnectivity, formatModelConnectivity } from '../engine/schemaAdjacency';
import { formatRenderConnectivity, type RenderConnectivity } from '../engine/renderConnectivity';
import { formatScreenStateSections, type RenderStateSnapshot, type ScreenStateExtras } from './debugDumpScreenState';
import {
  BRIDGE_PROTOCOL_VERSION,
  DetailPanelToExtensionMsgSchema,
  ProjectSchema,
  type BridgeEnvelope,
  type MainPanelToExtensionMsg,
  type Project,
} from '../engine/shared/bridgeContract';
import { summarizeZodError, postToDetail } from './host';

/**
 * Maps each main-panel message type to a handler whose `msg` parameter is
 * narrowed to the matching variant of {@link MainPanelToExtensionMsg}.
 */
export type WebviewMessageHandlers = {
  [K in MainPanelToExtensionMsg['type']]: (
    msg: Extract<MainPanelToExtensionMsg, { type: K }>,
  ) => Promise<void> | void;
};

/**
 * Panel-lived connection state for table profiling.
 *
 * @remarks
 * `pending` holds the connection negotiation currently in flight, so concurrent stats requests
 * join it rather than each opening their own connection.
 */
type StatsConnState = { uri: string | undefined; pending: Promise<string | undefined> | null };

declare const __BUILD_TIMESTAMP__: string;

/** Maximum number of recent webview errors retained for diagnostics. */
const MAX_LAST_ERRORS = 10;

const WEBVIEW_LOG_CATEGORIES: Readonly<Record<string, LogCategory>> = {
  ai: 'AI',
  bridge: 'Bridge',
  config: 'Config',
  db: 'DB',
  dacpac: 'Dacpac',
  detail: 'Detail',
  filter: 'Filter',
  parse: 'Parse',
  project: 'Project',
  stats: 'Stats',
  trace: 'Filter',
  graph: 'Bridge',
  saveview: 'Project',
};

function parseWebviewLog(text: string): { category: LogCategory; message: string } {
  const match = /^\s*\[([A-Za-z][A-Za-z0-9]*)\]\s*/.exec(text);
  if (!match) return { category: 'Bridge', message: text };
  return {
    category: WEBVIEW_LOG_CATEGORIES[match[1].toLowerCase()] ?? 'Bridge',
    message: text.slice(match[0].length),
  };
}

/**
 * Splits a project list into the records the webview contract accepts and those it rejects.
 *
 * @remarks
 * The send path validates the whole frame, so one unacceptable record used to cost every project in
 * it — the webview then kept an empty or stale list for the rest of the session. Partitioning first
 * keeps that failure proportional: the readable projects still arrive, and the rejected one is named
 * in the log. This does not soften the contract — {@link ProjectSchema} stays strict, and a record
 * it rejects is still not replayed.
 *
 * @param projects - Records loaded from the project store.
 * @returns The records that validate, plus one issue summary per record that does not.
 */
export function partitionSendableProjects(
  projects: readonly Project[],
): { sendable: Project[]; rejected: Array<{ id: string; issues: string }> } {
  const sendable: Project[] = [];
  const rejected: Array<{ id: string; issues: string }> = [];
  for (const project of projects) {
    const parsed = ProjectSchema.safeParse(project);
    if (parsed.success) sendable.push(parsed.data);
    else rejected.push({ id: project?.id ?? '(no id)', issues: summarizeZodError(parsed.error) });
  }
  return { sendable, rejected };
}

function postProjectsList(host: BridgeHost, store: ProjectStore): void {
  const { sendable, rejected } = partitionSendableProjects(store.projects);
  for (const record of rejected) {
    host.log('warn', 'Bridge', `Project "${record.id}" was not sent to the view — ${record.issues}`);
  }
  void host.postMessage({
    type: 'projects-list',
    projects: sendable,
    lastOpenedId: store.lastOpenedId,
    lastWizardView: store.lastWizardView,
  });
}

interface WebviewErrorEntry {
  timestamp: number;
  source: string;
  message: string;
  stack?: string;
  componentStack?: string;
  context?: unknown;
}

interface UiDiagnosticsState {
  renderState: unknown | null;
  lastUiSyncAt: number | null;
  lastErrors: WebviewErrorEntry[];
}

const uiDiagnosticsBySession = new WeakMap<AiSession, UiDiagnosticsState>();

function getUiDiagnostics(sess: AiSession): UiDiagnosticsState {
  let state = uiDiagnosticsBySession.get(sess);
  if (!state) {
    state = { renderState: null, lastUiSyncAt: null, lastErrors: [] };
    uiDiagnosticsBySession.set(sess, state);
  }
  return state;
}

function recordWebviewError(sess: AiSession, entry: WebviewErrorEntry): void {
  const state = getUiDiagnostics(sess);
  state.lastErrors.push(entry);
  if (state.lastErrors.length > MAX_LAST_ERRORS) state.lastErrors.shift();
}

/**
 * Storage key for the project store in VS Code's global state.
 */
export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

/**
 * Reports whether the SQL Server (mssql) extension is reachable from this host.
 *
 * @remarks
 * `getExtension` returns `undefined` for a disabled extension exactly as for a missing one, so this
 * single answer covers both states and the webview needs no third value.
 *
 * @returns True when the extension is installed and enabled.
 */
export function isMssqlAvailable(): boolean {
  return vscode.extensions.getExtension(MSSQL_EXTENSION_ID) !== undefined;
}

/**
 * Represents a bundle of message handlers and their associated cleanup logic.
 */
export interface MessageHandlerBundle {
  /** Map of message types to their per-variant handler functions. */
  handlers: WebviewMessageHandlers;
  /** Cleanup function to release resources (e.g., database connections) when the panel is disposed. */
  cleanup: () => Promise<void>;
  /** Function to programmatically trigger the demo load when the panel is already active. */
  triggerDemoLoad: () => Promise<void>;
}

/**
 * Installs a freshly built model as the session's current one.
 *
 * @remarks
 * Deliberately panel-independent — it never posts to a webview, so a command-driven load
 * (`dataLineageViz.openExternalProject`) leaves the session in exactly the state a
 * bridge-driven load does: column store repopulated (column tracing reads it), source
 * labels set, and `dataLineageViz.modelLoaded` raised so the model-gated language-model tools
 * become available.
 *
 * The lineage store is opened for `project` only, fire-and-forget: an ad-hoc or demo load gets no
 * store, and a storage failure degrades to storage-off rather than failing the model install. The
 * snapshot is captured synchronously here because the write runs later on the storage queue — a
 * payload read at write time could be read after the session had replaced the model it came from.
 *
 * @param sess - Session to install the model into.
 * @param model - Model just extracted from a dacpac or from DMV results.
 * @param isDb - Whether the model came from a live database rather than a dacpac.
 * @param project - Project identity when the load is backed by a stored project.
 * @param store - Project store consulted for the human-readable source label; read only when `project` is set.
 */
export function applyModelToSession(
  sess: AiSession,
  model: DatabaseModel,
  isDb: boolean,
  project?: { id: string; name: string } | null,
  store?: ProjectStore | null,
): void {
  sess.columnStore.clear();
  sess.clearDiscoveryTranscript(); // a new model invalidates prior-turn chat memory
  populateColumnStore(model, sess.columnStore);
  sess.model = model;
  sess.graph = buildBareGraph(model);
  sess.isDbSession = isDb;
  if (project) {
    sess.currentProjectId = project.id;
    sess.projectName = project.name;
    const p = store?.projects.find((p) => p.id === project.id);
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
  void vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
}

/**
 * Factory for creating the IPC (Inter-Process Communication) bridge between the Extension Host and the Webview.
 *
 * @param host - Bridge host used to interact with VS Code.
 * @param context - Extension context for global state and subscriptions.
 * @param getSession - Factory for retrieving the current AI session.
 * @param outputChannel - Output channel used for logging.
 * @param loadProjectStore - Loader for the persisted project store.
 * @param saveProjectStore - Persister for project-store updates.
 * @param migrateFromWorkspaceState - Migration helper for legacy workspace state.
 * @param loadDemoFlag - Whether demo data should be loaded instead of a persisted project.
 * @param setDetailPanel - Setter for the current detail panel reference.
 *
 * @returns The per-message-type handler map plus the panel-dispose cleanup function.
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

  // `pending` single-flights the connection negotiation. The detail panel's message listener is
  // async and VS Code does not serialize it, so two table-stats requests can both observe an
  // empty `uri` and each negotiate their own connection — the second overwriting the first.
  const statsConnState: StatsConnState = { uri: undefined, pending: null };
  async function cleanupStatsConnection(): Promise<void> {
    if (statsConnState.uri) {
      await disconnectDatabase(statsConnState.uri, outputChannel).catch(err =>
        host.log('warn', 'DB', `Stats disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
      );
      statsConnState.uri = undefined;
    }
  }

  function setCurrentModel(m: DatabaseModel, isDb: boolean, project?: { id: string; name: string } | null): void {
    applyModelToSession(getSession(), m, isDb, project, project ? loadProjectStore(context) : null);
  }

  /** Clears a filter view's stored AI run record, logging rather than throwing on failure. */
  async function clearStoredRunLogged(profileId: string): Promise<void> {
    try {
      await clearStoredRun(context.globalState, profileId);
    } catch (err) {
      host.log('warn', 'Bridge', `Failed to clear AI run memory for view ${profileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function getDetailConfig() {
    const cfg = host.getConfiguration();
    const sess = getSession();
    return {
      isDbMode: sess.isDbSession,
      statsEnabled: cfg.get<boolean>('tableStatistics.enabled', DEFAULT_CONFIG.tableStatistics.enabled),
      excludeExternalTables: cfg.get<boolean>('tableStatistics.excludeExternalTables', DEFAULT_CONFIG.tableStatistics.excludeExternalTables),
      standardModeEnabled: cfg.get<boolean>('tableStatistics.standardModeEnabled', DEFAULT_CONFIG.tableStatistics.standardModeEnabled),
    };
  }

  function enrichNodeForDetail(node: LineageNode): LineageNode {
    const sess = getSession();
    const cols = sess.columnStore.getColumns(node.id);
    const ddl = sess.columnStore.getDdl(node.id);
    return { ...node, ...(cols && { columns: cols }), ...(ddl && { bodyScript: ddl }) };
  }

  const bridgeLogger = Logger.create(outputChannel, 'Bridge');
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
      postProjectsList(host, store);
      if (sess.model && store.lastOpenedId) {
        const project = store.projects.find(p => p.id === store.lastOpenedId);
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
      host.log('info', 'Bridge', `Node detail opened — ${msg.node?.id || '(no node)'}`);
      if (msg.node) {
        lastDetailNode = msg.node;
      } else {
        lastDetailNode = null;
      }

      if (!detailPanel) {
        const title = msg.node ? `Detail: ${msg.node.name}` : 'Detail';
        detailPanel = vscode.window.createWebviewPanel('dataLineageDetail', title, vscode.ViewColumn.Beside, {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(host.getExtensionUri(), 'dist'), vscode.Uri.joinPath(host.getExtensionUri(), 'images')],
        });
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, host.getExtensionUri());
        detailPanel.onDidDispose(() => {
          detailPanel = undefined;
          setDetailPanel(undefined);
          host.postMessage({ type: 'detail-closed' });
        });
        setDetailPanel(detailPanel);

        detailPanel.webview.onDidReceiveMessage(async (rawM) => {
          // Same envelope gate as the main panel: detail→host frames are unstamped, so only a
          // present-but-wrong version proves the two bundles disagree about the message shapes.
          const inboundVersion = (rawM as BridgeEnvelope | undefined)?.protocolVersion;
          if (inboundVersion !== undefined && inboundVersion !== BRIDGE_PROTOCOL_VERSION) {
            notifyError(
              bridgeLogger,
              'Bridge protocol mismatch (detail panel)',
              `Data Lineage: the detail panel is speaking bridge protocol v${safeStringifyForLog(inboundVersion)} but this extension expects v${BRIDGE_PROTOCOL_VERSION}. Reload the window to pick up the matching view.`,
            );
            return;
          }
          const parsed = DetailPanelToExtensionMsgSchema.safeParse(rawM);
          if (!parsed.success) {
            host.log('warn', 'Bridge', `Rejected malformed detail-panel message (type=${rawM?.type ?? '?'}): ${summarizeZodError(parsed.error)}`);
            return;
          }
          try {
            const m = parsed.data;
            if (m.type === 'detail-ready') {
              if (lastDetailNode && detailPanel) {
                void postToDetail(detailPanel, {
                  type: 'detail-update',
                  node: enrichNodeForDetail(lastDetailNode),
                  findQuery: m.findQuery || msg.findQuery,
                  config: await getDetailConfig()
                }, bridgeLogger);
              } else if (detailPanel) {
                void postToDetail(detailPanel, { type: 'detail-clear' }, bridgeLogger);
              }
            } else if (m.type === 'table-stats-request') {
              if (detailPanel) {
                await handleTableStatsRequestHost(host, lastConnectionInfo, statsConnState, detailPanel, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel);
              }
            } else if (m.type === 'close-detail') {
              detailPanel?.dispose();
            } else if (m.type === 'error') {
              await handlers.error(m);
            } else if (m.type === 'show-warning') {
              await handlers['show-warning'](m);
            }
          } catch (err) {
            host.log('error', 'Bridge', 'Detail panel handler threw unexpectedly', err instanceof Error ? err : new Error(String(err)));
          }
        });
      } else {
        detailPanel.reveal(vscode.ViewColumn.Beside);
        if (msg.node) {
          detailPanel.title = `Detail: ${msg.node.name}`;
          void postToDetail(detailPanel, {
            type: 'detail-update',
            node: enrichNodeForDetail(msg.node),
            findQuery: msg.findQuery,
            config: await getDetailConfig()
          }, bridgeLogger);
        } else {
          detailPanel.title = 'Detail';
          void postToDetail(detailPanel, { type: 'detail-clear' }, bridgeLogger);
        }
      }
    },
    'update-detail': async (msg) => {
      if (msg.node) {
        lastDetailNode = msg.node;
      } else {
        lastDetailNode = null;
      }
      if (detailPanel) {
        if (msg.node) {
          detailPanel.title = `Detail: ${msg.node.name}`;
          void postToDetail(detailPanel, {
            type: 'detail-update',
            node: enrichNodeForDetail(msg.node),
            findQuery: msg.findQuery,
            config: await getDetailConfig()
          }, bridgeLogger);
        } else {
          detailPanel.title = 'Detail';
          void postToDetail(detailPanel, { type: 'detail-clear' }, bridgeLogger);
        }
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
        if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;
        const config = await readExtensionConfig(host);
        const { preview, elements, dspName } = await extractSchemaPreview(data);
        cachedElements = elements; cachedDspName = dspName;
        host.postMessage({
          type: 'dacpac-schema-preview',
          preview,
          config,
          sourceName: path.basename(uris[0].fsPath, '.dacpac'),
          filePath: uris[0].fsPath
        });
        host.log('info', 'Dacpac', `Schema preview — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
      } else {
        host.log('info', 'Bridge', 'Dacpac picker cancelled');
        host.postMessage({ type: 'db-cancelled' });
      }
    },
    'load-project': async (msg) => {
      host.log('info', 'Bridge', `Loading project: ${msg.id}`);
      await cleanupStatsConnection();

      const store = loadProjectStore(context);
      const project = store.projects.find(p => p.id === msg.id);
      if (!project) {
        host.log('error', 'Bridge', 'Load project', new Error(`Project not found: ${msg.id}`));
        host.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}`, phase: 'connect' });
        return;
      }

      if (project.connection.type === 'dacpac') {
        try {
          const fileUri = vscode.Uri.file(project.connection.path);
          host.log('debug', 'Bridge', `Reading dacpac file: ${fileUri.fsPath}`);
          const data = await host.readFile(fileUri);
          if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;

          const refreshed = { ...project, updatedAt: new Date().toISOString() };
          const updatedStore = updateProject(store, refreshed);
          await saveProjectStore(context, updatedStore);
          postProjectsList(host, updatedStore);

          const config = await readExtensionConfig(host);
          const schemas = project.connection.schemas;

          if (schemas && schemas.length > 0) {
            host.log('debug', 'Bridge', `Extracting filtered dacpac for schemas: ${trunc(schemas, 10)}`);
            const { elements, dspName } = await extractSchemaPreview(data);
            const logger = Logger.create(outputChannel, 'Parse');
            const model = extractDacpacFiltered(elements, new Set(schemas), dspName, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
              externalRefsEnabled: config.externalRefs.enabled,
              maxNodes: config.maxNodes,
            });
            logger.info(`Dacpac filtered — ${model.nodes.length} nodes, ${model.edges.length} edges`);
            setCurrentModel(model, false, { id: project.id, name: project.connection.displayName });
            if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
            host.postMessage({ type: 'dacpac-model', model, config, sourceName: project.connection.displayName });
          } else {
            host.log('debug', 'Bridge', 'No schemas in project, showing preview');
            const { preview, elements, dspName } = await extractSchemaPreview(data);
            cachedElements = elements; cachedDspName = dspName;
            host.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: project.connection.displayName });
            host.log('info', 'Dacpac', `Schema preview — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
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
        await withDbProgressHost(host, 'Loading project', async () => {
          const result = await connectDirect(dbConn.connectionInfo as IConnectionInfo, outputChannel);
          return result ?? await promptForConnection(outputChannel);
        }, async (dbResult) => {
          lastConnectionInfo = dbResult.connectionInfo;
          const schemas = dbConn.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1Host(host, dbResult.connectionUri, dbResult.connectionInfo, outputChannel);
          } else {
            await runDbPhase2Host(host, dbResult.connectionUri, schemas, outputChannel, getSession, dbResult.connectionInfo.database, dbConn.sourceName, (m) => {
              setCurrentModel(m, true, { id: project.id, name: project.name });
            });
            // Re-narrow on write-back: the record must carry only allow-listed fields, whoever
            // touched the object in between. `stripSensitiveFields` throws on a record the read
            // side would reject — at save time, by the owning layer's contract, never silently.
            const refreshed = {
              ...project,
              connection: { ...dbConn, connectionInfo: stripSensitiveFields(dbConn.connectionInfo as IConnectionInfo) },
              updatedAt: new Date().toISOString(),
            };
            const updatedStore = updateProject(store, refreshed);
            await saveProjectStore(context, updatedStore);
            postProjectsList(host, updatedStore);
          }
        });
      }
    },
    'save-project': async (msg) => {
      host.log('debug', 'Bridge', `Saving project: ${msg.project?.name}`);
      const store = loadProjectStore(context);
      const updated = updateProject(store, msg.project);
      await saveProjectStore(context, updated);
      const sess = getSession();
      sess.currentProjectId = msg.project.id;
      sess.projectName = msg.project.name;
      postProjectsList(host, updated);
    },
    'delete-project': async (msg) => {
      host.log('debug', 'Bridge', `Deleting project: ${msg.id}`);
      const store = loadProjectStore(context);
      // Captured before the delete: the profiles vanish with the project, and each may file an AI run record.
      const profileIds = (store.projects.find(p => p.id === msg.id)?.filterProfiles ?? []).map(fp => fp.id);
      const updated = deleteProject(store, msg.id);
      await saveProjectStore(context, updated);
      postProjectsList(host, updated);
      for (const profileId of profileIds) {
        await clearStoredRunLogged(profileId);
      }
    },
    'load-demo': async () => {
      host.log('debug', 'Bridge', 'Loading demo');
      await handleLoadDemo(host, getSession, outputChannel, (m) => {
        setCurrentModel(m, false, null);
        getSession().projectName = 'Demo';
      });
    },
    'dacpac-visualize': async (msg) => {
      host.log('debug', 'Bridge', `Dacpac visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      if (!cachedElements) {
        host.log('error', 'Bridge', 'Dacpac visualize', new Error('Session expired (cachedElements is null)'));
        host.postMessage({ type: 'db-error', message: 'Session expired. Please reopen the file.', phase: 'extract' });
        return;
      }
      const config = await readExtensionConfig(host);
      const logger = Logger.create(outputChannel, 'Parse');
      const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
        externalRefsEnabled: config.externalRefs.enabled,
        maxNodes: config.maxNodes,
      });
      logger.info(`Dacpac filtered — ${model.nodes.length} nodes, ${model.edges.length} edges`);
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      setCurrentModel(model, false, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null);
      if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
      host.postMessage({ type: 'dacpac-model', model, config, sourceName: projectName });
    },
    'db-visualize': async (msg) => {
      host.log('debug', 'Bridge', `Database visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      return withDbProgressHost(host, 'Loading selected schemas', async () => {
        if (!lastConnectionInfo) {
          host.log('error', 'Bridge', 'Database visualize', new Error('No stored connection info'));
          host.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
          return undefined;
        }
        return (await connectDirect(lastConnectionInfo, outputChannel)) ?? await promptForConnection(outputChannel);
      }, async (conn, _progress, token) => {
        const sourceName = `${conn.connectionInfo.server} / ${conn.connectionInfo.database}`;
        let pendingProject: ReturnType<typeof createProject> | null = null;
        if (msg.projectName) {
          try {
            pendingProject = createProject(msg.projectName, {
              type: 'database',
              connectionInfo: stripSensitiveFields(conn.connectionInfo),
              sourceName,
              schemas: msg.schemas,
            });
          } catch (err) {
            // The graph still loads; only persistence is skipped, and the user learns it now
            // rather than through a silently missing project on the next start.
            notifyWarning(
              Logger.create(outputChannel, 'DB'),
              'Persist database project',
              `Data Lineage: the project "${msg.projectName}" could not be saved — the connection info failed validation. The graph still loads.`,
              { sourceName, error: err },
            );
          }
        }

        await runDbPhase2Host(host, conn.connectionUri, msg.schemas, outputChannel, getSession, conn.connectionInfo.database, sourceName, (m) => {
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
          postProjectsList(host, updated);
        }
      });
    },
    'filter-changed': (msg) => {
      const sess = getSession();
      if (msg.uiState) {
        const prevCount = sess.filteredCount;
        const prevHit = sess.renderLimitHit;
        sess.uiState = msg.uiState;
        sess.filter = msg.uiState.filter;
        sess.traceState = msg.uiState.trace;
        sess.graphMode = msg.uiState.graphMode;
        sess.filteredCount = msg.uiState.filteredCount;
        sess.renderLimitHit = msg.uiState.renderLimitHit;
        getUiDiagnostics(sess).lastUiSyncAt = Date.now();
        if (prevCount !== msg.uiState.filteredCount || prevHit !== msg.uiState.renderLimitHit) {
          host.log('debug', 'Filter', `State sync — ${msg.uiState.filteredCount ?? '?'} nodes, renderLimitHit=${msg.uiState.renderLimitHit ?? 0}`);
        }
      }
    },
    'render-state': (msg) => {
      const sess = getSession();
      const state = getUiDiagnostics(sess);
      const renderState = msg.renderState ?? null;
      state.renderState = renderState;
      sess.renderState = renderState;
      state.lastUiSyncAt = Date.now();
    },
    'db-connect': () => {
      host.log('debug', 'Bridge', 'Database connect requested');
      return withDbProgressHost(host, 'Connecting', () => promptForConnection(outputChannel), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1Host(host, conn.connectionUri, conn.connectionInfo, outputChannel);
      });
    },
    'check-mssql': () => {
      host.postMessage({ type: 'mssql-status', available: isMssqlAvailable() });
    },
    'save-view': async (msg) => {
      const logger = Logger.create(outputChannel, 'Bridge');
      logger.debug(`Saving filter view: "${msg.profile?.name}" (projectId: ${msg.projectId})`);
      try {
        const store = loadProjectStore(context);
        const updated = addFilterProfile(store, msg.projectId, msg.profile);
        await saveProjectStore(context, updated);
        logger.info(`Successfully saved filter view: "${msg.profile?.name}"`);
        postProjectsList(host, updated);
        try {
          const sess = getSession();
          const run = buildStoredRun(msg.profile, sess.presentationArtifact, id => sess.columnStore.getDdl(id));
          if (run) {
            const chars = await writeStoredRun(context.globalState, msg.profile.id, run);
            logger.debug(`AI run memory stored for "${msg.profile?.name}" (${chars} chars).`);
          } else {
            // A save under an existing id replaces that profile in place, so a record filed under it
            // by an earlier run would survive and be recalled against a scope it no longer describes.
            // Writing and clearing are the two halves of one decision. A no-op for a profile that
            // never had a record.
            await clearStoredRun(context.globalState, msg.profile.id);
          }
        } catch (runErr) {
          logger.warn(`Failed to store AI run memory for "${msg.profile?.name}": ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        }
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
      host.log('debug', 'Bridge', `Deleting filter view: ${msg.profileId}`);
      const store = loadProjectStore(context);
      const updated = deleteFilterProfile(store, msg.projectId, msg.profileId);
      await saveProjectStore(context, updated);
      postProjectsList(host, updated);
      await clearStoredRunLogged(msg.profileId);
    },
    'rebuild': async () => {
      host.log('debug', 'Bridge', 'Rebuild requested');
      // The column store is a pure projection of `sess.model` (`populateColumnStore` is its only
      // writer), and a rebuild only re-reads configuration — the model is untouched. Clearing here
      // emptied the store with nothing to refill it, which blanked the detail panel's columns and
      // made every stored run report `stale` (an absent DDL hashes to `unknown`, never matching the
      // saved digest). Reset belongs to `applyModelToSession`, the actual model-load path.
      const config = await readExtensionConfig(host);
      host.postMessage({ type: 'rebuild-config', config });
    },
    'reload': () => {
      host.log('debug', 'Bridge', 'Reloading panel');
      host.executeCommand('dataLineageViz.open');
    },
    'request-projects': () => {
      host.log('debug', 'Bridge', 'Projects list requested');
      const store = loadProjectStore(context);
      postProjectsList(host, store);
    },
    'open-external': async (msg) => {
      if (msg.url) {
        host.log('debug', 'Bridge', `Opening external URL: ${msg.url}`);
        await host.openExternal(msg.url);
      }
    },
    'open-settings': () => {
      host.log('debug', 'Bridge', 'Opening extension settings');
      host.executeCommand('workbench.action.openSettings', 'dataLineageViz');
    },
    'export-file': async (msg) => {
      host.log('debug', 'Bridge', `Exporting file: ${msg.defaultName}`);
      const uri = await host.showSaveDialog({ defaultUri: vscode.Uri.file(msg.defaultName) });
      if (uri) {
        await host.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        host.executeCommand('revealFileInOS', uri);
      }
    },
    'log': (msg) => {
      const level = msg.level ?? 'debug';
      const { category, message } = parseWebviewLog(msg.text ?? '');
      host.log(level, category, message);
    },
    'error': (msg) => {
      const source = msg.source ?? 'unknown';
      const logger = Logger.create(outputChannel, 'Bridge');
      // Reconstruct an Error carrying the webview's original stack so downstream
      // consumers see the real throw site, not the rethrow point in the extension.
      const err = new Error(msg.error);
      if (msg.stack) err.stack = msg.stack;
      const componentLine = msg.componentStack
        ? trunc(sanitizeForLog(msg.componentStack), LOG_TRUNC_JSON)
        : '(no React tree)';
      const contextLine = msg.context
        ? safeStringifyForLog(msg.context, 500)
        : '(no context)';

      // Retain for the debug dump's LAST ERRORS section — the context carries the full
      // current-screen snapshot, so a crash is reproducible from the dump alone.
      recordWebviewError(getSession(), {
        timestamp: msg.timestamp ?? Date.now(),
        source,
        message: msg.error,
        stack: msg.stack ? trunc(sanitizeForLog(msg.stack), 600) : undefined,
        componentStack: componentLine,
        context: msg.context,
      });

      // A render-boundary crash auto-reloads the panel — say so plainly. Other sources
      // (window error, unhandled rejection) just report the failure.
      const userMessage = source === 'error-boundary'
        ? 'Data Lineage hit an error and is reloading the view — see the "Data Lineage Viz" Output channel for details.'
        : 'Data Lineage encountered an unexpected error — see the "Data Lineage Viz" Output channel for details.';

      // Full detail (message + stack + component tree + screen context) is written to the
      // Output channel at error level by notifyError, before the concise toast.
      notifyError(
        logger,
        `Webview ${source}`,
        userMessage,
        err,
        { messageType: 'error', source, component: componentLine, context: contextLine },
        host.showErrorMessage,
      );
    },
    'show-warning': (msg) => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      notifyWarning(
        Logger.create(outputChannel, 'Bridge'),
        'Webview warning notification',
        `Data Lineage: ${text}`,
        { messageType: 'show-warning', text },
      );
    },
    'view-render-result': (msg) => {
      const logger = Logger.create(outputChannel, 'Bridge');
      if (msg.of === 0) return;
      if (msg.rendered === msg.of) {
        logger.debug(`AI view rendered — ${msg.rendered}/${msg.of} nodes resolved`);
      } else if (msg.rendered > 0) {
        logger.info(`AI view rendered ${msg.rendered}/${msg.of} — ${msg.unresolved.length} scoped id(s) not in the loaded model: ${trunc(msg.unresolved.join(', '), 200)}`);
      } else {
        logger.warn(`AI view rendered 0/${msg.of} — none of the scoped objects are in the loaded render model. unresolved: ${trunc(msg.unresolved.join(', '), 200)}`);
      }
    },
  };

  return {
    handlers,
    cleanup: cleanupStatsConnection,
    triggerDemoLoad: () => handleLoadDemo(host, getSession, outputChannel, (m) => {
      setCurrentModel(m, false, null);
      getSession().projectName = 'Demo';
    }),
  };
}

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

function isDacpacTooLarge(bytes: number, host: BridgeHost, outputChannel: vscode.LogOutputChannel): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  notifyError(
    Logger.create(outputChannel, 'Dacpac'),
    'Validate dacpac size',
    `Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`,
    new Error(`DACPAC size ${bytes} exceeds ${MAX_DACPAC_BYTES}`),
    { bytes, maxBytes: MAX_DACPAC_BYTES },
    host.showErrorMessage,
  );
  return true;
}

async function handleLoadDemo(host: BridgeHost, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = await readExtensionConfig(host);
  try {
    const demoUri = vscode.Uri.joinPath(host.getExtensionUri(), 'assets', 'demo.dacpac');
    host.log('debug', 'Dacpac', `Loading demo dacpac from: ${demoUri.fsPath}`);
    const data = await host.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;
    const logger = Logger.create(outputChannel, 'Parse');
    const model = await extractDacpac(data, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
      externalRefsEnabled: config.externalRefs.enabled,
      maxNodes: config.maxNodes,
    });
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.log('info', 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyError(
      Logger.create(outputChannel, 'Dacpac'),
      'Load demo',
      `Data Lineage: Failed to load demo — ${msg}`,
      err,
      { asset: 'assets/demo.dacpac' },
      host.showErrorMessage,
    );
  }
}

async function runDbPhase1Host(host: BridgeHost, connectionUri: string, connectionInfo: IConnectionInfo, outputChannel: vscode.LogOutputChannel) {
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
  host.log('info', 'DB', `Phase 1 Complete — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
}

async function runDbPhase2Host(host: BridgeHost, connectionUri: string, schemas: string[], outputChannel: vscode.LogOutputChannel, getSession: () => AiSession, currentDatabase?: string, sourceName?: string, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadDmvQueries(outputChannel, host.getExtensionUri());
  host.log('info', 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
  const timeoutMs = (host.getConfiguration().get<number>('dmvQueryTimeout') ?? 120) * 1000;
  // Platform detection and the catalog fetch precede the sweep; the sweep's own 1..N steps
  // shift up by the lead-step count so the counter stays monotonic instead of restarting.
  const allObjectsQuery = queries.find(q => q.name === 'all-objects');
  const leadSteps = allObjectsQuery ? 2 : 1;
  const totalSteps = queries.filter(isPhase2Query).length + leadSteps;
  host.postMessage({ type: 'db-progress', step: 1, total: totalSteps, label: 'Detecting database platform' });
  const platformMetadata = await loadDatabasePlatform(connectionUri, queries, outputChannel, timeoutMs);
  // Full object catalog for cross-schema dependency resolution. Optional by contract: a custom
  // query file without 'all-objects', or a failed fetch, degrades to unclassified cross-schema
  // references — never to a failed import.
  let allObjectsResult: SimpleExecuteResult | undefined;
  if (allObjectsQuery) {
    host.postMessage({ type: 'db-progress', step: 2, total: totalSteps, label: 'Loading object catalog' });
    try {
      const catalogMap = await executeDmvQueries(connectionUri, [allObjectsQuery], outputChannel, undefined, timeoutMs);
      allObjectsResult = catalogMap.get('all-objects');
    } catch (err) {
      host.log('warn', 'DB', `Object catalog unavailable — cross-schema references stay unresolved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const resultMap = await executeDmvQueriesFiltered(connectionUri, queries, schemas, outputChannel, (step, total, label) => {
    host.postMessage({ type: 'db-progress', step: step + leadSteps, total: total + leadSteps, label });
  }, timeoutMs);
  const requireResult = (name: 'nodes' | 'columns' | 'dependencies'): SimpleExecuteResult => {
    const result = resultMap.get(name);
    if (!result) throw new Error(`No '${name}' result from Phase 2 DMV queries`);
    return result;
  };
  const dmvResults: DmvResults = {
    nodes: requireResult('nodes'),
    columns: requireResult('columns'),
    dependencies: requireResult('dependencies'),
    allObjects: allObjectsResult,
    ...platformMetadata,
  };
  const config = await readExtensionConfig(host);
  const logger = Logger.create(outputChannel, 'Parse');
  logger.info(`Phase 2 Resolution: Starting object parsing for ${dmvResults.nodes.rowCount} nodes...`);

  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, config.maxNodes, (msg) => {
    logger.debug(msg);
  });
  logger.info(`Extraction Complete — ${model.nodes.length} nodes, ${model.edges.length} deps`);

  onModelBuilt?.(model);
  if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
  host.postMessage({ type: 'db-model', model, config, sourceName: sourceName ?? 'Database' });
}

/**
 * Upper bound for the platform probe, independent of `dmvQueryTimeout`.
 *
 * @remarks
 * The probe is a single-row `SERVERPROPERTY` read that blocks the Phase 2 sweep, so it must
 * not inherit the user's bulk-query budget (default 120 s). An unreachable server would
 * otherwise stall the import behind a progress notification showing no steps before any real
 * work began. Capping here costs nothing when the server is healthy and bounds the stall when
 * it is not — the fallback tiers still produce a platform either way.
 */
const PLATFORM_PROBE_TIMEOUT_MS = 10_000;

/**
 * Shape accepted from the MSSQL extension's `getServerInfo`.
 *
 * @remarks
 * `IServerInfo` types these as required, but the value crosses an extension boundary this
 * code does not own, so the types are a claim rather than a guarantee. Only the three fields
 * the platform mapping reads are validated — a malformed response degrades to the explicit
 * unknown label instead of throwing inside `mapEngineMetadata`.
 */
const ServerInfoSchema = z.object({
  engineEditionId: z.number(),
  serverMajorVersion: z.number(),
  serverEdition: z.string(),
});

/**
 * Resolves the database platform before the Phase 2 model is built.
 *
 * @remarks
 * Three tiers, none of which may fail the import: the `platform-info` query, then
 * authoritative MSSQL `getServerInfo` metadata, then an explicit unknown label. Platform
 * is display and AI-grounding context, never a correctness input, so a database that
 * cannot answer must still import — but it must say so rather than be labelled with an
 * invented `SQL Server` default that the model would then reason from.
 *
 * Runs ahead of the Phase 2 sweep because `buildModelFromDmv` needs the result at model
 * construction; `platform-info` carries `phase: 1` so the sweep does not re-run it.
 */
async function loadDatabasePlatform(
  connectionUri: string,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  timeoutMs: number,
): Promise<Pick<DmvResults, 'platformInfo' | 'serverPlatform'>> {
  const logger = Logger.create(outputChannel, 'DB');
  const platformQuery = queries.find(q => q.name === 'platform-info');
  const probeTimeoutMs = Math.min(timeoutMs, PLATFORM_PROBE_TIMEOUT_MS);

  if (platformQuery) {
    try {
      const resultMap = await executeDmvQueries(connectionUri, [platformQuery], outputChannel, undefined, probeTimeoutMs);
      const platformInfo = resultMap.get('platform-info');
      const missingColumns = platformInfo ? validateQueryResult('platform-info', platformInfo) : [];
      if (platformInfo?.rows.length && missingColumns.length === 0) return { platformInfo };
      const reason = missingColumns.length > 0
        ? `missing columns: ${missingColumns.join(', ')}`
        : 'no rows';
      logger.warn(`Platform query returned unusable metadata (${reason}) — using MSSQL server metadata`);
    } catch (err) {
      logger.warn(`Platform query failed — using MSSQL server metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    logger.warn('Custom DMV configuration has no platform-info query — using MSSQL server metadata');
  }

  try {
    const serverInfo = ServerInfoSchema.parse(await withQueryTimeout(
      getServerInfo(connectionUri),
      probeTimeoutMs,
      `MSSQL getServerInfo timed out after ${probeTimeoutMs / 1000}s`,
    ));
    return { serverPlatform: mapServerInfoPlatform(serverInfo) };
  } catch (err) {
    logger.warn(`MSSQL server metadata unavailable — platform will be explicit unknown: ${err instanceof Error ? err.message : String(err)}`);
    return { serverPlatform: UNKNOWN_DB_PLATFORM };
  }
}

async function withDbProgressHost(host: BridgeHost, title: string, connectFn: () => Promise<any>, phaseFn: (res: any, progress: any, token: any) => Promise<void>) {
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
  statsConnState: StatsConnState,
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: ColumnDef[],
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Stats');
  const cfg = host.getConfiguration();
  if (!cfg.get('tableStatistics.enabled', true)) {
    logger.info(`Profiling disabled — rejected request for ${schema}.${objectName}`);
    void postToDetail(panel, {
      type: 'table-stats-error',
      message: 'Table profiling is disabled by dataLineageViz.tableStatistics.enabled.',
    }, logger);
    return;
  }
  const sampleThreshold = cfg.get('tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold);
  const sampleSize = cfg.get('tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize);
  const useApprox = cfg.get('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct);
  const maxColumns = cfg.get('tableStatistics.maxColumns', DEFAULT_CONFIG.tableStatistics.maxColumns);
  const timeoutSec = cfg.get('tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout);
  const timeoutMs = timeoutSec * 1000;
  const t0 = Date.now();

  logger.info(`Profiling ${schema}.${objectName} (mode=${mode})`);
  try {
    if (!statsConnState.uri) {
      // A concurrent request joins the negotiation already in flight instead of starting a
      // second one; only the winner's uri is stored, and both callers use it.
      statsConnState.pending ??= (async () => {
        const result = storedConnectionInfo ? (await connectDirect(storedConnectionInfo, outputChannel) ?? await promptForConnection(outputChannel)) : await promptForConnection(outputChannel);
        return result?.connectionUri;
      })();
      let negotiated: string | undefined;
      try {
        negotiated = await statsConnState.pending;
      } finally {
        statsConnState.pending = null;
      }
      if (!negotiated) {
        void postToDetail(panel, { type: 'table-stats-error', message: 'Connection cancelled.' }, logger);
        return;
      }
      statsConnState.uri ??= negotiated;
    }
    const connectionUri = statsConnState.uri;
    const serverInfo = await getServerInfo(connectionUri);
    const engineEdition = serverInfo.engineEditionId;

    const rowCountSql = buildRowCountQuery(schema, objectName);
    const rowCountPromise = executeSimpleQuery(connectionUri, rowCountSql, outputChannel);
    const rowCountResult = await withQueryTimeout(rowCountPromise, timeoutMs, `Row count query for ${schema}.${objectName} timed out after ${timeoutSec}s.`);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;

    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);
    if (!profilingSql) {
      // The detail panel is in its loading phase and leaves it only on a result or error frame —
      // a bare return here left it spinning forever.
      logger.info(`No profileable columns for ${schema}.${objectName} — nothing to query`);
      void postToDetail(panel, {
        type: 'table-stats-error',
        message: `No profileable columns in ${schema}.${objectName} — the column types are not supported by statistics, or dataLineageViz.tableStatistics.maxColumns excludes them all.`,
      }, logger);
      return;
    }

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
    if (!profilingResult.rows.length) {
      throw new Error(`Profiling query returned no rows for ${schema}.${objectName}`);
    }
    const resultRow: Record<string, string> = {};
    for (let i = 0; i < profilingResult.columnInfo.length; i++) {
      resultRow[profilingResult.columnInfo[i].columnName] = profilingResult.rows[0][i].displayValue;
    }

    const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
    const samplePercent = needsSampling ? computeSamplePercent(sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    logger.info(`Table statistics ready — ${schema}.${objectName} rows=${rowCount}${needsSampling ? ` (sampled ${samplePercent}%)` : ''} (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    void postToDetail(panel, { type: 'table-stats-result', stats, mode }, logger);
  } catch (err) {
    host.log('error', 'Stats', 'Profiling', err);
    void postToDetail(panel, { type: 'table-stats-error', message: err instanceof Error ? err.message : String(err) }, logger);
  }
}

/**
 * Logs a summary of the SQL parsing results and stores it in the session.
 */
function handleParseStats(stats: ParseStats, outputChannel: vscode.LogOutputChannel, getSession: () => AiSession, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const logger = Logger.create(outputChannel, 'Parse');
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

/**
 * Reads display and behaviour settings from a VS Code workspace configuration
 * and returns the serialisable config snapshot sent to the webview.
 *
 * @param cfg - Workspace configuration scoped to `dataLineageViz`.
 * @returns Config snapshot for the webview (same shape as {@link ExtensionConfigSchema}).
 */
export function buildExtensionConfig(cfg: vscode.WorkspaceConfiguration): Record<string, any> {
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
    overview: {
      enabled: cfg.get<boolean>('overview.enabled'),
      threshold: cfg.get<number>('overview.threshold'),
      schemaDoubleClickBehavior: cfg.get<string>('overview.schemaDoubleClickBehavior'),
    },
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

async function readExtensionConfig(host: BridgeHost): Promise<Record<string, any>> {
  return buildExtensionConfig(host.getConfiguration());
}

import { buildWebviewCsp } from '../utils/cspBuilder';
import { getNonce } from '../utils/getNonce';

/**
 * Generates the root HTML for the secondary Detail Webview.
 *
 * This provides the container, strict CSP, and bootloader fallback for the
 * detail panel.
 *
 * @param webview - The vscode.Webview instance for the detail panel.
 * @param extensionUri - The base URI of the extension for resolving assets.
 * @returns The complete HTML string.
 */
function getDetailWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "assets", "index.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "assets", "index.js"));
  const nonce = getNonce();
  const csp = buildWebviewCsp({ nonce, cspSource: webview.cspSource });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" type="text/css" href="${stylesUri}">
  <title>Detail</title>
</head>
<body class="vscode-body">
  <div id="root">
    <div id="bootloader-fallback" style="display: none; padding: 2rem; color: var(--vscode-errorForeground); font-family: var(--vscode-font-family);">
      <h2>Detail UI Failed to Load</h2>
      <p>The extension's user interface encountered a fatal error during initialization.</p>
      <p>Please open the <b>Developer: Toggle Developer Tools</b> command from the Command Palette to view the exact error.</p>
    </div>
  </div>
  <script nonce="${nonce}">
    window.__DETAIL_MODE__ = true;
    setTimeout(() => {
      const fallback = document.getElementById('bootloader-fallback');
      if (fallback) fallback.style.display = 'block';
    }, 3000);
  </script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * Builds a GUI diagnostic snapshot for the current extension state.
 *
 * @param context - Extension context for global state and subscriptions.
 * @param getSession - Factory for retrieving the current session-backed GUI state.
 *
 * @returns Diagnostic text focused on the user-visible graph, filters, render state, and settings.
 */
export function buildDebugDump(context: vscode.ExtensionContext, getSession: () => AiSession): string {
  const sess = getSession();
  const uiDiagnostics = getUiDiagnostics(sess);
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);
  const version = (context.extension.packageJSON as { version: string }).version ?? 'unknown';
  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';

  add(`Data Lineage Viz — Debug Info`);
  add(`Generated: ${new Date().toISOString()}`);
  add(`Last UI sync: ${uiDiagnostics.lastUiSyncAt ? new Date(uiDiagnostics.lastUiSyncAt).toISOString() : '(never — webview has not reported state)'}`);
  add(`Webview errors captured: ${uiDiagnostics.lastErrors.length}`);
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

    // ── MODEL CONNECTIVITY (full model, filter-independent) ──
    add('MODEL CONNECTIVITY (full model, filter-independent)');
    add(formatModelConnectivity(summarizeModelConnectivity(sess.model)));
    add('');
  }

  // ── SCHEMA LEGEND ──
  if (sess.model) {
    const names = sess.model.schemas
      .filter(s => !(s.types['external'] > 0 && s.nodeCount === s.types['external']))
      .map(s => s.name);
    add('SCHEMA LEGEND');
    add(`  ${names.join(', ') || '(none)'}`);
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

  // ── RENDER STATE (current on-screen graph) ──
  add('RENDER STATE (current screen)');
  if (uiDiagnostics.renderState) {
    add(JSON.stringify(uiDiagnostics.renderState, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
  } else {
    add('    (no render-state reported — graph not rendered, or render-limit mode)');
  }
  add('');

  // ── RENDERED CONNECTIVITY (what the user currently sees) ──
  const renderConnectivity = (uiDiagnostics.renderState as { connectivity?: RenderConnectivity } | undefined)?.connectivity;
  if (renderConnectivity) {
    add('RENDERED CONNECTIVITY (current screen)');
    add(formatRenderConnectivity(renderConnectivity));
    add('');
  }

  // ── SELECTION & AFFORDANCES / TRACE SCOPE / DETAIL PANEL / ANALYTICS / BOOKMARK ──
  // Explains why the selected node shows or grays its +/- trace controls, standalone.
  add(formatScreenStateSections(
    uiDiagnostics.renderState as RenderStateSnapshot | null,
    (sess.uiState as { screenState?: ScreenStateExtras } | null)?.screenState ?? null,
    sess.model ?? null,
  ));

  // ── LAST ERRORS (newest last) ──
  add(`LAST ERRORS (${uiDiagnostics.lastErrors.length})`);
  if (uiDiagnostics.lastErrors.length === 0) {
    add('    (none captured this session)');
  } else {
    for (const e of uiDiagnostics.lastErrors) {
      add(`  [${new Date(e.timestamp).toISOString()}] source=${e.source}`);
      add(`    message:   ${e.message}`);
      if (e.componentStack) add(`    component: ${e.componentStack}`);
      if (e.context !== undefined) add(`    context:   ${trunc(JSON.stringify(e.context), 800)}`);
      if (e.stack) add(`    stack:     ${e.stack}`);
    }
  }
  add('');

  // ── SM SUMMARY (overview only; full dump is a separate command) ──
  add('SM SUMMARY');
  add(`  Phase:        ${sess.phase.kind}`);
  add(`  Status:       ${sess.stateMachine?.status ?? 'idle'}`);
  add(`  Hops:         ${sess.hopCount}`);
  add(`  Pending gate: ${sess.phase.kind === 'awaiting_gate' ? sess.phase.gate.gate : 'none'}`);
  add(`  Result nodes: ${sess.resultGraph?.nodeIds.length ?? 0}`);
  add('  Full SM dump: use Data Lineage: Dump SM State');
  add('');

  // ── SETTINGS ──
  add('SETTINGS (dataLineageViz.*, excluding ai.*)');
  try {
    const cfg = vscode.workspace.getConfiguration('dataLineageViz');
    const pkg = context.extension.packageJSON;
    const allSettings: Record<string, any> = {};
    const configSections = pkg.contributes?.configuration || [];
    for (const section of configSections) {
      for (const key of Object.keys(section.properties || {})) {
        const shortKey = key.replace('dataLineageViz.', '');
        if (shortKey === 'ai' || shortKey.startsWith('ai.')) continue;
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
