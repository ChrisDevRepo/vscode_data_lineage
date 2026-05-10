import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { type AiSession } from './ai/session/session';
import { DeferredQuestionSchema } from './ai/sm/smTypes';
import { buildDeferredQuestionsPrompt } from './ai/prompting/prompts';
import { getActivePanel } from './panelProvider';
import { Logger } from './utils/log';
import { searchCatalog, type SearchableNode } from './utils/modelSearch';

/**
 * Runtime schema for the `dataLineageViz.showDeferredQuestions` command argument.
 *
 * @remarks
 * The command is invoked from a `stream.button` in a chat response and from
 * test harnesses, both of which cross a trust boundary. Validate the full
 * payload with Zod so a malformed entry surfaces as a diagnostic rather than
 * an exception during prompt construction.
 */
const DeferredQuestionArgSchema = z.array(DeferredQuestionSchema).min(1);

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
     * Command invoked by the "Show in Graph" button (rendered by `stream.button` at the end
     * of a completed SM turn). Handles both cases in one place so the UI only needs one entry
     * point.
     *
     * @remarks
     * - **Fast path**: if an AI view has already been synthesized this session
     *   (`sess.resultGraph` is populated) and the lineage panel exists, just reveal it.
     *   No new chat turn, no AI round-trip, no token cost.
     * - **Slow path**: if no view exists yet (e.g. the user ran a `bfs_trace` but the AI
     *   never called `present_result`), open a fresh `@lineage` chat turn asking the AI to
     *   synthesize a view from the stored trace results.
     *
     * @param originalPrompt - The user's original question, captured at SM start; used as
     *   the seed for the view name in the slow path.
     */
    vscode.commands.registerCommand('dataLineageViz.aiCreateView', (originalPrompt: string) => {
      const sess = getSession();
      const panel = getActivePanel();
      if (sess.resultGraph && panel) {
        // Always re-post the preview: present_result's ai-view-preview is ephemeral.
        // If it was never sent (present_result errored/skipped) or the webview lost state,
        // reveal alone would show a stale/empty panel.
        const rg = sess.resultGraph;
        const badges = (rg.suggested_labels ?? []).map(l => ({ nodeId: l.node_id, text: l.text }));
        const notes = (rg.notes ?? [])
          .filter(n => n.summary)
          .map(n => ({ nodeId: n.nodeId, text: n.summary }));
        const name = (originalPrompt || 'AI Lineage View').length > 200 
          ? (originalPrompt || 'AI Lineage View').slice(0, 200) + '\u2026'
          : (originalPrompt || 'AI Lineage View');
        panel.webview.postMessage({
          type: 'ai-view-preview',
          name,
          nodeIds: rg.nodeIds,
          aiMetadata: {
            summary: sess.lastPresentResultDescription ? '' : `Lineage trace for: ${originalPrompt}`,
            description: sess.lastPresentResultDescription ?? '',
            createdAt: new Date().toISOString(),
            modelName: sess.modelName || 'unknown',
            highlightGroups: [],
            badges,
            notes,
            layoutDirection: 'LR' as const,
          },
        });
        panel.reveal(vscode.ViewColumn.One);
        return;
      }
      const viewPrompt = `Create an AI view from the trace above. Use the BFS results you already have — add badges, notes, and highlight groups. Name it based on the original question: "${originalPrompt}"`;
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${viewPrompt}`,
      });
    }),

    /**
     * Pre-fills the chat input with the full list of deferred (out-of-approved-scope)
     * sub-questions the engine collected during an SM session. The user trims the list
     * to whatever they want to pursue and sends manually — the command starts no task.
     *
     * @remarks
     * Invoked from the `stream.button` emitted after a successful synthesis
     * (see `LineageParticipant.dispatchExit`). The argument is validated via
     * {@link DeferredQuestionArgSchema}; a malformed payload is logged and silently
     * skipped rather than throwing. Uses `workbench.action.chat.open` with
     * `isPartialQuery: true` so the input text is not auto-submitted.
     */
    vscode.commands.registerCommand('dataLineageViz.showDeferredQuestions', async (raw: unknown) => {
      const parsed = DeferredQuestionArgSchema.safeParse(raw);
      if (!parsed.success) {
        aiLogger.warn(`showDeferredQuestions: ignoring malformed argument — ${parsed.error.issues.map(i => i.message).join('; ')}`);
        return;
      }
      // Pre-fill the chat input with the full list. `isPartialQuery: true` keeps it unsent
      // so the user can trim to one question and decide when to send — no auto-task.
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: buildDeferredQuestionsPrompt(parsed.data),
        isPartialQuery: true,
      });
    }),

    /**
     * Internal command invoked by 'Approve' / 'Cancel' / 'Refine Scope' buttons in a chat gate.
     *
     * @remarks
     * - `'yes'` / `'no'` resolve mechanically — submit the literal token so the participant's
     *   gate classifier matches and the engine resumes or aborts.
     * - `'refine'` opens the chat input pre-filled with `@lineage refine: ` so the user types
     *   their narrowing instruction (free text). The classifier matches the `refine:` prefix
     *   and routes the message to the AI for structural translation.
     */
    vscode.commands.registerCommand('dataLineageViz.aiResolveGate', (choice: 'yes' | 'no' | 'refine') => {
      configLogger.info(`AI Gate resolved: choice=${choice}`);
      if (choice === 'refine') {
        vscode.commands.executeCommand('workbench.action.chat.open', {
          query: '@lineage refine: ',
          isPartialQuery: true,
        });
        return;
      }
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${choice}`
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
        const { buildBareGraph } = await import('./ai/infra/graphUtils');

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
