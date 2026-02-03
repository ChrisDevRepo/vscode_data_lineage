import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getUri } from './utilities/getUri';
import { getNonce } from './utilities/getNonce';

// ─── Logging ────────────────────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel;
type LogLevel = 'info' | 'debug';
let currentLogLevel: LogLevel = 'info';

function log(message: string, level: LogLevel = 'info') {
  if (level === 'debug' && currentLogLevel !== 'debug') return;
  const timestamp = new Date().toISOString();
  outputChannel?.appendLine(`[${timestamp}] ${message}`);
  // Auto-show the output channel for errors
  if (level === 'info' && message.includes('Error]')) {
    outputChannel?.show(true); // true = preserveFocus
  }
}

function refreshLogLevel() {
  currentLogLevel = vscode.workspace.getConfiguration('dataLineageViz').get<LogLevel>('logLevel', 'info');
}

// ─── DDL Virtual Document Provider ──────────────────────────────────────────

const DDL_SCHEME = 'dacpac-ddl';
const DDL_URI = vscode.Uri.parse(`${DDL_SCHEME}:DDL`);
let currentDdlContent = '';
let ddlOpened = false;


const ddlProvider = new class implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this._onDidChange.event;
  provideTextDocumentContent(): string { return currentDdlContent; }
  update() { this._onDidChange.fire(DDL_URI); }
};

function formatDdlContent(message: { objectName: string; schema: string; sqlBody?: string }): string {
  const { objectName, schema, sqlBody } = message;
  return sqlBody || `-- No DDL available for [${schema}].[${objectName}]`;
}

async function showDdl(message: { objectName: string; schema: string; sqlBody?: string }) {
  currentDdlContent = formatDdlContent(message);

  // If DDL editor is already visible, just refresh content in-place
  const existingDdlEditor = vscode.window.visibleTextEditors.find(
    e => e.document.uri.scheme === DDL_SCHEME
  );
  if (existingDdlEditor) {
    ddlProvider.update();
    return;
  }

  const doc = await vscode.workspace.openTextDocument(DDL_URI);
  if (doc.languageId !== 'dacpac-sql') {
    await vscode.languages.setTextDocumentLanguage(doc, 'dacpac-sql');
  }
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: true,
  });
  ddlOpened = true;
}

function updateDdlIfOpen(message: { objectName: string; schema: string; sqlBody?: string }) {
  // Always update content — the TextDocumentContentProvider works regardless of
  // which window the editor is in (visibleTextEditors misses secondary windows)
  if (!ddlOpened) return;
  currentDdlContent = formatDdlContent(message);
  ddlProvider.update();
}

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz');
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DDL_SCHEME, ddlProvider)
  );

  // Reset ddlOpened when the DDL document is closed
  // Note: onDidCloseTextDocument is somewhat unreliable for virtual docs, but
  // we can't use onDidChangeVisibleTextEditors because it misses secondary windows
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === DDL_SCHEME) {
        ddlOpened = false;
      }
    })
  );

  refreshLogLevel();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dataLineageViz.logLevel')) refreshLogLevel();
    })
  );
  log('[Extension] Activated');

  // Register Quick Actions TreeView
  const quickActionsProvider = new QuickActionsProvider();
  vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', quickActionsProvider);
  
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

    panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);

    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme((theme) => {
      const themeClass =
        theme.kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' :
        theme.kind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' :
        theme.kind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' :
        'vscode-light';
      panel.webview.postMessage({ type: 'themeChanged', kind: themeClass });
    });

    panel.onDidDispose(() => {
      themeChangeListener.dispose();
    });

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === 'ready') {
          const config = readExtensionConfig();
          panel.webview.postMessage({ type: 'config-only', config });
        }
        if (message.type === 'load-demo') {
          const config = readExtensionConfig();
          try {
            const demoUri = vscode.Uri.joinPath(context.extensionUri, 'assets', 'demo.dacpac');
            const data = await vscode.workspace.fs.readFile(demoUri);
            panel.webview.postMessage({
              type: 'dacpac-data',
              data: Array.from(data),
              fileName: 'AdventureWorks (Demo)',
              config,
            });
            log('[Extension] Demo dacpac loaded');
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log(`[Extension Error] Failed to load demo: ${errorMsg}`);
            vscode.window.showErrorMessage(`Failed to load demo: ${errorMsg}`);
          }
        }
        if (message.type === 'parse-rules-warning') {
          handleParseRulesWarning(message);
        }
        if (message.type === 'parse-stats') {
          handleParseStats(message.stats);
        }
        if (message.type === 'log') {
          log(`[Webview] ${message.text}`);
        }
        if (message.type === 'error') {
          log(`[Webview Error] ${message.error}`);
          if (message.stack) log(`[Webview Error Stack] ${message.stack}`, 'debug');
          vscode.window.showErrorMessage(`Data Lineage Error: ${message.error}`);
        }
        if (message.type === 'go-to-source') {
          try {
            const objectName = String(message.objectName).replace(/[^\w]/g, '');
            const schema = String(message.schema).replace(/[^\w]/g, '');
            if (objectName && schema) {
              log(`[Extension] Opening source file: ${schema}.${objectName}`);
              await openSourceFile(objectName, schema);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log(`[Extension Error] Failed to open source file: ${errorMsg}`);
            vscode.window.showErrorMessage(`Failed to open source file: ${errorMsg}`);
          }
        }
        if (message.type === 'open-external') {
          if (message.url) {
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
        }
        if (message.type === 'open-settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz');
        }
        if (message.type === 'show-ddl') {
          await showDdl(message);
        }
        if (message.type === 'update-ddl') {
          updateDdlIfOpen(message);
        }
      },
      undefined,
      context.subscriptions
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`[Extension Error] ${errorMsg}`);
    vscode.window.showErrorMessage(`Failed to open Data Lineage: ${errorMsg}`);
  }
}

// ─── Read Extension Config ──────────────────────────────────────────────────

interface ExtensionConfigMessage {
  parseRules?: unknown;
  excludePatterns: string[];
  maxNodes: number;
  layout: { direction: string; rankSeparation: number; nodeSeparation: number; edgeAnimation: boolean; highlightAnimation: boolean };
  edgeStyle: string;
  trace: { defaultUpstreamLevels: number; defaultDownstreamLevels: number };
}

function readExtensionConfig(): ExtensionConfigMessage {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');

  const config: ExtensionConfigMessage = {
    excludePatterns: cfg.get<string[]>('excludePatterns', []),
    maxNodes: cfg.get<number>('maxNodes', 250),
    layout: {
      direction: cfg.get<string>('layout.direction', 'LR'),
      rankSeparation: cfg.get<number>('layout.rankSeparation', 120),
      nodeSeparation: cfg.get<number>('layout.nodeSeparation', 30),
      edgeAnimation: cfg.get<boolean>('layout.edgeAnimation', true),
      highlightAnimation: cfg.get<boolean>('layout.highlightAnimation', false),
    },
    edgeStyle: cfg.get<string>('edgeStyle', 'default'),
    trace: {
      defaultUpstreamLevels: cfg.get<number>('trace.defaultUpstreamLevels', 3),
      defaultDownstreamLevels: cfg.get<number>('trace.defaultDownstreamLevels', 3),
    },
  };

  // Load YAML parse rules if configured
  const rulesPath = cfg.get<string>('parseRulesFile', '');
  if (rulesPath) {
    const resolved = resolveWorkspacePath(rulesPath);
    if (resolved) {
      try {
        const fs = require('fs');
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, 'utf8');
          const parsed = yaml.load(content) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
            log(`[ParseRules] Invalid YAML structure in ${rulesPath} — missing "rules" array`);
            vscode.window.showWarningMessage(
              `Parse rules YAML invalid: missing "rules" array. Using built-in defaults.`
            );
          } else {
            config.parseRules = parsed;
            log(`[ParseRules] Loaded ${parsed.rules.length} rules from ${rulesPath}`, 'debug');
          }
        } else {
          vscode.window.showWarningMessage(
            `Parse rules file not found: ${rulesPath}. Using built-in defaults.`
          );
        }
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to load parse rules: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return config;
}

// ─── Parse Rules Validation Feedback ─────────────────────────────────────────

function handleParseRulesWarning(message: {
  loaded: number;
  skipped: string[];
  errors: string[];
  usedDefaults: boolean;
}) {
  // Detail per-rule errors at debug level
  for (const err of message.errors) {
    log(`[ParseRules] ${err}`, 'debug');
  }

  // Summary at info level + VS Code notification
  if (message.usedDefaults) {
    log(`[ParseRules] YAML invalid — using built-in defaults`);
    vscode.window.showWarningMessage(
      `Parse rules YAML invalid — using built-in defaults. Set logLevel to "debug" for details.`
    );
  } else if (message.skipped.length > 0) {
    log(`[ParseRules] ${message.loaded} loaded, ${message.skipped.length} skipped: ${message.skipped.join(', ')}`);
    vscode.window.showWarningMessage(
      `Parse rules: ${message.loaded} loaded, ${message.skipped.length} skipped (${message.skipped.join(', ')}). Set logLevel to "debug" for details.`
    );
  } else {
    log(`[ParseRules] Custom rules loaded: ${message.loaded} rules`);
  }
}

function handleParseStats(stats: {
  parsedRefs: number;
  resolvedEdges: number;
  droppedRefs: string[];
  spDetails?: { name: string; inCount: number; outCount: number; unrelated: string[] }[];
}) {
  const spDetails = stats.spDetails || [];
  const spCount = spDetails.length;

  // Info level: summary only
  log(`[Parse] ${spCount} procedures parsed, ${stats.resolvedEdges} refs resolved, ${stats.droppedRefs.length} unrelated refs removed`);

  // Debug level: one line per SP with details
  for (const sp of spDetails) {
    const parts = [`In: ${sp.inCount}`, `Out: ${sp.outCount}`];
    if (sp.unrelated.length > 0) {
      parts.push(`Unrelated: ${sp.unrelated.join(', ')}`);
    }
    log(`[Parse] ${sp.name} — ${parts.join(', ')}`, 'debug');
  }

  // Warn: SPs with no inputs and no outputs
  const empty = spDetails.filter(sp => sp.inCount === 0 && sp.outCount === 0);
  if (empty.length > 0) {
    log(`[Parse] Warning: ${empty.length} procedure(s) with no dependencies found: ${empty.map(sp => sp.name).join(', ')}`);
  }
}

function resolveWorkspacePath(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) return relativePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, relativePath);
}

// ─── Go to Source ───────────────────────────────────────────────────────────

async function openSourceFile(objectName: string, schema: string) {
  const patterns = [
    `**/${schema}/**/${objectName}.sql`,
    `**/${objectName}.sql`,
    `**/${schema}.${objectName}.sql`,
  ];

  for (const pattern of patterns) {
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);
    if (files.length > 0) {
      const uri = files.length === 1
        ? files[0]
        : (await pickFile(files)) || files[0];

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      return;
    }
  }

  vscode.window.showWarningMessage(
    `Could not find source file for ${schema}.${objectName}. Ensure the SQL project is open in the workspace.`
  );
}

async function pickFile(files: vscode.Uri[]): Promise<vscode.Uri | undefined> {
  const items = files.map((uri) => ({
    label: path.basename(uri.fsPath),
    description: vscode.workspace.asRelativePath(uri),
    uri,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Multiple matches — select the correct file',
  });
  return picked?.uri;
}


// ─── Webview HTML ───────────────────────────────────────────────────────────

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  // Get URIs for the CSS and JS files from the React build output
  const stylesUri = getUri(webview, extensionUri, ["dist", "assets", "index.css"]);
  const scriptUri = getUri(webview, extensionUri, ["dist", "assets", "index.js"]);
  const logoUri = getUri(webview, extensionUri, ["images", "logo.png"]);

  const nonce = getNonce();

  // Get current theme kind for proper styling
  const themeKind = vscode.window.activeColorTheme.kind;
  const themeClass = 
    themeKind === vscode.ColorThemeKind.Dark ? 'vscode-dark' :
    themeKind === vscode.ColorThemeKind.HighContrast ? 'vscode-high-contrast' :
    themeKind === vscode.ColorThemeKind.HighContrastLight ? 'vscode-high-contrast-light' :
    'vscode-light';

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
        <script nonce="${nonce}">
          // Listen for theme changes from VS Code
          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'themeChanged') {
              document.body.setAttribute('data-vscode-theme-kind', message.kind);
            }
          });
        </script>
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
  - name: remove_comments
    enabled: true
    priority: 1
    category: preprocessing
    pattern: "--[^\\\\r\\\\n]*|\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/"
    flags: gi
    replacement: " "
    description: Remove SQL line and block comments

  - name: remove_string_literals
    enabled: true
    priority: 2
    category: preprocessing
    pattern: "'(?:''|[^'])*'"
    flags: g
    replacement: "''"
    description: Neutralize string literals to prevent false-positive refs

  # ── Source extraction ──────────────────────────────────────────────────────
  - name: extract_sources_ansi
    enabled: true
    priority: 5
    category: source
    pattern: "\\\\b(?:FROM|(?:(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER)\\\\s+(?:OUTER\\\\s+)?)?JOIN)\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)"
    flags: gi
    description: FROM/JOIN sources (handles 2- and 3-part names)

  - name: extract_sources_tsql_apply
    enabled: true
    priority: 7
    category: source
    pattern: "\\\\b(?:CROSS|OUTER)\\\\s+APPLY\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)"
    flags: gi
    description: CROSS/OUTER APPLY sources

  - name: extract_merge_using
    enabled: true
    priority: 9
    category: source
    pattern: "\\\\bMERGE\\\\b[\\\\s\\\\S]*?\\\\bUSING\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)"
    flags: gi
    description: MERGE ... USING source table

  # ── Target extraction ──────────────────────────────────────────────────────
  - name: extract_targets_dml
    enabled: true
    priority: 6
    category: target
    pattern: "\\\\b(?:INSERT\\\\s+(?:INTO\\\\s+)?|UPDATE\\\\s+|MERGE\\\\s+(?:INTO\\\\s+)?|DELETE\\\\s+(?:FROM\\\\s+)?)((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)"
    flags: gi
    description: INSERT/UPDATE/MERGE/DELETE targets

  - name: extract_ctas
    enabled: true
    priority: 13
    category: target
    pattern: "\\\\bCREATE\\\\s+TABLE\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)\\\\s+AS\\\\s+SELECT"
    flags: gi
    description: CREATE TABLE AS SELECT target (Synapse/Fabric)

  - name: extract_select_into
    enabled: true
    priority: 14
    category: target
    pattern: "\\\\bINTO\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)\\\\s+FROM"
    flags: gi
    description: SELECT INTO target

  # ── Exec calls ─────────────────────────────────────────────────────────────
  - name: extract_sp_calls
    enabled: true
    priority: 8
    category: exec
    pattern: "\\\\bEXEC(?:UTE)?\\\\s+((?:\\\\[?\\\\w+\\\\]?\\\\.)*\\\\[?\\\\w+\\\\]?)"
    flags: gi
    description: EXEC/EXECUTE procedure calls

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
    public readonly label: string,
    public readonly command: string,
    public readonly iconPath?: vscode.ThemeIcon
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: command,
      title: label,
    };
    this.iconPath = iconPath;
  }
}

export function deactivate() {}
