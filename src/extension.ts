import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Graph from 'graphology';
import { buildBareGraph } from './ai/graphUtils';
import {
  AI_CAPS, type AiCapsOverride,
  getContext, getSchemasSummary, searchObjects, getObjectDetail,
  getNeighbors, runBfsTrace, runAnalysis, searchDdl, validateSaveView,
} from './ai/tools';
import { searchCatalog, type SearchableNode } from './utils/modelSearch';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import { DEFAULT_CONFIG, ENGINE_EDITION_FABRIC, type LayoutConfig, type EdgeStyle, type TraceConfig, type AnalysisConfig, type TableStatsConfig, type ExternalRefsConfig, type OverviewConfig, type ObjectType, type DatabaseModel, type XmlElement } from './engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from './engine/dacpacExtractor';
import {
  isMssqlAvailable, promptForConnection, connectDirect, stripSensitiveFields,
  loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered, disconnectDatabase,
  getServerInfo, executeSimpleQuery,
} from './engine/connectionManager';
import type { IConnectionInfo, SimpleExecuteResult } from './types/mssql';
import { buildColumnAggregations, buildProfilingQuery, buildRowCountQuery, computeSamplePercent, parseProfilingResult } from './engine/profilingEngine';
import type { StatsMode } from './engine/profilingEngine';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult } from './engine/dmvExtractor';
import { loadRules } from './engine/sqlBodyParser';
import type { ParseRulesConfig } from './engine/sqlBodyParser';
import type { DmvResults } from './engine/dmvExtractor';
import {
  migrateProjectStore, createProject, updateProject, deleteProject, generateProjectName,
  addFilterProfile, deleteFilterProfile, isValidProject,
} from './engine/projectStore';
import type { Project, ProjectStore, FilterProfile, SerializedFilterState } from './engine/projectStore';

// ─── Logging ────────────────────────────────────────────────────────────────

let outputChannel: vscode.LogOutputChannel;
let extensionUri: vscode.Uri;
let lastRulesLabel = 'built-in rules';

// ─── AI bridge (module-level, written by panel closures, read by LM tools) ──
// Only one panel is ever open at a time — safe to use module-level state.
let _aiModel:          import('./engine/types').DatabaseModel | null = null;
let _aiGraph:          Graph | null = null;
let _aiFilter:         SerializedFilterState | null = null;
let _aiViews:          FilterProfile[] = [];
let _aiProjectName:    string | null = null;
let _aiMaxInputTokens: number = 32000; // updated per @lineage chat request; conservative fallback

function isAiEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled') ?? true;
}

function autoScaleTier(maxInputTokens: number): AiCapsOverride {
  if (maxInputTokens > 128000) {
    return { BFS_MAX_NODES: 400, BFS_MAX_EDGES: 600, SEARCH_MAX_RESULTS: 100, ANALYSIS_MAX_GROUPS: 200, MAX_DDL_CHARS: 500000 };
  }
  if (maxInputTokens < 32000) {
    return { BFS_MAX_NODES: 100, BFS_MAX_EDGES: 150, SEARCH_MAX_RESULTS: 20, ANALYSIS_MAX_GROUPS: 50, MAX_DDL_CHARS: 4000 };
  }
  return {}; // medium tier: falls through to AI_CAPS defaults in resolve()
}

/** Caps for the current request. Precedence: explicit VS Code setting > model auto-scale > AI_CAPS defaults. */
function readAiCaps(): AiCapsOverride {
  const cfg  = vscode.workspace.getConfiguration('dataLineageViz.ai');
  const tier = autoScaleTier(_aiMaxInputTokens);

  function resolve(key: keyof typeof AI_CAPS, settingName: string): number {
    const insp     = cfg.inspect<number>(settingName);
    const explicit = insp?.globalValue ?? insp?.workspaceValue ?? insp?.workspaceFolderValue;
    if (explicit !== undefined) return explicit;
    const scaled = tier[key];
    return scaled !== undefined ? scaled : AI_CAPS[key];
  }

  return {
    SEARCH_MAX_RESULTS:  resolve('SEARCH_MAX_RESULTS',  'searchMaxResults'),
    BFS_MAX_NODES:       resolve('BFS_MAX_NODES',       'bfsMaxNodes'),
    BFS_MAX_EDGES:       resolve('BFS_MAX_EDGES',       'bfsMaxEdges'),
    ANALYSIS_MAX_GROUPS: resolve('ANALYSIS_MAX_GROUPS', 'analysisMaxGroups'),
    MAX_DDL_CHARS:       resolve('MAX_DDL_CHARS',       'maxDdlChars'),
  };
}

function getThemeClass(kind: vscode.ColorThemeKind): string {
  return kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' :
    kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' :
    kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' :
    'vscode-light';
}

// ─── Panel State ─────────────────────────────────────────────────────────────

const MAX_DACPAC_BYTES = 50 * 1024 * 1024; // 50 MB

function isDacpacTooLarge(bytes: number): boolean {
  if (bytes <= MAX_DACPAC_BYTES) return false;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  vscode.window.showErrorMessage(`Dacpac too large (${mb} MB). Maximum supported size is ${MAX_DACPAC_BYTES / 1024 / 1024} MB.`);
  return true;
}
let panelCounter = 0;
let activePanel: vscode.WebviewPanel | undefined;
let overviewStatusBar: vscode.StatusBarItem | undefined;

// ─── Stats Connection Reuse ──────────────────────────────────────────────────

let statsConnectionUri: string | undefined;

async function verifyStatsConnection(timeoutMs = DEFAULT_CONFIG.tableStatistics.queryTimeout * 1000): Promise<boolean> {
  if (!statsConnectionUri) return false;
  try {
    await withTimeout(executeSimpleQuery(statsConnectionUri, 'SELECT 1', outputChannel), timeoutMs);
    return true;
  } catch {
    statsConnectionUri = undefined;
    return false;
  }
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!activePanel) return;

      try {
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
          // Re-check after await — panel may have been disposed while waiting
          if (!activePanel) return;
          activePanel.webview.postMessage({ type: 'config-only', config });
          outputChannel.debug('[Config] Settings changed — pushed to webview');
        }
      } catch (err) {
        outputChannel.error(`[Config] onDidChangeConfiguration failed: ${err instanceof Error ? err.message : err}`);
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

  // ─── Schema overview mode: status bar + toggle command ─────────────────────
  overviewStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  overviewStatusBar.command = 'dataLineageViz.toggleOverviewMode';
  overviewStatusBar.tooltip = 'Toggle schema overview / full object view (Ctrl+Alt+O)';
  context.subscriptions.push(overviewStatusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.toggleOverviewMode', () => {
      if (activePanel) {
        activePanel.webview.postMessage({ type: 'toggle-overview' });
      }
    })
  );

  // ─── QuickPick object search command ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.searchObjects', async () => {
      if (!_aiModel) {
        vscode.window.showWarningMessage('Open a .dacpac file or connect to a database first.');
        return;
      }
      const model = _aiModel;
      const qp = vscode.window.createQuickPick();
      qp.placeholder = 'Search tables, views, procedures, functions…';
      qp.matchOnDescription = false;
      qp.matchOnDetail = false;

      qp.onDidChangeValue(value => {
        if (!value.trim()) { qp.items = []; return; }
        const results = searchCatalog(model.nodes as SearchableNode[], value, undefined, undefined, 20);
        qp.items = results.map(n => ({
          label:       n.name,
          description: `[${n.schema}]`,
          detail:      n.type,
        }));
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
  );

  // ─── AI Language Model Tools ───────────────────────────────────────────────
  // All 9 tools read from module-level _ai* bridge vars (written by panel closures).
  // Only throws on "no model loaded" — all other errors return JSON for LLM self-correction.

  function requireModel(): NonNullable<typeof _aiModel> {
    if (!_aiModel) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return _aiModel;
  }
  function requireGraph(): NonNullable<typeof _aiGraph> {
    if (!_aiGraph) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return _aiGraph;
  }

  function toolResult(data: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
  }

  const disabled = () => toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' });

  context.subscriptions.push(
    vscode.lm.registerTool('lineage_get_context', {
      invoke(_options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        outputChannel.debug('[AI] lineage_get_context');
        return toolResult(getContext(m, _aiFilter, _aiProjectName, _aiViews));
      },
    }),
    vscode.lm.registerTool('lineage_get_schema_summary', {
      invoke(_options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        outputChannel.debug('[AI] lineage_get_schema_summary');
        return toolResult(getSchemasSummary(m));
      },
    }),
    vscode.lm.registerTool('lineage_search_objects', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const { query, types, schemas, external_subtypes } = options.input as {
          query: string; types?: string[]; schemas?: string[]; external_subtypes?: string[];
        };
        outputChannel.debug(`[AI] lineage_search_objects: query="${query}", types=${JSON.stringify(types ?? null)}`);
        const result = searchObjects(m, query, types as never, schemas, external_subtypes as never, readAiCaps());
        return toolResult(result);
      },
    }),
    vscode.lm.registerTool('lineage_get_object_detail', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const { id } = options.input as { id: string };
        outputChannel.debug(`[AI] lineage_get_object_detail: id="${id}"`);
        return toolResult(getObjectDetail(m, id, readAiCaps()));
      },
    }),
    vscode.lm.registerTool('lineage_get_neighbors', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const { id, direction, types } = options.input as {
          id: string; direction?: string; types?: string[];
        };
        outputChannel.debug(`[AI] lineage_get_neighbors: id="${id}", direction=${direction ?? 'both'}`);
        return toolResult(getNeighbors(m, id, direction as never, types as never));
      },
    }),
    vscode.lm.registerTool('lineage_run_bfs_trace', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const g = requireGraph();
        const { id, upstream_hops, downstream_hops, types, schemas } = options.input as {
          id: string; upstream_hops?: number; downstream_hops?: number; types?: string[]; schemas?: string[];
        };
        outputChannel.debug(`[AI] lineage_run_bfs_trace: id="${id}", up=${upstream_hops ?? 3}, down=${downstream_hops ?? 3}`);
        const result = runBfsTrace(m, g, id, upstream_hops ?? 3, downstream_hops ?? 3, types as never, schemas, readAiCaps());
        return toolResult(result);
      },
    }),
    vscode.lm.registerTool('lineage_run_analysis', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const g = requireGraph();
        const { type, min_degree, max_size } = options.input as {
          type: string; min_degree?: number; max_size?: number;
        };
        outputChannel.debug(`[AI] lineage_run_analysis: type="${type}"`);
        return toolResult(runAnalysis(m, g, type as never, min_degree, max_size, readAiCaps()));
      },
    }),
    vscode.lm.registerTool('lineage_search_ddl', {
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const { query, types } = options.input as { query: string; types?: string[] };
        outputChannel.debug(`[AI] lineage_search_ddl: query="${query.slice(0, 60)}"`);
        return toolResult(searchDdl(m, query, types as never, readAiCaps()));
      },
    }),
    vscode.lm.registerTool('lineage_save_view', {
      prepareInvocation(options, _token) {
        const { name, node_ids } = options.input as { name: string; node_ids: string[] };
        return { invocationMessage: `Save view "${name}" with ${node_ids?.length ?? 0} objects` };
      },
      invoke(options, _token) {
        if (!isAiEnabled()) return disabled();
        const m = requireModel();
        const { name, node_ids } = options.input as { name: string; node_ids: string[] };
        outputChannel.debug(`[AI] lineage_save_view: name="${name}", ids=${node_ids?.length ?? 0}`);
        const validation = validateSaveView(m, node_ids ?? [], name);
        if (!validation.success) {
          outputChannel.warn(`[AI] lineage_save_view: validation failed — ${validation.errors?.join(', ')}`);
          return toolResult(validation);
        }
        // Push to the active panel's webview (if any)
        if (activePanel) {
          activePanel.webview.postMessage({
            type: 'save-view',
            name: validation.name,
            nodeIds: validation.node_ids,
          });
          outputChannel.info(`[AI] lineage_save_view: saved "${validation.name}" with ${validation.node_ids.length} nodes`);
        }
        return toolResult({ success: true, view_name: validation.name, node_count: validation.node_ids.length });
      },
    }),
  );

  // ─── @lineage Chat Participant ─────────────────────────────────────────────
  const participant = vscode.chat.createChatParticipant(
    'dataLineageViz.lineage',
    async (request, context, stream, token) => {
      // Update model context window for auto-scaling caps
      _aiMaxInputTokens = request.model.maxInputTokens;

      if (!isAiEnabled()) {
        stream.markdown('`@lineage` AI features are disabled. Enable via `dataLineageViz.ai.enabled`.');
        return;
      }

      if (!_aiModel) {
        stream.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first, then ask your question.');
        return;
      }

      const lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage'));

      // Build conversation history so the model remembers previous turns
      const historyMessages: vscode.LanguageModelChatMessage[] = [];
      for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          historyMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
            .map(p => (p as vscode.ChatResponseMarkdownPart).value.value)
            .join('');
          if (text) {
            historyMessages.push(new vscode.LanguageModelChatMessage(
              vscode.LanguageModelChatMessageRole.Assistant, text,
            ));
          }
        }
      }

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(
          'You are a data lineage assistant for a SQL database. ' +
          'You ONLY answer using the provided lineage tools — never from general training knowledge. ' +
          'Start every new conversation by calling lineage_get_context to understand what is loaded. ' +
          'Format rules: render columns as a markdown table, dependencies as a bullet list with → arrows, ' +
          'DDL/SQL as a ```sql fenced block, search results as a short bullet list, ' +
          'and context overviews as brief prose followed by a summary table. ' +
          'If a question cannot be answered with the lineage tools, respond exactly: ' +
          '"I can only answer questions about the lineage graph (tables, procedures, dependencies, data flow)."',
        ),
        ...historyMessages,
        vscode.LanguageModelChatMessage.User(request.prompt),
      ];

      const runWithTools = async (): Promise<void> => {
        const response = await request.model.sendRequest(messages, { tools: lineageTools }, token);
        const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            assistantParts.push(part);
            stream.markdown(part.value);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            assistantParts.push(part);
            toolCalls.push(part);
          }
        }

        if (!toolCalls.length) return; // done — no more tool calls

        messages.push(new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.Assistant, assistantParts,
        ));

        const resultParts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
          stream.progress(`Querying lineage: ${call.name.replace(/_/g, ' ')}…`);
          try {
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: call.input, toolInvocationToken: request.toolInvocationToken },
              token,
            );
            resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.warn(`[AI] Tool call failed: ${call.name} — ${msg}`);
            resultParts.push(new vscode.LanguageModelToolResultPart(
              call.callId,
              [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: msg }))],
            ));
          }
        }

        messages.push(new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User, resultParts,
        ));

        return runWithTools(); // recurse until no more tool calls
      };

      try {
        await runWithTools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.error(`[AI] Chat handler failed: ${msg}`);
        stream.markdown(`\n\n*Error: ${msg}*`);
      }
    },
  );
  context.subscriptions.push(participant);
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

// ─── Project Store Helpers ───────────────────────────────────────────────────

const PROJECT_STORE_KEY = 'dataLineageViz.projectStore';

function loadProjectStore(context: vscode.ExtensionContext): ProjectStore {
  const raw = context.globalState.get(PROJECT_STORE_KEY);
  return migrateProjectStore(raw);
}

async function saveProjectStore(context: vscode.ExtensionContext, store: ProjectStore): Promise<void> {
  await context.globalState.update(PROJECT_STORE_KEY, store);
}

/**
 * One-time migration from legacy workspaceState keys into the project store.
 * Runs only when globalState has no project store yet.
 */
async function migrateFromWorkspaceState(context: vscode.ExtensionContext): Promise<void> {
  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  if (!sourceType) return;

  let connection: import('./engine/projectStore').DacpacConnection | import('./engine/projectStore').DatabaseConnection | undefined;

  if (sourceType === 'dacpac') {
    const dacpacPath = context.workspaceState.get<string>('lastDacpacPath');
    const dacpacName = context.workspaceState.get<string>('lastDacpacName');
    if (dacpacPath && dacpacName) {
      // schemas stored as empty — migrated project shows schema selector on next load
      connection = { type: 'dacpac', path: dacpacPath, displayName: dacpacName, schemas: [] };
    }
  } else if (sourceType === 'database') {
    const sourceName = context.workspaceState.get<string>('lastDbSourceName');
    const connectionInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
    if (sourceName && connectionInfo) {
      connection = { type: 'database', connectionInfo: stripSensitiveFields(connectionInfo), sourceName, schemas: [] };
    }
  }

  if (connection) {
    const name = generateProjectName(connection);
    const project = createProject(name, connection);
    const store = loadProjectStore(context);
    const updated = updateProject(store, project);
    await saveProjectStore(context, updated);
    outputChannel.info(`[Project] Migrated legacy connection to project "${name}"`);
  }

  // Clear old workspaceState keys regardless
  await context.workspaceState.update('lastSourceType', undefined);
  await context.workspaceState.update('lastDacpacPath', undefined);
  await context.workspaceState.update('lastDacpacName', undefined);
  await context.workspaceState.update('lastDeselectedSchemas', undefined);
  await context.workspaceState.update('lastDbConnectionInfo', undefined);
  await context.workspaceState.update('lastDbSourceName', undefined);
}

// ─── Open Panel ─────────────────────────────────────────────────────────────

function openPanel(context: vscode.ExtensionContext, title: string, loadDemo = false) {
  if (activePanel) {
    activePanel.reveal();
    if (loadDemo) {
      activePanel.webview.postMessage({ type: 'auto-visualize-start' });
      handleLoadDemo(activePanel, context, true).catch(err => outputChannel.error(`Demo: ${err}`));
    }
    return;
  }
  try {
    ++panelCounter;

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

    // Detail panel — opened on demand, scoped to this main panel's lifetime
    let detailPanel: vscode.WebviewPanel | undefined;

    let panelDisposed = false;
    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme((theme) => {
      if (panelDisposed) return;
      // Main panel: CSS-class string for body attribute
      panel.webview.postMessage({ type: 'themeChanged', kind: getThemeClass(theme.kind) });
      // Detail panel: CSS-class string for body attribute (Monaco reads same attribute)
      detailPanel?.webview.postMessage({ type: 'themeChanged', kind: getThemeClass(theme.kind) });
    });
    panel.onDidDispose(() => {
      panelDisposed = true;
      activePanel = undefined;
      overviewStatusBar?.hide();
      themeChangeListener.dispose();
      detailPanel?.dispose();
      if (statsConnectionUri) {
        disconnectDatabase(statsConnectionUri, outputChannel).catch(err => {
          outputChannel.debug(`[DB] Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
        });
        statsConnectionUri = undefined;
      }
      currentModel = null;
      currentGraph = null;
      _aiModel = null;
      _aiGraph = null;
      _aiFilter = null;
      _aiViews = [];
      _aiProjectName = null;
      cachedElements = null;
      cachedDspName = '';
      currentActiveFilter = null;
      currentSavedViews = [];
      currentProjectId = null;
      vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
      outputChannel.debug('[Bridge] Model cleared (panel disposed)');
    });

    // ─── Message Handler Map ──────────────────────────────────────────────
    type MessageHandlerMap = {
      [K in WebviewMessage['type']]?: (msg: Extract<WebviewMessage, { type: K }>) => Promise<void> | void;
    };
    // Cache the Phase 1 all-objects result for use in Phase 2 (cross-schema resolution).
    // Scoped to this panel so multiple panels don't share state.
    let allObjectsCache: SimpleExecuteResult | undefined;
    // Cache the Phase 1 platform-info result for use in Phase 2 model building.
    let platformInfoCache: SimpleExecuteResult | undefined;
    // Last successful DB connection info for Phase 2 reconnect and stats connection.
    let lastConnectionInfo: IConnectionInfo | undefined;
    // ─── State bridge — retained model for AI tools + panel restore ──────────
    let currentModel: DatabaseModel | null = null;
    let currentGraph: Graph | null = null;         // bare graphology graph for AI BFS
    let currentActiveFilter: SerializedFilterState | null = null;
    let currentSavedViews: FilterProfile[] = [];
    let currentProjectId: string | null = null;
    let cachedElements: XmlElement[] | null = null;   // dacpac Phase 1 cache
    let cachedDspName = '';                            // dacpac DSP name from Phase 1

    // ─── Detail Panel Helper ─────────────────────────────────────────────────
    // Holds the first detail-update payload until the webview signals detail-ready.
    // The webview's message listener (useEffect) is set up after React's first render,
    // so any postMessage sent during panel creation would be lost.
    let pendingDetailUpdate: { node: import('./engine/types').LineageNode; findQuery?: string; config: object } | undefined;

    function openOrRevealDetailPanel(node: import('./engine/types').LineageNode, findQuery?: string): void {
      const cfg = vscode.workspace.getConfiguration('dataLineageViz');
      const detailConfig = {
        isDbMode: lastConnectionInfo !== undefined,
        statsEnabled: cfg.get<boolean>('tableStatistics.enabled', DEFAULT_CONFIG.tableStatistics.enabled),
        excludeExternalTables: cfg.get<boolean>('tableStatistics.excludeExternalTables', DEFAULT_CONFIG.tableStatistics.excludeExternalTables),
        standardModeEnabled: cfg.get<boolean>('tableStatistics.standardModeEnabled', DEFAULT_CONFIG.tableStatistics.standardModeEnabled),
      };
      const panelTitle = node.schema ? `[${node.schema}].[${node.name}]` : node.name;
      if (!detailPanel) {
        // Store the payload — send it only after the webview signals detail-ready.
        pendingDetailUpdate = { node, findQuery, config: detailConfig };
        detailPanel = vscode.window.createWebviewPanel(
          'dataLineageDetail',
          panelTitle,
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
          }
        );
        detailPanel.webview.html = getDetailWebviewHtml(detailPanel.webview, context.extensionUri);
        detailPanel.webview.onDidReceiveMessage(async (msg) => {
          try {
            if (msg.type === 'detail-ready') {
              if (pendingDetailUpdate) {
                outputChannel.debug(`[Detail] Ready — flushing '${pendingDetailUpdate.node.id}'`);
                detailPanel?.webview.postMessage({ type: 'detail-update', ...pendingDetailUpdate });
                pendingDetailUpdate = undefined;
              } else {
                outputChannel.debug('[Detail] Ready — pendingUpdate empty (re-mount or duplicate signal)');
              }
            } else if (msg.type === 'error') {
              // React ErrorBoundary + global handlers post here.
              // Log at error level so it's visible in the output channel without debug mode.
              outputChannel.error(`[Detail] ${(msg as { error: string }).error}`);
              const typedMsg = msg as { error: string; stack?: string; componentStack?: string };
              if (typedMsg.stack) outputChannel.debug(`[Detail] Stack: ${typedMsg.stack}`);
              if (typedMsg.componentStack) outputChannel.debug(`[Detail] Component stack: ${typedMsg.componentStack}`);
            } else if (msg.type === 'table-stats-request') {
              await handleTableStatsRequest(lastConnectionInfo, detailPanel!, msg.schema, msg.objectName, msg.mode, msg.columns ?? []);
            } else if (msg.type === 'close-detail') {
              detailPanel?.dispose();
            } else {
              outputChannel.debug(
                `[Detail] No handler for '${(msg as { type: string }).type}' — ` +
                `pendingUpdate: ${pendingDetailUpdate ? 'set' : 'empty'}, ` +
                `payload: ${JSON.stringify(msg).slice(0, 120)}`
              );
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            outputChannel.error(`[Detail] Message handler failed for "${(msg as { type: string }).type}": ${errorMsg}`);
          }
        });
        detailPanel.onDidDispose(() => {
          detailPanel = undefined;
          pendingDetailUpdate = undefined;
          panel.webview.postMessage({ type: 'detail-closed' });
        });
      } else {
        // Panel already loaded — postMessage is safe, webview is listening.
        detailPanel.title = panelTitle;
        detailPanel.reveal(undefined, /*preserveFocus*/ true);
        detailPanel.webview.postMessage({ type: 'detail-update', node, findQuery, config: detailConfig });
      }
    }

    const handlers: MessageHandlerMap = {
      'ready': async () => {
        if (loadDemo) {
          await handleLoadDemo(panel, context, true, (m) => {
            currentModel = m;
            currentGraph = buildBareGraph(m);
            _aiModel = m;
            _aiGraph = currentGraph;
            _aiProjectName = 'Demo';
            vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
          });
          return;
        }
        // One-time migration from legacy workspaceState keys (runs once, clears old keys)
        if (context.globalState.get(PROJECT_STORE_KEY) === undefined) {
          await migrateFromWorkspaceState(context);
        }
        const config = await readExtensionConfig();
        const store = loadProjectStore(context);
        panel.webview.postMessage({ type: 'config-only', config });
        panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
        // Re-send retained model for panel restore (<100ms vs re-import)
        if (currentModel) {
          const projectName = store.projects.find(p => p.id === currentProjectId)?.name;
          panel.webview.postMessage({ type: 'dacpac-model', model: currentModel, config, sourceName: projectName ?? 'Project', autoVisualize: true });
          outputChannel.debug('[Bridge] Panel restored from retained model');
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
          const fileName = path.basename(fileUri.fsPath, '.dacpac');
          try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            if (isDacpacTooLarge(data.byteLength)) return;
            const config = await readExtensionConfig();
            outputChannel.info(`── Opening ${fileName} ──`);
            const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            cachedElements = elements;
            cachedDspName = dspName;
            currentModel = null;
            currentGraph = null;
            _aiModel = null;
            _aiGraph = null;
            currentProjectId = null;
            vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
            panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: fileName });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            outputChannel.error(`Failed to read file: ${errorMsg}`);
            vscode.window.showErrorMessage(`Failed to read file: ${errorMsg}`);
          }
        }
      },
      'load-project': async (msg) => {
        // Clear stale stats connection — prevents dev/prod cross-query on project switch
        if (statsConnectionUri) {
          disconnectDatabase(statsConnectionUri, outputChannel).catch(err => outputChannel.debug('[DB] stats disconnect on project switch:', String(err)));
          statsConnectionUri = undefined;
        }
        const store = loadProjectStore(context);
        const project = store.projects.find(p => p.id === msg.id);
        if (!project) {
          panel.webview.postMessage({ type: 'db-error', message: `Project not found: ${msg.id}`, phase: 'connect' });
          return;
        }
        if (project.connection.type === 'dacpac') {
          const conn = project.connection;
          const schemas = conn.schemas.length > 0 ? conn.schemas : undefined;
          try {
            const fileUri = vscode.Uri.file(conn.path);
            const data = await vscode.workspace.fs.readFile(fileUri);
            if (isDacpacTooLarge(data.byteLength)) return;
            const refreshed = { ...project, updatedAt: new Date().toISOString() };
            const updatedStore = updateProject(store, refreshed);
            await saveProjectStore(context, updatedStore);
            panel.webview.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });
            const config = await readExtensionConfig();
            outputChannel.info(`── Loading project "${project.name}" ──`);
            currentProjectId = project.id;
            if (schemas && schemas.length > 0) {
              // Phase 2 directly: preselected schemas from saved project
              if (config.parseRules) loadRules(config.parseRules as ParseRulesConfig);
              const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
              const model = extractDacpacFiltered(elements, new Set(schemas), dspName);
              currentModel = model;
              currentGraph = buildBareGraph(model);
              _aiModel = model;
              _aiGraph = currentGraph;
              _aiProjectName = conn.displayName;
              cachedElements = null;
              cachedDspName = '';
              vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
              outputChannel.info(`[Bridge] Model retained: ${model.nodes.length} nodes, ${model.edges.length} edges — ${model.dbPlatform ?? 'platform unknown'}`);
              if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
              panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: conn.displayName });
            } else {
              // Phase 1: no stored schemas — show schema selector
              const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
              cachedElements = elements;
              cachedDspName = dspName;
              currentModel = null;
              currentGraph = null;
              _aiModel = null;
              _aiGraph = null;
              vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
              panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: conn.displayName });
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            outputChannel.error(`[Project] Failed to load "${conn.path}": ${errorMsg}`);
            if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
              panel.webview.postMessage({ type: 'last-dacpac-gone' });
            } else {
              panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'extract' });
            }
          }
        } else if (project.connection.type === 'database') {
          const conn = project.connection;
          await withDbProgress(
            panel, 'Data Lineage: Loading project',
            async () => {
              const result = await connectDirect(conn.connectionInfo as IConnectionInfo, outputChannel);
              if (result) return result;
              outputChannel.info('[Project] Direct reconnect failed — falling back to picker');
              return promptForConnection(outputChannel);
            },
            async (dbResult, progress, token) => {
              lastConnectionInfo = dbResult.connectionInfo;
              // Silent Phase 1: load all-objects for cross-schema resolution
              const queries = await loadDmvQueries(outputChannel, extensionUri);
              const allObjectsQuery = queries.find(q => q.name === 'all-objects');
              if (allObjectsQuery) {
                const dmvTimeout = vscode.workspace.getConfiguration('dataLineageViz').get<number>('dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
                const ph1Result = await executeDmvQueries(dbResult.connectionUri, [allObjectsQuery], outputChannel, undefined, dmvTimeout);
                const r = ph1Result.get('all-objects');
                if (r) {
                  allObjectsCache = r;
                  outputChannel.info(`[Project] Catalog: ${r.rowCount} objects loaded`);
                }
              }
              if (token.isCancellationRequested) { panel.webview.postMessage({ type: 'db-cancelled' }); return; }
              // Phase 2 with stored schemas
              const schemas = conn.schemas.length > 0 ? conn.schemas : undefined;
              if (!schemas) {
                // No schemas stored — run Phase 1 visually (schema selector will appear)
                await runDbPhase1(panel, dbResult.connectionUri, dbResult.connectionInfo, progress, token, (r) => { allObjectsCache = r; }, (r) => { platformInfoCache = r; });
                return;
              }
              await runDbPhase2(panel, dbResult.connectionUri, schemas, progress, token, allObjectsCache, conn.connectionInfo.database, conn.sourceName, platformInfoCache,
                (m) => {
                  currentModel = m;
                  currentGraph = buildBareGraph(m);
                  _aiModel = m;
                  _aiGraph = currentGraph;
                  _aiProjectName = project.name;
                  vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
                  outputChannel.info(`[Bridge] Model retained: ${m.nodes.length} nodes, ${m.edges.length} edges — ${m.dbPlatform ?? 'platform unknown'}`);
                });
              if (!token.isCancellationRequested) {
                const refreshed = { ...project, updatedAt: new Date().toISOString() };
                const updatedStore = updateProject(store, refreshed);
                await saveProjectStore(context, updatedStore);
                panel.webview.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });
              }
              outputChannel.info(`── Loading project "${project.name}" ──`);
            },
          );
        }
      },
      'save-project': async (msg) => {
        if (!isValidProject(msg.project)) {
          outputChannel.warn(`[Project] Rejected malformed save-project payload: ${JSON.stringify(msg.project)}`);
          return;
        }
        const store = loadProjectStore(context);
        const updated = updateProject(store, msg.project);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        outputChannel.debug(`[Project] Saved: "${msg.project.name}"`);
      },
      'delete-project': async (msg) => {
        const store = loadProjectStore(context);
        const updated = deleteProject(store, msg.id);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        outputChannel.debug(`[Project] Deleted: ${msg.id}`);
      },
      'load-demo': async () => {
        await handleLoadDemo(panel, context, true, (m) => {
          currentModel = m;
          currentGraph = buildBareGraph(m);
          _aiModel = m;
          _aiGraph = currentGraph;
          _aiProjectName = 'Demo';
          currentProjectId = null;
          vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
        });
      },
      'dacpac-visualize': async (msg) => {
        if (!cachedElements) {
          outputChannel.warn('[Dacpac] Phase 2 requested but no cached elements — aborting');
          return;
        }
        const config = await readExtensionConfig();
        try {
          if (config.parseRules) loadRules(config.parseRules as ParseRulesConfig);
          const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName);
          currentModel = model;
          currentGraph = buildBareGraph(model);
          _aiModel = model;
          _aiGraph = currentGraph;
          _aiProjectName = msg.projectName ?? null;
          cachedElements = null;
          cachedDspName = '';
          vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
          outputChannel.info(`[Bridge] Model retained: ${model.nodes.length} nodes, ${model.edges.length} edges — ${model.dbPlatform ?? 'platform unknown'}`);
          if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
          const sourceName = msg.projectName ?? currentProjectId ?? 'dacpac';
          panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          outputChannel.error(`[Dacpac] Phase 2 extraction failed: ${errorMsg}`);
          panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'extract' });
        }
      },
      'filter-changed': (msg) => {
        currentActiveFilter = msg.filter;
        currentSavedViews = msg.savedViews;
        _aiFilter = msg.filter;
        _aiViews = msg.savedViews;
        outputChannel.debug('[Bridge] Active filter updated via filter-changed');
      },
      'parse-rules-result': (msg) => { handleParseRulesResult(msg); },
      'parse-stats': (msg) => { handleParseStats(msg.stats, msg.objectCount, msg.edgeCount, msg.schemaCount); },
      'log': (msg) => { outputChannel.info(msg.text); },
      'error': (msg) => {
        outputChannel.error(msg.error);
        if (msg.stack) outputChannel.debug(msg.stack);
        vscode.window.showErrorMessage(`Data Lineage Error: ${msg.error}`);
      },
      'open-external': async (msg) => {
        if (msg.url && /^https?:\/\//i.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      },
      'open-settings': () => { vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz'); },
      'overview-mode-changed': (msg) => {
        if (!overviewStatusBar) return;
        if (msg.mode === 'overview') {
          overviewStatusBar.text = '$(graph) Lineage: Overview';
        } else if (msg.enteredFocusFromOverview) {
          overviewStatusBar.text = '$(graph) Lineage: Full View · ← Overview';
        } else {
          overviewStatusBar.text = '$(graph) Lineage: Full View';
        }
        overviewStatusBar.show();
      },
      'export-file': async (msg) => {
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, msg.defaultName)
          : vscode.Uri.file(msg.defaultName);
        const ext = msg.defaultName.split('.').pop() || 'drawio';
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'Draw.io': [ext] },
          title: 'Export Diagram',
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.data, 'utf-8'));
        outputChannel.info(`Exported: ${uri.fsPath}`);
        await vscode.commands.executeCommand('revealFileInOS', uri);
      },
      'show-detail': (msg) => { openOrRevealDetailPanel(msg.node, msg.findQuery); },
      'update-detail': (msg) => { if (detailPanel) openOrRevealDetailPanel(msg.node, msg.findQuery); },
      'close-detail': () => { detailPanel?.dispose(); },
      'check-mssql': () => {
        panel.webview.postMessage({ type: 'mssql-status', available: isMssqlAvailable() });
      },
      'db-connect': () => withDbProgress(
        panel, 'Data Lineage: Connecting to database',
        () => promptForConnection(outputChannel),
        (conn, progress, token) => {
          lastConnectionInfo = conn.connectionInfo;
          return runDbPhase1(panel, conn.connectionUri, conn.connectionInfo, progress, token,
            (result) => { allObjectsCache = result; },
            (result) => { platformInfoCache = result; });
        },
      ),
      'db-visualize': (msg) => withDbProgress(
        panel, 'Data Lineage: Loading selected schemas',
        async () => {
          if (!lastConnectionInfo) {
            panel.webview.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
            return undefined;
          }
          const result = await connectDirect(lastConnectionInfo, outputChannel);
          if (result) return result;
          outputChannel.info('[DB] Direct reconnect failed for Phase 2 — falling back to picker');
          return promptForConnection(outputChannel);
        },
        async (conn, progress, token) => {
          const sourceName = `${conn.connectionInfo.server} / ${conn.connectionInfo.database}`;
          await runDbPhase2(
            panel, conn.connectionUri, msg.schemas, progress, token, allObjectsCache,
            conn.connectionInfo.database, sourceName, platformInfoCache,
            (m) => {
              currentModel = m;
              currentGraph = buildBareGraph(m);
              _aiModel = m;
              _aiGraph = currentGraph;
              _aiProjectName = msg.projectName ?? sourceName;
              vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
              outputChannel.info(`[Bridge] Model retained: ${m.nodes.length} nodes, ${m.edges.length} edges — ${m.dbPlatform ?? 'platform unknown'}`);
            },
          );
          // Auto-save project if a name was provided (Create New DB flow)
          if (msg.projectName && !token.isCancellationRequested) {
            const dbConn = {
              type: 'database' as const,
              connectionInfo: stripSensitiveFields(conn.connectionInfo),
              sourceName,
              schemas: msg.schemas,
            };
            const project = createProject(msg.projectName, dbConn);
            const store = loadProjectStore(context);
            const updated = updateProject(store, project);
            await saveProjectStore(context, updated);
            panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
            outputChannel.info(`[Project] Saved: "${msg.projectName}"`);
          }
        },
      ),
      'save-view': async (msg) => {
        const store = loadProjectStore(context);
        if (!store.projects.some(p => p.id === msg.projectId)) {
          outputChannel.warn(`[Project] save-view: projectId ${msg.projectId} not found in store`);
          return;
        }
        const updated = addFilterProfile(store, msg.projectId, msg.profile as FilterProfile);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        outputChannel.debug(`[Project] View saved: "${(msg.profile as FilterProfile).name}" on project ${msg.projectId}`);
      },
      'save-wizard-view': async (msg) => {
        const store = loadProjectStore(context);
        await saveProjectStore(context, { ...store, lastWizardView: msg.view as 'main' | 'projects' });
        outputChannel.debug(`[Project] Wizard view saved: ${msg.view}`);
      },
      'delete-view': async (msg) => {
        const store = loadProjectStore(context);
        const updated = deleteFilterProfile(store, msg.projectId, msg.profileId);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        outputChannel.debug(`[Project] View deleted: ${msg.profileId}`);
      },
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
            outputChannel.debug(
              `[Webview] No handler for '${(message as { type: string }).type}' — ` +
              `payload: ${JSON.stringify(message).slice(0, 120)}`
            );
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
  | { type: 'load-demo' }
  | { type: 'load-project'; id: string }
  | { type: 'save-project'; project: import('./engine/projectStore').Project }
  | { type: 'delete-project'; id: string }
  | { type: 'save-view'; projectId: string; profile: import('./engine/projectStore').FilterProfile }
  | { type: 'save-wizard-view'; view: 'main' | 'projects' }
  | { type: 'delete-view'; projectId: string; profileId: string }
  | { type: 'parse-rules-result'; loaded: number; skipped: string[]; errors: string[]; usedDefaults: boolean; categoryCounts?: Record<string, number> }
  | { type: 'parse-stats'; stats: { parsedRefs: number; resolvedEdges: number; droppedRefs: string[]; spDetails?: { name: string; inCount: number; outCount: number; inRefs?: string[]; outRefs?: string[]; unrelated: string[]; skippedRefs?: string[] }[] }; objectCount?: number; edgeCount?: number; schemaCount?: number }
  | { type: 'log'; text: string }
  | { type: 'error'; error: string; stack?: string }
  | { type: 'open-external'; url?: string }
  | { type: 'open-settings' }
  | { type: 'show-detail'; node: import('./engine/types').LineageNode; findQuery?: string }
  | { type: 'update-detail'; node: import('./engine/types').LineageNode; findQuery?: string }
  | { type: 'close-detail' }
  | { type: 'check-mssql' }
  | { type: 'db-connect' }
  | { type: 'reload' }
  | { type: 'dacpac-visualize'; schemas: string[]; projectName?: string }
  | { type: 'db-visualize'; schemas: string[]; projectName?: string }
  | { type: 'filter-changed'; filter: import('./engine/projectStore').SerializedFilterState; savedViews: import('./engine/projectStore').FilterProfile[] }
  | { type: 'export-file'; data: string; defaultName: string }
  | { type: 'overview-mode-changed'; mode: 'full' | 'overview'; enteredFocusFromOverview: boolean };

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
  trace: TraceConfig;
  analysis: AnalysisConfig;
  tableStatistics: TableStatsConfig;
  externalRefs: ExternalRefsConfig;
  overview: OverviewConfig;
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
      edgeStyle: cfg.get<EdgeStyle>('layout.edgeStyle', DEFAULT_CONFIG.layout.edgeStyle)!,
    },
    trace: {
      defaultUpstreamLevels: clamp(cfg.get<number>('trace.defaultUpstreamLevels', DEFAULT_CONFIG.trace.defaultUpstreamLevels), 0, 99, DEFAULT_CONFIG.trace.defaultUpstreamLevels),
      defaultDownstreamLevels: clamp(cfg.get<number>('trace.defaultDownstreamLevels', DEFAULT_CONFIG.trace.defaultDownstreamLevels), 0, 99, DEFAULT_CONFIG.trace.defaultDownstreamLevels),
    },
    analysis: {
      hubMinDegree: clamp(cfg.get<number>('analysis.hubMinDegree', DEFAULT_CONFIG.analysis.hubMinDegree), 1, 50, DEFAULT_CONFIG.analysis.hubMinDegree),
      islandMaxSize: clamp(cfg.get<number>('analysis.islandMaxSize', DEFAULT_CONFIG.analysis.islandMaxSize), 2, maxNodes, DEFAULT_CONFIG.analysis.islandMaxSize),
      longestPathMinNodes: clamp(cfg.get<number>('analysis.longestPathMinNodes', DEFAULT_CONFIG.analysis.longestPathMinNodes), 2, 50, DEFAULT_CONFIG.analysis.longestPathMinNodes),
    },
    tableStatistics: {
      enabled: cfg.get<boolean>('tableStatistics.enabled', DEFAULT_CONFIG.tableStatistics.enabled),
      standardModeEnabled: cfg.get<boolean>('tableStatistics.standardModeEnabled', DEFAULT_CONFIG.tableStatistics.standardModeEnabled),
      excludeExternalTables: cfg.get<boolean>('tableStatistics.excludeExternalTables', DEFAULT_CONFIG.tableStatistics.excludeExternalTables),
      maxColumns: clamp(cfg.get<number>('tableStatistics.maxColumns', DEFAULT_CONFIG.tableStatistics.maxColumns), 1, 500, DEFAULT_CONFIG.tableStatistics.maxColumns),
      sampleThreshold: clamp(cfg.get<number>('tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold), 0, 999999999, DEFAULT_CONFIG.tableStatistics.sampleThreshold),
      sampleSize: clamp(cfg.get<number>('tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize), 100, 1000000, DEFAULT_CONFIG.tableStatistics.sampleSize),
      useApproxDistinct: cfg.get<boolean>('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct),
      queryTimeout: clamp(cfg.get<number>('tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout), 10, 600, DEFAULT_CONFIG.tableStatistics.queryTimeout),
    },
    externalRefs: {
      enabled: cfg.get<boolean>('externalRefs.enabled', DEFAULT_CONFIG.externalRefs.enabled),
    },
    overview: {
      enabled: cfg.get<boolean>('overview.enabled', DEFAULT_CONFIG.overview.enabled),
      threshold: clamp(cfg.get<number>('overview.threshold', DEFAULT_CONFIG.overview.threshold), 10, 1000, DEFAULT_CONFIG.overview.threshold),
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
      vscode.window.showWarningMessage('Failed to load parse rules — regex-based edge detection disabled. Check Output channel.');
    }
  } else {
    const resolved = resolveWorkspacePath(rulesPath);
    if (!resolved) {
      outputChannel.warn(`[ParseRules] Cannot resolve "${rulesPath}" — no workspace folder open`);
      vscode.window.showWarningMessage(
        `Parse rules: cannot resolve "${rulesPath}" — open a workspace folder or use an absolute path.`
      );
      config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        outputChannel.error(`[ParseRules] Built-in fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        return undefined;
      });
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
          config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        outputChannel.error(`[ParseRules] Built-in fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        return undefined;
      });
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
        config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        outputChannel.error(`[ParseRules] Built-in fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        return undefined;
      });
      }
    }
  }

  return config;
}

// ─── Table Statistics ────────────────────────────────────────────────────────

/**
 * Handle a table-stats-request from the React panel.
 * Reuses the persistent statsConnectionUri connection (kept alive between clicks).
 * Falls back to stored credentials → interactive picker if connection is stale.
 * Does NOT disconnect after completion — connection stays alive for subsequent clicks.
 */
async function handleTableStatsRequest(
  storedConnectionInfo: IConnectionInfo | undefined,
  panel: vscode.WebviewPanel,
  schema: string,
  objectName: string,
  mode: StatsMode,
  cols: import('./engine/types').ColumnDef[],
): Promise<void> {
  if (cols.length === 0) {
    panel.webview.postMessage({ type: 'table-stats-error', message: 'No column metadata available for profiling.' });
    return;
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const sampleThreshold = clamp(cfg.get<number>('tableStatistics.sampleThreshold', DEFAULT_CONFIG.tableStatistics.sampleThreshold), 0, 999999999, DEFAULT_CONFIG.tableStatistics.sampleThreshold);
  const sampleSize = clamp(cfg.get<number>('tableStatistics.sampleSize', DEFAULT_CONFIG.tableStatistics.sampleSize), 100, 1000000, DEFAULT_CONFIG.tableStatistics.sampleSize);
  const useApprox = cfg.get<boolean>('tableStatistics.useApproxDistinct', DEFAULT_CONFIG.tableStatistics.useApproxDistinct);
  const maxColumns = clamp(cfg.get<number>('tableStatistics.maxColumns', DEFAULT_CONFIG.tableStatistics.maxColumns), 1, 500, DEFAULT_CONFIG.tableStatistics.maxColumns);
  const queryTimeout = clamp(cfg.get<number>('tableStatistics.queryTimeout', DEFAULT_CONFIG.tableStatistics.queryTimeout), 10, 600, DEFAULT_CONFIG.tableStatistics.queryTimeout) * 1000;

  try {
    outputChannel.info(`[Stats] Profiling [${schema}].[${objectName}] (mode=${mode}, timeout=${queryTimeout / 1000}s, cols=${cols.length})`);

    // Reuse existing stats connection if alive; otherwise connect (stored creds → picker)
    const isAlive = await verifyStatsConnection(queryTimeout);
    if (!isAlive) {
      // Same reconnect pattern as db-reconnect: stored creds first, fall back to picker
      const result = storedConnectionInfo
        ? ((await connectDirect(storedConnectionInfo, outputChannel)) ?? await promptForConnection(outputChannel))
        : await promptForConnection(outputChannel);
      if (!result) {
        panel.webview.postMessage({ type: 'table-stats-error', message: 'Connection cancelled.' });
        return;
      }
      statsConnectionUri = result.connectionUri;
    }

    const connectionUri = statsConnectionUri!;

    // Get server info for platform detection
    outputChannel.info(`[Stats] Getting server info (timeout=${queryTimeout / 1000}s)...`);
    const serverInfo = await withTimeout(getServerInfo(connectionUri, outputChannel), queryTimeout);
    const engineEdition = serverInfo.engineEditionId;
    outputChannel.info(`[Stats] Platform: engineEditionId=${engineEdition}, server=${serverInfo.serverVersion}`);

    // Row count from DMV
    const rowCountSql = buildRowCountQuery(schema, objectName);
    outputChannel.info(`[Stats] Row count query:\n${rowCountSql}`);
    const rowCountResult = await withTimeout(executeSimpleQuery(connectionUri, rowCountSql, outputChannel), queryTimeout);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;
    outputChannel.info(`[Stats] Row count: ${rowCount.toLocaleString()}`);

    // Build and run profiling query
    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
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
      if (String(err).includes('TABLESAMPLE') && engineEdition !== ENGINE_EDITION_FABRIC) {
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
    const samplePercent = needsSampling ? computeSamplePercent(engineEdition, sampleSize, rowCount) : undefined;

    const stats = parseProfilingResult(resultRow, cols, rowCount, needsSampling, samplePercent);
    if (stats.warnings) {
      for (const w of stats.warnings) outputChannel.warn(`[Stats] Parse warning: ${w}`);
    }
    panel.webview.postMessage({ type: 'table-stats-result', stats, mode });

    // Connection stays alive — not disconnected here

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    outputChannel.error(`[Stats] Failed: ${errorMsg}`);
    // Invalidate stale connection on error
    if (statsConnectionUri) {
      disconnectDatabase(statsConnectionUri, outputChannel).catch(err => {
          outputChannel.debug(`[DB] Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
        });
      statsConnectionUri = undefined;
    }
    panel.webview.postMessage({ type: 'table-stats-error', message: errorMsg });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(`Query timed out after ${ms / 1000}s. Increase dataLineageViz.tableStatistics.queryTimeout if needed.`)), ms);
    }),
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
  connectionUri: string,
  connectionInfo: IConnectionInfo,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  onCacheAllObjects: (result: SimpleExecuteResult) => void,
  onCachePlatformInfo?: (result: SimpleExecuteResult) => void,
): Promise<void> {
  const sourceName = `${connectionInfo.server} / ${connectionInfo.database}`;

  progress.report({ message: 'Loading queries...' });
  const queries = await loadDmvQueries(outputChannel, extensionUri);

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  // schema-preview is required — no silent fallback
  const previewQuery = queries.find(q => q.name === 'schema-preview');
  if (!previewQuery) {
    throw new Error('YAML is missing required "schema-preview" query. Add a query with name: schema-preview and phase: 1.');
  }

  progress.report({ message: 'Querying schema overview...' });
  // Run schema-preview (always) and all-objects + platform-info (if available) in parallel
  const allObjectsQuery   = queries.find(q => q.name === 'all-objects');
  const platformInfoQuery = onCachePlatformInfo ? queries.find(q => q.name === 'platform-info') : undefined;

  panel.webview.postMessage({ type: 'db-progress', step: 1, total: allObjectsQuery ? 2 : 1, label: 'schema-preview' });
  const phase1Queries = [previewQuery, ...(allObjectsQuery ? [allObjectsQuery] : []), ...(platformInfoQuery ? [platformInfoQuery] : [])];

  const dmvTimeoutMs = vscode.workspace.getConfiguration('dataLineageViz').get<number>('dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const previewResult = await executeDmvQueries(connectionUri, phase1Queries, outputChannel, undefined, dmvTimeoutMs);

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

  // Cache platform-info for Phase 2 model building (optional — no warning if absent)
  if (platformInfoQuery && onCachePlatformInfo) {
    const platformResult = previewResult.get('platform-info');
    if (platformResult) onCachePlatformInfo(platformResult);
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

  const config = await readExtensionConfig();
  panel.webview.postMessage({
    type: 'db-schema-preview',
    preview,
    config,
    sourceName,
  });
}

/**
 * Phase 2: Reconnect, run filtered DMV queries for selected schemas,
 * build full model (with cross-schema catalog from Phase 1 allObjects), send to webview.
 */
async function runDbPhase2(
  panel: vscode.WebviewPanel,
  connectionUri: string,
  schemas: string[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  allObjects?: SimpleExecuteResult,
  currentDatabase?: string,
  sourceName?: string,
  platformInfo?: SimpleExecuteResult,
  onModelBuilt?: (model: DatabaseModel) => void,
): Promise<void> {
  progress.report({ message: 'Loading queries...' });
  const queries = await loadDmvQueries(outputChannel, extensionUri);

  if (token.isCancellationRequested) {
    panel.webview.postMessage({ type: 'db-cancelled' });
    return;
  }

  const dmvTimeoutMs = vscode.workspace.getConfiguration('dataLineageViz').get<number>('dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout) * 1000;
  const resultMap = await executeDmvQueriesFiltered(
    connectionUri,
    queries,
    schemas,
    outputChannel,
    (step, total, label) => {
      progress.report({ message: `Query ${step}/${total}: ${label}`, increment: Math.round(100 / total) });
      panel.webview.postMessage({ type: 'db-progress', step, total, label });
    },
    dmvTimeoutMs,
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

  const REQUIRED_PHASE2 = ['nodes', 'columns', 'dependencies'] as const;
  const missingQueries = REQUIRED_PHASE2.filter(name => !resultMap.has(name));
  if (missingQueries.length > 0) {
    throw new Error(`DMV YAML is missing required queries: ${missingQueries.join(', ')}. Each must have a matching "name:" field.`);
  }

  const dmvResults: DmvResults = {
    nodes: resultMap.get('nodes')!,
    columns: resultMap.get('columns')!,
    dependencies: resultMap.get('dependencies')!,
    allObjects,
    constraints: resultMap.get('constraints'),
    platformInfo,
  };

  progress.report({ message: 'Building model...' });
  outputChannel.info('[DB] Building model from DMV results...');
  const start = Date.now();
  const preConfig = await readExtensionConfig();
  if (preConfig.parseRules) {
    const rulesResult = loadRules(preConfig.parseRules as ParseRulesConfig);
    outputChannel.debug(`[DB] Parse rules loaded: ${rulesResult.loaded} rules (${Object.entries(rulesResult.categoryCounts).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
  }
  const model = buildModelFromDmv(dmvResults, currentDatabase, preConfig.externalRefs.enabled, preConfig.maxNodes);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const extNodes = model.nodes.filter(n => n.type === 'external');
  const extSuffix = extNodes.length > 0 ? `, incl. ${extNodes.length} external (⬡)` : '';
  outputChannel.info(`[DB] Model built: ${model.nodes.length} nodes${extSuffix}, ${model.edges.length} edges, ${model.schemas.length} schemas (${elapsed}s)`);
  if (extNodes.length > 0) {
    outputChannel.debug(`[DB] External nodes: ${extNodes.map(n => n.fullName).join(', ')}`);
  }

  onModelBuilt?.(model);
  panel.webview.postMessage({
    type: 'db-model',
    model,
    config: preConfig,
    sourceName: sourceName ?? 'Database',
  });
}

// ─── Parse Rules Validation Feedback ─────────────────────────────────────────

function formatCategoryCounts(counts?: Record<string, number>): string {
  if (!counts || Object.keys(counts).length === 0) return '';
  const order = ['preprocessing', 'source', 'target', 'exec'];
  const parts = order.filter(c => counts[c]).map(c => `${counts[c]} ${c}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

async function handleLoadDemo(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  autoVisualize = false,
  onModelBuilt?: (model: DatabaseModel) => void,
) {
  const config = await readExtensionConfig();
  try {
    const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
    const data = await vscode.workspace.fs.readFile(demoUri);
    if (isDacpacTooLarge(data.byteLength)) return;
    outputChannel.info('── Opening AdventureWorks (Demo) ──');
    if (config.parseRules) loadRules(config.parseRules as ParseRulesConfig);
    const model = await extractDacpac(data.buffer as ArrayBuffer);
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
    panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
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
  const distinctDropped = new Set(stats.droppedRefs.map(r => r.split(' → ')[1] ?? '')).size;

  if (spCount > 0) {
    outputChannel.debug(`[Parse] Done — ${stats.resolvedEdges} resolved, ${stats.droppedRefs.length} dropped (${distinctDropped} distinct unrelated)`);
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
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
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

function getDetailWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);

  const nonce = getNonce();
  const themeClass = getThemeClass(vscode.window.activeColorTheme.kind);

  return /*html*/ `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;">
        <link rel="stylesheet" type="text/css" href="${stylesUri}">
        <title>Detail</title>
      </head>
      <body class="vscode-body" data-vscode-theme-kind="${themeClass}" style="margin:0;padding:0;height:100vh;overflow:hidden;">
        <div id="root" style="width:100%;height:100%;"></div>
        <script nonce="${nonce}">window.__DETAIL_MODE__ = true;</script>
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
  if (statsConnectionUri) {
    disconnectDatabase(statsConnectionUri, outputChannel).catch(err => {
          outputChannel.debug(`[DB] Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
        });
    statsConnectionUri = undefined;
  }
}
