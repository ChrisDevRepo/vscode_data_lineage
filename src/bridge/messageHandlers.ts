import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { type AiSession, type SessionParseCounts } from '../ai/session/session';
import {
  Logger,
  trunc,
  LOG_TRUNC_LIST,
  sanitizeForLog,
  safeStringifyForLog,
  LOG_TRUNC_JSON,
  type LogCategory,
} from '../utils/log';
import { notifyError, notifyWarning } from '../utils/notifications';
import { type BridgeHost } from './host';
import {
  type DatabaseModel, type LineageNode, type ColumnDef, type ParseStats, DEFAULT_CONFIG,
  type ExtensionConfig, type LayoutConfig, type OverviewConfig,
} from '../engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from '../engine/dacpacExtractor';
import { checkObjectLimit, formatObjectLimitMessage } from '../engine/modelFilters';
import {
  connectDatabase, connectionErrorHooks,
  loadDmvQueries, createDmvQueryCache, executeDmvQueries, executeDmvQueriesFiltered,
  executeSimpleQuery, isPhase2Query, type DmvQuery, type DbConnectEnv,
} from '../engine/connectionManager';
import { type DbSession } from '../engine/db/dbSession';
import { isDbConnectionError, isDriverError, reportConnectionError, targetFromSession } from '../engine/db/connectionErrors';
import { redactSecrets } from '../utils/redact';
import { type SimpleExecuteResult } from '../types/database';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, parseProfilingResult, computeSamplePercent, profilingRowFromResult } from '../engine/profilingEngine';
import { type StatsMode } from '../engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult, type DmvResults } from '../engine/dmvExtractor';
import {
  createProject, updateProject, deleteProject,
  addFilterProfile, deleteFilterProfile,
  type ProjectStore,
} from '../engine/projectStore';
import { buildBareGraph } from '../ai/support/graphUtils';
import { buildStoredRun, clearStoredRun, writeStoredRun } from '../ai/session/runStore';
import { populateColumnStore } from '../engine/modelBuilder';
import { summarizeModelConnectivity, formatModelConnectivity } from '../engine/schemaAdjacency';
import { formatRenderConnectivity } from '../engine/renderConnectivity';
import { formatScreenStateSections } from './debugDumpScreenState';
import {
  BRIDGE_PROTOCOL_VERSION,
  TRACE_ALL_LEVELS,
  DetailPanelToExtensionMsgSchema,
  ProjectSchema,
  type BridgeEnvelope,
  type MainPanelToExtensionMsg,
  type Project,
  type RenderStateSnapshot,
  type StoredConnectionInfo,
  type ScreenStateExtras,
  stripFocusNodeLinks,
} from '../engine/shared/bridgeContract';
import { summarizeZodError, postToDetail } from './host';
import { readDeclaredNumericSetting } from '../configCore';
import { buildWebviewCsp } from '../utils/cspBuilder';
import { getNonce } from '../utils/getNonce';
import { errorMessage } from '../utils/errorMessage';

/** Maps each main-panel message type to a handler whose `msg` parameter is narrowed to the matching variant of {@link MainPanelToExtensionMsg}. */
export type WebviewMessageHandlers = {
  [K in MainPanelToExtensionMsg['type']]: (
    msg: Extract<MainPanelToExtensionMsg, { type: K }>,
  ) => Promise<void> | void;
};

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

/** Splits a project list into the records the webview contract accepts and those it rejects. */
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
  renderState: RenderStateSnapshot | null;
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

/** Storage key for the project store in VS Code's global state. */
export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

/** Represents a bundle of message handlers and their associated cleanup logic. */
export interface MessageHandlerBundle {
  /** Map of message types to their per-variant handler functions. */
  handlers: WebviewMessageHandlers;
  /** Cleanup function to release resources (e.g., database connections) when the panel is disposed. */
  cleanup: () => Promise<void>;
  /** Function to programmatically trigger the demo load when the panel is already active. */
  triggerDemoLoad: () => Promise<void>;
  /** Starts a host-initiated import on this panel: supersedes the active load and tells the webview a new load began, so its result is not discarded as belonging to a cancelled load. */
  beginExternalLoad: () => vscode.CancellationToken;
}

/** Installs a freshly built model as the session's current one. */
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

/** Mutable holder for the session's untitled AI report document; a closed document is never reused. */
export interface ReportDocumentRef {
  document?: vscode.TextDocument;
}

/** Factory for creating the IPC (Inter-Process Communication) bridge between the Extension Host and the Webview. */
export function createMessageHandlers(
  host: BridgeHost,
  context: vscode.ExtensionContext,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  loadProjectStore: (context: vscode.ExtensionContext) => ProjectStore,
  saveProjectStore: (context: vscode.ExtensionContext, store: ProjectStore) => Promise<void>,
  migrateFromWorkspaceState: (context: vscode.ExtensionContext) => Promise<void>,
  loadDemoFlag: boolean,
  setDetailPanel: (panel: vscode.WebviewPanel | undefined) => void,
  reportDocumentRef: ReportDocumentRef = {}
): MessageHandlerBundle {

  type DacpacPreview = Awaited<ReturnType<typeof extractSchemaPreview>>;
  let cachedDacpac: DacpacPreview | null = null;
  /** Builds the selected schemas of a DACPAC preview and installs the model; false when it is over the object limit. */
  function installFilteredDacpac(dacpac: DacpacPreview, schemas: readonly string[], project: { id: string; name: string } | null, sourceName: string): boolean {
    const config = readExtensionConfig(host);
    const logger = Logger.create(outputChannel, 'Parse');
    const model = extractDacpacFiltered(dacpac.elements, new Set(schemas), dacpac.dspName, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
      externalRefsEnabled: config.externalRefs.enabled,
      identifierCaseSensitive: dacpac.identifierCaseSensitive,
      databaseName: dacpac.databaseName,
    });
    if (isModelOverLimit(model, config.maxNodes, logger, host)) return false;
    logger.info(`Dacpac filtered — ${model.nodes.length} nodes, ${model.edges.length} edges`);
    setCurrentModel(model, false, project);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName });
    return true;
  }
  let lastConnectionInfo: StoredConnectionInfo | undefined;
  const dmvQueries = createDmvQueryCache(() => loadDmvQueries(outputChannel, context.extensionUri));
  const dbEnv: DbConnectEnv = { secrets: context.secrets, outputChannel, loadQueries: dmvQueries.get };
  let detailPanel: vscode.WebviewPanel | undefined;
  let lastDetailNode: LineageNode | null = null;

  let panelClosed = false;
  let activeLoad = new vscode.CancellationTokenSource();
  /** A new import replaces the preceding import; cancelled tokens stay cancelled after its awaits. */
  function beginLoad(): vscode.CancellationTokenSource {
    activeLoad.cancel();
    activeLoad.dispose();
    activeLoad = new vscode.CancellationTokenSource();
    if (panelClosed) activeLoad.cancel();
    else host.postMessage({ type: 'load-started' });
    return activeLoad;
  }
  function cancelLoad(load = activeLoad, replyType: 'db-cancelled' | 'load-cancelled' = 'db-cancelled'): void {
    load.cancel();
    if (!panelClosed && load === activeLoad) host.postMessage({ type: replyType });
  }

  let reportWrite: Promise<unknown> = Promise.resolve();
  /** Puts `content` into the session's report document, one call at a time so a second click meets the document the first created. */
  function writeReportDocument(content: string): Promise<vscode.TextDocument> {
    const written = reportWrite.then(() => putReportContent(content));
    reportWrite = written.catch(() => undefined);
    return written;
  }
  /** Replaces the report document's text, creating the document when none is open or the edit is refused. */
  async function putReportContent(content: string): Promise<vscode.TextDocument> {
    const open = reportDocumentRef.document;
    if (open && !open.isClosed) {
      if (open.getText() === content) return open;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, open.validateRange(new vscode.Range(0, 0, open.lineCount, 0)), content);
      if (await vscode.workspace.applyEdit(edit)) return open;
    }
    const created = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    reportDocumentRef.document = created;
    return created;
  }
  /** The built-in markdown preview tabs titled for `doc`, across every editor group. */
  function reportPreviewTabs(doc: vscode.TextDocument): vscode.Tab[] {
    const name = path.basename(doc.uri.path);
    return vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('markdown.preview') && tab.label.endsWith(` ${name}`)));
  }
  /** Leaves at most the visible report previews on screen; returns true when one is the visible tab of an editor group. */
  async function settleReportPreviews(doc: vscode.TextDocument): Promise<boolean> {
    const previews = reportPreviewTabs(doc);
    for (const tab of previews.filter((candidate) => !candidate.isActive)) {
      const closed = await Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => false);
      if (!closed) host.log('warn', 'Bridge', `Hidden report preview tab "${tab.label}" could not be closed`);
    }
    return previews.some((tab) => tab.isActive);
  }

  /** Installs a newly loaded model. */
  function setCurrentModel(m: DatabaseModel, isDb: boolean, project?: { id: string; name: string } | null): void {
    applyModelToSession(getSession(), m, isDb, project, project ? loadProjectStore(context) : null);
    if (!isDb) lastConnectionInfo = undefined;
    lastDetailNode = null;
    if (detailPanel) {
      detailPanel.title = 'Detail';
      void postToDetail(detailPanel, { type: 'detail-clear' }, bridgeLogger);
    }
  }

  /** Clears a filter view's stored AI run record, logging rather than throwing on failure. */
  async function clearStoredRunLogged(profileId: string): Promise<void> {
    try {
      await clearStoredRun(context.globalState, profileId);
    } catch (err) {
      host.log('warn', 'Bridge', `Failed to clear AI run memory for view ${profileId}: ${errorMessage(err)}`);
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

  /** Shows `node` in the open detail panel, or clears the panel when there is no node. */
  async function postDetailNode(panel: vscode.WebviewPanel, node: LineageNode | null | undefined, findQuery?: string): Promise<void> {
    if (!node) {
      panel.title = 'Detail';
      void postToDetail(panel, { type: 'detail-clear' }, bridgeLogger);
      return;
    }
    panel.title = `Detail: ${node.name}`;
    void postToDetail(panel, {
      type: 'detail-update',
      node: enrichNodeForDetail(node),
      findQuery,
      config: await getDetailConfig(),
    }, bridgeLogger);
  }

  const bridgeLogger = Logger.create(outputChannel, 'Bridge');
  const handlers: WebviewMessageHandlers = {
    'cancel-load': () => cancelLoad(activeLoad, 'load-cancelled'),
    'ready': async () => {
      host.log('info', 'Bridge', 'Webview ready');
      if (loadDemoFlag) {
        await handlers['load-demo']({ type: 'load-demo' });
        return;
      }
      const token = beginLoad().token;
      if (token.isCancellationRequested) return;
      if (host.getGlobalState().get(PROJECT_STORE_KEY) === undefined) {
        host.log('info', 'Bridge', 'No project store found, triggering migration');
        await migrateFromWorkspaceState(context);
        if (token.isCancellationRequested) return;
      }
      const config = readExtensionConfig(host);
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
      host.log('info', 'Bridge', 'Node detail opened');
      host.log('debug', 'Bridge', `Node detail: ${msg.node?.id || '(no node)'}`);
      lastDetailNode = msg.node ?? null;

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
              if (detailPanel && !getSession().isDbSession) {
                void postToDetail(detailPanel, { type: 'table-stats-error', objectRef: { schema: m.schema, objectName: m.objectName }, message: 'Table statistics need a database project.' }, bridgeLogger);
              } else if (detailPanel) {
                await handleTableStatsRequestHost(host, dbEnv, lastConnectionInfo, detailPanel, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel);
              }
            } else if (m.type === 'close-detail') {
              detailPanel?.dispose();
            } else if (m.type === 'error') {
              await handlers.error(m);
            } else if (m.type === 'show-warning') {
              await handlers['show-warning'](m);
            }
          } catch (err) {
            host.log('error', 'Bridge', 'Detail panel handler threw unexpectedly', err);
          }
        });
      } else {
        detailPanel.reveal(vscode.ViewColumn.Beside);
        await postDetailNode(detailPanel, msg.node, msg.findQuery);
      }
    },
    'update-detail': async (msg) => {
      lastDetailNode = msg.node ?? null;
      if (detailPanel) await postDetailNode(detailPanel, msg.node, msg.findQuery);
    },
    'open-dacpac': async () => {
      const token = beginLoad().token;
      if (token.isCancellationRequested) return;
      host.log('info', 'Bridge', 'Opening dacpac picker');
      const uris = await host.showOpenDialog({
        canSelectMany: false,
        filters: { 'DACPAC': ['dacpac'] },
        title: 'Select a .dacpac file'
      });
      if (token.isCancellationRequested) return;
      if (uris && uris.length > 0) {
        host.log('info', 'Bridge', `Selected dacpac: ${uris[0].fsPath}`);
        const config = readExtensionConfig(host);
        let extracted: Awaited<ReturnType<typeof extractSchemaPreview>>;
        try {
          const data = await host.readFile(uris[0]);
          if (token.isCancellationRequested) return;
          if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;
          extracted = await extractSchemaPreview(data);
          if (token.isCancellationRequested) return;
        } catch (err) {
          if (token.isCancellationRequested) return;
          const reason = errorMessage(err);
          host.log('error', 'Dacpac', `Open ${uris[0].fsPath}`, err);
          host.postMessage({ type: 'db-error', message: `Could not open ${path.basename(uris[0].fsPath)}: ${reason}`, phase: 'extract' });
          return;
        }
        const { preview } = extracted;
        cachedDacpac = extracted;
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
      const load = beginLoad();
      const token = load.token;
      if (token.isCancellationRequested) return;
      host.log('info', 'Bridge', `Loading project: ${msg.id}`);

      const store = loadProjectStore(context);
      const project = store.projects.find(p => p.id === msg.id);
      if (!project) {
        host.log('error', 'Bridge', 'Load project', `Project not found: ${msg.id}`);
        host.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}`, phase: 'connect' });
        return;
      }

      if (project.connection.type === 'dacpac') {
        try {
          const fileUri = vscode.Uri.file(project.connection.path);
          host.log('debug', 'Bridge', `Reading dacpac file: ${fileUri.fsPath}`);
          const data = await host.readFile(fileUri);
          if (token.isCancellationRequested) return;
          if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;

          const schemas = project.connection.schemas;
          const extracted = await extractSchemaPreview(data);
          if (token.isCancellationRequested) return;

          if (schemas && schemas.length > 0) {
            host.log('debug', 'Bridge', `Extracting filtered dacpac for schemas: ${trunc(schemas, LOG_TRUNC_LIST)}`);
            const name = project.connection.displayName;
            if (!installFilteredDacpac(extracted, schemas, { id: project.id, name }, name)) return;
          } else {
            host.log('debug', 'Bridge', 'No schemas in project, showing preview');
            cachedDacpac = extracted;
            const { preview } = extracted;
            host.postMessage({ type: 'dacpac-schema-preview', preview, config: readExtensionConfig(host), sourceName: project.connection.displayName });
            host.log('info', 'Dacpac', `Schema preview — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
          }
          const latestStore = loadProjectStore(context);
          const latestProject = latestStore.projects.find(p => p.id === project.id);
          if (latestProject) {
            const updatedStore = updateProject(latestStore, { ...latestProject, updatedAt: new Date().toISOString() });
            await saveProjectStore(context, updatedStore);
            if (token.isCancellationRequested) return;
            postProjectsList(host, updatedStore);
          }
        } catch (err) {
          if (token.isCancellationRequested) return;
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            host.log('warn', 'Bridge', `Dacpac file not found: ${project.connection.path}`);
            host.postMessage({ type: 'last-dacpac-gone' });
          } else {
            const reason = errorMessage(err);
            host.log('error', 'Bridge', `Load project ${project.connection.path}`, err);
            host.postMessage({ type: 'db-error', message: `Could not load ${project.connection.displayName}: ${reason}`, phase: 'extract' });
          }
        }
      } else if (project.connection.type === 'database') {
        const dbConn = project.connection;
        await withDbProgressHost(host, dbEnv, 'Loading project', (patch, token) => connectDatabase(dbEnv, { ...dbConn.connectionInfo, ...patch }, token), async (session, token) => {
          lastConnectionInfo = session.connectionInfo;
          const schemas = dbConn.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1Host(host, session, outputChannel, dmvQueries.reload, token);
          } else {
            const loaded = await runDbPhase2Host(host, session, schemas, outputChannel, dmvQueries.reload, token, getSession, session.connectionInfo.database, dbConn.sourceName, (m) => {
              setCurrentModel(m, true, { id: project.id, name: project.name });
            });
            if (!loaded || token.isCancellationRequested) return;
            const latestStore = loadProjectStore(context);
            const latestProject = latestStore.projects.find(p => p.id === project.id);
            if (latestProject?.connection.type === 'database') {
              const refreshed = {
                ...latestProject,
                connection: { ...latestProject.connection, connectionInfo: session.connectionInfo },
                updatedAt: new Date().toISOString(),
              };
              const updatedStore = updateProject(latestStore, refreshed);
              await saveProjectStore(context, updatedStore);
              if (token.isCancellationRequested) return;
              postProjectsList(host, updatedStore);
            }
          }
        }, load, () => cancelLoad(load));
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
      const profileIds = (store.projects.find(p => p.id === msg.id)?.filterProfiles ?? []).map(fp => fp.id);
      const updated = deleteProject(store, msg.id);
      await saveProjectStore(context, updated);
      postProjectsList(host, updated);
      for (const profileId of profileIds) {
        await clearStoredRunLogged(profileId);
      }
    },
    'load-demo': async () => {
      const token = beginLoad().token;
      if (token.isCancellationRequested) return;
      host.log('debug', 'Bridge', 'Loading demo');
      await handleLoadDemo(host, getSession, outputChannel, token, (m) => {
        setCurrentModel(m, false, null);
        getSession().projectName = 'Demo';
      });
    },
    'dacpac-visualize': async (msg) => {
      const token = beginLoad().token;
      if (token.isCancellationRequested) return;
      host.log('debug', 'Bridge', `Dacpac visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      if (!cachedDacpac) {
        host.log('error', 'Bridge', 'Dacpac visualize', 'Session expired (no cached dacpac preview)');
        host.postMessage({ type: 'db-error', message: 'Session expired. Please reopen the file.', phase: 'extract' });
        return;
      }
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      try {
        installFilteredDacpac(cachedDacpac, msg.schemas, sess.currentProjectId ? { id: sess.currentProjectId, name: projectName } : null, projectName);
      } catch (err) {
        const reason = errorMessage(err);
        host.log('error', 'Dacpac', 'Dacpac visualize', err);
        host.postMessage({ type: 'db-error', message: `Could not build the lineage model: ${reason}`, phase: 'extract' });
      }
    },
    'db-visualize': async (msg) => {
      const load = beginLoad();
      if (load.token.isCancellationRequested) return;
      host.log('debug', 'Bridge', `Database visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      return withDbProgressHost(host, dbEnv, 'Loading selected schemas', async (patch, token) => {
        if (!lastConnectionInfo) {
          host.log('error', 'Bridge', 'Database visualize', 'No stored connection info');
          host.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
          return undefined;
        }
        return connectDatabase(dbEnv, { ...lastConnectionInfo, ...patch }, token);
      }, async (conn, token) => {
        const sourceName = `${conn.connectionInfo.server} / ${conn.connectionInfo.database}`;
        let pendingProject: ReturnType<typeof createProject> | null = null;
        if (msg.projectName) {
          try {
            pendingProject = createProject(msg.projectName, {
              type: 'database',
              connectionInfo: conn.connectionInfo,
              sourceName,
              schemas: msg.schemas,
            });
          } catch (err) {
            const dbLogger = Logger.create(outputChannel, 'DB');
            notifyWarning(
              dbLogger,
              'Persist database project',
              `Data Lineage: the project "${msg.projectName}" could not be saved — the connection info failed validation. The graph still loads.`,
              { error: err },
            );
            dbLogger.debug(`Unsaved project source: ${sourceName}`);
          }
        }

        const loaded = await runDbPhase2Host(host, conn, msg.schemas, outputChannel, dmvQueries.reload, token, getSession, conn.connectionInfo.database, sourceName, (m) => {
          if (pendingProject) {
            setCurrentModel(m, true, { id: pendingProject.id, name: pendingProject.name });
          } else {
            setCurrentModel(m, true, null);
            getSession().projectName = sourceName;
          }
        });

        if (loaded && pendingProject && !token.isCancellationRequested) {
          const store = loadProjectStore(context);
          const updated = updateProject(store, pendingProject);
          await saveProjectStore(context, updated);
          if (token.isCancellationRequested) return;
          postProjectsList(host, updated);
        }
      }, load, () => cancelLoad(load));
    },
    'filter-changed': (msg) => {
      const sess = getSession();
      const { uiState } = msg;
      const prevCount = sess.filteredCount;
      const prevHit = sess.renderLimitHit;
      sess.uiState = uiState;
      sess.filter = uiState.filter;
      sess.traceState = uiState.trace;
      sess.graphMode = uiState.graphMode;
      sess.filteredCount = uiState.filteredCount;
      sess.renderLimitHit = uiState.renderLimitHit;
      getUiDiagnostics(sess).lastUiSyncAt = Date.now();
      if (prevCount !== uiState.filteredCount || prevHit !== uiState.renderLimitHit) {
        host.log('debug', 'Filter', `State sync — ${uiState.filteredCount} nodes, renderLimitHit=${uiState.renderLimitHit}`);
      }
    },
    'render-state': (msg) => {
      const sess = getSession();
      const state = getUiDiagnostics(sess);
      state.renderState = msg.renderState;
      sess.renderState = msg.renderState;
      state.lastUiSyncAt = Date.now();
    },
    'db-connect': () => {
      const load = beginLoad();
      if (load.token.isCancellationRequested) return;
      host.log('debug', 'Bridge', 'Database connect requested');
      return withDbProgressHost(host, dbEnv, 'Connecting', (_patch, token) => connectDatabase(dbEnv, undefined, token), (conn, token) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1Host(host, conn, outputChannel, dmvQueries.reload, token);
      }, load, () => cancelLoad(load));
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
            logger.debug(`AI run memory kept for "${msg.profile?.name}" — the save resolves to no presented run.`);
          }
        } catch (runErr) {
          logger.warn(`Failed to store AI run memory for "${msg.profile?.name}": ${errorMessage(runErr)}`);
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
      const config = readExtensionConfig(host);
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
    /** Saves a webview-composed export under a name the user confirms in the save dialog. */
    'export-file': async (msg) => {
      const defaultName = path.basename(msg.defaultName);
      host.log('debug', 'Bridge', `Exporting file: ${defaultName}`);
      const uri = await host.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName) });
      if (uri) {
        await host.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        host.executeCommand('revealFileInOS', uri);
      }
    },
    /** Shows the AI report in one untitled markdown document and one preview beside the panel. */
    'ai-open-in-editor': async (msg) => {
      host.log('debug', 'Bridge', 'Opening AI description in editor');
      const content = stripFocusNodeLinks(msg.markdown);
      const doc = await writeReportDocument(content);
      if (await settleReportPreviews(doc)) return;
      try {
        await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
      } catch (err) {
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
        notifyWarning(
          Logger.create(outputChannel, 'Bridge'),
          'Markdown preview unavailable',
          'Data Lineage: the built-in Markdown preview is unavailable, so the report opened as a Markdown document instead.',
          { messageType: 'ai-open-in-editor', reason: errorMessage(err) },
        );
      }
    },
    'log': (msg) => {
      const level = msg.level ?? 'debug';
      const { category, message } = parseWebviewLog(msg.text ?? '');
      host.log(level, category, message);
    },
    'error': (msg) => {
      const source = msg.source ?? 'unknown';
      const err = new Error(msg.error);
      if (msg.stack) err.stack = msg.stack;
      const componentLine = msg.componentStack
        ? trunc(sanitizeForLog(msg.componentStack), LOG_TRUNC_JSON)
        : '(no React tree)';
      const contextLine = msg.context
        ? safeStringifyForLog(msg.context, 500)
        : '(no context)';

      recordWebviewError(getSession(), {
        timestamp: msg.timestamp ?? Date.now(),
        source,
        message: redactSecrets(msg.error),
        stack: msg.stack ? trunc(redactSecrets(sanitizeForLog(msg.stack)), 600) : undefined,
        componentStack: componentLine,
        context: msg.context,
      });

      const userMessage = source === 'error-boundary'
        ? 'Data Lineage hit an error and is reloading the view — see the "Data Lineage Viz" Output channel for details.'
        : 'Data Lineage encountered an unexpected error — see the "Data Lineage Viz" Output channel for details.';

      host.log('error', 'Bridge', `Webview ${sanitizeForLog(source)} — notification="${userMessage}" — messageType=error; source=${sanitizeForLog(source)}; component=${componentLine}; context=${contextLine}`, err);
      host.showErrorMessage(userMessage);
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
      if (msg.rendered === 0) logger.warn(`AI view rendered 0/${msg.of} — none of the scoped objects are in the loaded render model`);
      else if (msg.rendered < msg.of) logger.info(`AI view rendered ${msg.rendered}/${msg.of} — ${msg.unresolved.length} scoped id(s) not in the loaded model`);
      logger.debug(`AI view rendered ${msg.rendered}/${msg.of}${msg.unresolved.length ? ` — unresolved: ${trunc(msg.unresolved.join(', '), 200)}` : ''}`);
    },
  };

  return {
    handlers,
    cleanup: async () => {
      panelClosed = true;
      activeLoad.cancel();
      activeLoad.dispose();
      dmvQueries.dispose();
    },
    triggerDemoLoad: async () => { await handlers['load-demo']({ type: 'load-demo' }); },
    beginExternalLoad: () => beginLoad().token,
  };
}

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

/** Toast sink for a failure the webview already shows inline through `db-error`: log it, show it once. */
const SHOWN_INLINE = (): void => {};

/** Refuses a dacpac over {@link MAX_DACPAC_BYTES}. Like {@link isModelOverLimit}, the refusal is posted as a `db-error`, so the loader shows it inline and leaves its loading state instead of spinning to its timeout. */
function isDacpacTooLarge(bytes: number, host: BridgeHost, outputChannel: vscode.LogOutputChannel): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  const message = `Dacpac too large (${mb} MB). Max supported is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`;
  notifyError(
    Logger.create(outputChannel, 'Dacpac'),
    'Validate dacpac size',
    message,
    new Error(`DACPAC size ${bytes} exceeds ${MAX_DACPAC_BYTES}`),
    { bytes, maxBytes: MAX_DACPAC_BYTES },
    SHOWN_INLINE,
  );
  host.postMessage({ type: 'db-error', message, phase: 'extract' });
  return true;
}

/** Refuses a built model that exceeds `dataLineageViz.maxNodes` — the shared `checkObjectLimit` gate for every model load path, webview-bridge or command. When a webview bridge is present the refusal is posted to it as a `db-error` — shown inline, and the loader leaves its loading state at once instead of spinning to the generic "Processing timed out" notice. `host` is omitted where there is no webview bridge; the refusal is then a `vscode.window.showErrorMessage` toast. */
export function isModelOverLimit(model: DatabaseModel, maxNodes: number, logger: Logger, host?: BridgeHost): boolean {
  const check = checkObjectLimit(model, maxNodes);
  if (check.ok) return false;
  const message = formatObjectLimitMessage(check.count, check.limit);
  notifyError(
    logger,
    'Validate object count',
    message,
    new Error(`Model object count ${check.count} exceeds maxNodes ${check.limit}`),
    { count: check.count, limit: check.limit },
    host ? SHOWN_INLINE : undefined,
  );
  host?.postMessage({ type: 'db-error', message, phase: 'extract' });
  return true;
}

async function handleLoadDemo(host: BridgeHost, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel, token: vscode.CancellationToken, onModelBuilt?: (model: DatabaseModel) => void) {
  const config = readExtensionConfig(host);
  try {
    const demoUri = vscode.Uri.joinPath(host.getExtensionUri(), 'assets', 'demo.dacpac');
    host.log('debug', 'Dacpac', `Loading demo dacpac from: ${demoUri.fsPath}`);
    const data = await host.readFile(demoUri);
    if (token.isCancellationRequested) return;
    if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;
    const logger = Logger.create(outputChannel, 'Parse');
    const model = await extractDacpac(data, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
      externalRefsEnabled: config.externalRefs.enabled,
    });
    if (token.isCancellationRequested) return;
    if (isModelOverLimit(model, config.maxNodes, logger, host)) return;
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.log('info', 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
  } catch (err) {
    if (token.isCancellationRequested) return;
    const msg = errorMessage(err);
    notifyError(
      Logger.create(outputChannel, 'Dacpac'),
      'Load demo',
      `Data Lineage: Failed to load demo — ${msg}`,
      err,
      { asset: 'assets/demo.dacpac' },
      SHOWN_INLINE,
    );
    host.postMessage({ type: 'db-error', message: `Failed to load demo — ${msg}`, phase: 'extract' });
  }
}

async function runDbPhase1Host(host: BridgeHost, session: DbSession, outputChannel: vscode.LogOutputChannel, loadQueries: () => Promise<DmvQuery[]>, token: vscode.CancellationToken) {
  const queries = await loadQueries();
  if (token.isCancellationRequested) return;
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  host.log('info', 'DB', 'Running schema preview query');
  const timeoutMs = readDeclaredNumericSetting(host.getConfiguration(), 'dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const resultMap = await executeDmvQueries(session, [previewQuery], outputChannel, undefined, timeoutMs);
  if (token.isCancellationRequested) return;
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const platform = await loadDatabasePlatform(session, queries, outputChannel, timeoutMs);
  if (token.isCancellationRequested) return;
  const preview = buildSchemaPreview(result, platform.platformInfo);
  const config = readExtensionConfig(host);
  host.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${session.connectionInfo.server} / ${session.connectionInfo.database}` });
  host.log('info', 'DB', `Phase 1 Complete — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
}

async function runDbPhase2Host(host: BridgeHost, session: DbSession, schemas: string[], outputChannel: vscode.LogOutputChannel, loadQueries: () => Promise<DmvQuery[]>, token: vscode.CancellationToken, getSession: () => AiSession, currentDatabase?: string, sourceName?: string, onModelBuilt?: (model: DatabaseModel) => void) {
  const queries = await loadQueries();
  if (token.isCancellationRequested) return;
  host.log('info', 'DB', `Running Phase 2 queries for ${schemas.length} schema(s)`);
  host.log('debug', 'DB', `Phase 2 schemas: ${trunc(schemas, LOG_TRUNC_LIST)}`);
  const timeoutMs = readDeclaredNumericSetting(host.getConfiguration(), 'dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const allObjectsQuery = queries.find(q => q.name === 'all-objects');
  const leadSteps = allObjectsQuery ? 2 : 1;
  const totalSteps = queries.filter(isPhase2Query).length + leadSteps;
  host.postMessage({ type: 'db-progress', step: 1, total: totalSteps, label: 'Detecting database platform' });
  const platformMetadata = await loadDatabasePlatform(session, queries, outputChannel, timeoutMs);
  if (token.isCancellationRequested) return;
  let allObjectsResult: SimpleExecuteResult | undefined;
  if (allObjectsQuery) {
    host.postMessage({ type: 'db-progress', step: 2, total: totalSteps, label: 'Loading object catalog' });
    try {
      const catalogMap = await executeDmvQueries(session, [allObjectsQuery], outputChannel, undefined, timeoutMs);
      allObjectsResult = catalogMap.get('all-objects');
    } catch (err) {
      host.log('warn', 'DB', `Object catalog unavailable — cross-schema references stay unresolved: ${errorMessage(err)}`);
    }
  }
  if (token.isCancellationRequested) return;
  const resultMap = await executeDmvQueriesFiltered(session, queries, schemas, outputChannel, (step, total, label) => {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    host.postMessage({ type: 'db-progress', step: step + leadSteps, total: total + leadSteps, label });
  }, timeoutMs);
  if (token.isCancellationRequested) return;
  const requireResult = (name: 'nodes' | 'columns' | 'dependencies'): SimpleExecuteResult => {
    const result = resultMap.get(name);
    if (!result) throw new Error(`No '${name}' result from Phase 2 DMV queries`);
    return result;
  };
  const dmvResults: DmvResults = {
    nodes: requireResult('nodes'),
    columns: requireResult('columns'),
    dependencies: requireResult('dependencies'),
    constraints: resultMap.get('constraints'),
    allObjects: allObjectsResult,
    ...platformMetadata,
  };
  const config = readExtensionConfig(host);
  const logger = Logger.create(outputChannel, 'Parse');
  logger.info(`Phase 2 Resolution: Starting object parsing for ${dmvResults.nodes.rowCount} nodes...`);

  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, (msg) => {
    logger.debug(msg);
  });
  if (isModelOverLimit(model, config.maxNodes, logger, host)) return;
  logger.info(`Extraction Complete — ${model.nodes.length} nodes, ${model.edges.length} deps`);

  onModelBuilt?.(model);
  if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
  host.postMessage({ type: 'db-model', model, config, sourceName: sourceName ?? 'Database' });
  return true;
}

/** Upper bound for the platform probe, independent of `dmvQueryTimeout`. */
const PLATFORM_PROBE_TIMEOUT_MS = 10_000;

/** Resolves the database platform before the Phase 2 model is built. */
async function loadDatabasePlatform(
  session: DbSession,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  timeoutMs: number,
): Promise<Pick<DmvResults, 'platformInfo'>> {
  const logger = Logger.create(outputChannel, 'DB');
  const platformQuery = queries.find(q => q.name === 'platform-info');
  const probeTimeoutMs = Math.min(timeoutMs, PLATFORM_PROBE_TIMEOUT_MS);
  const fallback = 'platform will be explicit unknown';

  if (platformQuery) {
    try {
      const resultMap = await executeDmvQueries(session, [platformQuery], outputChannel, undefined, probeTimeoutMs);
      const platformInfo = resultMap.get('platform-info');
      const missingColumns = platformInfo ? validateQueryResult('platform-info', platformInfo) : [];
      if (platformInfo?.rows.length && missingColumns.length === 0) return { platformInfo };
      const reason = missingColumns.length > 0
        ? `missing columns: ${missingColumns.join(', ')}`
        : 'no rows';
      logger.warn(`Platform query returned unusable metadata (${reason}) — ${fallback}`);
    } catch (err) {
      logger.warn(`Platform query failed — ${fallback}: ${redactSecrets(errorMessage(err))}`);
    }
  } else {
    logger.warn(`Custom DMV configuration has no platform-info query — ${fallback}`);
  }
  return {};
}

async function withDbProgressHost(
  host: BridgeHost,
  env: DbConnectEnv,
  title: string,
  connectFn: (patch: Partial<StoredConnectionInfo> | undefined, token: vscode.CancellationToken) => Promise<DbSession | undefined>,
  phaseFn: (session: DbSession, token: vscode.CancellationToken) => Promise<void>,
  load: vscode.CancellationTokenSource,
  onCancel: () => void,
) {
  await host.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
    let session: DbSession | undefined;
    let disconnected: Promise<void> | undefined;
    const disconnect = () => session ? disconnected ??= session.dispose().catch((err: unknown) =>
      host.log('warn', 'DB', `Disconnect failed: ${errorMessage(err)}`)) : Promise.resolve();
    const progressCancellation = token.onCancellationRequested(onCancel);
    const loadCancellation = load.token.onCancellationRequested(() => { void disconnect(); });
    if (token.isCancellationRequested) onCancel();
    try {
      if (load.token.isCancellationRequested) return;
      session = await connectFn(undefined, load.token);
      if (load.token.isCancellationRequested) return;
      if (session) {
        await phaseFn(session, load.token);
      } else {
        host.log('info', 'DB', `${title} cancelled or failed to connect`);
        host.postMessage({ type: 'db-cancelled' });
      }
    } catch (err) {
      if (load.token.isCancellationRequested) return;
      const target = isDbConnectionError(err) ? err.target : session && isDriverError(err) ? targetFromSession(session) : undefined;
      if (target) {
        const retry = (patch?: Partial<StoredConnectionInfo>) => withDbProgressHost(host, env, title, (_patch, token) => connectFn(patch, token), phaseFn, load, onCancel);
        const reported = reportConnectionError(
          isDbConnectionError(err) ? err.original : err,
          target,
          Logger.create(env.outputChannel, 'DB'),
          connectionErrorHooks(env, target.connectionId, retry),
        );
        host.postMessage({ type: 'db-error', message: reported.message, phase: 'connect' });
      } else {
        const message = redactSecrets(errorMessage(err));
        host.log('error', 'DB', title, message);
        host.postMessage({ type: 'db-error', message, phase: 'connect' });
      }
    } finally {
      progressCancellation.dispose();
      loadCancellation.dispose();
      await disconnect();
    }
  });
}

async function handleTableStatsRequestHost(
  host: BridgeHost,
  dbEnv: DbConnectEnv,
  storedConnectionInfo: StoredConnectionInfo | undefined,
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: ColumnDef[],
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Stats');
  const cfg = host.getConfiguration();
  if (!cfg.get('tableStatistics.enabled', DEFAULT_CONFIG.tableStatistics.enabled)) {
    logger.info('Profiling disabled — request rejected');
    logger.debug(`Rejected profiling target: ${schema}.${objectName}`);
    void postToDetail(panel, {
      type: 'table-stats-error', objectRef: { schema, objectName },
      message: 'Table profiling is disabled by dataLineageViz.tableStatistics.enabled.',
    }, logger);
    return;
  }
  const sampleThreshold = readDeclaredNumericSetting(cfg, 'tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold);
  const sampleSize = readDeclaredNumericSetting(cfg, 'tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize);
  const useApprox = cfg.get('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct);
  const maxColumns = readDeclaredNumericSetting(cfg, 'tableStatistics.maxColumns', DEFAULT_CONFIG.tableStatistics.maxColumns);
  const timeoutSec = readDeclaredNumericSetting(cfg, 'tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout);
  const timeoutMs = timeoutSec * 1000;
  const t0 = Date.now();

  logger.info(`Profiling started (mode=${mode}, columns=${cols.length})`);
  logger.debug(`Profiling target: ${schema}.${objectName}`);
  let session: DbSession | undefined;
  try {
    session = await connectDatabase(dbEnv, storedConnectionInfo);
    if (!session) {
      void postToDetail(panel, { type: 'table-stats-error', objectRef: { schema, objectName }, message: 'Connection cancelled.' }, logger);
      return;
    }
    const serverInfo = await session.getServerInfo();
    const engineEdition = serverInfo.engineEditionId;

    const rowCountSql = buildRowCountQuery(schema, objectName);
    const rowCountResult = await executeSimpleQuery(session, rowCountSql, outputChannel, {
      ms: timeoutMs, message: `Row count query for ${schema}.${objectName} timed out after ${timeoutSec}s.`,
    });
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;

    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);
    if (!profilingSql) {
      logger.info('No profileable columns — nothing to query');
      void postToDetail(panel, {
        type: 'table-stats-error', objectRef: { schema, objectName },
        message: `No profileable columns in ${schema}.${objectName} — the column types are not supported by statistics, or dataLineageViz.tableStatistics.maxColumns excludes them all.`,
      }, logger);
      return;
    }

    const profilingTimeout = { ms: timeoutMs, message: `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.` };
    let sampled = rowCount > sampleThreshold && sampleThreshold >= 0;
    let profilingResult;
    try {
      profilingResult = await executeSimpleQuery(session, profilingSql, outputChannel, profilingTimeout);
    } catch (sampleErr) {
      if (!sampled || !/TABLESAMPLE/i.test(errorMessage(sampleErr))) throw sampleErr;
      // The table refuses TABLESAMPLE: profile it with a full scan, reported as unsampled.
      const fullScanSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, -1, sampleSize);
      profilingResult = await executeSimpleQuery(session, fullScanSql, outputChannel, profilingTimeout);
      sampled = false;
    }
    if (!profilingResult.rows.length) {
      throw new Error(`Profiling query returned no rows for ${schema}.${objectName}`);
    }
    const resultRow = profilingRowFromResult(profilingResult);

    const samplePercent = sampled ? computeSamplePercent(sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, sampled, samplePercent);
    logger.info(`Table statistics ready — rows=${rowCount}${sampled ? ` (sampled ${samplePercent}%)` : ''} (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    void postToDetail(panel, { type: 'table-stats-result', objectRef: { schema, objectName }, stats, mode }, logger);
  } catch (err) {
    if (isDbConnectionError(err)) {
      const reported = reportConnectionError(err.original, err.target, logger, connectionErrorHooks(dbEnv, err.target.connectionId, undefined));
      void postToDetail(panel, { type: 'table-stats-error', objectRef: { schema, objectName }, message: reported.message }, logger);
      return;
    }
    host.log('error', 'Stats', 'Profiling', err);
    void postToDetail(panel, { type: 'table-stats-error', objectRef: { schema, objectName }, message: redactSecrets(errorMessage(err)) }, logger);
  } finally {
    if (session) {
      await session.dispose().catch((err: unknown) =>
        host.log('warn', 'Stats', `Disconnect failed: ${redactSecrets(errorMessage(err))}`));
    }
  }
}

/** Logs a summary of the SQL parsing results and stores it in the session. */
function handleParseStats(stats: ParseStats, outputChannel: vscode.LogOutputChannel, getSession: () => AiSession, objectCount?: number, edgeCount?: number, schemaCount?: number) {
  const logger = Logger.create(outputChannel, 'Parse');
  const sess = getSession();
  const spCount = stats.spDetails?.length ?? 0;
  sess.parseStats = {
    resolvedEdges: stats.resolvedEdges,
    parsedRefs: stats.parsedRefs,
    droppedRefs: stats.droppedRefs.length,
    scripts: spCount,
    unreadableDefinitions: stats.unreadableDefinitions?.length ?? 0,
  };
  if (objectCount !== undefined) {
    logger.info(`Phase 2 Result: Construction Complete — ${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas`);
    logger.info(`Phase 2 Result: Parsing Complete — ${spCount} objects scripted, ${stats.parsedRefs} refs found, ${stats.resolvedEdges} refs resolved`);
    if (stats.droppedRefs.length > 0) {
      logger.info(`Phase 2 Result: Dropped — ${stats.droppedRefs.length} refs unrelated (aliases/built-ins)`);
    }
  }

  const unsupported: Array<[string, string[]]> = [['Definition not readable (encrypted or no VIEW DEFINITION permission) — loaded without edges', stats.unreadableDefinitions ?? []],
    ...Object.entries(stats.unsupported ?? {}).map(([label, names]): [string, string[]] => [`${label} not fully supported — loaded with the references the parser captures`, names])];
  for (const [text, names] of unsupported) {
    if (names.length) logger.warn(`${text}: ${names.length} module(s), named in the debug log`);
    if (names.length) logger.debug(`${text}: ${trunc(names, LOG_TRUNC_LIST)}`);
  }

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

/** The settings snapshot the host sends to the webview. Every other {@link ExtensionConfig} field is host-only and read where it is used. */
export type HostConfigSnapshot = Pick<
  ExtensionConfig,
  'excludePatterns' | 'maxNodes' | 'layout' | 'externalRefs' | 'overview' | 'renderLimit' | 'trace' | 'analysis'
>;

/** Reads display and behaviour settings from a VS Code workspace configuration and returns the serialisable config snapshot sent to the webview. Numeric settings are clamped to their declared manifest range; an unset value takes its `DEFAULT_CONFIG` default. */
export function buildExtensionConfig(cfg: vscode.WorkspaceConfiguration): HostConfigSnapshot {
  const num = (key: string) => readDeclaredNumericSetting(cfg, key);
  const { layout, overview, externalRefs } = DEFAULT_CONFIG;
  return {
    excludePatterns: cfg.get<string[]>('excludePatterns', DEFAULT_CONFIG.excludePatterns),
    maxNodes: num('maxNodes'),
    layout: {
      direction: cfg.get<LayoutConfig['direction']>('layout.direction', layout.direction),
      rankSeparation: num('layout.rankSeparation'),
      nodeSeparation: num('layout.nodeSeparation'),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', layout.edgeAnimation),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation', layout.highlightAnimation),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled', layout.minimapEnabled),
      edgeStyle: cfg.get<LayoutConfig['edgeStyle']>('layout.edgeStyle', layout.edgeStyle),
    },
    externalRefs: { enabled: cfg.get<boolean>('externalRefs.enabled', externalRefs.enabled) },
    overview: {
      enabled: cfg.get<boolean>('overview.enabled', overview.enabled),
      threshold: num('overview.threshold'),
      schemaDoubleClickBehavior: cfg.get<OverviewConfig['schemaDoubleClickBehavior']>('overview.schemaDoubleClickBehavior', overview.schemaDoubleClickBehavior),
    },
    renderLimit: num('renderLimit'),
    trace: {
      defaultUpstreamLevels: num('trace.defaultUpstreamLevels'),
      defaultDownstreamLevels: num('trace.defaultDownstreamLevels'),
    },
    analysis: {
      hubMinDegree: num('analysis.hubMinDegree'),
      islandMaxSize: num('analysis.islandMaxSize'),
      longestPathMinNodes: num('analysis.longestPathMinNodes'),
    },
  };
}

function readExtensionConfig(host: BridgeHost): HostConfigSnapshot {
  return buildExtensionConfig(host.getConfiguration());
}

/** Generates the root HTML for the secondary Detail Webview. */
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

/** Schema names kept on one legend line before the dump says how many more there are. */
const SCHEMA_LEGEND_CAP = 40;

/** Characters of a non-default setting value pasted into the debug dump. */
const SETTING_VALUE_CAP = 120;

/** Reads one field of an untrusted snapshot object. */
function recordField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** Prints a trace level, using All for the unbounded sentinel. */
function formatTraceLevel(value: unknown): string {
  return value === TRACE_ALL_LEVELS ? 'All' : String(value ?? '—');
}

/** Redacts one setting value, then clips it for the debug dump. Long arrays become a count. */
function formatSettingValue(value: unknown): string {
  if (Array.isArray(value)) {
    const text = JSON.stringify(value);
    return text.length > SETTING_VALUE_CAP ? `${value.length} item(s)` : redactSecrets(text);
  }
  if (value === undefined) return 'undefined';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return trunc(redactSecrets(text), SETTING_VALUE_CAP);
}

/** True when two setting values are the same JSON shape, treating a missing value as null. */
function sameSetting(actual: unknown, fallback: unknown): boolean {
  const stable = (value: unknown) => JSON.stringify(value === undefined ? null : value);
  return stable(actual) === stable(fallback);
}

/** Numeric parse summary. Script names and reference lists stay out of the clipboard. */
function formatParseStatsSummary(stats: SessionParseCounts): string {
  return [
    'PARSE STATS',
    `  Parsed refs:            ${stats.parsedRefs}`,
    `  Resolved edges:         ${stats.resolvedEdges}`,
    `  Dropped refs:           ${stats.droppedRefs}`,
    `  Scripts:                ${stats.scripts}`,
    `  Unreadable definitions: ${stats.unreadableDefinitions}`,
  ].join('\n');
}

/** Short view summary: mode, filter counts and trace scope. The raw ui-state object is not pasted. */
function formatGuiSummary(uiState: unknown): string | null {
  if (uiState === null || typeof uiState !== 'object') return null;
  const lines = ['GUI'];
  const graphMode = recordField(uiState, 'graphMode');
  if (graphMode !== undefined) lines.push(`  Graph mode:   ${String(graphMode)}`);
  const filteredCount = recordField(uiState, 'filteredCount');
  if (typeof filteredCount === 'number') lines.push(`  Filtered:     ${filteredCount} nodes`);
  const renderLimitHit = recordField(uiState, 'renderLimitHit');
  if (typeof renderLimitHit === 'number') lines.push(`  Render limit: ${renderLimitHit}`);
  const filter = recordField(uiState, 'filter');
  if (filter !== null && typeof filter === 'object') {
    const count = (key: string) => Array.isArray(recordField(filter, key)) ? (recordField(filter, key) as unknown[]).length : 0;
    const allowlist = recordField(filter, 'allowlistNodeIds');
    const allowText = Array.isArray(allowlist) ? `, allowlist ${allowlist.length}` : '';
    lines.push(`  Filter:       schemas ${count('schemas')}, types ${count('types')}, exclusions ${count('exclusionPatterns')}, focus ${count('focusSchemas')}, hideIsolated ${String(recordField(filter, 'hideIsolated'))}, external ${String(recordField(filter, 'showExternalRefs'))}${allowText}`);
  }
  const trace = recordField(uiState, 'trace');
  if (trace !== null && typeof trace === 'object') {
    lines.push(`  Trace:        ${String(recordField(trace, 'mode') ?? 'none')} origin ${String(recordField(trace, 'selectedNodeId') ?? '(none)')} up ${formatTraceLevel(recordField(trace, 'upstreamLevels'))} down ${formatTraceLevel(recordField(trace, 'downstreamLevels'))}`);
  }
  const expanded = recordField(uiState, 'expandedSchemaView');
  if (expanded !== null && typeof expanded === 'object') {
    const schemas = recordField(expanded, 'expandedSchemas');
    const count = Array.isArray(schemas) ? schemas.length : 0;
    lines.push(`  Schema view:  ${count} expanded schema(s), focus ${String(recordField(expanded, 'focusNodeId') ?? '(none)')}`);
  }
  return lines.join('\n');
}

/** Settings that differ from the package default. `ai.*` is omitted. Connection records are a count. */
function formatNonDefaultSettings(context: vscode.ExtensionContext): string {
  const lines = ['SETTINGS (non-default dataLineageViz.*, excluding ai.*)'];
  try {
    const cfg = vscode.workspace.getConfiguration('dataLineageViz');
    const pkg = context.extension.packageJSON as { contributes?: { configuration?: Array<{ properties?: Record<string, { default?: unknown }> }> } };
    const sections = pkg.contributes?.configuration ?? [];
    let declared = 0;
    let any = false;
    for (const section of sections) {
      for (const [key, property] of Object.entries(section.properties ?? {})) {
        const shortKey = key.replace(/^dataLineageViz\./, '');
        if (shortKey === 'ai' || shortKey.startsWith('ai.')) continue;
        declared += 1;
        const actual = cfg.get(shortKey);
        if (sameSetting(actual, property.default)) continue;
        any = true;
        if (shortKey === 'database.connections' && Array.isArray(actual)) {
          lines.push(`  database.connections: ${actual.length} connection(s)`);
          continue;
        }
        lines.push(`  ${shortKey}: ${formatSettingValue(actual)} (default ${formatSettingValue(property.default)})`);
      }
    }
    if (declared === 0) lines.push('  (no declared settings)');
    else if (!any) lines.push('  (all at package defaults)');
  } catch (err) {
    lines.push(`  Error reading settings: ${err}`);
  }
  return lines.join('\n');
}

/** Builds a GUI diagnostic snapshot for the current extension state. */
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

  add('ENVIRONMENT');
  add(`  Extension:    ${version}`);
  add(`  Build Stamp:  ${buildStamp}`);
  add(`  VS Code:      ${vscode.version}`);
  add(`  OS:           ${os.type()} ${os.release()} (${os.arch()})`);
  add('');

  add('DATA SOURCE');
  add(`  Project:      ${sess.projectName ?? 'N/A'}`);
  add(`  Source:       ${sess.sourceLabel}`);
  add(`  Platform:     ${sess.model?.dbPlatform ?? 'N/A'}`);
  add(`  Parse rules:  ${sess.parseRulesLabel}`);
  add('');

  if (sess.model) {
    add('MODEL');
    add(`  Nodes total:  ${sess.model.nodes.length}`);
    add(`  Edges total:  ${sess.model.edges.length}`);
    add(`  Schemas:      ${sess.model.schemas.length}`);
    add('');

    add('MODEL CONNECTIVITY (full model, filter-independent)');
    add(formatModelConnectivity(summarizeModelConnectivity(sess.model)));
    add('');

    const legend = sess.model.schemas
      .filter(s => !(s.types['external'] > 0 && s.nodeCount === s.types['external']))
      .map(s => `${s.name} (${s.nodeCount})`);
    const shownLegend = legend.slice(0, SCHEMA_LEGEND_CAP);
    const hiddenLegend = legend.length - shownLegend.length;
    add('SCHEMA LEGEND');
    add(`  ${shownLegend.join(', ') || '(none)'}${hiddenLegend > 0 ? ` … +${hiddenLegend} more` : ''}`);
    add('');
  }

  if (sess.parseStats) {
    add(formatParseStatsSummary(sess.parseStats));
    add('');
  }

  const gui = formatGuiSummary(sess.uiState);
  if (gui) {
    add(gui);
    add('');
  }

  add('RENDER STATE (current screen)');
  if (uiDiagnostics.renderState) {
    add(`  Highlighted: ${uiDiagnostics.renderState.highlightedNodeId ?? '(none)'}`);
    if (uiDiagnostics.renderState.connectivity) add(formatRenderConnectivity(uiDiagnostics.renderState.connectivity));
  } else {
    add('  (no render-state reported — graph not rendered, or render-limit mode)');
  }
  add('');

  add(formatScreenStateSections(
    uiDiagnostics.renderState,
    (sess.uiState as { screenState?: ScreenStateExtras } | null)?.screenState ?? null,
    sess.model ?? null,
  ));

  add(`LAST ERRORS (${uiDiagnostics.lastErrors.length})`);
  if (uiDiagnostics.lastErrors.length === 0) {
    add('    (none captured this session)');
  } else {
    for (const e of uiDiagnostics.lastErrors) {
      add(`  [${new Date(e.timestamp).toISOString()}] source=${e.source}`);
      add(`    message:   ${e.message}`);
      if (e.componentStack) add(`    component: ${e.componentStack}`);
      if (e.context !== undefined) add(`    context:   ${trunc(redactSecrets(JSON.stringify(e.context)), 800)}`);
      if (e.stack) add(`    stack:     ${e.stack}`);
    }
  }
  add('');

  add('SM SUMMARY');
  add(`  Phase:        ${sess.phase.kind}`);
  add(`  Status:       ${sess.stateMachine?.status ?? 'idle'}`);
  add(`  Hops:         ${sess.hopCount}`);
  add(`  Pending gate: ${sess.phase.kind === 'awaiting_gate' ? sess.phase.gate.gate : 'none'}`);
  add(`  Result nodes: ${sess.resultGraph?.nodeIds.length ?? 0}`);
  add('  Full SM dump: use Data Lineage: Dump AI State Machine');
  add('');

  add(formatNonDefaultSettings(context));
  add('');

  return lines.join('\n');
}
