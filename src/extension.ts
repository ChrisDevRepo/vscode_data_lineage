import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

declare const __BUILD_TIMESTAMP__: string;
import Graph from 'graphology';
import { buildBareGraph } from './ai/graphUtils';
import {
  estimateTokens, setInlineTokenBudget, setSmInlineNodeCap, shouldSmInline,
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch, autoFixEnrichView, validateEnrichView, orderAndAssemble,
  validateToolInput,
  type EnrichViewInput,
} from './ai/tools';
import { ColumnTraceState } from './ai/columnTraceState';
import { BlackboardState } from './ai/blackboardState';
import { ColumnStore } from './engine/columnStore';
import { populateColumnStore } from './engine/modelBuilder';
import { searchCatalog, type SearchableNode } from './utils/modelSearch';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import { DEFAULT_CONFIG, ENGINE_EDITION_FABRIC, type LayoutConfig, type EdgeStyle, type TraceConfig, type AnalysisConfig, type TableStatsConfig, type ExternalRefsConfig, type OverviewConfig, type ObjectType, type AnalysisType, type DatabaseModel, type XmlElement } from './engine/types';
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
import type { Project, ProjectStore, FilterProfile, SerializedFilterState, AIViewMetadata } from './engine/projectStore';
import { logInfo, logDebug, logWarn, logError, logTrace, trunc, sanitizeForLog } from './utils/log';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './ai/historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './ai/tokenBudget';
import { buildSystemPromptBase, buildPlatformContext, buildSchemaContext, buildTracePrompt, buildSearchPrompt, buildActionRequiredGate, ACTION_REQUIRED_PENDING_HINT } from './ai/prompts';
import { buildCtPrompt, buildCtDepPrompt, buildBbPrompt, buildSynthesisPrompt, buildSynthesisReminder } from './ai/smPrompts';
import { AiSession } from './ai/session';
import { EMPTY_AI_TEMPLATES, type NodeRole, type ResultGraph, type AiOutputTemplates } from './ai/types';

// ─── Logging ────────────────────────────────────────────────────────────────

let outputChannel: vscode.LogOutputChannel;
let extensionUri: vscode.Uri;
let lastRulesLabel = 'built-in rules';

// ─── AI session (The "Clean Slate" container) ───────────────────────────────
// Only one panel is ever open at a time — safe to use module-level activeSession.
let _session: AiSession | null = null;

function getSession(): AiSession {
  if (!_session) {
    _session = new AiSession();
  }
  return _session;
}

// ─── Debug dump state (synced from webview messages) ───────────────────────
let _lastOverviewMode: 'full' | 'overview' | null = null;
let _lastFilteredCount = 0;    // node count after all filters (from webview)
let _lastRenderLimitHit = 0;   // >0 when render limit exceeded (from webview)


function isAiEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled') ?? true;
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
  } catch (err) {
    logDebug(outputChannel, 'Stats', `Connection verification failed: ${err instanceof Error ? err.message : String(err)} — clearing URI`);
    statsConnectionUri = undefined;
    return false;
  }
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);

  // Load AI output templates at activation (async, non-blocking)
  loadAiOutputTemplates(outputChannel, context.extensionUri)
    .then(t => { getSession().outputTemplates = t; })
    .catch(err => logWarn(outputChannel, 'Config', `Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)}`));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      // Reload AI templates when setting changes (independent of panel)
      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri);
        getSession().outputTemplates = t;
      }

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
          logDebug(outputChannel, 'Config', 'Settings changed — pushed to webview');
        }
      } catch (err) {
        logError(outputChannel, 'Config', 'onDidChangeConfiguration', err);
      }
    })
  );
  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logInfo(outputChannel, 'Config', `Extension activated — built ${buildStamp}`);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.open', () => openPanel(context, 'Data Lineage Viz')),
    vscode.commands.registerCommand('dataLineageViz.openDemo', () => openPanel(context, 'Data Lineage Viz', true)),
    vscode.commands.registerCommand('dataLineageViz.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz')
    ),
    vscode.commands.registerCommand('dataLineageViz.copyDebugInfo', async () => {
      try {
        const dump = buildDebugDump(context);
        await vscode.env.clipboard.writeText(dump);
        vscode.window.showInformationMessage('Data Lineage: Debug info copied to clipboard.');
      } catch (err) {
        logError(outputChannel, 'Config', 'Copy debug info', err);
        vscode.window.showErrorMessage('Data Lineage: Failed to copy debug info.');
      }
    }),
  );

  // Command: Dump SM State — serialize active state machine to JSON file
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.dumpSmState', async () => {
      const sess = getSession();
      const sm = sess.stateMachine;
      if (!sm) {
        vscode.window.showWarningMessage('Data Lineage: No active state machine to dump.');
        return;
      }
      try {
        const dump = JSON.stringify(sm.toJSON(), null, 2);
        const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
          vscode.window.showWarningMessage('Data Lineage: No workspace folder open.');
          return;
        }
        const dir = vscode.Uri.joinPath(wsFolder.uri, 'ai', 'sm-dumps');
        await vscode.workspace.fs.createDirectory(dir);
        const fileUri = vscode.Uri.joinPath(dir, `sm-${ts}.json`);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(dump, 'utf-8'));
        logDebug(outputChannel, 'AI', `SM state dumped to ${fileUri.fsPath}`);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        logError(outputChannel, 'AI', 'Dump SM state', err);
        vscode.window.showErrorMessage('Data Lineage: Failed to dump SM state.');
      }
    }),
  );

  // Commands: Create YAML scaffold files (parse rules + DMV queries + AI output templates)
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.createParseRules', () =>
      createYamlScaffold(context, 'parseRules.yaml', 'defaultParseRules.yaml', 'parseRulesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', () =>
      createYamlScaffold(context, 'dmvQueries.yaml', 'dmvQueries.yaml', 'dmvQueriesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createAiOutputTemplates', () =>
      createYamlScaffold(context, 'aiOutputTemplates.yaml', 'aiOutputTemplates.yaml', 'ai.outputTemplateFile')
    ),
  );

  // ─── AI: "Show in Graph" — sends follow-up to @lineage to create annotated view
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.aiCreateView', (originalPrompt: string) => {
      const viewPrompt = `Create an AI view from the trace above. Use the BFS results you already have — add badges, notes, and highlight groups. Name it based on the original question: "${trunc(originalPrompt || '', 60)}"`;
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${viewPrompt}`,
      });
    }),
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
      const sess = getSession();
      if (!sess.model) {
        vscode.window.showWarningMessage('Open a .dacpac file or connect to a database first.');
        return;
      }
      const model = sess.model;
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
  // All 12 tools read from session bridge (written by panel closures, read by LM tools).
  // Only throws on "no model loaded" — all other errors return JSON for LLM self-correction.

  function requireModel(): import('./engine/types').DatabaseModel {
    const m = getSession().model;
    if (!m) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return m;
  }
  function requireGraph(): Graph {
    const g = getSession().graph;
    if (!g) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return g;
  }

  function toolResult(data: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
  }

  /** Log + return: every tool exit is visible in the Output Channel. */
  function logAndReturn(toolName: string, data: object): vscode.LanguageModelToolResult {
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), 300);
    const isError = 'error' in data || ('success' in data && !(data as any).success);
    if (isError) logWarn(outputChannel, 'AI', `${toolName}: ${preview}`);
    logDebug(outputChannel, 'AI', `${toolName} → ${chars} chars: ${preview}`);
    return toolResult(data);
  }

  /** Catch-all for unhandled exceptions inside tool handlers. */
  function toolError(toolName: string, err: unknown): vscode.LanguageModelToolResult {
    const msg = err instanceof Error ? err.message : String(err);
    logError(outputChannel, 'AI', `${toolName}: unhandled`, err instanceof Error ? err : new Error(msg));
    return toolResult({ error: 'internal_error', tool: toolName, message: msg });
  }

  const disabled = () => toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' });

  context.subscriptions.push(
    vscode.lm.registerTool('lineage_get_context', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Loading lineage context…' };
      },
      invoke(_options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const ctx = getContext(m, sess.filter, sess.projectName, sess.views, sess.columnStore);
          const te = (ctx as any)._token_estimate;
          logDebug(outputChannel, 'AI', `lineage_get_context: ${te.catalog_chars} chars (~${te.estimated_tokens} tokens), budget ${te.budget} → ${te.decision}`);
          return logAndReturn('get_context', ctx);
        } catch (err) { return toolError('get_context', err); }
      },
    }),
    vscode.lm.registerTool('lineage_search_objects', {
      prepareInvocation(options, _token) {
        const { query } = options.input as { query: string };
        return { invocationMessage: `Searching for "${query}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `search_objects: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { query, types, schemas, mode } = options.input as {
            query: string; types?: string[]; schemas?: string[];
            mode?: 'substring' | 'regex';
          };
          logDebug(outputChannel, 'AI', `lineage_search_objects: query="${query}", types=${JSON.stringify(types ?? null)}, schemas=${JSON.stringify(schemas ?? null)}${mode === 'regex' ? ', mode=regex' : ''}`);
          return logAndReturn('search_objects', searchObjects(m, query, types as ObjectType[] | undefined, schemas, mode ?? 'substring', sess.filter));
        } catch (err) { return toolError('search_objects', err); }
      },
    }),
    vscode.lm.registerTool('lineage_get_object_detail', {
      prepareInvocation(options, _token) {
        const { id } = options.input as { id: string };
        return { invocationMessage: `Getting details for "${id}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { id: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `get_object_detail: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { id } = options.input as { id: string };
          logDebug(outputChannel, 'AI', `lineage_get_object_detail: id="${id}"`);
          return logAndReturn('get_object_detail', getObjectDetail(m, id, sess.columnStore));
        } catch (err) { return toolError('get_object_detail', err); }
      },
    }),
    vscode.lm.registerTool('lineage_run_bfs_trace', {
      prepareInvocation(options, _token) {
        const { id, upstream_hops, downstream_hops, include_ddl } = options.input as {
          id: string; upstream_hops?: number; downstream_hops?: number; include_ddl?: boolean;
        };
        const ddlTag = (include_ddl ?? true) ? '' : ' (structure only)';
        return { invocationMessage: `Tracing lineage from "${id}" (↑${upstream_hops ?? 3} ↓${downstream_hops ?? 3} hops)${ddlTag}…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { id: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `run_bfs_trace: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { id, upstream_hops, downstream_hops, types, schemas, include_ddl, target } =
            options.input as {
              id: string; upstream_hops?: number; downstream_hops?: number;
              types?: string[]; schemas?: string[];
              include_ddl?: boolean; target?: string;
            };
          logDebug(outputChannel, 'AI', `lineage_run_bfs_trace: id="${id}"${target ? ` → target="${target}"` : `, up=${upstream_hops ?? 3}, down=${downstream_hops ?? 3}`}, ddl=${include_ddl ?? true}`);
          const bfsResult = runBfsTrace(m, g, id, upstream_hops ?? 3, downstream_hops ?? 3,
            types as ObjectType[] | undefined, schemas, include_ddl ?? true, sess.columnStore, target) as Record<string, unknown>;
          return logAndReturn('run_bfs_trace', bfsResult);
        } catch (err) { return toolError('run_bfs_trace', err); }
      },
    }),
    vscode.lm.registerTool('lineage_run_analysis', {
      prepareInvocation(options, _token) {
        const { type } = options.input as { type: string };
        return { invocationMessage: `Running ${type} analysis…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { type: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `run_analysis: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { type, min_degree, max_size } = options.input as {
            type: string; min_degree?: number; max_size?: number;
          };
          logDebug(outputChannel, 'AI', `lineage_run_analysis: type="${type}"`);
          return logAndReturn('run_analysis', runAnalysis(m, g, type as AnalysisType, min_degree, max_size));
        } catch (err) { return toolError('run_analysis', err); }
      },
    }),
    vscode.lm.registerTool('lineage_search_ddl', {
      prepareInvocation(options, _token) {
        const { query } = options.input as { query: string };
        return { invocationMessage: `Searching DDL for "${trunc(query, 40)}"…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { query: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `search_ddl: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { query, types } = options.input as { query: string; types?: string[] };
          logDebug(outputChannel, 'AI', `lineage_search_ddl: query="${trunc(query, 200)}"`);
          return logAndReturn('search_ddl', searchDdl(m, query, types as ('view' | 'procedure' | 'function')[] | undefined, sess.columnStore));
        } catch (err) { return toolError('search_ddl', err); }
      },
    }),
    vscode.lm.registerTool('lineage_enrich_view', {
      prepareInvocation(options, _token) {
        const input = options.input as EnrichViewInput;
        const sess = getSession();
        const source = sess.resultGraph ? sess.resultGraph.source : 'manual';
        const nodeCount = sess.resultGraph ? sess.resultGraph.nodeIds.length : 0;
        return {
          invocationMessage: `Enrich view "${input.name}" (${nodeCount} nodes from ${source})`,
          confirmationMessages: {
            title: 'Create AI lineage view?',
            message: new vscode.MarkdownString(
              `**${input.name ?? 'Unnamed'}** · ${nodeCount} nodes\n\nSaved to project and applied.`
            ),
          },
        };
      },
      async invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { name: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `enrich_view: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const rawInput = options.input as EnrichViewInput;
          logDebug(outputChannel, 'AI', `enrich_view: entry — name="${rawInput.name}", summary=${rawInput.summary?.length ?? 0}ch, desc=${rawInput.description?.length ?? 0}ch, stored_graph=${!!sess.resultGraph}`);

          let resolvedNodeIds: string[];
          let resolvedEdges: [string, string, string][];
          let graphSource: string;

          if (sess.resultGraph) {
            resolvedNodeIds = [...sess.resultGraph.nodeIds];
            resolvedEdges = [...sess.resultGraph.edges];
            graphSource = sess.resultGraph.source;

            if (rawInput.prune_node_ids?.length) {
              const pruneSet = new Set(rawInput.prune_node_ids);
              resolvedNodeIds = resolvedNodeIds.filter(id => !pruneSet.has(id));
              resolvedEdges = resolvedEdges.filter(([src, tgt]) => !pruneSet.has(src) && !pruneSet.has(tgt));
            }
          } else {
            return logAndReturn('enrich_view', {
              success: false,
              errors: ['No state-machine result available — enrich_view requires a completed column_trace or blackboard exploration.'],
            });
          }

          if (sess.resultGraph?.notes?.length) {
            const userNoteIds = new Set((rawInput.notes ?? []).map(n => (n as any).node_id as string));
            const autoNotes: Array<{ node_id: string; text: string }> = [];
            const resolvedSet = new Set(resolvedNodeIds);
            for (const { nodeId, summary } of sess.resultGraph.notes) {
              if (resolvedSet.has(nodeId) && !userNoteIds.has(nodeId) && summary) {
                autoNotes.push({ node_id: nodeId, text: summary });
              }
            }
            if (autoNotes.length > 0) rawInput.notes = [...(rawInput.notes ?? []), ...autoNotes];
          }

          if (sess.resultGraph?.suggested_labels?.length && rawInput.sections?.length) {
            const hasNodeIds = rawInput.sections.some(s => s.node_ids && s.node_ids.length > 0);
            if (!hasNodeIds) {
              const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
              const labelToNodeIds = new Map<string, string[]>();
              for (const sl of sess.resultGraph.suggested_labels) {
                if (!sl.text) continue;
                const label = stripNum(sl.text);
                if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, []);
                labelToNodeIds.get(label)!.push(sl.node_id);
              }
              rawInput.sections = rawInput.sections.map(sec => {
                const norm = stripNum(sec.label);
                const ids = labelToNodeIds.get(norm);
                if (ids?.length) return { ...sec, node_ids: ids };
                return sec;
              });
            }
          }

          let assembledBadges: Array<{ node_id: string; text: string }> = [];
          if (rawInput.sections?.length) {
            const assembled = orderAndAssemble(rawInput.sections, { title: rawInput.title, intro: rawInput.intro, closing: rawInput.closing });
            assembledBadges = assembled.badges;
            if (!rawInput.description) rawInput.description = assembled.description;
            rawInput.sections = undefined;
          }

          const { input, fixes } = autoFixEnrichView(m, rawInput, resolvedNodeIds);
          const validation = validateEnrichView(input, resolvedNodeIds, assembledBadges);
          if (!validation.success) return logAndReturn('enrich_view', validation);

          const aiMetadata: AIViewMetadata = {
            summary: validation.summary,
            description: validation.description,
            createdAt: new Date().toISOString(),
            modelName: sess.modelName,
            highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
            badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
            notes: validation.notes.map(n => ({ nodeId: n.node_id, text: n.text })),
            layoutDirection: validation.layout_direction,
          };
          
          if (activePanel) {
            activePanel.webview.postMessage({ type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata });
            activePanel.reveal(vscode.ViewColumn.One);
          }
          return logAndReturn('enrich_view', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource });
        } catch (err) { return toolError('enrich_view', err); }
      },
    }),
    vscode.lm.registerTool('lineage_get_ddl_batch', {
      prepareInvocation(options, _token) {
        const { ids } = options.input as { ids: string[] };
        return { invocationMessage: `Loading DDL for ${ids.length} object(s)…` };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const inputErr = validateToolInput(options.input, { ids: 'array' });
          if (inputErr) { logWarn(outputChannel, 'AI', `get_ddl_batch: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const { ids } = options.input as { ids: string[] };
          return logAndReturn('get_ddl_batch', getDdlBatch(m, ids, sess.columnStore));
        } catch (err) { return toolError('get_ddl_batch', err); }
      },
    }),
    // ─── Column-Trace tools (hop-and-distill state machine) ─────────────────
    vscode.lm.registerTool('lineage_start_column_trace', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Starting column-level trace…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { columns: 'array' });
          if (inputErr) { logWarn(outputChannel, 'AI', `start_column_trace: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const input = options.input as { columns?: string[]; direction?: string; origin?: string; depth?: number };
          const columns = input.columns ?? [];
          const direction = (input.direction ?? 'up') as 'up' | 'down' | 'both';
          const depth = typeof input.depth === 'number' ? Math.max(1, Math.min(Math.round(input.depth), 20)) : 5;
          logDebug(outputChannel, 'AI', `start_column_trace: columns=[${columns}], direction=${direction}, depth=${depth}, origin=${input.origin ?? 'auto'}`);

          sess.resetExploration();

          const ct = new ColumnTraceState(m, g, (level, msg) => {
            if (level === 'info') logInfo(outputChannel, 'AI', `[CT] ${msg}`);
            else if (level === 'warn') logWarn(outputChannel, 'AI', `[CT] ${msg}`);
            else logDebug(outputChannel, 'AI', `[CT] ${msg}`);
          }, { activeFilter: sess.filter, memory: sess.memory }, sess.columnStore);
          
          sess.stateMachine = ct;

          const initResult = ct.init({ targetColumns: columns, origin: input.origin, direction, depth });
          if ('error' in initResult) return logAndReturn('start_column_trace', initResult);

          const scopeDdlChars = ct.estimateScopeDdlChars();
          const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
          if (inline) ct.setInlineMode(true);
          
          const hopResult = ct.getHopContext();
          if ('error' in hopResult) return logAndReturn('start_column_trace', hopResult);
          if ('done' in hopResult) return logAndReturn('start_column_trace', { ...initResult, status: 'complete', message: 'No neighbors to trace.' });

          return logAndReturn('start_column_trace', {
            ...initResult, ...hopResult,
            ...(inline && { scope_nodes: ct.getAllScopeNodesWithDdl(), delivery: 'inline' }),
          });
        } catch (err) { return toolError('start_column_trace', err); }
      },
    }),
    vscode.lm.registerTool('lineage_submit_hop_analysis', {
      prepareInvocation(options, _token) {
        const input = options.input as { focus_node_id?: string };
        const name = input.focus_node_id?.replace(/\[|\]/g, '').split('.').pop() ?? '';
        const sess = getSession();
        const sm = sess.stateMachine;
        const visited = (sm && 'visitedCount' in sm) ? (sm as any).visitedCount : 0;
        const total = sm?.scopeSize ?? 0;
        return { invocationMessage: name ? `Node ${visited} of ${total} · Tracing ${name}…` : 'Processing hop verdicts…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const ct = sess.stateMachine as ColumnTraceState | null;
          if (!ct || !(ct instanceof ColumnTraceState)) {
            return logAndReturn('submit_hop_analysis', { error: 'no_active_trace', hint: 'No active column trace. Call start_column_trace first.' });
          }

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', verdicts: 'array' });
          if (inputErr) { logWarn(outputChannel, 'AI', `submit_hop_analysis: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }

          const input = options.input as {
            focus_node_id?: string; notes?: string; badge_label?: string; note_caption?: string;
            verdicts?: Array<{ neighbor_id?: string; verdict?: string; columns?: string[]; summary?: string; question?: string }>;
          };
          const focusNodeId = input.focus_node_id ?? '';
          const verdicts = (input.verdicts ?? []).map(v => ({
            nodeId: v.neighbor_id ?? '',
            verdict: (v.verdict ?? 'prune') as 'trace' | 'prune' | 'pass' | 'revisit',
            columnsOut: v.columns,
            summary: v.summary,
            question: v.question,
          }));

          const submitResult = ct.submitVerdicts({ focusNodeId, notes: input.notes, verdicts, badge_label: input.badge_label, note_caption: input.note_caption });
          if ('error' in submitResult) return logAndReturn('submit_hop_analysis', submitResult);

          const hopResult = ct.getHopContext();
          if ('error' in hopResult) return logAndReturn('submit_hop_analysis', hopResult);
          if ('done' in hopResult) {
            const fullResult = ct.getResult();
            if (!('error' in fullResult)) {
              sess.storeCtResult(fullResult);
              (fullResult as any).synthesis_reminder = buildSynthesisReminder('column trace — focus on data flow and column transformations');
            }
            return logAndReturn('submit_hop_analysis', fullResult);
          }

          return logAndReturn('submit_hop_analysis', hopResult);
        } catch (err) { return toolError('submit_hop_analysis', err); }
      },
    }),
    vscode.lm.registerTool('lineage_start_exploration', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Starting exploration…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const m = requireModel();
          const g = requireGraph();
          const inputErr = validateToolInput(options.input, { question: 'string', origin: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `start_exploration: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }
          const input = options.input as { question?: string; origin?: string; scope_direction?: string; depth?: number };
          const question = input.question ?? '';
          const origin = input.origin ?? '';
          const scopeDirection = (['upstream', 'downstream', 'bidirectional'].includes(input.scope_direction ?? '')
            ? input.scope_direction as 'upstream' | 'downstream' | 'bidirectional'
            : 'bidirectional');
          const depth = typeof input.depth === 'number' ? Math.max(1, Math.min(Math.round(input.depth), 20)) : 5;

          sess.resetExploration();

          const bb = new BlackboardState(m, g, (level, msg) => {
            if (level === 'info') logInfo(outputChannel, 'AI', `[BB] ${msg}`);
            else if (level === 'warn') logWarn(outputChannel, 'AI', `[BB] ${msg}`);
            else if (level === 'trace') logTrace(outputChannel, 'AI', `[BB] ${msg}`);
            else logDebug(outputChannel, 'AI', `[BB] ${msg}`);
          }, { activeFilter: sess.filter, scopeDirection, memory: sess.memory }, sess.columnStore);
          
          sess.stateMachine = bb;

          const initResult = bb.init({ question, origin, depth });
          if ('error' in initResult) return logAndReturn('start_exploration', initResult);

          const scopeDdlChars = bb.estimateScopeDdlChars();
          const inline = shouldSmInline(scopeDdlChars, initResult.scopeSize);
          if (inline) bb.setInlineMode(true);

          const hopResult = bb.getHopContext();
          if ('error' in hopResult) return logAndReturn('start_exploration', hopResult);
          if ('done' in hopResult) return logAndReturn('start_exploration', { ...initResult, status: 'complete', message: 'No neighbors to explore.' });

          const scopePreview = { total_scope_nodes: bb.filterBreakdown.total, in_user_filter: bb.filterBreakdown.in_filter, outside_filter: bb.filterBreakdown.outside_filter, schemas: bb.schemaBreakdown() };

          return logAndReturn('start_exploration', {
            ...initResult, ...hopResult,
            scope_preview: scopePreview,
            ...(inline && { scope_nodes: bb.getAllScopeNodesWithDdl(), delivery: 'inline' }),
            ai_hint: `Scope: ${scopePreview.total_scope_nodes} nodes. Proceed with exploration.`,
          });
        } catch (err) { return toolError('start_exploration', err); }
      },
    }),
    vscode.lm.registerTool('lineage_expand_frontier', {
      prepareInvocation(_options, _token) {
        return { invocationMessage: 'Expanding exploration scope…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const bb = sess.stateMachine as BlackboardState | null;
          if (!bb || !(bb instanceof BlackboardState)) {
            return logAndReturn('expand_frontier', { error: 'no_active_exploration', hint: 'No active exploration. Call start_exploration first.' });
          }
          const input = options.input as { extra_hops?: number };
          const extraHops = typeof input.extra_hops === 'number' ? Math.max(1, Math.min(Math.round(input.extra_hops), 5)) : 2;
          const result = bb.expandFrontier(extraHops);
          return logAndReturn('expand_frontier', { ok: true, ...result });
        } catch (err) { return toolError('expand_frontier', err); }
      },
    }),
    vscode.lm.registerTool('lineage_submit_findings', {
      prepareInvocation(options, _token) {
        const input = options.input as { focus_node_id?: string };
        const name = input.focus_node_id?.replace(/\[|\]/g, '').split('.').pop() ?? '';
        const sess = getSession();
        const sm = sess.stateMachine;
        const visited = (sm && 'visitedCount' in sm) ? (sm as any).visitedCount : 0;
        const total = sm?.scopeSize ?? 0;
        return { invocationMessage: name ? `Node ${visited} of ${total} · Analyzing ${name}…` : 'Recording findings…' };
      },
      invoke(options, _token) {
        try {
          if (!isAiEnabled()) return disabled();
          const sess = getSession();
          const bb = sess.stateMachine as BlackboardState | null;
          if (!bb || !(bb instanceof BlackboardState)) {
            return logAndReturn('submit_findings', { error: 'no_active_exploration', hint: 'No active exploration. Call start_exploration first.' });
          }

          const inputErr = validateToolInput(options.input, { focus_node_id: 'string', findings: 'string', summary: 'string' });
          if (inputErr) { logWarn(outputChannel, 'AI', `submit_findings: input validation failed — ${inputErr.hint}`); return toolResult(inputErr); }

          const input = options.input as {
            focus_node_id?: string; findings?: string; summary?: string;
            tags?: string[]; questions?: Array<{ node_id?: string; question?: string }>;
            verdict?: string; prune_ids?: string[]; add_ids?: string[];
            badge_label?: string; note_caption?: string; complete?: boolean;
          };
          const questions = (input.questions ?? []).map(q => ({ nodeId: q.node_id ?? '', question: q.question ?? '' }));
          
          const submitResult = bb.submitFindings({
            focusNodeId: input.focus_node_id ?? '', findings: input.findings ?? '', summary: input.summary ?? '',
            tags: input.tags, questions, verdict: input.verdict as any,
            pruneIds: input.prune_ids ?? [], addIds: input.add_ids ?? [], complete: !!input.complete,
            badge_label: input.badge_label, note_caption: input.note_caption,
          });
          if ('error' in submitResult) return logAndReturn('submit_findings', submitResult);

          const earlyResult = submitResult.early_complete ?? null;
          if (earlyResult && !('error' in earlyResult)) {
            sess.storeBbResult(earlyResult);
            return logAndReturn('submit_findings', earlyResult);
          }

          const hopResult = bb.getHopContext();
          if ('error' in hopResult) return logAndReturn('submit_findings', hopResult);
          if ('done' in hopResult) {
            const fullResult = bb.getResult();
            if (!('error' in fullResult)) {
              sess.storeBbResult(fullResult);
              (fullResult as any).synthesis_reminder = buildSynthesisReminder(bb.question);
            }
            return logAndReturn('submit_findings', fullResult);
          }

          return logAndReturn('submit_findings', hopResult);
        } catch (err) { return toolError('submit_findings', err); }
      },
    }),
  );

  // ─── @lineage Chat Participant ─────────────────────────────────────────────
  type ToolCallRound = { response: string; toolCalls: vscode.LanguageModelToolCallPart[] };

  /** Normalize tool call parts from history — may be class instances or plain objects after deserialization. */
  function extractToolCallFields(tc: vscode.LanguageModelToolCallPart | Record<string, unknown>) {
    return {
      callId: (tc as any).callId as string,
      name:   (tc as any).name as string,
      input:  (tc as any).input as Record<string, unknown>,
    };
  }

  const participant = vscode.chat.createChatParticipant(
    'dataLineageViz.lineage',
    async (request, context, stream, token): Promise<vscode.ChatResult> => {
      const sess = getSession();
      // Update model context window + inline budget once per request
      sess.maxInputTokens = request.model.maxInputTokens;
      sess.modelName = request.model.name || request.model.id;
      const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
      setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
      setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));

      if (!isAiEnabled()) {
        logInfo(outputChannel, 'AI', 'Session rejected — AI disabled');
        stream.markdown('`@lineage` AI features are disabled. Enable via `dataLineageViz.ai.enabled`.');
        return {};
      }

      if (!sess.model) {
        logInfo(outputChannel, 'AI', 'Session rejected — no model loaded');
        stream.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first, then ask your question.');
        return {};
      }

      // ─── Explore-first: no upfront routing. AI discovers intent via tools. ───
      // Dynamic tool filtering: classic tools during discovery, CT tools during state machine.
      let activePhase: 'discover' | 'ct_active' | 'ct_done' | 'bb_active' | 'bb_done' = 'discover';
      // Shared filter: SM-done phases restore classic tools but exclude BFS (SM result is authoritative)
      const smDoneTools = () => vscode.lm.tools.filter(t => t.tags.includes('lineage') && t.name !== 'lineage_run_bfs_trace');
      let lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage'));
      logInfo(outputChannel, 'AI', `[${sess.id}] Session start — model=${request.model.id}, prompt="${trunc(request.prompt, 200)}"`);

      // Slash commands: /trace filters tools (forces CT path), /search is prompt-only
      let effectivePrompt = request.prompt;
      if (request.command === 'trace') {
        // Tool filtering: remove BFS and BB — AI must use start_column_trace (token gate guaranteed)
        const traceTools = new Set([
          'lineage_search_objects', 'lineage_get_object_detail', 'lineage_get_ddl_batch',
          'lineage_start_column_trace', 'lineage_submit_hop_analysis', 'lineage_enrich_view',
        ]);
        lineageTools = lineageTools.filter(t => traceTools.has(t.name));
        effectivePrompt = buildTracePrompt(request.prompt);
      } else if (request.command === 'search') {
        effectivePrompt = buildSearchPrompt(request.prompt);
      }
      if (request.command) {
        logInfo(outputChannel, 'AI', `Slash /${request.command} — prompt rewritten`);
        logDebug(outputChannel, 'AI', `Effective prompt: "${trunc(effectivePrompt, 200)}"`);
      }
      logDebug(outputChannel, 'AI', `Phase: discover${request.command ? ` /${request.command}` : ''} | Tools: ${lineageTools.map(t => t.name).join(', ')} (${lineageTools.length})`);

      // Build conversation history with smart management:
      // 1. DROP — replace error/empty tool results with 1-line summaries
      const responseTurns = context.history.filter(t => t instanceof vscode.ChatResponseTurn);
      const totalResponseTurns = responseTurns.length;
      let responseIndex = 0;

      const historyMessages: vscode.LanguageModelChatMessage[] = [];
      for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          historyMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const turnAge = totalResponseTurns - responseIndex; // age in turns from present
          responseIndex++;
          const meta = (turn.result.metadata as any)?.toolCallsMetadata as
            | { toolCallRounds: ToolCallRound[]; toolCallResults: Record<string, vscode.LanguageModelToolResult> }
            | undefined;
          if (meta?.toolCallRounds?.length) {
            for (const round of meta.toolCallRounds) {
              // Determine which tool calls have results (skip missing)
              const keepCallIds = new Set<string>();
              for (const tc of round.toolCalls) {
                const { callId } = extractToolCallFields(tc);
                if (meta.toolCallResults[callId]) {
                  keepCallIds.add(callId);
                }
              }

              // Re-inject assistant turn: response text + tool call parts (only those with results)
              const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
              if (round.response) assistantParts.push(new vscode.LanguageModelTextPart(round.response));
              for (const tc of round.toolCalls) {
                const f = extractToolCallFields(tc);
                if (!keepCallIds.has(f.callId)) continue;
                const part = tc instanceof vscode.LanguageModelToolCallPart
                  ? tc
                  : new vscode.LanguageModelToolCallPart(f.callId, f.name, f.input);
                assistantParts.push(part);
              }
              if (assistantParts.length === 0) continue; // skip empty rounds
              historyMessages.push(new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.Assistant, assistantParts,
              ));

              // Always re-inject tool results (no hard cutoff) — apply DROP
              const resultParts = round.toolCalls
                .map(tc => {
                  const { callId, name: toolName } = extractToolCallFields(tc);
                  if (!keepCallIds.has(callId)) return null;

                  const r = meta.toolCallResults[callId];
                  if (!r) {
                    logDebug(outputChannel, 'AI', `[History] Missing result for callId=${callId.slice(-8)} (${toolName}), skipping`);
                    return null;
                  }

                  // Serialize the content to a string for processing
                  let contentStr = (r.content as any[]).map((c: any) =>
                    typeof c.value === 'string' ? c.value : JSON.stringify(c),
                  ).join('');

                  // DROP: replace error/empty results with compact summary
                  const compact = compactNoiseResult(toolName, contentStr);
                  if (compact) contentStr = compact;

                  // DROP: compact stale SM hop results from completed state machines
                  // After SM completion, hop results are stale — synthesis has all evidence.
                  if (!compact) {
                    const ct = sess.stateMachine instanceof ColumnTraceState ? sess.stateMachine : null;
                    const bb = sess.stateMachine instanceof BlackboardState ? sess.stateMachine : null;
                    const hopCompact = compactStaleHopResult(
                      toolName, contentStr,
                      bb?.status === 'complete',
                      ct?.status === 'complete',
                    );
                    if (hopCompact) contentStr = hopCompact;
                  }

                  return new vscode.LanguageModelToolResultPart(
                    callId,
                    [new vscode.LanguageModelTextPart(contentStr)],
                  );
                })
                .filter((p): p is vscode.LanguageModelToolResultPart => p !== null);
              if (resultParts.length) {
                historyMessages.push(new vscode.LanguageModelChatMessage(
                  vscode.LanguageModelChatMessageRole.User, resultParts,
                ));
              }
            }
          } else {
            // Text-only turn fallback (turns with no tool calls)
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
      }
      logDebug(outputChannel, 'AI', `History: ${context.history.length} turns → ${historyMessages.length} messages`);

      const MAX_ROUNDS = vscode.workspace.getConfiguration('dataLineageViz').get<number>('ai.maxRounds', 50);

      // Single system prompt — explore-first data provider
      const platformCtx = sess.model?.dbPlatform ? buildPlatformContext(sess.model.dbPlatform) : '';
      const schemaCtx = (sess.filter?.schemas?.length ?? 0) > 0 ? buildSchemaContext(sess.filter!.schemas) : '';
      const templates = sess.outputTemplates;
      const systemPrompt =
        platformCtx +
        schemaCtx +
        buildSystemPromptBase(MAX_ROUNDS) +
        `   summary: ${templates.summary}\n` +
        `   sections: ${templates.sections}\n` +
        `   notes: ${templates.notes}\n` +
        `   highlights: ${templates.highlights}\n` +
        `   description (fallback): ${templates.description}`;

      /** Serialize messages to a single string for countTokens (string overload only — message overload has known bugs). */
      const serializeMessages = (msgs: vscode.LanguageModelChatMessage[]): string => {
        const parts: string[] = [];
        for (const m of msgs) {
          if (typeof m.content === 'string') { parts.push(m.content); continue; }
          if (!Array.isArray(m.content)) continue;
          for (const p of m.content as unknown[]) {
            if (p instanceof vscode.LanguageModelTextPart) parts.push(p.value);
            else if (p instanceof vscode.LanguageModelToolCallPart) parts.push(JSON.stringify(p.input));
            else if (p instanceof vscode.LanguageModelToolResultPart) {
              for (const c of (p as { content: unknown[] }).content) {
                if (c instanceof vscode.LanguageModelTextPart) parts.push(c.value);
              }
            }
          }
        }
        return parts.join('\n');
      };

      // EVICT: drop oldest history turns if total context exceeds pressure threshold
      const budgetTokens = Math.floor(sess.maxInputTokens * CONTEXT_PRESSURE_THRESHOLD);
      if (historyMessages.length > MIN_HISTORY_MESSAGES) {
        try {
          const fullText = `${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`;
          const totalTokens = await request.model.countTokens(fullText);

          if (totalTokens > budgetTokens) {
            let evicted = 0;
            while (historyMessages.length > MIN_HISTORY_MESSAGES) {
              // Evict in pairs
              const removed = historyMessages.shift()!;
              evicted++;
              if (removed.role === vscode.LanguageModelChatMessageRole.Assistant &&
                  Array.isArray(removed.content) &&
                  (removed.content as unknown[]).some(p => p instanceof vscode.LanguageModelToolCallPart) &&
                  historyMessages.length > 0) {
                historyMessages.shift(); // remove paired tool_result User message
                evicted++;
              }
              const newText = `${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`;
              const newTokens = await request.model.countTokens(newText);
              if (newTokens <= budgetTokens) break;
            }
            if (evicted > 0) {
              // Post-eviction: remove orphaned tool_result messages
              let orphansRemoved = 0;
              for (let i = 0; i < historyMessages.length; i++) {
                const msg = historyMessages[i];
                if (msg.role !== vscode.LanguageModelChatMessageRole.User || !Array.isArray(msg.content)) continue;
                const resultCallIds = (msg.content as unknown[])
                  .filter(p => p instanceof vscode.LanguageModelToolResultPart)
                  .map(p => (p as vscode.LanguageModelToolResultPart).callId);
                if (resultCallIds.length === 0) continue;
                const prev = i > 0 ? historyMessages[i - 1] : undefined;
                const prevCallIds = new Set<string>();
                if (prev && prev.role === vscode.LanguageModelChatMessageRole.Assistant && Array.isArray(prev.content)) {
                  for (const p of prev.content as unknown[]) {
                    if (p instanceof vscode.LanguageModelToolCallPart) prevCallIds.add(p.callId);
                  }
                }
                if (resultCallIds.some(id => !prevCallIds.has(id))) {
                  historyMessages.splice(i, 1);
                  orphansRemoved++;
                  i--;
                }
              }
              historyMessages.unshift(vscode.LanguageModelChatMessage.User(buildEvictionStub(evicted + orphansRemoved)));
              logWarn(outputChannel, 'AI', `[History] Evicted ${evicted + orphansRemoved} message(s) — context pressure (${totalTokens} tokens > ${budgetTokens} budget)`);
            }
          }
        } catch { /* countTokens unavailable */ }
      }

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        ...historyMessages,
        vscode.LanguageModelChatMessage.User(effectivePrompt),
      ];
      // Accumulators for this request's tool call rounds
      const toolCallRounds: ToolCallRound[] = [];
      const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
      const toolSequence: string[] = [];
      let totalToolCallsMade = 0;
      const toolCallCache = new Map<string, vscode.LanguageModelToolResult>();
      let roundCount = 0;

      let lastInputTokenEstimate = 0;
      let totalOutputTokens = 0;
      let totalToolResultChars = 0;
      let dedupCount = 0;
      let rejectedCount = 0;
      let errorCount = 0;
      const phaseTransitions: string[] = [];

      const runWithTools = async (): Promise<void> => {
        let actionRequiredPending = false;
        const SEARCH_TOOLS = new Set(['lineage_search_objects', 'lineage_search_ddl', 'lineage_get_context']);
        let modePromptMsg: vscode.LanguageModelChatMessage | null = null;

        const cleanHopContext = (label: string) => {
          const lastAssistant = messages[messages.length - 2];
          const lastResult = messages[messages.length - 1];
          const beforeCount = messages.length;
          messages.length = 0;
          messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
          messages.push(vscode.LanguageModelChatMessage.User(effectivePrompt));
          if (modePromptMsg) messages.push(modePromptMsg);
          messages.push(lastAssistant);
          messages.push(lastResult);
          logDebug(outputChannel, 'AI', `[${label}] Clean hop context: ${beforeCount} → ${messages.length} messages`);
        };

        while (roundCount < MAX_ROUNDS) {
          roundCount++;
          try {
            lastInputTokenEstimate = await request.model.countTokens(serializeMessages(messages));
          } catch { }

          logDebug(outputChannel, 'AI', `Round ${roundCount}/${MAX_ROUNDS} [${activePhase}] — sending request`);
          const roundT0 = performance.now();

          const response = await request.model.sendRequest(messages, { tools: lineageTools }, token);
          const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
          const toolCalls: vscode.LanguageModelToolCallPart[] = [];
          let responseText = '';

          for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              assistantParts.push(part);
              responseText += part.value;
              stream.markdown(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              assistantParts.push(part);
              toolCalls.push(part);
            }
          }

          const roundMs = Math.round(performance.now() - roundT0);
          try {
            totalOutputTokens += await request.model.countTokens(responseText);
          } catch { }

          if (responseText.length > 0) {
            const flat = responseText.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            logDebug(outputChannel, 'AI', `"${trunc(flat, 200)}"`);
          }

          if (!toolCalls.length) {
            logDebug(outputChannel, 'AI', `Round ${roundCount} complete — no tool calls, phase=${activePhase} (${roundMs}ms)`);
            return;
          }

          if (actionRequiredPending && responseText.length > 0) {
            actionRequiredPending = false;
            logDebug(outputChannel, 'AI', `[Gate] action_required cleared — AI responded`);
          }

          messages.push(new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.Assistant, assistantParts,
          ));

          const resultParts: vscode.LanguageModelToolResultPart[] = [];
          const processedCallIds = new Set<string>();
          let roundToolResultChars = 0;
          for (const call of toolCalls) {
            if (processedCallIds.has(call.callId)) continue;
            processedCallIds.add(call.callId);
            
            const normalizeInput = (input: Record<string, unknown>): string => {
              const sorted = Object.keys(input).sort().reduce((acc, k) => {
                if (input[k] !== undefined && input[k] !== null && input[k] !== false) acc[k] = input[k];
                return acc;
              }, {} as Record<string, unknown>);
              return JSON.stringify(sorted);
            };
            const cacheKey = `${call.name}::${normalizeInput(call.input as Record<string, unknown>)}`;
            const cached = toolCallCache.get(cacheKey);
            if (cached) {
              resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true, message: 'Identical call already returned.' }))]));
              dedupCount++;
              continue;
            }
            
            const allowedToolNames = new Set(lineageTools.map(t => t.name));
            if (!allowedToolNames.has(call.name)) {
              rejectedCount++;
              resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_not_available_in_phase', phase: activePhase }))]));
              continue;
            }
            if (actionRequiredPending && !SEARCH_TOOLS.has(call.name)) {
              rejectedCount++;
              resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
              continue;
            }

            const inp = call.input as Record<string, unknown>;
            const progressLabel = (() => {
              if (call.name === 'lineage_submit_findings' && typeof inp.focus_node_id === 'string') {
                return `Analyzing: ${(inp.focus_node_id as string).split('.').pop()}…`;
              }
              return `Querying lineage: ${call.name.replace('lineage_', '').replace(/_/g, ' ')}…`;
            })();
            stream.progress(progressLabel);
            const t0 = performance.now();
            try {
              const result = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, token);
              resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
              accumulatedToolResults[call.callId] = result;
              toolCallCache.set(cacheKey, result);
              roundToolResultChars += JSON.stringify(result.content).length;
            } catch (err) {
              errorCount++;
              const msg = err instanceof Error ? err.message : String(err);
              const errContent = [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: msg }))];
              resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, errContent));
              accumulatedToolResults[call.callId] = new vscode.LanguageModelToolResult(errContent);
            }
          }
          totalToolResultChars += roundToolResultChars;
          const toolNames = toolCalls.map(c => c.name.replace('lineage_', '')).join(', ');
          toolSequence.push(toolCalls.length > 1 ? `[${toolNames}]` : toolNames);

          messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
          
          const actionGates: string[] = [];
          for (const call of toolCalls) {
            const result = accumulatedToolResults[call.callId];
            if (!result) continue;
            for (const part of result.content) {
              if (part instanceof vscode.LanguageModelTextPart) {
                try {
                  const parsed = JSON.parse(part.value);
                  if (parsed.action_required === 'analyze_and_respond') actionGates.push(parsed.action_required);
                } catch { }
              }
            }
          }
          if (actionGates.length > 0) {
            actionRequiredPending = true;
            messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, buildActionRequiredGate(actionGates)));
          }

          toolCallRounds.push({ response: responseText, toolCalls });
          totalToolCallsMade += toolCalls.length;

          // ─── Phase Transitions ───────────────────────────────────────────
          const hasCtStart = toolCalls.some(tc => tc.name === 'lineage_start_column_trace');
          const hasCtSubmit = toolCalls.some(tc => tc.name === 'lineage_submit_hop_analysis');
          const hasExplStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
          const hasSubFindings = toolCalls.some(tc => tc.name === 'lineage_submit_findings');

          if (hasCtStart && sess.stateMachine instanceof ColumnTraceState && activePhase === 'discover') {
            const ct = sess.stateMachine;
            if (ct.status === 'hopping' || ct.status === 'awaiting_verdicts') {
              activePhase = 'ct_active';
              phaseTransitions.push(`discover→ct_active@R${roundCount}`);
              lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-ct'));
              modePromptMsg = vscode.LanguageModelChatMessage.User(ct.columns.length > 0 ? buildCtPrompt() : buildCtDepPrompt());
              messages.push(modePromptMsg);
            }
          }
          if (sess.stateMachine instanceof ColumnTraceState && sess.stateMachine.status === 'complete' && activePhase === 'ct_active') {
            activePhase = 'ct_done';
            phaseTransitions.push(`ct_active→ct_done@R${roundCount}`);
            lineageTools = smDoneTools();
            if (!sess.stateMachine.inlineMode) {
              modePromptMsg = vscode.LanguageModelChatMessage.User(buildSynthesisPrompt());
              cleanHopContext('CT');
            }
          }

          if (hasExplStart && sess.stateMachine instanceof BlackboardState && activePhase === 'discover') {
            const bb = sess.stateMachine;
            if (bb.status === 'exploring' || bb.status === 'awaiting_findings') {
              activePhase = 'bb_active';
              phaseTransitions.push(`discover→bb_active@R${roundCount}`);
              lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-bb') || t.tags.includes('lineage-research'));
              modePromptMsg = vscode.LanguageModelChatMessage.User(buildBbPrompt());
              messages.push(modePromptMsg);
            }
          }
          if (sess.stateMachine instanceof BlackboardState && sess.stateMachine.status === 'complete' && activePhase === 'bb_active') {
            activePhase = 'bb_done';
            phaseTransitions.push(`bb_active→bb_done@R${roundCount}`);
            lineageTools = smDoneTools();
            if (!sess.stateMachine.inlineMode) {
              modePromptMsg = vscode.LanguageModelChatMessage.User(buildSynthesisPrompt());
              cleanHopContext('BB');
            }
          }

          const isHopSubmission = hasSubFindings || hasCtSubmit;
          const smStillHopping =
            (activePhase === 'bb_active' && sess.stateMachine instanceof BlackboardState && !sess.stateMachine.inlineMode && sess.stateMachine.status !== 'complete') ||
            (activePhase === 'ct_active' && sess.stateMachine instanceof ColumnTraceState && !sess.stateMachine.inlineMode && sess.stateMachine.status !== 'complete');
          if (isHopSubmission && smStillHopping) {
            cleanHopContext(activePhase === 'bb_active' ? 'BB' : 'CT');
          }
        }
        logError(outputChannel, 'AI', `Round limit reached (${MAX_ROUNDS})`, new Error('MAX_ROUNDS exceeded'));
        stream.markdown(`\n\n**Error:** Reached the ${MAX_ROUNDS}-round limit.`);
      };

      try {
        await runWithTools();
        // C2: Structured summary — lastInputTokenEstimate is the final round's full context size (correct budget measure)
        const totalTokenEst = lastInputTokenEstimate + totalOutputTokens + Math.round(totalToolResultChars / 4);
        const budgetPct = sess.maxInputTokens > 0 ? Math.round((lastInputTokenEstimate / sess.maxInputTokens) * 100) : 0;
        const modeLabel = sess.stateMachine instanceof BlackboardState ? 'exploration' : sess.stateMachine instanceof ColumnTraceState ? 'trace' : 'discover';
        logInfo(outputChannel, 'AI', `Summary — model: ${sess.modelName}, mode: ${modeLabel}, phase: ${activePhase}, rounds: ${roundCount}, tools: ${totalToolCallsMade}, tokens: ~${totalTokenEst} (${budgetPct}% of ${sess.maxInputTokens})`);
        if (toolSequence.length > 0) {
          // Compress consecutive repeated tool names: [a, b, b, b, c] → "a, b ×3, c"
          const compressed: string[] = [];
          let i = 0;
          while (i < toolSequence.length) {
            const name = toolSequence[i];
            let count = 1;
            while (i + count < toolSequence.length && toolSequence[i + count] === name) count++;
            compressed.push(count > 1 ? `${name} ×${count}` : name);
            i += count;
          }
          logDebug(outputChannel, 'AI', `Tool sequence: ${compressed.join(', ')}`);
        }
        const sm = sess.stateMachine;
        if (sm instanceof ColumnTraceState) {
          kpiParts.push(`ct_hops=${sm.hops}, ct_visited=${sm.visitedCount}/${sm.scopeSize}, ct_frontier=${sm.frontierSize}`);
        } else if (sm instanceof BlackboardState) {
          kpiParts.push(`bb_notes=${sm.noteCount}, bb_status=${sm.status}`);
        }
        if (kpiParts.length > 0) logDebug(outputChannel, 'AI', `KPIs — ${kpiParts.join(', ')}`);
        logInfo(outputChannel, 'AI', `Session end`);

        // Store partial result when session ends with active SM (round/token exhaustion, AI stopped early).
        if (!sess.resultGraph) {
          if (sm instanceof BlackboardState && sm.status !== 'complete') {
            sm.forceComplete();
            const partial = sm.getResult();
            if (!('error' in partial)) sess.storeBbResult(partial);
          } else if (sm instanceof ColumnTraceState && sm.status !== 'complete') {
            sm.forceComplete();
            const partial = sm.getResult();
            if (!('error' in partial)) sess.storeCtResult(partial);
          }
        }

        // B3: "Show in Graph" button — after BFS trace or SM completion (CT/BB)
        const alreadyEnriched = toolCallRounds.some(r => r.toolCalls.some(tc => tc.name === 'lineage_enrich_view'));
        const hasBfs = toolCallRounds.some(r => r.toolCalls.some(tc => tc.name === 'lineage_run_bfs_trace'));
        const smComplete = ctSnap?.status === 'complete' || bbSnap?.status === 'complete';
        if (activePanel && !alreadyEnriched && (hasBfs || smComplete)) {
          stream.button({
            command: 'dataLineageViz.aiCreateView',
            title: '$(type-hierarchy-sub) Show in Graph',
            arguments: [request.prompt],
          });
        }

        // Behavioral hint: if no tools were called, the model likely doesn't support function calling
        if (totalToolCallsMade === 0 && lineageTools.length > 0) {
          logInfo(outputChannel, 'AI', `No tools called in ${roundCount} round(s) — model may lack function calling`);

          stream.markdown(
            '\n\n> **Tip:** @lineage needs a model with tool/function calling support. ' +
            'Switch to **GPT-4o**, **Claude Sonnet**, or **Gemini** in the model picker.',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(outputChannel, 'AI', 'Chat handler', err);
        stream.markdown(`\n\n*Error: ${msg}*`);
      }

      // Determine last tool types for follow-up suggestions
      const lastTools = toolCallRounds.length > 0
        ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map(tc => tc.name)
        : [];

      return {
        metadata: {
          toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults },
          rounds: roundCount,
          toolCalls: totalToolCallsMade,
          model: request.model.id,
          lastTools,
        },
      };
    },
  );

  // B1: Follow-up provider — context-aware suggestions based on last tool calls
  participant.followupProvider = {
    provideFollowups(result, _context, _token) {
      const meta = result.metadata as Record<string, unknown> | undefined;
      const lastTools = (meta?.lastTools as string[]) ?? [];
      const followups: vscode.ChatFollowup[] = [];

      if (lastTools.some(t => t.includes('bfs_trace'))) {
        followups.push({ prompt: 'Create a view from this trace', label: 'Create AI view' });
        followups.push({ prompt: 'Show me the upstream sources in more detail', label: 'Trace deeper upstream' });
      } else if (lastTools.some(t => t.includes('search'))) {
        followups.push({ prompt: 'Trace the lineage from the top result', label: 'Trace lineage' });
        followups.push({ prompt: 'Show me the DDL for the top result', label: 'Get details' });
      } else if (lastTools.some(t => t.includes('get_object_detail'))) {
        followups.push({ prompt: 'Trace the lineage from this object', label: 'Trace lineage' });
        followups.push({ prompt: 'What other objects reference this one?', label: 'Find references' });
      } else if (lastTools.some(t => t.includes('run_analysis'))) {
        followups.push({ prompt: 'Show me the details of the top hub', label: 'Explore top hub' });
      } else if (lastTools.some(t => t.includes('enrich_view'))) {
        followups.push({ prompt: 'Explain the lineage in more detail', label: 'Detailed explanation' });
      } else if (lastTools.some(t => t.includes('submit_hop') || t.includes('submit_findings'))) {
        followups.push({ prompt: 'Show the trace result in the graph', label: 'Show in Graph' });
        followups.push({ prompt: 'Explain the full lineage path in detail', label: 'Detailed explanation' });
      }

      return followups;
    },
  };

  // C3: Feedback telemetry — log thumbs up/down with request metadata
  participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
    const meta = feedback.result.metadata as Record<string, unknown> | undefined;
    const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    logInfo(outputChannel, 'AI', `Feedback: ${kind} — rounds: ${meta?.rounds ?? '?'}, tools: ${meta?.toolCalls ?? '?'}, model: ${meta?.model ?? '?'}`);
  });

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

// ─── AI Output Templates ────────────────────────────────────────────────────

async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplates> {
  if (!isAiEnabled()) return { ...EMPTY_AI_TEMPLATES };

  const REQUIRED_KEYS: (keyof AiOutputTemplates)[] = ['summary', 'description', 'sections', 'highlights', 'notes'];

  // Load built-in YAML first — serves as base and fallback for missing custom keys
  const builtIn: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
  try {
    const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'aiOutputTemplates.yaml');
    const data = await vscode.workspace.fs.readFile(builtInUri);
    const content = new TextDecoder().decode(data);
    const parsed = yaml.load(content) as Record<string, { instruction?: string }>;
    for (const key of REQUIRED_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
      }
    }
    logDebug(outputChannel, 'Config', 'AI output templates loaded from built-in defaults');
  } catch (err) {
    logError(outputChannel, 'Config', 'load built-in AI templates', err instanceof Error ? err : new Error(String(err)));
  }

  // Overlay custom YAML if configured
  const cfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
  const customPath = cfg.get<string>('outputTemplateFile', '');

  if (!customPath) return builtIn;

  const resolved = resolveWorkspacePath(customPath);
  if (!resolved) {
    logWarn(outputChannel, 'Config', `Cannot resolve AI templates path "${customPath}" — using built-in defaults`);
    return builtIn;
  }

  try {
    const fileUri = vscode.Uri.file(resolved);
    const data = await vscode.workspace.fs.readFile(fileUri);
    const content = new TextDecoder().decode(data);
    const parsed = yaml.load(content) as Record<string, { instruction?: string }>;

    const result = { ...builtIn };
    const missing: string[] = [];

    for (const key of REQUIRED_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string' && entry.instruction.trim().length > 0) {
        result[key] = entry.instruction.trim();
      } else {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      logWarn(outputChannel, 'Config', `Custom AI templates missing keys: ${missing.join(', ')} — using built-in defaults for those`);
    }
    await persistAbsolutePath('ai.outputTemplateFile', customPath, resolved);
    logInfo(outputChannel, 'Config', `AI output templates loaded from ${path.basename(customPath)}${missing.length > 0 ? ` (${missing.length} key(s) using defaults)` : ''}`);
    return result;
  } catch (err) {
    logWarn(outputChannel, 'Config', `Failed to load custom AI templates: ${err instanceof Error ? err.message : String(err)} — using built-in defaults`);
    vscode.window.showWarningMessage('Data Lineage: Failed to load custom AI output templates — using built-in defaults.');
    return builtIn;
  }
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
    logInfo(outputChannel, 'Project', `Migrated legacy connection to project "${name}"`);
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
      handleLoadDemo(activePanel, context, true).catch(err => logError(outputChannel, 'Dacpac', 'Load demo', err));
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
          logDebug(outputChannel, 'DB', `Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
        });
        statsConnectionUri = undefined;
      }
      
      if (_session) {
        const disposedNodeCount = _session.model?.nodes.length ?? 0;
        _session.resetExploration();
        _session.model = null;
        _session.graph = null;
        _session.columnStore.clear();
        _session.filter = null;
        _session.views = [];
        _session.projectName = null;
        _session.currentProjectId = null;
        logDebug(outputChannel, 'Bridge', `Model cleared (panel disposed) — had ${disposedNodeCount} nodes`);
      }
      
      cachedElements = null;
      cachedDspName = '';
      currentActiveFilter = null;
      currentSavedViews = [];
      currentProjectId = null;
      vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
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

    /** Centralized model assignment — populates ColumnStore, strips nodes, syncs AI state. */
    function setCurrentModel(m: DatabaseModel, project?: { id: string; name: string } | null): void {
      const sess = getSession();
      sess.columnStore.clear();
      populateColumnStore(m, sess.columnStore);
      sess.model = m;
      sess.graph = buildBareGraph(m);
      
      if (project !== undefined) {
        sess.currentProjectId = project?.id ?? null;
        sess.projectName = project?.name ?? null;
      }
      vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', true);
      const stats = sess.columnStore.size;
      logDebug(outputChannel, 'Bridge', `ColumnStore: ${stats.objects} objects with columns, ${stats.totalColumns} total columns, ${stats.ddlCount} DDL entries`);
    }

    // ─── Detail Panel Helper ─────────────────────────────────────────────────
    // Holds the first detail-update payload until the webview signals detail-ready.
    // The webview's message listener (useEffect) is set up after React's first render,
    // so any postMessage sent during panel creation would be lost.
    let pendingDetailUpdate: { node: import('./engine/types').LineageNode; findQuery?: string; config: object } | undefined;

    /** Re-attach columns + DDL from ColumnStore before sending to detail webview. */
    function enrichNodeForDetail(node: import('./engine/types').LineageNode): import('./engine/types').LineageNode {
      const sess = getSession();
      const cols = sess.columnStore.getColumns(node.id);
      const ddl = sess.columnStore.getDdl(node.id);
      if (!cols && !ddl) return node;
      return { ...node, ...(cols && { columns: cols }), ...(ddl && { bodyScript: ddl }) };
    }

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
        pendingDetailUpdate = { node: enrichNodeForDetail(node), findQuery, config: detailConfig };
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
                logDebug(outputChannel, 'Detail', `Ready — flushing '${pendingDetailUpdate.node.id}'`);
                detailPanel?.webview.postMessage({ type: 'detail-update', ...pendingDetailUpdate });
                pendingDetailUpdate = undefined;
              } else {
                logDebug(outputChannel, 'Detail', 'Ready — pendingUpdate empty (re-mount or duplicate signal)');
              }
            } else if (msg.type === 'error') {
              // React ErrorBoundary + global handlers post here.
              // Log at error level so it's visible in the output channel without debug mode.
              logWarn(outputChannel, 'Detail', (msg as { error: string }).error);
              const typedMsg = msg as { error: string; stack?: string; componentStack?: string };
              if (typedMsg.stack) logDebug(outputChannel, 'Detail', `Stack: ${typedMsg.stack}`);
              if (typedMsg.componentStack) logDebug(outputChannel, 'Detail', `Component stack: ${typedMsg.componentStack}`);
            } else if (msg.type === 'table-stats-request') {
              await handleTableStatsRequest(lastConnectionInfo, detailPanel!, msg.schema, msg.objectName, msg.mode, msg.columns ?? []);
            } else if (msg.type === 'close-detail') {
              detailPanel?.dispose();
            } else {
              logDebug(outputChannel, 'Detail',
                `No handler for '${(msg as { type: string }).type}' — ` +
                `pendingUpdate: ${pendingDetailUpdate ? 'set' : 'empty'}, ` +
                `payload: ${trunc(JSON.stringify(msg), 300)}`
              );
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logError(outputChannel, 'Detail', `Message handler for "${(msg as { type: string }).type}"`, err);
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
        detailPanel.webview.postMessage({ type: 'detail-update', node: enrichNodeForDetail(node), findQuery, config: detailConfig });
      }
    }

    const handlers: MessageHandlerMap = {
      'ready': async () => {
        if (loadDemo) {
          await handleLoadDemo(panel, context, true, (m) => {
            const sess = getSession();
            setCurrentModel(m, null);
            sess.projectName = 'Demo';
          });
          return;
        }
        // One-time migration from legacy workspaceState keys (runs once, clears old keys)
        if (context.globalState.get(PROJECT_STORE_KEY) === undefined) {
          await migrateFromWorkspaceState(context);
        }
        const config = await readExtensionConfig();
        const store = loadProjectStore(context);
        const sess = getSession();
        panel.webview.postMessage({ type: 'config-only', config });
        panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
        // Restore project context from store on panel re-create
        if (sess.model && store.lastOpenedId) {
          const project = store.projects.find(p => p.id === store.lastOpenedId);
          if (project) {
            sess.currentProjectId = project.id;
            sess.projectName = project.name;
          }
          panel.webview.postMessage({ type: 'dacpac-model', model: sess.model, config, sourceName: sess.projectName ?? 'Project', autoVisualize: true });
          logDebug(outputChannel, 'Bridge', 'Panel restored from retained model');
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
            logInfo(outputChannel, 'Dacpac', `Opening ${fileName}`);
            const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
            if (preview.warnings?.length) logWarn(outputChannel, 'Dacpac', preview.warnings[0]);
            cachedElements = elements;
            cachedDspName = dspName;
            
            const sess = getSession();
            sess.model = null;
            sess.graph = null;
            sess.columnStore.clear();
            sess.currentProjectId = null;
            vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
            panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: fileName, filePath: fileUri.fsPath });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logError(outputChannel, 'Dacpac', 'Read file', err);
            vscode.window.showErrorMessage(`Failed to read file: ${errorMsg}`);
          }
        }
      },
      'load-project': async (msg) => {
        // Clear stale stats connection — prevents dev/prod cross-query on project switch
        if (statsConnectionUri) {
          disconnectDatabase(statsConnectionUri, outputChannel).catch(err => logDebug(outputChannel, 'DB', `stats disconnect on project switch: ${String(err)}`));
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
            logInfo(outputChannel, 'Project', `Loading project "${project.name}"`);
            
            const sess = getSession();
            sess.currentProjectId = project.id;
            if (schemas && schemas.length > 0) {
              // Phase 2 directly: preselected schemas from saved project
              if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig));
              const { elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
              const model = extractDacpacFiltered(elements, new Set(schemas), dspName);
              setCurrentModel(model, { id: project.id, name: conn.displayName });
              cachedElements = null;
              cachedDspName = '';
              logDebug(outputChannel, 'Bridge', `Model retained: ${model.nodes.length} nodes, ${model.edges.length} edges — ${model.dbPlatform ?? 'platform unknown'}`);
              if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
              panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: conn.displayName });
            } else {
              // Phase 1: no stored schemas — show schema selector
              const { preview, elements, dspName } = await extractSchemaPreview(data.buffer as ArrayBuffer);
              if (preview.warnings?.length) logWarn(outputChannel, 'Dacpac', preview.warnings[0]);
              cachedElements = elements;
              cachedDspName = dspName;
              
              sess.model = null;
              sess.graph = null;
              sess.columnStore.clear();
              vscode.commands.executeCommand('setContext', 'dataLineageViz.modelLoaded', false);
              panel.webview.postMessage({ type: 'dacpac-schema-preview', preview, config, sourceName: conn.displayName });
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logError(outputChannel, 'Project', `Load "${conn.path}"`, err);
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
              logInfo(outputChannel, 'Project', 'Direct reconnect failed — falling back to picker');
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
                  logDebug(outputChannel, 'Project', `Catalog: ${r.rowCount} objects loaded`);
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
                  setCurrentModel(m, { id: project.id, name: project.name });
                  logDebug(outputChannel, 'Bridge', `Model retained: ${m.nodes.length} nodes, ${m.edges.length} edges — ${m.dbPlatform ?? 'platform unknown'}`);
                });
              if (!token.isCancellationRequested) {
                const refreshed = { ...project, updatedAt: new Date().toISOString() };
                const updatedStore = updateProject(store, refreshed);
                await saveProjectStore(context, updatedStore);
                panel.webview.postMessage({ type: 'projects-list', projects: updatedStore.projects, lastOpenedId: updatedStore.lastOpenedId, lastWizardView: updatedStore.lastWizardView });
              }
              logInfo(outputChannel, 'Project', `Loading project "${project.name}"`);
            },
          );
        }
      },
      'save-project': async (msg) => {
        if (!isValidProject(msg.project)) {
          logWarn(outputChannel, 'Project', `Rejected malformed save-project payload: ${JSON.stringify(msg.project)}`);
          return;
        }
        const store = loadProjectStore(context);
        const updated = updateProject(store, msg.project);
        await saveProjectStore(context, updated);
        getSession().currentProjectId = msg.project.id;
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        logInfo(outputChannel, 'Project', `Saved: "${msg.project.name}"`);
      },
      'delete-project': async (msg) => {
        const store = loadProjectStore(context);
        const updated = deleteProject(store, msg.id);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        logInfo(outputChannel, 'Project', `Deleted: ${msg.id}`);
      },
      'load-demo': async () => {
        await handleLoadDemo(panel, context, true, (m) => {
          const sess = getSession();
          setCurrentModel(m, null);
          sess.projectName = 'Demo';
        });
      },
      'dacpac-visualize': async (msg) => {
        logDebug(outputChannel, 'Dacpac', `Received: dacpac-visualize — schemas: ${msg.schemas?.join(', ')}`);
        if (!cachedElements) {
          logWarn(outputChannel, 'Dacpac',
            'Phase 2 aborted — session expired between Phase 1 and schema selection ' +
            '(no cached elements). Sending session-expired error to webview. ' +
            'User should reopen the file to retry.'
          );
          panel.webview.postMessage({ type: 'db-error', message: 'Session expired — please reopen the file to restart.', phase: 'extract' });
          return;
        }
        const config = await readExtensionConfig();
        try {
          if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig));
          const model = extractDacpacFiltered(cachedElements, new Set(msg.schemas), cachedDspName);
          const sess = getSession();
          const projectName = msg.projectName ?? sess.projectName ?? 'dacpac';
          if (sess.currentProjectId) {
            setCurrentModel(model, { id: sess.currentProjectId, name: projectName });
          } else {
            setCurrentModel(model);
            sess.projectName = projectName;
          }
          cachedElements = null;
          cachedDspName = '';
          logDebug(outputChannel, 'Bridge', `Model retained: ${model.nodes.length} nodes, ${model.edges.length} edges — ${model.dbPlatform ?? 'platform unknown'}`);
          if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
          const sourceName = projectName;
          panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError(outputChannel, 'Dacpac', 'Phase 2 extraction', err);
          panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase: 'extract' });
        }
      },
      'filter-changed': (msg) => {
        const sess = getSession();
        sess.filter = msg.filter;
        sess.views = msg.savedViews;
        if (msg.filteredCount !== undefined) _lastFilteredCount = msg.filteredCount;
        if (msg.renderLimitHit !== undefined) _lastRenderLimitHit = msg.renderLimitHit;
        const f = msg.filter;
        const focus = f.focusSchemas?.length ? `, focus=[${f.focusSchemas.join(',')}]` : '';
        const excl = f.exclusionPatterns?.length ? `, exclusions=${f.exclusionPatterns.length}` : '';
        const allow = msg.filteredCount !== undefined ? `, filteredCount=${msg.filteredCount}` : '';
        logDebug(outputChannel, 'Bridge',
          `filter-changed: schemas=${f.schemas.length}, types=[${f.types.join(',')}], ` +
          `hideIsolated=${f.hideIsolated}${focus}${excl}${allow}`);
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
        if (msg.stack) logDebug(outputChannel, 'Bridge', msg.stack);
        vscode.window.showErrorMessage(`Data Lineage Error: ${msg.error}`);
      },
      'show-warning': (msg) => {
        logWarn(outputChannel, 'Bridge', msg.text);
        vscode.window.showWarningMessage(`Data Lineage: ${msg.text}`);
      },
      'open-external': async (msg) => {
        if (msg.url && /^https?:\/\//i.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      },
      'open-settings': () => { vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz'); },
      'overview-mode-changed': (msg) => {
        _lastOverviewMode = msg.mode;
        logDebug(outputChannel, 'Bridge',
          `overview-mode-changed: mode=${msg.mode}, focusDrill=${msg.enteredFocusFromOverview}, ` +
          `filteredCount=${_lastFilteredCount ?? '?'}, renderLimitHit=${_lastRenderLimitHit ?? 0}`);
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
        logInfo(outputChannel, 'Bridge', `Exported: ${uri.fsPath}`);
        await vscode.commands.executeCommand('revealFileInOS', uri);
      },
      'show-detail': (msg) => {
        logDebug(outputChannel, 'Detail', `show-detail: [${msg.node.schema}].[${msg.node.name}]${msg.findQuery ? ` find="${msg.findQuery}"` : ''}`);
        openOrRevealDetailPanel(msg.node, msg.findQuery);
      },
      'update-detail': (msg) => {
        if (detailPanel) {
          logDebug(outputChannel, 'Detail', `update-detail: [${msg.node.schema}].[${msg.node.name}]`);
          openOrRevealDetailPanel(msg.node, msg.findQuery);
        }
      },
      'close-detail': () => {
        logDebug(outputChannel, 'Detail', 'close-detail');
        detailPanel?.dispose();
      },
      'check-mssql': () => {
        panel.webview.postMessage({ type: 'mssql-status', available: isMssqlAvailable() });
      },
      'db-connect': () => {
        logDebug(outputChannel, 'DB', 'Received: db-connect');
        return withDbProgress(panel, 'Data Lineage: Connecting to database',
        () => promptForConnection(outputChannel),
        (conn, progress, token) => {
          lastConnectionInfo = conn.connectionInfo;
          return runDbPhase1(panel, conn.connectionUri, conn.connectionInfo, progress, token,
            (result) => { allObjectsCache = result; },
            (result) => { platformInfoCache = result; });
        },
        );
      },
      'db-visualize': (msg) => {
        logDebug(outputChannel, 'DB', `Received: db-visualize — schemas: ${msg.schemas?.join(', ')}`);
        return withDbProgress(panel, 'Data Lineage: Loading selected schemas',
        async () => {
          if (!lastConnectionInfo) {
            panel.webview.postMessage({ type: 'db-error', message: 'No stored connection info. Please reconnect.', phase: 'connect' });
            return undefined;
          }
          const result = await connectDirect(lastConnectionInfo, outputChannel);
          if (result) return result;
          logInfo(outputChannel, 'DB', 'Direct reconnect failed for Phase 2 — falling back to picker');
          return promptForConnection(outputChannel);
        },
        async (conn, progress, token) => {
          const sourceName = `${conn.connectionInfo.server} / ${conn.connectionInfo.database}`;
          // Create project before Phase 2 so the callback can set the ID atomically with model
          const pendingProject = msg.projectName ? createProject(msg.projectName, {
            type: 'database' as const,
            connectionInfo: stripSensitiveFields(conn.connectionInfo),
            sourceName,
            schemas: msg.schemas,
          }) : null;
          await runDbPhase2(
            panel, conn.connectionUri, msg.schemas, progress, token, allObjectsCache,
            conn.connectionInfo.database, sourceName, platformInfoCache,
            (m) => {
              if (pendingProject) {
                setCurrentModel(m, { id: pendingProject.id, name: pendingProject.name });
              } else {
                setCurrentModel(m);
                getSession().projectName = sourceName;
              }
              logDebug(outputChannel, 'Bridge', `Model retained: ${m.nodes.length} nodes, ${m.edges.length} edges — ${m.dbPlatform ?? 'platform unknown'}`);
            },
          );
          // Persist project after Phase 2 completes
          if (pendingProject && !token.isCancellationRequested) {
            const store = loadProjectStore(context);
            const updated = updateProject(store, pendingProject);
            await saveProjectStore(context, updated);
            panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
            logInfo(outputChannel, 'Project', `Saved: "${msg.projectName}"`);
          }
        },
      );
      },
      'save-view': async (msg) => {
        const store = loadProjectStore(context);
        if (!store.projects.some(p => p.id === msg.projectId)) {
          logWarn(outputChannel, 'Project', `save-view: projectId ${msg.projectId} not found in store`);
          return;
        }
        const updated = addFilterProfile(store, msg.projectId, msg.profile as FilterProfile);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        logInfo(outputChannel, 'Project', `View saved: "${(msg.profile as FilterProfile).name}" on project ${msg.projectId}`);
      },
      'save-wizard-view': async (msg) => {
        const store = loadProjectStore(context);
        await saveProjectStore(context, { ...store, lastWizardView: msg.view as 'main' | 'projects' });
        logDebug(outputChannel, 'Project', `Wizard view saved: ${msg.view}`);
      },
      'delete-view': async (msg) => {
        const store = loadProjectStore(context);
        const updated = deleteFilterProfile(store, msg.projectId, msg.profileId);
        await saveProjectStore(context, updated);
        panel.webview.postMessage({ type: 'projects-list', projects: updated.projects, lastOpenedId: updated.lastOpenedId, lastWizardView: updated.lastWizardView });
        logInfo(outputChannel, 'Project', `View deleted: ${msg.profileId}`);
      },
      'rebuild': async () => {
        logInfo(outputChannel, 'Bridge', 'Rebuild requested — re-reading extension settings');
        const config = await readExtensionConfig();
        if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig));
        panel.webview.postMessage({ type: 'rebuild-config', config });
        const { layout, excludePatterns, maxNodes, analysis, externalRefs } = config;
        logDebug(outputChannel, 'Bridge',
          `Rebuild: direction=${layout.direction}, edgeStyle=${layout.edgeStyle}, ` +
          `nodeSep=${layout.nodeSeparation}, rankSep=${layout.rankSeparation}, ` +
          `maxNodes=${maxNodes}, excludePatterns=${excludePatterns.length ? excludePatterns.join(';') : '(none)'}, ` +
          `islandMaxSize=${analysis.islandMaxSize}, hubMinDegree=${analysis.hubMinDegree}, ` +
          `externalRefs=${externalRefs.enabled ? 'on' : 'off'}`
        );
        const nodeCount = currentModel?.nodes.length ?? 0;
        const edgeCount = currentModel?.edges.length ?? 0;
        logDebug(outputChannel, 'Bridge', `Rebuilding dagre layout for ${nodeCount} nodes, ${edgeCount} edges`);
      },
      'reload': () => {
        logInfo(outputChannel, 'Bridge', 'Panel reload requested');
        panel.dispose();
        openPanel(context, title, loadDemo);
      },
      'request-projects': () => {
        const store = loadProjectStore(context);
        panel.webview.postMessage({ type: 'projects-list', projects: store.projects, lastOpenedId: store.lastOpenedId, lastWizardView: store.lastWizardView });
      },
    };

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        const msgType = (message as { type: string }).type;
        if (msgType !== 'log' && msgType !== 'error') {
          logDebug(outputChannel, 'Bridge', `→ ${msgType} (${JSON.stringify(message).length} chars)`);
        }
        try {
          const handler = handlers[message.type] as ((msg: WebviewMessage) => Promise<void> | void) | undefined;
          if (handler) {
            await handler(message);
          } else {
            logDebug(outputChannel, 'Bridge',
              `No handler for '${(message as { type: string }).type}' — ` +
              `payload: ${trunc(JSON.stringify(message), 300)}`
            );
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError(outputChannel, 'Bridge', `Message handler for "${message.type}"`, err);
          vscode.window.showErrorMessage(`Data Lineage Error: ${errorMsg}`);
        }
      },
      undefined,
      context.subscriptions
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError(outputChannel, 'Bridge', 'Open panel', error);
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
  | { type: 'log'; text: string; level?: 'info' | 'warn' | 'debug' | 'trace' }
  | { type: 'error'; error: string; stack?: string }
  | { type: 'show-warning'; text: string }
  | { type: 'open-external'; url?: string }
  | { type: 'open-settings' }
  | { type: 'show-detail'; node: import('./engine/types').LineageNode; findQuery?: string }
  | { type: 'update-detail'; node: import('./engine/types').LineageNode; findQuery?: string }
  | { type: 'close-detail' }
  | { type: 'check-mssql' }
  | { type: 'db-connect' }
  | { type: 'rebuild' }
  | { type: 'reload' }
  | { type: 'dacpac-visualize'; schemas: string[]; projectName?: string }
  | { type: 'db-visualize'; schemas: string[]; projectName?: string }
  | { type: 'filter-changed'; filter: import('./engine/projectStore').SerializedFilterState; savedViews: import('./engine/projectStore').FilterProfile[]; filteredCount?: number; renderLimitHit?: number }
  | { type: 'export-file'; data: string; defaultName: string }
  | { type: 'overview-mode-changed'; mode: 'full' | 'overview'; enteredFocusFromOverview: boolean }
  | { type: 'request-projects' };

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
        logError(outputChannel, 'DB', `${phase} (${title})`, err);
        panel.webview.postMessage({ type: 'db-error', message: errorMsg, phase });
      } finally {
        if (connectionUri) {
          await disconnectDatabase(connectionUri, outputChannel).catch(err => {
            logWarn(outputChannel, 'DB', `Disconnect cleanup failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    },
  );
}

// ─── Read Extension Config ──────────────────────────────────────────────────

// ─── Debug Dump ─────────────────────────────────────────────────────────────

function buildDebugDump(context: vscode.ExtensionContext): string {
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);
  const version = (context.extension.packageJSON as { version: string }).version ?? 'unknown';
  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';

  add(`Data Lineage Viz — Debug Info`);
  add(`Generated: ${new Date().toISOString()}`);

  // ── ENVIRONMENT ──
  add('');
  add('ENVIRONMENT');
  add(`  Extension:    ${version} (built ${buildStamp})`);
  add(`  VS Code:      ${vscode.version}`);
  add(`  OS:           ${process.platform} ${process.arch} (${os.release()})`);
  add(`  Node:         ${process.version}`);

  // ── DATA SOURCE ──
  add('');
  add('DATA SOURCE');
  const sess = getSession();
  if (!sess.model) {
    add('  Model loaded: No');
  } else {
    add('  Model loaded: Yes');
    add(`  Project:      ${sess.projectName ?? 'N/A'}`);

    // Resolve connection type from project store
    let sourceLabel = 'N/A';
    if (sess.currentProjectId) {
      const store = loadProjectStore(context);
      const project = store.projects.find(p => p.id === sess.currentProjectId);
      if (project) {
        if (project.connection.type === 'dacpac') {
          sourceLabel = `dacpac (${path.basename(project.connection.path)})`;
        } else {
          const ci = project.connection.connectionInfo;
          sourceLabel = `database (${ci.server} / ${ci.database})`;
        }
      }
    }
    add(`  Source:       ${sourceLabel}`);
    add(`  Platform:     ${sess.model.dbPlatform ?? 'N/A'}`);
    add(`  Parse rules:  ${lastRulesLabel}`);
  }

  // ── MODEL ──
  if (sess.model) {
    const model = sess.model;
    const totalNodes = model.nodes.length;
    const totalEdges = model.edges.length;
    const bodyEdges = model.edges.filter(e => e.type === 'body').length;
    const execEdges = model.edges.filter(e => e.type === 'exec').length;

    // Root/leaf from graphology graph
    let rootNodes = 0;
    let leafNodes = 0;
    if (sess.graph) {
      sess.graph.forEachNode((node) => {
        if (sess.graph!.inDegree(node) === 0) rootNodes++;
        if (sess.graph!.outDegree(node) === 0) leafNodes++;
      });
    }

    const cfg = vscode.workspace.getConfiguration('dataLineageViz');
    const renderLimit = cfg.get<number>('renderLimit', DEFAULT_CONFIG.renderLimit);
    const filteredOut = totalNodes - _lastFilteredCount;
    const renderStatus = _lastRenderLimitHit > 0
      ? `HIT (${_lastFilteredCount} filtered, limit ${renderLimit})`
      : _lastFilteredCount > 0
        ? `not hit (${_lastFilteredCount}/${renderLimit})`
        : `N/A`;

    add('');
    add('MODEL');
    add(`  Nodes:        ${totalNodes} total${_lastFilteredCount > 0 ? ` (rendered: ${Math.min(_lastFilteredCount, renderLimit)}, filtered out: ${filteredOut})` : ''}`);
    add(`  Edges:        ${totalEdges} (body: ${bodyEdges}, exec: ${execEdges})`);
    add(`  Schemas:      ${model.schemas.length}`);

    // Per-schema breakdown sorted by node count descending
    const sorted = [...model.schemas].sort((a, b) => b.nodeCount - a.nodeCount);
    for (const s of sorted) {
      const t = s.types;
      const parts = [`T:${t.table}`, `V:${t.view}`, `P:${t.procedure}`, `F:${t.function}`];
      if (t.external) parts.push(`E:${t.external}`);
      add(`    ${s.name.padEnd(20)} ${String(s.nodeCount).padStart(4)} nodes (${parts.join(' ')})`);
    }

    add(`  Root nodes:   ${rootNodes} (in-degree 0)`);
    add(`  Leaf nodes:   ${leafNodes} (out-degree 0)`);
    add(`  Render limit: ${renderStatus}`);

    const cs = sess.columnStore.size;
    add(`  Column store: ${cs.objects} objects, ${cs.totalColumns} columns, ${cs.ddlCount} DDL entries`);

    // ── PARSE STATS ──
    if (model.parseStats) {
      const ps = model.parseStats;
      const resolveRate = ps.parsedRefs > 0 ? ((ps.resolvedEdges / ps.parsedRefs) * 100).toFixed(1) : '0.0';
      add('');
      add('PARSE STATS');
      add(`  Refs found:   ${ps.parsedRefs}`);
      add(`  Resolved:     ${ps.resolvedEdges} (${resolveRate}%)`);
      add(`  Dropped:      ${ps.droppedRefs.length}`);
      if (ps.droppedRefs.length > 0) {
        add(`  Top dropped:  ${ps.droppedRefs.slice(0, 5).join(', ')}`);
      }
    }

    // ── MODEL WARNINGS ──
    if (model.warnings && model.warnings.length > 0) {
      add('');
      add('MODEL WARNINGS');
      for (const w of model.warnings.slice(0, 5)) {
        add(`  - ${w}`);
      }
      if (model.warnings.length > 5) {
        add(`  ... and ${model.warnings.length - 5} more`);
      }
    }
  }

  // ── ACTIVE FILTERS ──
  add('');
  add('ACTIVE FILTERS');
  if (!sess.filter) {
    add('  (no active filter)');
  } else {
    const f = sess.filter;
    const totalSchemas = sess.model?.schemas.length ?? 0;
    add(`  Schemas:      ${f.schemas.length > 0 ? f.schemas.join(', ') : '(all)'}${totalSchemas > 0 ? ` (${f.schemas.length} of ${totalSchemas})` : ''}`);
    add(`  Types:        ${f.types.length > 0 ? f.types.join(', ') : '(all)'}`);
    add(`  Hide isolated: ${f.hideIsolated ? 'Yes' : 'No'}`);
    add(`  Focus schemas: ${f.focusSchemas.length > 0 ? f.focusSchemas.join(', ') : '(none)'}`);
    add(`  External refs: ${f.showExternalRefs ? `Yes (${f.externalRefTypes.join(', ')})` : 'No'}`);
    add(`  Exclusions:   ${f.exclusionPatterns?.length ?? 0} patterns`);
    add(`  Search term:  ${f.searchTerm ? 'Yes' : '(none)'}`);
    add(`  Allowlist:    ${f.allowlistNodeIds?.length ? `${f.allowlistNodeIds.length} nodes` : '(none)'}`);
  }
  add(`  Overview mode: ${_lastOverviewMode ?? 'unknown'}`);

  // ── CONFIGURATION ──
  // ... (unchanged)

  // ── AI STATE ──
  if (sess.modelName || sess.stateMachine) {
    add('');
    add('AI STATE');
    add(`  Copilot model:   ${sess.modelName || 'N/A'}`);
    add(`  Max input tokens: ${sess.maxInputTokens}`);
    add(`  Session ID:      ${sess.id}`);
    const sm = sess.stateMachine;
    if (sm instanceof ColumnTraceState) {
      add(`  Active SM:       column_trace (${sm.status})`);
    } else if (sm instanceof BlackboardState) {
      add(`  Active SM:       blackboard (${sm.status})`);
    } else {
      add(`  Active SM:       none`);
    }
  }

  // ── RELATED EXTENSIONS ──
  add('');
  add('RELATED EXTENSIONS');
  const extVersion = (id: string) => vscode.extensions.getExtension(id)?.packageJSON?.version ?? 'not installed';
  add(`  mssql:         ${extVersion('ms-mssql.mssql')}`);
  add(`  Copilot:       ${extVersion('github.copilot')}`);
  add(`  Copilot Chat:  ${extVersion('github.copilot-chat')}`);

  // Wrap in markdown details + code fence
  const body = lines.join('\n');
  return `<details>\n<summary>Data Lineage Viz — Debug Info (v${version})</summary>\n\n\`\`\`text\n${body}\n\`\`\`\n\n</details>`;
}

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
  renderLimit: number;
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

  const maxNodes = clamp(cfg.get<number>('maxNodes', DEFAULT_CONFIG.maxNodes), 10, 10000, DEFAULT_CONFIG.maxNodes);

  const config: ExtensionConfigMessage = {
    excludePatterns: cfg.get<string[]>('excludePatterns', []).filter(p => {
      try { new RegExp(p); return true; } catch {
        logWarn(outputChannel, 'Config', `Invalid excludePattern "${p}" — not a valid regex. Pattern removed.`);
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
    renderLimit: clamp(cfg.get<number>('renderLimit', DEFAULT_CONFIG.renderLimit), 100, 5000, DEFAULT_CONFIG.renderLimit),
  };

  // Load YAML parse rules — custom file if configured, otherwise built-in defaults.
  // Single source of truth: assets/defaultParseRules.yaml (same pattern as DMV queries).
  const rulesPath = cfg.get<string>('parseRulesFile', '');
  if (!rulesPath) {
    try {
      config.parseRules = await loadBuiltInParseRules();
      lastRulesLabel = 'built-in rules';
      logDebug(outputChannel, 'Config', `Built-in YAML loaded (${(config.parseRules as Record<string, unknown[]>).rules.length} rules)`);
    } catch (err) {
      logError(outputChannel, 'Config', 'Load built-in rules', err);
      vscode.window.showWarningMessage('Failed to load parse rules — regex-based edge detection disabled. Check Output channel.');
    }
  } else {
    const resolved = resolveWorkspacePath(rulesPath);
    if (!resolved) {
      logWarn(outputChannel, 'Config', `Cannot resolve "${rulesPath}" — no workspace folder open`);
      vscode.window.showWarningMessage(
        `Parse rules: cannot resolve "${rulesPath}" — open a workspace folder or use an absolute path.`
      );
      config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        logError(outputChannel, 'Config', 'Built-in fallback', fallbackErr);
        return undefined;
      });
    } else {
      try {
        const fileUri = vscode.Uri.file(resolved);
        const data = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder().decode(data);
        const parsed = yaml.load(content) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
          logWarn(outputChannel, 'Config', `Invalid YAML in ${rulesPath} — missing "rules" array`);
          vscode.window.showWarningMessage(
            `Parse rules YAML invalid: missing "rules" array. Using built-in defaults.`
          );
          config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        logError(outputChannel, 'Config', 'Built-in fallback', fallbackErr);
        return undefined;
      });
        } else {
          config.parseRules = parsed;
          lastRulesLabel = `${parsed.rules.length} rules from ${path.basename(rulesPath)}`;
          logDebug(outputChannel, 'Config', `Read ${parsed.rules.length} rules from ${rulesPath}`);
          await persistAbsolutePath('parseRulesFile', rulesPath, resolved);
        }
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
          logWarn(outputChannel, 'Config', `File not found: ${rulesPath} — using built-in defaults`);
          vscode.window.showWarningMessage(
            `Parse rules file not found: ${rulesPath}. Using built-in defaults.`
          );
        } else {
          vscode.window.showWarningMessage(
            `Failed to load parse rules: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        config.parseRules = await loadBuiltInParseRules().catch(fallbackErr => {
        logError(outputChannel, 'Config', 'Built-in fallback', fallbackErr);
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
    logDebug(outputChannel, 'Stats', `Profiling [${schema}].[${objectName}] (mode=${mode}, timeout=${queryTimeout / 1000}s, cols=${cols.length})`);

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
    logDebug(outputChannel, 'Stats', `Getting server info (timeout=${queryTimeout / 1000}s)...`);
    const serverInfo = await withTimeout(getServerInfo(connectionUri, outputChannel), queryTimeout);
    const engineEdition = serverInfo.engineEditionId;
    logDebug(outputChannel, 'Stats', `Platform: engineEditionId=${engineEdition}, server=${serverInfo.serverVersion}`);

    // Row count from DMV
    const rowCountSql = buildRowCountQuery(schema, objectName);
    logTrace(outputChannel, 'Stats', `Row count query:\n${rowCountSql}`);
    const rowCountResult = await withTimeout(executeSimpleQuery(connectionUri, rowCountSql, outputChannel), queryTimeout);
    const rowCount = rowCountResult.rowCount > 0 ? parseInt(rowCountResult.rows[0][0].displayValue, 10) || 0 : 0;
    logDebug(outputChannel, 'Stats', `Row count: ${rowCount.toLocaleString()}`);

    // Build and run profiling query
    const aggregations = buildColumnAggregations(cols, useApprox, mode, maxColumns);
    const profilingSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, rowCount, sampleThreshold, sampleSize);

    if (!profilingSql) {
      panel.webview.postMessage({ type: 'table-stats-error', message: 'No profilable columns found.' });
      return;
    }

    logTrace(outputChannel, 'Stats', `Profiling query (${mode}):\n${profilingSql}`);
    const start = Date.now();

    let profilingResult: SimpleExecuteResult;
    try {
      profilingResult = await withTimeout(executeSimpleQuery(connectionUri, profilingSql, outputChannel), queryTimeout);
    } catch (err) {
      // Retry without sampling on TABLESAMPLE failure (e.g., Fabric DWH)
      if (String(err).includes('TABLESAMPLE') && engineEdition !== ENGINE_EDITION_FABRIC) {
        logWarn(outputChannel, 'Stats', 'TABLESAMPLE failed, retrying without sampling...');
        const fallbackSql = buildProfilingQuery(schema, objectName, aggregations, engineEdition, 0, sampleThreshold, sampleSize);
        profilingResult = await withTimeout(executeSimpleQuery(connectionUri, fallbackSql, outputChannel), queryTimeout);
      } else {
        throw err;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logInfo(outputChannel, 'Stats', `Table statistics ready (${elapsed}s)`);

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
      for (const w of stats.warnings) logWarn(outputChannel, 'Stats', `Parse warning: ${w}`);
    }
    panel.webview.postMessage({ type: 'table-stats-result', stats, mode });

    // Connection stays alive — not disconnected here

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(outputChannel, 'Stats', 'Profiling', err);
    // Invalidate stale connection on error
    if (statsConnectionUri) {
      disconnectDatabase(statsConnectionUri, outputChannel).catch(err => {
        logDebug(outputChannel, 'DB', `Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
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
  logInfo(outputChannel, 'DB', `Connecting to ${sourceName}...`);

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
      logDebug(outputChannel, 'DB', `Full catalog: ${allObjectsResult.rowCount} objects loaded for cross-schema resolution`);
    } else {
      logWarn(outputChannel, 'DB', 'all-objects query returned no result — cross-schema resolution disabled');
    }
  } else {
    logWarn(outputChannel, 'DB', 'No all-objects query found in YAML — cross-schema resolution disabled');
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
  logInfo(outputChannel, 'DB', `Found ${preview.totalObjects} objects across ${preview.schemas.length} schemas${etPreviewTotal > 0 ? ` (${etPreviewTotal} external)` : ''}`);
  if (etPreviewTotal > 0) {
    for (const s of preview.schemas.filter(s => s.types.external > 0)) {
      logDebug(outputChannel, 'DB', `Schema '${s.name}': ${s.types.external} external table(s) detected`);
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
  logInfo(outputChannel, 'DB', `Loading ${schemas.length} schema(s): ${schemas.join(', ')}`);
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
  logDebug(outputChannel, 'DB', 'Building model from DMV results...');
  const start = Date.now();
  const preConfig = await readExtensionConfig();
  if (preConfig.parseRules) handleParseRulesResult(loadRules(preConfig.parseRules as ParseRulesConfig));
  const model = buildModelFromDmv(dmvResults, currentDatabase, preConfig.externalRefs.enabled, preConfig.maxNodes);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const extNodes = model.nodes.filter(n => n.type === 'external');
  const extSuffix = extNodes.length > 0 ? `, incl. ${extNodes.length} external (⬡)` : '';
  logInfo(outputChannel, 'DB', `Model ready — ${model.nodes.length} objects${extSuffix}, ${model.edges.length} relationships, ${model.schemas.length} schemas (${elapsed}s)`);
  if (extNodes.length > 0) {
    logDebug(outputChannel, 'DB', `External nodes: ${extNodes.map(n => n.fullName).join(', ')}`);
  }

  if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
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
    logInfo(outputChannel, 'Dacpac', 'Opening AdventureWorks (Demo)');
    if (config.parseRules) handleParseRulesResult(loadRules(config.parseRules as ParseRulesConfig));
    const model = await extractDacpac(data.buffer as ArrayBuffer);
    onModelBuilt?.(model);
    if (model.parseStats) handleParseStats(model.parseStats, model.nodes.length, model.edges.length, model.schemas.length);
    panel.webview.postMessage({ type: 'dacpac-model', model, config, sourceName: 'AdventureWorks (Demo)', autoVisualize: true });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError(outputChannel, 'Dacpac', 'Load demo', err);
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
    logDebug(outputChannel, 'Config', err);
  }

  const breakdown = formatCategoryCounts(message.categoryCounts);

  // Summary at info level + VS Code notification for problems
  if (message.usedDefaults) {
    logWarn(outputChannel, 'Config', 'YAML invalid — using built-in defaults');
    vscode.window.showWarningMessage(
      'Parse rules YAML invalid — using built-in defaults. Check Output channel for details.'
    );
  } else if (message.skipped.length > 0) {
    logWarn(outputChannel, 'Config', `${message.loaded} loaded${breakdown}, ${message.skipped.length} skipped: ${message.skipped.join(', ')}`);
    vscode.window.showWarningMessage(
      `Parse rules: ${message.loaded} loaded, ${message.skipped.length} skipped (${message.skipped.join(', ')}). Check Output channel for details.`
    );
  } else {
    logInfo(outputChannel, 'Config', `${lastRulesLabel || `${message.loaded} rules`} loaded${breakdown}`);
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
    logDebug(outputChannel, 'Parse', `Starting — ${spCount} object(s) with ${lastRulesLabel}`);
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
    logDebug(outputChannel, 'Parse', `${sp.name} — ${parts.join(' | ')}`);
  }
  const distinctDropped = new Set(stats.droppedRefs.map(r => r.split(' → ')[1] ?? '')).size;

  if (spCount > 0) {
    logDebug(outputChannel, 'Parse', `Done — ${stats.resolvedEdges} resolved, ${stats.droppedRefs.length} dropped (${distinctDropped} distinct unrelated)`);
  }

  // Warn: procedures with no inputs and no outputs AND no unresolved catalog refs.
  // Exclude entries that have body refs but they were all skipped (e.g. XML method calls for views).
  // Exclude SPs that do have body refs but they fall outside the selected schemas.
  const empty = spDetails.filter(sp =>
    sp.inCount === 0 && sp.outCount === 0 && sp.unrelated.length === 0 &&
    !(sp.skippedRefs && sp.skippedRefs.length > 0)
  );
  if (empty.length > 0) {
    logWarn(outputChannel, 'Parse', `${empty.length} procedure(s) with no dependencies found: ${empty.map(sp => sp.name).join(', ')}`);
  }

  // Info level: canonical summary (last line — contains everything the user needs)
  if (objectCount !== undefined && objectCount > 0) {
    logInfo(outputChannel, 'Parse', `${objectCount} objects, ${edgeCount} edges, ${schemaCount} schemas — ${lastRulesLabel}, ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved, ${distinctDropped} distinct unrelated refs dropped`);
  } else if (objectCount === undefined) {
    logInfo(outputChannel, 'Parse', `${lastRulesLabel}, ${spCount} objects parsed, ${stats.resolvedEdges} refs resolved, ${distinctDropped} distinct unrelated refs removed`);
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
          logDebug(outputChannel, 'DB', `Disconnect cleanup: ${err instanceof Error ? err.message : err}`);
        });
    statsConnectionUri = undefined;
  }
}
