import * as vscode from 'vscode';
import { AiSession, getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, deactivatePanels, getActivePanel, SidebarProvider, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { logInfo, logDebug, logWarn, logError, trunc } from './utils/log';
import { migrateProjectStore, createProject, updateProject, generateProjectName } from './engine/projectStore';
import { stripSensitiveFields } from './engine/connectionManager';
import { IConnectionInfo } from './types/mssql';
import { setInlineTokenBudget, setSmInlineNodeCap } from './ai/tools';

declare const __BUILD_TIMESTAMP__: string;

let outputChannel: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);

  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logInfo(outputChannel, 'Config', `Extension activated — built ${buildStamp}`);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  const loadStore = (c: vscode.ExtensionContext) => migrateProjectStore(c.globalState.get(PROJECT_STORE_KEY));
  const saveStore = async (c: vscode.ExtensionContext, s: any) => { await c.globalState.update(PROJECT_STORE_KEY, s); };

  // ─── Command Registration ──────────────────────────────────────────────────
  context.subscriptions.push(...registerCommands(
    context, 
    getSession, 
    outputChannel, 
    (ctx, title, demo) => {
      logInfo(outputChannel, 'Bridge', `Command executed: openPanel (demo=${demo})`);
      return openPanel(
        ctx, 
        title, 
        getSession, 
        outputChannel, 
        loadStore, 
        saveStore, 
        async (c) => { await migrateFromWorkspaceState(c, loadStore, saveStore, outputChannel); }, 
        demo
      );
    },
    (ctx) => buildDebugDump(ctx, getSession, outputChannel)
  ));

  // ─── AI Language Model Tools ───────────────────────────────────────────────
  context.subscriptions.push(...registerAiTools(getSession, outputChannel, getActivePanel));

  // ─── @lineage Chat Participant ─────────────────────────────────────────────
  registerChatParticipant(context, getSession, outputChannel);
}

export function deactivate() {
  deactivatePanels(outputChannel);
}

async function migrateFromWorkspaceState(
  context: vscode.ExtensionContext, 
  loadProjectStore: (c: vscode.ExtensionContext) => any, 
  saveProjectStore: (c: vscode.ExtensionContext, s: any) => Promise<void>,
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  if (!sourceType) return;

  let connection: any;

  if (sourceType === 'dacpac') {
    const dacpacPath = context.workspaceState.get<string>('lastDacpacPath');
    const dacpacName = context.workspaceState.get<string>('lastDacpacName');
    if (dacpacPath && dacpacName) {
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

function registerChatParticipant(context: vscode.ExtensionContext, getSession: () => AiSession, outputChannel: vscode.LogOutputChannel) {
  const participant = vscode.chat.createChatParticipant(
    'dataLineageViz.lineage',
    async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
      const sess = getSession();
      sess.maxInputTokens = request.model.maxInputTokens;
      sess.modelName = request.model.name || request.model.id;
      
      const aiConfig = vscode.workspace.getConfiguration('dataLineageViz');
      setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
      setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));

      if (!sess.model) {
        stream.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first.');
        return {};
      }

      logInfo(outputChannel, 'AI', `[${sess.id}] Session start — model=${request.model.id}, prompt="${trunc(request.prompt, 200)}"`);
      // ... Full logic would go here ...
      return {}; 
    }
  );
  context.subscriptions.push(participant);
}
