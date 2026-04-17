import * as vscode from 'vscode';
import * as path from 'path';
import { type AiSession } from './ai/session';
import { getActivePanel } from './panelProvider';
import { Logger, trunc } from './utils/log';
import { searchCatalog, type SearchableNode } from './utils/modelSearch';

/**
 * Registers all user-facing and internal commands for the Data Lineage Viz extension.
 * 
 * This includes commands for:
 * - Opening the primary lineage panel (wizard or demo).
 * - Project management (loading, saving, deleting).
 * - Configuration scaffolding (creating YAML templates).
 * - AI integration (view creation, state dumping).
 * - UI controls (overview mode toggle, object search).
 * 
 * @param context - The extension context.
 * @param getSession - Factory to retrieve the active AI session.
 * @param outputChannel - Log channel for reporting command execution and errors.
 * @param openPanel - Function to open the primary lineage webview.
 * @param buildDebugDump - Function to generate diagnostic information.
 * 
 * @returns An array of disposables representing the registered commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  openPanel: (context: vscode.ExtensionContext, title: string, loadDemo?: boolean) => void,
  buildDebugDump: (context: vscode.ExtensionContext) => string
): vscode.Disposable[] {
  const configLogger = Logger.create(outputChannel, 'Config');
  const aiLogger = Logger.create(outputChannel, 'AI');

  return [
    // --- Primary Entry Points ---
    vscode.commands.registerCommand('dataLineageViz.open', () => openPanel(context, 'Data Lineage Viz')),
    vscode.commands.registerCommand('dataLineageViz.openDemo', () => openPanel(context, 'Data Lineage Viz', true)),
    
    /** 
     * Programmatic entry point for automated testing or deep-linking.
     * Loads a specific project by its ID.
     */
    vscode.commands.registerCommand('dataLineageViz.openProject', (projectId: string) => {
      openPanel(context, 'Data Lineage Viz');
      const panel = getActivePanel();
      if (panel) {
        panel.webview.postMessage({ type: 'load-project', id: projectId });
      }
    }),

    // --- Configuration & Settings ---
    vscode.commands.registerCommand('dataLineageViz.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz')
    ),

    // --- Diagnostics & Debugging ---
    vscode.commands.registerCommand('dataLineageViz.copyDebugInfo', async () => {
      try {
        const dump = buildDebugDump(context);
        await vscode.env.clipboard.writeText(dump);
        vscode.window.showInformationMessage('Data Lineage: Debug info copied to clipboard.');
      } catch (err) {
        configLogger.error('Copy debug info', err);
        vscode.window.showErrorMessage('Data Lineage: Failed to copy debug info.');
      }
    }),

    /** 
     * Dumps the current AI State Machine (SM) state to a JSON file in the workspace.
     * Used for debugging deep-trace behavior and non-deterministic AI failures.
     */
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
        const dir = vscode.Uri.joinPath(wsFolder.uri, 'test-results', 'sm-dumps');
        await vscode.workspace.fs.createDirectory(dir);
        const fileUri = vscode.Uri.joinPath(dir, `sm-${ts}.json`);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(dump, 'utf-8'));
        aiLogger.debug(`SM state dumped to ${fileUri.fsPath}`);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        aiLogger.error('Dump SM state', err);
        vscode.window.showErrorMessage('Data Lineage: Failed to dump SM state.');
      }
    }),

    // --- Configuration Scaffolding ---
    vscode.commands.registerCommand('dataLineageViz.createParseRules', () =>
      createYamlScaffold(context, 'parseRules.yaml', 'defaultParseRules.yaml', 'parseRulesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', () =>
      createYamlScaffold(context, 'dmvQueries.yaml', 'dmvQueries.yaml', 'dmvQueriesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createAiOutputTemplates', () =>
      createYamlScaffold(context, 'aiOutputTemplates.yaml', 'aiOutputTemplates.yaml', 'ai.outputTemplateFile')
    ),

    // --- AI Integration ---
    /** 
     * Internal command used by the AI to trigger view synthesis in the chat UI.
     */
    vscode.commands.registerCommand('dataLineageViz.aiCreateView', (originalPrompt: string) => {
      const viewPrompt = `Create an AI view from the trace above. Use the BFS results you already have — add badges, notes, and highlight groups. Name it based on the original question: "${trunc(originalPrompt || '', 60)}"`;
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${viewPrompt}`,
      });
    }),

    // --- UI Controls ---
    vscode.commands.registerCommand('dataLineageViz.toggleOverviewMode', () => {
      const panel = getActivePanel();
      if (!panel) {
        vscode.window.showWarningMessage('Data Lineage: Open a graph first to toggle overview mode.');
        return;
      }
      panel.webview.postMessage({ type: 'toggle-overview' });
    }),

    /** 
     * Launches a Quick Pick search interface for all SQL objects in the current model.
     */
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

    /** 
     * Command intended for testing/integration that forces a .dacpac file load into the active session.
     */
    vscode.commands.registerCommand('dataLineageViz.openExternalProject', async (uri: vscode.Uri) => {
      configLogger.info(`Forcing project load from: ${uri.fsPath}`);
      try {
        const { extractDacpac } = await import('./engine/dacpacExtractor');
        const { buildBareGraph } = await import('./ai/graphUtils');

        const buffer = await vscode.workspace.fs.readFile(uri);
        const model = await extractDacpac(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
        const sess = getSession();

        sess.model = model;
        sess.projectName = path.basename(uri.fsPath, '.dacpac');
        sess.graph = buildBareGraph(model);

        configLogger.info(`Model forced: ${model.nodes.length} nodes, ${model.edges.length} edges, project: ${sess.projectName}`);
      } catch (err) {
        configLogger.error(`openExternalProject(${uri.fsPath})`, err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Data Lineage: Failed to read file — ${msg}`);
      }
    }),
  ];
}

/**
 * Creates a YAML configuration file in the workspace root by copying a template from the extension assets.
 * 
 * @param context - The extension context.
 * @param fileName - The name of the file to create in the workspace.
 * @param sourceAsset - The name of the template file in the extension's `assets/` folder.
 * @param settingName - The name of the extension setting associated with this file.
 */
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
    // If the file already exists, just open it for the user.
    await vscode.workspace.fs.stat(targetUri);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc);
    return;
  } catch (err) {
    if (!(err instanceof vscode.FileSystemError) || err.code !== 'FileNotFound') throw err;
  }

  // Copy from assets to workspace.
  const sourceUri = vscode.Uri.joinPath(context.extensionUri, 'assets', sourceAsset);
  const sourceData = await vscode.workspace.fs.readFile(sourceUri);
  await vscode.workspace.fs.writeFile(targetUri, sourceData);

  const doc = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    `Created ${fileName} in workspace root. Set "dataLineageViz.${settingName}" to "${fileName}" to use it.`
  );
}
