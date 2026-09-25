import * as vscode from 'vscode';
import * as path from 'path';
import { type AiSession } from './ai/session/session';
import { getActivePanel } from './panelProvider';
import { postToWebview } from './bridge/host';
import { Logger } from './utils/log';
import { notifyError, notifyWarning, notifyInfo } from './utils/notifications';
import { searchCatalog } from './utils/modelSearch';
import { markGitIgnored } from './utils/gitIgnoredDir';
import { applyModelToSession, buildExtensionConfig, isModelOverLimit } from './bridge/messageHandlers';
import type { AiTraceWriter } from './ai/observability/aiTraceWriter';

/**
 * Registers all user-facing and internal commands for the Data Lineage Viz extension.
 *
 * @returns An array of disposables representing the registered commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  openPanel: (context: vscode.ExtensionContext, title: string, loadDemo?: boolean) => void,
  buildDebugDump: (context: vscode.ExtensionContext) => string,
  traceWriter: AiTraceWriter,
): vscode.Disposable[] {
  const configLogger = Logger.create(outputChannel, 'Config');
  const aiLogger = Logger.create(outputChannel, 'AI');

  return [
    vscode.commands.registerCommand('dataLineageViz.open', () => openPanel(context, 'Data Lineage Viz')),
    vscode.commands.registerCommand('dataLineageViz.openDemo', () => openPanel(context, 'Data Lineage Viz', true)),

    /**
     * Pushes fresh extension settings to the active panel, bringing the view into
     * sync without reloading data.
     *
     * @remarks
     * Equivalent to clicking the toolbar Refresh button, but without the full filter reset —
     * suitable for programmatic callers and keyboard shortcuts; does not exit active trace,
     * analysis, or AI preview modes. The column store is left intact since a settings push
     * does not touch the session model it projects.
     */
    vscode.commands.registerCommand('dataLineageViz.refresh', () => {
      const panel = getActivePanel();
      if (!panel) {
        notifyInfo(configLogger, 'Refresh', 'Open a Data Lineage view first.', { command: 'dataLineageViz.refresh' });
        return;
      }
      const config = buildExtensionConfig(vscode.workspace.getConfiguration('dataLineageViz'));
      void postToWebview(panel, { type: 'rebuild-config', config }, configLogger);
      configLogger.debug('dataLineageViz.refresh — pushed rebuild-config');
    }),

    vscode.commands.registerCommand('dataLineageViz.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dataLineageViz')
    ),

    vscode.commands.registerCommand('dataLineageViz.copyDebugInfo', async () => {
      try {
        const dump = buildDebugDump(context);
        await vscode.env.clipboard.writeText(dump);
        notifyInfo(configLogger, 'Copy debug info', 'Data Lineage: Debug info copied to clipboard.', { command: 'dataLineageViz.copyDebugInfo' });
      } catch (err) {
        notifyError(configLogger, 'Copy debug info', 'Data Lineage: Failed to copy debug info.', err, { command: 'dataLineageViz.copyDebugInfo' });
      }
    }),

    vscode.commands.registerCommand('dataLineageViz.enableAiTraceLogging', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        notifyWarning(
          configLogger,
          'Enable AI trace logging',
          'Data Lineage: Open a workspace folder before enabling AI trace logging.',
          { command: 'dataLineageViz.enableAiTraceLogging' },
        );
        return undefined;
      }

      const traceRoot = vscode.Uri.joinPath(workspaceFolder.uri, 'tmp').fsPath;
      try {
        const tracePath = await traceWriter.enable(traceRoot);
        notifyInfo(
          configLogger,
          'Enable AI trace logging',
          `Data Lineage: AI trace logging enabled for this session. Writing to ${tracePath}`,
          { command: 'dataLineageViz.enableAiTraceLogging' },
        );
        return tracePath;
      } catch (err) {
        notifyError(
          configLogger,
          'Enable AI trace logging',
          'Data Lineage: Failed to enable AI trace logging.',
          err,
          { command: 'dataLineageViz.enableAiTraceLogging', traceRoot },
        );
        return undefined;
      }
    }),

    /**
     * Dumps the current AI State Machine (SM) state to a JSON file under the workspace's
     * `tmp/sm-dumps` directory, for debugging deep-trace and non-deterministic AI failures.
     *
     * @returns The SM state, also when no workspace folder is open to write it to;
     *   `undefined` only when there is no state machine or the write failed.
     *
     * @remarks
     * Shares the `tmp` root with AI trace logging rather than creating a `test-results`
     * directory in the user's project — that name is this repository's test-output
     * convention, not something a user's workspace should grow.
     */
    vscode.commands.registerCommand('dataLineageViz.dumpSmState', async () => {
      const sess = getSession();
      const sm = sess.stateMachine;
      if (!sm) {
        notifyWarning(
          aiLogger,
          'Dump SM state',
          'Data Lineage: No active state machine to dump. A bounded graph preview runs in one pass; use its AI NDJSON trace for diagnostics.',
          { command: 'dataLineageViz.dumpSmState', hasPresentation: sess.presentationArtifact !== null },
        );
        return;
      }
      try {
        const state = sm.toJSON();
        const dump = JSON.stringify(state, null, 2);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
          notifyWarning(aiLogger, 'Dump SM state', 'Data Lineage: No workspace folder open.', { command: 'dataLineageViz.dumpSmState' });
          return state;
        }
        const dir = vscode.Uri.joinPath(wsFolder.uri, 'tmp', 'sm-dumps');
        await vscode.workspace.fs.createDirectory(dir);
        await markGitIgnored(dir.fsPath);
        const fileUri = vscode.Uri.joinPath(dir, `sm-${ts}.json`);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(dump, 'utf-8'));
        aiLogger.debug(`SM state dumped to ${fileUri.fsPath}`);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
        return state;
      } catch (err) {
        notifyError(aiLogger, 'Dump SM state', 'Data Lineage: Failed to dump SM state.', err, { command: 'dataLineageViz.dumpSmState' });
      }
    }),


    vscode.commands.registerCommand('dataLineageViz.createParseRules', () =>
      createYamlScaffold(context, configLogger, 'parseRules.yaml', 'defaultParseRules.yaml', 'parseRulesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createDmvQueries', () =>
      createYamlScaffold(context, configLogger, 'dmvQueries.yaml', 'dmvQueries.yaml', 'dmvQueriesFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.createAiOutputTemplates', () =>
      createYamlScaffold(context, configLogger, 'aiOutputTemplates.yaml', 'aiOutputTemplates.yaml', 'ai.outputTemplateFile')
    ),

    vscode.commands.registerCommand('dataLineageViz.aiCreateView', () => {
      const sess = getSession();
      const panel = getActivePanel();
      if (sess.presentationArtifact && panel) {
        const preview = sess.presentationArtifact;
        panel.reveal(vscode.ViewColumn.One);
        void postToWebview(panel, {
          type: 'ai-view-preview',
          name: preview.name,
          nodeIds: [...preview.nodeIds],
          aiMetadata: preview.aiMetadata,
        }, aiLogger);
        return;
      }
      notifyInfo(aiLogger, 'AI create view', 'No validated AI lineage preview is available for this session.', {
        command: 'dataLineageViz.aiCreateView',
        hasResultGraph: sess.resultGraph !== null,
        hasPresentationArtifact: sess.presentationArtifact !== null,
        hasPanel: panel !== undefined,
      });
    }),

    /**
     * Launches a Quick Pick search interface for all SQL objects in the current model.
     */
    vscode.commands.registerCommand('dataLineageViz.searchObjects', async () => {
      const sess = getSession();
      if (!sess.model) {
        notifyWarning(configLogger, 'Search objects', 'Open a .dacpac file or connect to a database first.', { command: 'dataLineageViz.searchObjects' });
        return;
      }
      const model = sess.model;
      const qp = vscode.window.createQuickPick();
      qp.placeholder = 'Search tables, views, procedures, functions…';
      qp.matchOnDescription = false;
      qp.matchOnDetail = false;

      qp.onDidChangeValue(value => {
        if (!value.trim()) { qp.items = []; return; }
        const results = searchCatalog(model.nodes, value, undefined, undefined, 20);
        qp.items = results.map(n => ({
          label:       n.name,
          description: `[${n.schema}]`,
          detail:      n.type,
          schema:      n.schema,
        }));
      });

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0] as (vscode.QuickPickItem & { schema: string }) | undefined;
        if (!picked) return;
        qp.hide();
        const panel = getActivePanel();
        if (!panel) {
          notifyWarning(configLogger, 'Search objects', 'Open the Data Lineage view to focus an object.', { command: 'dataLineageViz.searchObjects' });
          return;
        }
        panel.reveal();
        void postToWebview(panel, { type: 'focus-object', schema: picked.schema, name: picked.label }, configLogger);
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),

    /**
     * Command intended for testing/integration that forces a .dacpac file load into the active session.
     *
     * @remarks
     * Installs the model through the same path the webview bridge uses, so the session it leaves
     * behind is indistinguishable from a wizard load — including the `dataLineageViz.modelLoaded`
     * context key. Renders into an already-open panel; it does not open one.
     */
    vscode.commands.registerCommand('dataLineageViz.openExternalProject', async (uri: vscode.Uri) => {
      configLogger.info(`Forcing project load from: ${uri.fsPath}`);
      try {
        const { extractDacpac } = await import('./engine/dacpacExtractor');

        const buffer = await vscode.workspace.fs.readFile(uri);
        const config = buildExtensionConfig(vscode.workspace.getConfiguration('dataLineageViz'));
        const model = await extractDacpac(
          buffer,
          undefined,
          undefined,
          {
            externalRefsEnabled: config.externalRefs.enabled,
          },
        );
        if (isModelOverLimit(model, config.maxNodes, configLogger)) return;
        const sess = getSession();

        applyModelToSession(sess, model, false, null);
        sess.projectName = path.basename(uri.fsPath, '.dacpac');

        const panel = getActivePanel();
        if (panel) {
          void postToWebview(panel, { type: 'dacpac-model', model, config, sourceName: sess.projectName, autoVisualize: true }, configLogger);
        }

        configLogger.info(`Model forced: ${model.nodes.length} nodes, ${model.edges.length} edges, project: ${sess.projectName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyError(configLogger, 'Open external project', `Data Lineage: Failed to read file — ${msg}`, err, {
          command: 'dataLineageViz.openExternalProject',
          path: uri.fsPath,
        });
      }
    }),
  ];
}

/**
 * Creates a YAML configuration file in the workspace root by copying a template from the extension assets.
 */
async function createYamlScaffold(
  context: vscode.ExtensionContext, logger: Logger, fileName: string, sourceAsset: string, settingName: string
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    notifyWarning(logger, 'Create YAML scaffold', 'Open a workspace folder first.', { fileName, settingName });
    return;
  }

  const targetUri = vscode.Uri.joinPath(folder.uri, fileName);

  try {
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
    notifyInfo(logger, 'Create YAML scaffold', `Created ${fileName} in workspace root. Set "dataLineageViz.${settingName}" to "${fileName}" to use it.`, { fileName, settingName });
  } catch (err) {
    notifyError(logger, 'Create YAML scaffold', `Data Lineage: Failed to create ${fileName} — check the Output channel for details.`, err, { fileName, sourceAsset, settingName });
    throw err;
  }
}
