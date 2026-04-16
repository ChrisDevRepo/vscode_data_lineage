import * as vscode from 'vscode';
import * as path from 'path';
import { type AiSession } from './ai/session';
import { getActivePanel } from './panelProvider';
import { Logger, trunc } from './utils/log';
import { searchCatalog, type SearchableNode } from './utils/modelSearch';

/**
 * Registers all extension commands.
 * Returns an array of disposables to be added to context.subscriptions.
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
    vscode.commands.registerCommand('dataLineageViz.open', () => openPanel(context, 'Data Lineage Viz')),
    vscode.commands.registerCommand('dataLineageViz.openDemo', () => openPanel(context, 'Data Lineage Viz', true)),
    vscode.commands.registerCommand('dataLineageViz.openProject', (projectId: string) => {
      openPanel(context, 'Data Lineage Viz');
      const panel = getActivePanel();
      if (panel) {
        panel.webview.postMessage({ type: 'load-project', id: projectId });
      }
    }),
    vscode.commands.registerCommand('dataLineageViz.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz')
    ),
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

    vscode.commands.registerCommand('dataLineageViz.createParseRules', () =>
      createYamlScaffold(context, 'parseRules.yaml', 'defaultParseRules.yaml', 'parseRulesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', () =>
      createYamlScaffold(context, 'dmvQueries.yaml', 'dmvQueries.yaml', 'dmvQueriesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createAiOutputTemplates', () =>
      createYamlScaffold(context, 'aiOutputTemplates.yaml', 'aiOutputTemplates.yaml', 'ai.outputTemplateFile')
    ),

    vscode.commands.registerCommand('dataLineageViz.aiCreateView', (originalPrompt: string) => {
      const viewPrompt = `Create an AI view from the trace above. Use the BFS results you already have — add badges, notes, and highlight groups. Name it based on the original question: "${trunc(originalPrompt || '', 60)}"`;
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${viewPrompt}`,
      });
    }),

    vscode.commands.registerCommand('dataLineageViz.toggleOverviewMode', () => {
      // Logic handled via postMessage to activePanel, which we can't access here directly
      // extension.ts will handle the activePanel reference.
      vscode.commands.executeCommand('dataLineageViz.internal.toggleOverview');
    }),

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
    vscode.commands.registerCommand('dataLineageViz.openExternalProject', async (uri: vscode.Uri) => {
      configLogger.info(`Forcing project load from: ${uri.fsPath}`);
      const { extractDacpac } = await import('./engine/dacpacExtractor');
      const { buildBareGraph } = await import('./ai/graphUtils');

      const buffer = await vscode.workspace.fs.readFile(uri);
      const model = await extractDacpac(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
      const sess = getSession();

      sess.model = model;
      sess.projectName = path.basename(uri.fsPath, '.dacpac');
      sess.graph = buildBareGraph(model);

      configLogger.info(`Model forced: ${model.nodes.length} nodes, ${model.edges.length} edges, project: ${sess.projectName}`);
    }),
  ];
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
