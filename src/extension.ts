import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getUri } from './utils/getUri';
import { getNonce } from './utils/getNonce';

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
          `${label} changed. Re-import your dacpac to apply.`,
          'Open Dacpac'
        );
        if (action === 'Open Dacpac') {
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

  // Register Quick Actions TreeView
  const quickActionsProvider = new QuickActionsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', quickActionsProvider)
  );
  
  // Command: Open (shows wizard with file picker + demo option)
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.open', () => {
      openPanel(context, 'Data Lineage Viz');
    })
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
      const defaultYaml = getDefaultParseRulesYaml();
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(targetUri, encoder.encode(defaultYaml));

      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        'Created parseRules.yaml in workspace root. Set "dataLineageViz.parseRulesFile" to "parseRules.yaml" to use it.'
      );
    })
  );
}

// ─── Open Panel ─────────────────────────────────────────────────────────────

function openPanel(context: vscode.ExtensionContext, title: string) {
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
    panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);

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
            const config = await readExtensionConfig();
            const lastDacpacName = context.workspaceState.get<string>('lastDacpacName');
            panel.webview.postMessage({ type: 'config-only', config, lastDacpacName });
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
                if (data.byteLength > MAX_DACPAC_BYTES) {
                  vscode.window.showErrorMessage(`Dacpac file too large (${(data.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 50 MB.`);
                  break;
                }
                await context.workspaceState.update('lastDacpacPath', fileUri.fsPath);
                await context.workspaceState.update('lastDacpacName', fileName);
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
                outputChannel.error(`Failed to read dacpac: ${errorMsg}`);
                vscode.window.showErrorMessage(`Failed to read dacpac: ${errorMsg}`);
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
              if (data.byteLength > MAX_DACPAC_BYTES) {
                vscode.window.showErrorMessage(`Dacpac file too large (${(data.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 50 MB.`);
                break;
              }
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
              panel.webview.postMessage({ type: 'last-dacpac-gone' });
              outputChannel.warn(`Last dacpac no longer available: ${lastPath}`);
            }
            break;
          }
          case 'load-demo': {
            const config = await readExtensionConfig();
            try {
              const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
              const data = await vscode.workspace.fs.readFile(demoUri);
              if (data.byteLength > MAX_DACPAC_BYTES) {
                vscode.window.showErrorMessage(`Dacpac file too large (${(data.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum supported size is 50 MB.`);
                break;
              }
              panel.webview.postMessage({
                type: 'dacpac-data',
                data: Array.from(data),
                fileName: 'AdventureWorks (Demo)',
                config,
              });
              outputChannel.info('── Opening AdventureWorks (Demo) ──');
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              outputChannel.error(`Failed to load demo: ${errorMsg}`);
              vscode.window.showErrorMessage(`Failed to load demo: ${errorMsg}`);
            }
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
  | { type: 'update-ddl'; objectName: string; schema: string; sqlBody?: string };

// ─── Read Extension Config ──────────────────────────────────────────────────

interface ExtensionConfigMessage {
  parseRules?: unknown;
  excludePatterns: string[];
  maxNodes: number;
  layout: { direction: string; rankSeparation: number; nodeSeparation: number; edgeAnimation: boolean; highlightAnimation: boolean; minimapEnabled: boolean };
  edgeStyle: string;
  trace: { defaultUpstreamLevels: number; defaultDownstreamLevels: number };
  analysis: { hubMinDegree: number; islandMaxSize: number; longestPathMinNodes: number };
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
      direction: cfg.get<string>('layout.direction', 'LR'),
      rankSeparation: clamp(cfg.get<number>('layout.rankSeparation', 120), 20, 300, 120),
      nodeSeparation: clamp(cfg.get<number>('layout.nodeSeparation', 30), 10, 200, 30),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', true),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation', false),
      minimapEnabled: cfg.get<boolean>('layout.minimapEnabled', true),
    },
    edgeStyle: cfg.get<string>('edgeStyle', 'default'),
    trace: {
      defaultUpstreamLevels: clamp(cfg.get<number>('trace.defaultUpstreamLevels', 3), 0, 99, 3),
      defaultDownstreamLevels: clamp(cfg.get<number>('trace.defaultDownstreamLevels', 3), 0, 99, 3),
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
    outputChannel.info('[ParseRules] Using built-in defaults (9 rules)');
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

// ─── Parse Rules Validation Feedback ─────────────────────────────────────────

function formatCategoryCounts(counts?: Record<string, number>): string {
  if (!counts || Object.keys(counts).length === 0) return '';
  const order = ['preprocessing', 'source', 'target', 'exec'];
  const parts = order.filter(c => counts[c]).map(c => `${counts[c]} ${c}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
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

function resolveWorkspacePath(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) return relativePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, relativePath);
}

// ─── Webview HTML ───────────────────────────────────────────────────────────

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
      <body class="vscode-body" data-vscode-theme-kind="${themeClass}">
        <div id="root"></div>
        <script nonce="${nonce}">
          window.LOGO_URI = "${logoUri}";
        </script>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>
  `;
}

// ─── Default Parse Rules YAML ───────────────────────────────────────────────

function getDefaultParseRulesYaml(): string {
  return `# ─── DACPAC Lineage Parser Rules ─────────────────────────────────────────────
# Regex rules for extracting SQL dependencies from stored procedure bodies.
# Covers all MS SQL family: SQL Server, Azure Synapse, Microsoft Fabric DWH.
# View and UDF dependencies come from dacpac XML — no regex parsing needed.
#
# Rules run in priority order (lowest first). Disable rules with enabled: false.
#
#   name:        Unique identifier
#   enabled:     true/false to toggle
#   priority:    Execution order (lower = earlier)
#   category:    preprocessing | source | target | exec
#   pattern:     JavaScript regex (capture group 1 = object reference)
#   flags:       Regex flags (gi = global, case-insensitive)
#   replacement: (preprocessing only) replacement string
#   description: What this rule extracts
# ─────────────────────────────────────────────────────────────────────────────

rules:
  # ── Preprocessing ──────────────────────────────────────────────────────────
  # Single-pass: brackets, strings, and comments matched together, leftmost wins.
  # Built-in function replacement (brackets → keep, strings → neutralize, comments → remove).
  - name: clean_sql
    enabled: true
    priority: 1
    category: preprocessing
    pattern: "\\\\[[^\\\\]]+\\\\]|'(?:''|[^'])*'|--[^\\\\r\\\\n]*|\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/"
    flags: g
    description: "Single-pass bracket/string/comment handling (built-in)"

  # ── Source extraction ──────────────────────────────────────────────────────
  - name: extract_sources_ansi
    enabled: true
    priority: 5
    category: source
    pattern: "\\\\b(?:FROM|(?:(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER)\\\\s+(?:OUTER\\\\s+)?)?JOIN)\\\\s+((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))"
    flags: gi
    description: FROM/JOIN sources (handles 2- and 3-part names)

  - name: extract_sources_tsql_apply
    enabled: true
    priority: 7
    category: source
    pattern: "\\\\b(?:CROSS|OUTER)\\\\s+APPLY\\\\s+((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))"
    flags: gi
    description: CROSS/OUTER APPLY sources

  - name: extract_merge_using
    enabled: true
    priority: 9
    category: source
    pattern: "\\\\bMERGE\\\\b[\\\\s\\\\S]*?\\\\bUSING\\\\s+((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))"
    flags: gi
    description: MERGE ... USING source table

  - name: extract_udf_calls
    enabled: true
    priority: 10
    category: source
    pattern: "((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)+(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))\\\\s*\\\\("
    flags: gi
    description: "Inline scalar UDF calls (schema.func() — requires 2+ part name)"

  # ── Target extraction ──────────────────────────────────────────────────────
  - name: extract_targets_dml
    enabled: true
    priority: 6
    category: target
    pattern: "\\\\b(?:INSERT\\\\s+(?:INTO\\\\s+)?|UPDATE\\\\s+|MERGE\\\\s+(?:INTO\\\\s+)?)((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))"
    flags: gi
    description: INSERT/UPDATE/MERGE targets (DELETE/TRUNCATE excluded — not lineage)

  - name: extract_ctas
    enabled: true
    priority: 13
    category: target
    pattern: "\\\\bCREATE\\\\s+TABLE\\\\s+((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))\\\\s+AS\\\\s+SELECT"
    flags: gi
    description: CREATE TABLE AS SELECT target (Synapse/Fabric)

  - name: extract_select_into
    enabled: true
    priority: 14
    category: target
    pattern: "\\\\bINTO\\\\s+((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))\\\\s+FROM"
    flags: gi
    description: SELECT INTO target

  # ── Exec calls ─────────────────────────────────────────────────────────────
  - name: extract_sp_calls
    enabled: true
    priority: 8
    category: exec
    pattern: "\\\\bEXEC(?:UTE)?\\\\s+(?:@\\\\w+\\\\s*=\\\\s*)?((?:(?:\\\\[[^\\\\]]+\\\\]|\\\\w+)\\\\.)*(?:\\\\[[^\\\\]]+\\\\]|\\\\w+))"
    flags: gi
    description: "EXEC/EXECUTE procedure calls (including @var = proc pattern)"

# ─── Skip Patterns ──────────────────────────────────────────────────────────
# Object names matching these prefixes are ignored (system objects, temp tables)
skip_prefixes:
  - "#"
  - "@"
  - "sys."
  - "sp_"
  - "xp_"
  - "fn_"
  - "information_schema."
  - "master."
  - "msdb."
  - "tempdb."
  - "model."

# Keywords that look like identifiers but aren't
skip_keywords:
  - set
  - declare
  - print
  - return
  - begin
  - end
  - if
  - else
  - while
  - break
  - continue
  - goto
  - try
  - catch
  - throw
  - raiserror
  - waitfor
  - as
  - "is"
  - "null"
  - not
  - and
  - or
  - select
  - where
  - group
  - order
  - having
  - top
  - distinct
  - table
  - index
  - view
  - procedure
  - function
  - trigger
  - values
  - output
  - with
  - nolock
  - "on"
`;
}

// ─── Quick Actions TreeView Provider ─────────────────────────────────────────

class QuickActionsProvider implements vscode.TreeDataProvider<QuickAction> {
  getTreeItem(element: QuickAction): vscode.TreeItem {
    return element;
  }

  getChildren(): QuickAction[] {
    return [
      new QuickAction(
        'Open',
        'dataLineageViz.open',
        new vscode.ThemeIcon('graph')
      ),
    ];
  }
}

class QuickAction extends vscode.TreeItem {
  constructor(
    label: string,
    commandId: string,
    iconPath?: vscode.ThemeIcon
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: commandId,
      title: label,
    };
    this.iconPath = iconPath;
  }
}

export function deactivate() {
  ddlContentMap.clear();
}
