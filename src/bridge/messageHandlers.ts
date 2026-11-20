import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { type AiSession } from '../ai/session/session';
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
  UNKNOWN_DB_PLATFORM,
} from '../engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from '../engine/dacpacExtractor';
import { checkObjectLimit, formatObjectLimitMessage } from '../engine/modelFilters';
import {
  connectDatabase, connectionErrorHooks, releaseSession,
  loadDmvQueries, createDmvQueryCache, executeDmvQueries, executeDmvQueriesFiltered,
  executeSimpleQuery, isPhase2Query, type DmvQuery, type DbConnectEnv,
} from '../engine/connectionManager';
import type { DbSession } from '../engine/db/dbSession';
import { usesMssqlExtension } from '../engine/db/mssqlRetiring';
import { connectionFailure, reportConnectionError } from '../engine/db/connectionErrors';
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
  DetailPanelToExtensionMsgSchema,
  LOAD_RESULT_TYPES,
  ProjectSchema,
  type ExtensionToWebviewMsg,
  type MainPanelToExtensionMsg,
  type Project,
  type RenderStateSnapshot,
  type StoredConnectionInfo,
  type ScreenStateExtras,
  stripFocusNodeLinks,
} from '../engine/shared/bridgeContract';
import { summarizeZodError, postToDetail } from './host';
import { readDeclaredNumericSetting } from '../configCore';

/**
 * Handler per main-panel message type, with `msg` narrowed to the matching
 * {@link MainPanelToExtensionMsg} variant.
 */
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

/**
 * Splits a project list into records the webview contract accepts and those it rejects. The send
 * validates the whole frame, so one bad record would cost every project; partitioning keeps the
 * rest and names the rejected one in the log. {@link ProjectSchema} stays strict.
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
    host.log('warn', 'Bridge', 'A saved project failed validation and was not sent to the view');
    host.log('debug', 'Bridge', `Project "${record.id}" was not sent to the view — ${record.issues}`);
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

/** Key of the project store in VS Code's global state. */
export const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

/** Message handlers with their cleanup logic. */
export interface MessageHandlerBundle {
  /** Map of message types to their per-variant handler functions. */
  handlers: WebviewMessageHandlers;
  /** Releases resources (e.g. database connections) when the panel is disposed. */
  cleanup: () => Promise<void>;
  /** Function to programmatically trigger the demo load when the panel is already active. */
  triggerDemoLoad: () => Promise<void>;
}

/**
 * Installs a freshly built model as the session's current one, without posting to a webview, so a
 * command-driven load leaves the session as a bridge-driven load does: column store repopulated,
 * source labels set, `dataLineageViz.modelLoaded` raised. The lineage store is opened for `project`
 * only, fire-and-forget; the snapshot is taken synchronously because the write runs later on the
 * storage queue, when the session may hold another model.
 *
 * @param store - Consulted for the source label; read only when `project` is set.
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
    sess.currentProjectId = null;
    sess.sourceLabel = isDb ? 'database' : 'dacpac';
  }
  void vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
}

/**
 * Mutable holder of the session's untitled AI report document; a closed document is never reused.
 */
export interface ReportDocumentRef {
  document?: vscode.TextDocument;
}

/**
 * Creates the IPC bridge between the Extension Host and the Webview.
 *
 * @param reportDocumentRef - Holder of the untitled AI report document, owned by the caller so one
 *   report document survives the handlers being re-created when the panel is reopened. Defaults to
 *   a private holder.
 * @returns The per-message-type handler map plus the panel-dispose cleanup.
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
  setDetailPanel: (panel: vscode.WebviewPanel | undefined) => void,
  reportDocumentRef: ReportDocumentRef = {}
): MessageHandlerBundle {

  type DacpacPreview = Awaited<ReturnType<typeof extractSchemaPreview>>;
  let cachedDacpac: DacpacPreview | null = null;
  /**
   * Builds the selected schemas of a parsed dacpac and installs the model, unless it is over the
   * object limit.
   */
  function installFilteredDacpac(
    host: BridgeHost,
    dacpac: DacpacPreview,
    schemas: readonly string[],
    config: Awaited<ReturnType<typeof readExtensionConfig>>,
    project: { id: string; name: string } | null,
    sourceName: string,
  ): void {
    const logger = Logger.create(outputChannel, 'Parse');
    const model = extractDacpacFiltered(dacpac.elements, new Set(schemas), dacpac.dspName, (msg) => logger.debug(msg), (msg) => logger.info(msg), {
      externalRefsEnabled: config.externalRefs.enabled,
      identifierCaseSensitive: dacpac.identifierCaseSensitive,
    });
    if (isModelOverLimit(model, config.maxNodes, logger, host)) return;
    logger.info(`Dacpac filtered — ${model.nodes.length} nodes, ${model.edges.length} edges`);
    setCurrentModel(model, false, project);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName, projectId: project?.id });
  }

  let lastConnectionInfo: StoredConnectionInfo | undefined;
  const dmvQueries = createDmvQueryCache(() => loadDmvQueries(outputChannel, context.extensionUri));
  const dbEnv: DbConnectEnv = { secrets: context.secrets, outputChannel, loadQueries: dmvQueries.get };
  let detailPanel: vscode.WebviewPanel | undefined;
  let lastDetailNode: LineageNode | null = null;

  let reportWrite: Promise<unknown> = Promise.resolve();
  /**
   * Puts `content` into the report document, one call at a time so a second click meets the
   * document the first created.
   */
  function writeReportDocument(content: string): Promise<vscode.TextDocument> {
    const written = reportWrite.then(() => putReportContent(content));
    reportWrite = written.catch(() => undefined);
    return written;
  }
  /** Replaces the report document's text, creating it when none is open or the edit is refused. */
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
  /**
   * The built-in markdown preview tabs titled for `doc`, across all editor groups.
   *
   * The built-in preview labels a tab `<prefix> <name>` (`Preview <name>`, `[Preview] <name>` when
   * locked, prefix localized), so the document name must be the whole last word. The webview tab
   * has no document URI; a different document whose name has a space before the same `Untitled-N`
   * text is the one case this cannot tell apart.
   */
  function reportPreviewTabs(doc: vscode.TextDocument): vscode.Tab[] {
    const name = path.basename(doc.uri.path);
    return vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('markdown.preview') && tab.label.endsWith(` ${name}`)));
  }
  /**
   * Leaves at most the visible report previews on screen; true when one is the visible tab of an
   * editor group.
   *
   * A hidden preview is closed even when another report preview is visible: the preview command
   * opens a new one whenever the group beside the active one has none, which would leave two. A
   * refused or failed close is logged and the command still runs.
   */
  async function settleReportPreviews(doc: vscode.TextDocument): Promise<boolean> {
    const previews = reportPreviewTabs(doc);
    for (const tab of previews.filter((candidate) => !candidate.isActive)) {
      const closed = await Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => false);
      if (!closed) {
        host.log('warn', 'Bridge', 'A hidden report preview tab could not be closed');
        host.log('debug', 'Bridge', `Hidden report preview tab "${tab.label}" could not be closed`);
      }
    }
    return previews.some((tab) => tab.isActive);
  }

  /**
   * Installs a newly loaded model. The detail panel shows a node of the old model, so it is
   * cleared; a DACPAC model drops the previous database connection, so table statistics cannot
   * reach the database it came from.
   */
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
      host.log('warn', 'Bridge', `Failed to clear AI run memory for a saved view: ${err instanceof Error ? err.message : String(err)}`);
      host.log('debug', 'Bridge', `AI run memory not cleared for view ${profileId}`);
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

  /** The one load the webview still waits for; starting another cancels it. */
  let current: { id?: string; cancel(): void } | undefined;

  /**
   * Wraps a load-starting handler so the load the webview named can be cancelled by its id.
   *
   * `msg.loadId` is the webview's id for the load; a request without one runs unstamped and cannot
   * be cancelled by id. `body` gets a host that stamps load-result messages with the id and drops
   * them once the load is cancelled; this closure is the only place the id is applied. The host's
   * progress token also fires on cancel, stopping the connection and query steps that watch it.
   *
   * The latest intent wins: starting a load cancels the previous one, because the webview drops its
   * results and a load that finished last must not set the session model or write the project store
   * behind the screen.
   *
   * A retry started by the connection-error toast after its load ended opens a new progress
   * notification through the same host. While the load is current the retry gets a fresh source, so
   * `cancel-load` still reaches it and its results are stamped. It is refused when a newer load
   * replaced this one (the webview would drop its results) and while another retry runs, so one
   * load never has two live sources and the live source gates every post.
   */
  function loadHandler<M extends { loadId?: string }>(
    body: (host: BridgeHost, token: vscode.CancellationToken, msg: M) => Promise<void> | void,
  ): (msg: M) => Promise<void> {
    return async (msg) => {
      const { loadId } = msg;
      let source = new vscode.CancellationTokenSource();
      let ended = false;
      let retrying = false;
      const mine = { id: loadId, cancel: () => source.cancel() };
      current?.cancel();
      current = mine;
      /** Reads the live source, so a guard made before a retry still sees the retry's cancel. */
      const token: vscode.CancellationToken = {
        get isCancellationRequested() { return source.token.isCancellationRequested; },
        onCancellationRequested: (listener, thisArgs, disposables) => source.token.onCancellationRequested(listener, thisArgs, disposables),
      };
      const scoped: BridgeHost = {
        ...host,
        postMessage: (out: ExtensionToWebviewMsg) => {
          if (!loadId || !(LOAD_RESULT_TYPES as readonly string[]).includes(out.type)) return host.postMessage(out);
          return source.token.isCancellationRequested ? Promise.resolve(false) : host.postMessage({ ...out, loadId } as ExtensionToWebviewMsg);
        },
        withProgress: <R,>(options: vscode.ProgressOptions, task: (progress: vscode.Progress<unknown>, token: vscode.CancellationToken) => Thenable<R>) => {
          const isRetry = ended;
          if (isRetry) {
            if (current !== mine || retrying) {
              host.log('info', 'Bridge', 'Retry skipped — a newer load replaced this one or a retry is running');
              return Promise.resolve(undefined as R);
            }
            retrying = true;
            source = new vscode.CancellationTokenSource();
          }
          const mySource = source;
          return host.withProgress(options, async (progress, progressToken) => {
            const merged = new vscode.CancellationTokenSource();
            const links = [progressToken, mySource.token].map((t) => t.onCancellationRequested(() => merged.cancel()));
            try {
              return await task(progress, merged.token);
            } finally {
              links.forEach((link) => link.dispose());
              merged.dispose();
              if (isRetry) {
                mySource.dispose();
                retrying = false;
              }
            }
          });
        },
      };
      try {
        await body(scoped, token, msg);
      } finally {
        ended = true;
        source.dispose();
      }
    };
  }

  /** Runs `fn` only while the load is live, so a cancelled load leaves no model in the session. */
  const unlessCancelled = (token: vscode.CancellationToken, fn: (model: DatabaseModel) => void) =>
    (model: DatabaseModel): void => { if (!token.isCancellationRequested) fn(model); };

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
      // Every `ready` (first, or after a webview reload) re-syncs the session's model: a load a
      // command installed before the webview could receive it, or a post lost across a reload, is
      // delivered here.
      if (sess.model) {
        host.log('info', 'Bridge', 'Restoring the session model');
        host.log('debug', 'Bridge', `Restoring session for project: ${sess.projectName}`);
        host.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true, projectId: sess.currentProjectId ?? undefined });
      }
    },
    'show-detail': async (msg) => {
      host.log('info', 'Bridge', 'Node detail opened');
      host.log('debug', 'Bridge', `Node detail opened — ${msg.node?.id || '(no node)'}`);
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
                await handleTableStatsRequestHost(host, dbEnv, lastConnectionInfo, detailPanel, m.schema, m.objectName, m.mode, m.columns ?? [], outputChannel, getSession().model);
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
    'open-dacpac': loadHandler(async (host, token) => {
      host.log('info', 'Bridge', 'Opening dacpac picker');
      const uris = await host.showOpenDialog({
        canSelectMany: false,
        filters: { 'DACPAC': ['dacpac'] },
        title: 'Select a .dacpac file'
      });
      if (uris && uris.length > 0) {
        host.log('info', 'Bridge', 'Dacpac selected');
        host.log('debug', 'Bridge', `Selected dacpac: ${uris[0].fsPath}`);
        const data = await host.readFile(uris[0]);
        if (isDacpacTooLarge(data.byteLength, host, outputChannel)) return;
        const config = await readExtensionConfig(host);
        let extracted: Awaited<ReturnType<typeof extractSchemaPreview>>;
        try {
          extracted = await extractSchemaPreview(data);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          host.log('error', 'Dacpac', 'Open dacpac', err);
          host.log('debug', 'Dacpac', `Open dacpac failed: ${uris[0].fsPath}`);
          host.postMessage({ type: 'db-error', message: `Could not open ${path.basename(uris[0].fsPath)}: ${reason}` });
          return;
        }
        if (token.isCancellationRequested) return;
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
    }),
    'load-project': loadHandler(async (host, token, msg) => {
      host.log('info', 'Bridge', 'Loading project');
      host.log('debug', 'Bridge', `Loading project: ${msg.id}`);
      const store = loadProjectStore(context);
      const project = store.projects.find(p => p.id === msg.id);
      if (!project) {
        host.log('error', 'Bridge', 'Load project', 'Project not found');
        host.log('debug', 'Bridge', `Project not found: ${msg.id}`);
        host.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}` });
        return;
      }

      if (project.connection.type === 'dacpac') {
        try {
          const fileUri = vscode.Uri.file(project.connection.path);
          host.log('debug', 'Bridge', `Reading dacpac file: ${fileUri.fsPath}`);
          const data = await host.readFile(fileUri);
          if (token.isCancellationRequested || isDacpacTooLarge(data.byteLength, host, outputChannel)) return;

          const refreshed = { ...project, updatedAt: new Date().toISOString() };
          const updatedStore = updateProject(store, refreshed);
          await saveProjectStore(context, updatedStore);
          postProjectsList(host, updatedStore);

          const config = await readExtensionConfig(host);
          const schemas = project.connection.schemas;

          const extracted = await extractSchemaPreview(data);
          if (token.isCancellationRequested) return;
          if (schemas && schemas.length > 0) {
            host.log('debug', 'Bridge', `Extracting filtered dacpac for schemas: ${trunc(schemas, LOG_TRUNC_LIST)}`);
            const name = project.connection.displayName;
            installFilteredDacpac(host, extracted, schemas, config, { id: project.id, name }, name);
          } else {
            host.log('debug', 'Bridge', 'No schemas in project, showing preview');
            const { preview } = extracted;
            cachedDacpac = extracted;
            host.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: project.connection.displayName });
            host.log('info', 'Dacpac', `Schema preview — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
          }
        } catch (err) {
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            host.log('warn', 'Bridge', 'Dacpac file not found');
            host.log('debug', 'Bridge', `Dacpac file not found: ${project.connection.path}`);
            host.postMessage({ type: 'last-dacpac-gone' });
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            host.log('error', 'Bridge', 'Load project', err);
            host.log('debug', 'Bridge', `Load project failed: ${project.connection.path}`);
            host.postMessage({ type: 'db-error', message: `Could not load ${project.connection.displayName}: ${reason}` });
          }
        }
      } else if (project.connection.type === 'database') {
        const dbConn = project.connection;
        const wasLegacy = usesMssqlExtension(dbConn.connectionInfo);
        const storeReconnected = async (session: DbSession) => {
          if (token.isCancellationRequested) return;
          const updatedStore = updateProject(store, {
            ...project,
            connection: { ...dbConn, connectionInfo: session.connectionInfo },
            updatedAt: new Date().toISOString(),
          });
          await saveProjectStore(context, updatedStore);
          postProjectsList(host, updatedStore);
        };
        await withDbProgressHost(host, dbEnv, 'Loading project', (patch, progressToken) => connectDatabase(dbEnv, { ...dbConn.connectionInfo, ...patch }, progressToken), async (session) => {
          lastConnectionInfo = session.connectionInfo;
          const schemas = dbConn.schemas;
          if (!schemas || schemas.length === 0) {
            await runDbPhase1Host(host, session, outputChannel, dmvQueries.reload);
            if (wasLegacy) await storeReconnected(session);
          } else {
            await runDbPhase2Host(host, session, schemas, outputChannel, dmvQueries.reload, getSession, session.connectionInfo.database, dbConn.sourceName, unlessCancelled(token, (m) => {
              setCurrentModel(m, true, { id: project.id, name: project.name });
            }), project.id);
            await storeReconnected(session);
          }
        });
      }
    }),
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
      const sess = getSession();
      if (sess.currentProjectId === msg.id) sess.currentProjectId = null;
      postProjectsList(host, updated);
      for (const profileId of profileIds) {
        await clearStoredRunLogged(profileId);
      }
    },
    'load-demo': loadHandler(async (host, token) => {
      host.log('debug', 'Bridge', 'Loading demo');
      await handleLoadDemo(host, getSession, outputChannel, unlessCancelled(token, (m) => {
        setCurrentModel(m, false, null);
        getSession().projectName = 'Demo';
      }));
    }),
    'dacpac-visualize': loadHandler(async (host, token, msg) => {
      host.log('debug', 'Bridge', `Dacpac visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      if (!cachedDacpac) {
        host.log('error', 'Bridge', 'Dacpac visualize', 'Session expired (cachedDacpac is null)');
        host.postMessage({ type: 'db-error', message: 'Session expired. Please reopen the file.' });
        return;
      }
      const config = await readExtensionConfig(host);
      if (token.isCancellationRequested) return;
      const sess = getSession();
      const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
      try {
        installFilteredDacpac(host, cachedDacpac, msg.schemas, config, msg.projectId ? { id: msg.projectId, name: projectName } : null, projectName);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        host.log('error', 'Dacpac', 'Dacpac visualize', err);
        host.postMessage({ type: 'db-error', message: `Could not build the lineage model: ${reason}` });
      }
    }),
    'db-visualize': loadHandler(async (host, token, msg) => {
      host.log('debug', 'Bridge', `Database visualize requested for schemas: ${msg.schemas?.join(', ')}`);
      return withDbProgressHost(host, dbEnv, 'Loading selected schemas', async (patch, progressToken) => {
        if (!lastConnectionInfo) {
          host.log('error', 'Bridge', 'Database visualize', 'No stored connection info');
          host.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.' });
          return undefined;
        }
        return connectDatabase(dbEnv, { ...lastConnectionInfo, ...patch }, progressToken);
      }, async (conn, _progress, progressToken) => {
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

        await runDbPhase2Host(host, conn, msg.schemas, outputChannel, dmvQueries.reload, getSession, conn.connectionInfo.database, sourceName, unlessCancelled(token, (m) => {
          if (pendingProject) {
            setCurrentModel(m, true, { id: pendingProject.id, name: pendingProject.name });
          } else {
            setCurrentModel(m, true, null);
            getSession().projectName = sourceName;
          }
        }), pendingProject?.id);

        if (pendingProject && !progressToken.isCancellationRequested) {
          const store = loadProjectStore(context);
          const updated = updateProject(store, pendingProject);
          await saveProjectStore(context, updated);
          postProjectsList(host, updated);
        }
      });
    }),
    'filter-changed': (msg) => {
      const sess = getSession();
      const { uiState } = msg;
      const prevCount = (sess.uiState as { filteredCount?: number } | null)?.filteredCount;
      const prevHit = sess.renderLimitHit;
      sess.uiState = uiState;
      sess.filter = uiState.filter;
      sess.traceState = uiState.trace;
      sess.graphMode = uiState.graphMode;
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
    'db-connect': loadHandler((host) => {
      host.log('debug', 'Bridge', 'Database connect requested');
      return withDbProgressHost(host, dbEnv, 'Connecting', (_patch, token) => connectDatabase(dbEnv, undefined, token), (conn) => {
        lastConnectionInfo = conn.connectionInfo;
        return runDbPhase1Host(host, conn, outputChannel, dmvQueries.reload);
      });
    }),
    'cancel-load': (msg) => {
      host.log('debug', 'Bridge', 'Load cancel requested');
      if (current?.id === msg.loadId) current.cancel();
    },
    'save-view': async (msg) => {
      const logger = Logger.create(outputChannel, 'Bridge');
      logger.debug(`Saving filter view: "${msg.profile?.name}" (projectId: ${msg.projectId})`);
      try {
        const store = loadProjectStore(context);
        const updated = addFilterProfile(store, msg.projectId, msg.profile);
        await saveProjectStore(context, updated);
        logger.info('Saved filter view');
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
          logger.warn(`Failed to store AI run memory for the saved view: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        }
      } catch (err) {
        logger.error('Failed to save filter view', err);
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
      const config = await readExtensionConfig(host);
      host.postMessage({ type: 'rebuild-config', config });
    },
    'reload': () => {
      host.log('debug', 'Bridge', 'Reloading panel');
      host.executeCommand('dataLineageViz.open', { replace: true });
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
    /**
     * Saves a webview-composed export under a name the user confirms in the save dialog.
     * `defaultName` is webview-supplied, so only its base name pre-fills the dialog; separators or
     * `..` segments would seed it at a path the export never came from. The dialog still owns the
     * destination.
     */
    'export-file': async (msg) => {
      const defaultName = path.basename(msg.defaultName);
      host.log('debug', 'Bridge', `Exporting file: ${defaultName}`);
      const uri = await host.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName) });
      if (uri) {
        await host.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        host.executeCommand('revealFileInOS', uri);
      }
    },
    /**
     * Shows the AI report in one untitled markdown document and one preview beside the panel.
     *
     * The first click creates the document; later clicks replace its text and reuse it while open,
     * so repeated clicks accumulate no documents or previews. The unsaved document stays for the
     * user to keep or save. An open preview follows its document, so the preview command runs only
     * when no report preview is the visible tab of a group; a hidden one is closed first (the
     * command opens a new preview whenever the group beside the active one has none). No HTML
     * sanitizing runs: the content lands in a text document that VS Code's markdown preview renders
     * under its `markdown.preview.security` policy. The preview command belongs to the built-in
     * markdown extension, which a user can disable; its absence is not a failed action, so the
     * fallback shows the document and warns.
     */
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
          { messageType: 'ai-open-in-editor', reason: err instanceof Error ? err.message : String(err) },
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

      host.log('error', 'Bridge', `Webview ${sanitizeForLog(source)} — notification="${userMessage}" — messageType=error; source=${sanitizeForLog(source)}; component=${componentLine}`, err);
      host.log('debug', 'Bridge', `Webview ${sanitizeForLog(source)} error context=${contextLine}`);
      host.showErrorMessage(userMessage);
    },
    'show-warning': (msg) => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      notifyWarning(
        Logger.create(outputChannel, 'Bridge'),
        'Webview warning notification',
        `Data Lineage: ${text}`,
        { messageType: 'show-warning' },
      );
    },
    'view-render-result': (msg) => {
      const logger = Logger.create(outputChannel, 'Bridge');
      if (msg.of === 0) return;
      if (msg.rendered === msg.of) {
        logger.debug(`AI view rendered — ${msg.rendered}/${msg.of} nodes resolved`);
      } else if (msg.rendered > 0) {
        logger.info(`AI view rendered ${msg.rendered}/${msg.of} — ${msg.unresolved.length} scoped id(s) not in the loaded model`);
        logger.debug(`AI view unresolved ids: ${trunc(msg.unresolved.join(', '), 200)}`);
      } else {
        logger.warn(`AI view rendered 0/${msg.of} — none of the scoped objects are in the loaded render model`);
        logger.debug(`AI view unresolved ids: ${trunc(msg.unresolved.join(', '), 200)}`);
      }
    },
  };

  return {
    handlers,
    cleanup: async () => {
      dmvQueries.dispose();
    },
    triggerDemoLoad: async () => handlers['load-demo']({ type: 'load-demo' }),
  };
}

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Toast sink for a failure the webview already shows inline via `db-error`: log it, show it once.
 */
const SHOWN_INLINE = (): void => {};

/**
 * Refuses a dacpac over {@link MAX_DACPAC_BYTES}. Like {@link isModelOverLimit}, the refusal is
 * posted as a `db-error`, so the loader shows it inline and leaves its loading state instead of
 * spinning to its timeout.
 */
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
  host.postMessage({ type: 'db-error', message });
  return true;
}

/**
 * Refuses a built model that exceeds `dataLineageViz.maxNodes`: the shared `checkObjectLimit` gate
 * for every load path. With a webview bridge the refusal is posted as a `db-error`, shown inline,
 * and the loader leaves its loading state at once instead of timing out. Without `host` it is a
 * `vscode.window.showErrorMessage` toast.
 */
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
  host?.postMessage({ type: 'db-error', message });
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
    });
    if (isModelOverLimit(model, config.maxNodes, logger, host)) return;
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
    host.log('info', 'Dacpac', `Demo loaded: ${model.nodes.length} nodes`);
    host.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true, isDemo: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyError(
      Logger.create(outputChannel, 'Dacpac'),
      'Load demo',
      `Data Lineage: Failed to load demo — ${msg}`,
      err,
      { asset: 'assets/demo.dacpac' },
      SHOWN_INLINE,
    );
    host.postMessage({ type: 'db-error', message: `Failed to load demo — ${msg}` });
  }
}

async function runDbPhase1Host(host: BridgeHost, session: DbSession, outputChannel: vscode.LogOutputChannel, loadQueries: () => Promise<DmvQuery[]>) {
  const queries = await loadQueries();
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) throw new Error('Missing schema-preview query');
  host.log('info', 'DB', 'Running schema preview query');
  const timeoutMs = readDeclaredNumericSetting(host.getConfiguration(), 'dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const resultMap = await executeDmvQueries(session, [previewQuery], outputChannel, undefined, timeoutMs);
  const result = resultMap.get('schema-preview');
  if (!result) throw new Error('No schema preview result');
  const platform = await loadDatabasePlatform(session, queries, outputChannel, timeoutMs);
  const preview = buildSchemaPreview(result, platform.platformInfo);
  const config = await readExtensionConfig(host);
  host.postMessage({ type: 'db-schema-preview', preview, config, sourceName: `${session.connectionInfo.server} / ${session.connectionInfo.database}` });
  host.log('info', 'DB', `Phase 1 Complete — ${preview.schemas.length} schemas, ${preview.totalObjects} objects`);
}

async function runDbPhase2Host(host: BridgeHost, session: DbSession, schemas: string[], outputChannel: vscode.LogOutputChannel, loadQueries: () => Promise<DmvQuery[]>, getSession: () => AiSession, currentDatabase?: string, sourceName?: string, onModelBuilt?: (model: DatabaseModel) => void, projectId?: string) {
  const queries = await loadQueries();
  host.log('info', 'DB', `Running Phase 2 queries for ${schemas.length} schema(s)`);
  host.log('debug', 'DB', `Running Phase 2 queries for schemas: ${schemas.join(', ')}`);
  const timeoutMs = readDeclaredNumericSetting(host.getConfiguration(), 'dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const allObjectsQuery = queries.find(q => q.name === 'all-objects');
  const leadSteps = allObjectsQuery ? 2 : 1;
  const totalSteps = queries.filter(isPhase2Query).length + leadSteps;
  host.postMessage({ type: 'db-progress', step: 1, total: totalSteps, label: 'Detecting database platform' });
  const platformMetadata = await loadDatabasePlatform(session, queries, outputChannel, timeoutMs);
  let allObjectsResult: SimpleExecuteResult | undefined;
  if (allObjectsQuery) {
    host.postMessage({ type: 'db-progress', step: 2, total: totalSteps, label: 'Loading object catalog' });
    try {
      const catalogMap = await executeDmvQueries(session, [allObjectsQuery], outputChannel, undefined, timeoutMs);
      allObjectsResult = catalogMap.get('all-objects');
    } catch (err) {
      host.log('warn', 'DB', `Object catalog unavailable — cross-schema references stay unresolved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const resultMap = await executeDmvQueriesFiltered(session, queries, schemas, outputChannel, (step, total, label) => {
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

  const model = buildModelFromDmv(dmvResults, currentDatabase, config.externalRefs.enabled, (msg) => {
    logger.debug(msg);
  });
  if (isModelOverLimit(model, config.maxNodes, logger, host)) return;
  logger.info(`Extraction Complete — ${model.nodes.length} nodes, ${model.edges.length} deps`);

  onModelBuilt?.(model);
  if (model.parseStats) handleParseStats(model.parseStats, outputChannel, getSession, model.nodes.length, model.edges.length, model.schemas.length);
  host.postMessage({ type: 'db-model', model, config, sourceName: sourceName ?? 'Database', projectId });
}

/**
 * Upper bound for the platform probe, independent of `dmvQueryTimeout`. The probe is a single-row
 * `SERVERPROPERTY` read that blocks the Phase 2 sweep, so it must not inherit the bulk-query budget
 * (default 120 s): an unreachable server would stall the import behind a progress notification with
 * no steps.
 */
const PLATFORM_PROBE_TIMEOUT_MS = 10_000;

/**
 * Resolves the database platform before the Phase 2 model is built, as `buildModelFromDmv` needs it
 * at construction.
 *
 * Two tiers, neither may fail the import: the `platform-info` query, then an explicit unknown
 * label, never an invented `SQL Server` default. The session's `getServerInfo` is no third tier: it
 * sends the same query, so it cannot succeed where the probe did not.
 */
async function loadDatabasePlatform(
  session: DbSession,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  timeoutMs: number,
): Promise<Pick<DmvResults, 'platformInfo' | 'serverPlatform'>> {
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
      logger.warn(`Platform query failed — ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    logger.warn(`Custom DMV configuration has no platform-info query — ${fallback}`);
  }
  return { serverPlatform: UNKNOWN_DB_PLATFORM };
}

async function withDbProgressHost(
  host: BridgeHost,
  env: DbConnectEnv,
  title: string,
  connectFn: (patch: Partial<StoredConnectionInfo> | undefined, token: vscode.CancellationToken) => Promise<DbSession | undefined>,
  phaseFn: (session: DbSession, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<void>,
) {
  await host.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    let session: DbSession | undefined;
    try {
      session = await connectFn(undefined, token);
      if (session && !token.isCancellationRequested) {
        await phaseFn(session, progress, token);
      } else {
        host.log('info', 'DB', `${title} cancelled or failed to connect`);
        host.postMessage({ type: 'db-cancelled' });
      }
    } catch (err) {
      const failure = connectionFailure(err, session);
      if (failure) {
        const { target } = failure;
        // A retry reconnects the connection that failed, so a record stored by the retired mssql
        // extension is not asked to reconnect twice.
        const failed: Partial<StoredConnectionInfo> | undefined = target.connectionId ? { provider: 'builtIn', connectionId: target.connectionId } : undefined;
        const retry = (patch?: Partial<StoredConnectionInfo>) => withDbProgressHost(host, env, title, (_patch, token) => connectFn({ ...failed, ...patch }, token), phaseFn);
        const reported = reportConnectionError(
          failure.error,
          target,
          Logger.create(env.outputChannel, 'DB'),
          connectionErrorHooks(env, target.connectionId, token.isCancellationRequested ? undefined : retry),
        );
        host.postMessage({ type: 'db-error', message: reported.message });
      } else {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        host.log('error', 'DB', title, message);
        host.postMessage({ type: 'db-error', message });
      }
    } finally {
      if (session) {
        await releaseSession(session).catch((err: unknown) =>
          host.log('warn', 'DB', `Disconnect failed: ${err instanceof Error ? err.message : String(err)}`));
      }
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
  outputChannel: vscode.LogOutputChannel,
  model: DatabaseModel | null,
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Stats');
  const objectRef = { schema, objectName };
  const cfg = host.getConfiguration();
  const defaults = DEFAULT_CONFIG.tableStatistics;
  const isExternalTable = model?.nodes.some(n => n.schema === schema && n.name === objectName && n.type === 'external') ?? false;
  const refusedBy = !cfg.get('tableStatistics.enabled', defaults.enabled) ? 'enabled'
    : mode === 'standard' && !cfg.get('tableStatistics.standardModeEnabled', defaults.standardModeEnabled) ? 'standardModeEnabled'
    : isExternalTable && cfg.get('tableStatistics.excludeExternalTables', defaults.excludeExternalTables) ? 'excludeExternalTables'
    : undefined;
  if (refusedBy) {
    logger.info(`Profiling refused by tableStatistics.${refusedBy} — request rejected`);
    logger.debug(`Rejected profiling target: ${schema}.${objectName}`);
    void postToDetail(panel, {
      type: 'table-stats-error',
      objectRef,
      message: `Table profiling is disabled by dataLineageViz.tableStatistics.${refusedBy}.`,
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
      void postToDetail(panel, { type: 'table-stats-error', objectRef, message: 'Connection cancelled.' }, logger);
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
        type: 'table-stats-error',
        objectRef,
        message: `No profileable columns in ${schema}.${objectName} — the column types are not supported by statistics, or dataLineageViz.tableStatistics.maxColumns excludes them all.`,
      }, logger);
      return;
    }

    let profilingResult;
    try {
      profilingResult = await executeSimpleQuery(session, profilingSql, outputChannel, {
        ms: timeoutMs, message: `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.`,
      });
    } catch (sampleErr) {
      const needsSampling0 = rowCount > sampleThreshold && sampleThreshold >= 0;
      if (needsSampling0 && /TABLESAMPLE/i.test(sampleErr instanceof Error ? sampleErr.message : String(sampleErr))) {
        const retrySql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, -1, sampleSize);
        if (!retrySql) throw sampleErr;
        profilingResult = await executeSimpleQuery(session, retrySql, outputChannel, {
          ms: timeoutMs, message: `Profiling query for ${schema}.${objectName} timed out after ${timeoutSec}s.`,
        });
      } else {
        throw sampleErr;
      }
    }
    if (!profilingResult.rows.length) {
      throw new Error(`Profiling query returned no rows for ${schema}.${objectName}`);
    }
    const resultRow = profilingRowFromResult(profilingResult);

    const needsSampling = rowCount > sampleThreshold && sampleThreshold >= 0;
    const samplePercent = needsSampling ? computeSamplePercent(sampleSize, rowCount) : undefined;
    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    logger.info(`Table statistics ready — rows=${rowCount}${needsSampling ? ` (sampled ${samplePercent}%)` : ''} (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    void postToDetail(panel, { type: 'table-stats-result', objectRef, stats, mode }, logger);
  } catch (err) {
    const failure = connectionFailure(err);
    if (failure) {
      const reported = reportConnectionError(failure.error, failure.target, logger, connectionErrorHooks(dbEnv, failure.target.connectionId, undefined));
      void postToDetail(panel, { type: 'table-stats-error', objectRef, message: reported.message }, logger);
      return;
    }
    host.log('error', 'Stats', 'Profiling failed', err instanceof Error ? err.name : typeof err);
    host.log('debug', 'Stats', `Profiling failed — ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    void postToDetail(panel, { type: 'table-stats-error', objectRef, message: redactSecrets(err instanceof Error ? err.message : String(err)) }, logger);
  } finally {
    if (session) {
      await releaseSession(session).catch((err: unknown) =>
        host.log('warn', 'Stats', `Disconnect failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

/** Logs a summary of the SQL parsing results and stores it in the session. */
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

  if (stats.unreadableDefinitions?.length) {
    logger.warn(`Definition not readable (encrypted or no VIEW DEFINITION permission) — ${stats.unreadableDefinitions.length} object(s) loaded without edges`);
    logger.debug(`Definitions not readable: ${stats.unreadableDefinitions.join(', ')}`);
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

/**
 * Reads display and behaviour settings from a workspace configuration into the serialisable
 * snapshot sent to the webview (same shape as {@link ExtensionConfigSchema}). Numeric settings are
 * clamped to their declared manifest range.
 *
 * @param cfg - Workspace configuration scoped to `dataLineageViz`.
 */
export function buildExtensionConfig(cfg: vscode.WorkspaceConfiguration): Record<string, any> {
  const num = (key: string) => readDeclaredNumericSetting(cfg, key);
  return {
    excludePatterns: cfg.get<string[]>('excludePatterns'),
    maxNodes: num('maxNodes'),
    layout: {
      direction: cfg.get<string>('layout.direction'),
      rankSeparation: num('layout.rankSeparation'),
      nodeSeparation: num('layout.nodeSeparation'),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation'),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation'),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled'),
      edgeStyle: cfg.get<string>('layout.edgeStyle'),
    },
    externalRefs: { enabled: cfg.get<boolean>('externalRefs.enabled') },
    overview: {
      enabled: cfg.get<boolean>('overview.enabled'),
      threshold: num('overview.threshold'),
      schemaDoubleClickBehavior: cfg.get<string>('overview.schemaDoubleClickBehavior'),
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

async function readExtensionConfig(host: BridgeHost): Promise<Record<string, any>> {
  return buildExtensionConfig(host.getConfiguration());
}

import { buildWebviewCsp } from '../utils/cspBuilder';
import { getNonce } from '../utils/getNonce';

/** Root HTML for the secondary Detail Webview: container, strict CSP and bootloader fallback. */
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
 * Builds a GUI diagnostic snapshot of the user-visible graph, filters, render state and settings.
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
    add('  Schemas:');
    add(JSON.stringify(sess.model.schemas, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');

    add('MODEL CONNECTIVITY (full model, filter-independent)');
    add(formatModelConnectivity(summarizeModelConnectivity(sess.model)));
    add('');
  }

  if (sess.model) {
    const names = sess.model.schemas
      .filter(s => !(s.types['external'] > 0 && s.nodeCount === s.types['external']))
      .map(s => s.name);
    add('SCHEMA LEGEND');
    add(`  ${names.join(', ') || '(none)'}`);
    add('');
  }

  if (sess.parseStats) {
    add('PARSE STATS');
    add(JSON.stringify(sess.parseStats, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');
  }

  if (sess.uiState) {
    add('GUI STATE');
    add(JSON.stringify(sess.uiState, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    add('');
  }

  add('RENDER STATE (current screen)');
  if (uiDiagnostics.renderState) {
    add(JSON.stringify(uiDiagnostics.renderState, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
  } else {
    add('    (no render-state reported — graph not rendered, or render-limit mode)');
  }
  add('');

  const renderConnectivity = uiDiagnostics.renderState?.connectivity;
  if (renderConnectivity) {
    add('RENDERED CONNECTIVITY (current screen)');
    add(formatRenderConnectivity(renderConnectivity));
    add('');
  }

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
