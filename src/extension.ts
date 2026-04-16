import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { AiSession, getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, deactivatePanels, getActivePanel, SidebarProvider, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { logInfo, logDebug, logWarn, logError, trunc, testLogCapture } from './utils/log';
import { migrateProjectStore, createProject, updateProject, generateProjectName } from './engine/projectStore';
import { stripSensitiveFields } from './engine/connectionManager';
import { IConnectionInfo } from './types/mssql';
import { type AiOutputTemplates, EMPTY_AI_TEMPLATES } from './ai/types';
import { LineageParticipant } from './ai/lineageParticipant';

declare const __BUILD_TIMESTAMP__: string;

let outputChannel: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);

  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logInfo(outputChannel, 'Config', `Extension activated — built ${buildStamp}`);

  // ─── CRITICAL: Register Tree Provider first to prevent "no data provider" error ───
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  const templates = await loadAiOutputTemplates(outputChannel, context.extensionUri);
  const sess = getSession();
  sess.outputTemplates = templates;

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
  const participant = new LineageParticipant(context, getSession, outputChannel, getActivePanel);
  participant.register();

  // ─── AI Config Watcher ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri);
        getSession().outputTemplates = t;
      }
    })
  );

  return {
    getSession,
    getActivePanel,
    testLogCapture,
    participant
  };
}

export function deactivate() {
  deactivatePanels(outputChannel);
}

async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplates> {
  const REQUIRED_KEYS: (keyof AiOutputTemplates)[] = ['summary', 'description', 'sections', 'highlights', 'notes'];
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
    logError(outputChannel, 'Config', 'load built-in AI templates', err);
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
  const customPath = cfg.get<string>('outputTemplateFile', '');
  if (!customPath) return builtIn;

  try {
    const customUri = vscode.Uri.file(customPath);
    const data = await vscode.workspace.fs.readFile(customUri);
    const content = new TextDecoder().decode(data);
    const parsed = yaml.load(content) as Record<string, { instruction?: string }>;
    for (const key of REQUIRED_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
      }
    }
    logInfo(outputChannel, 'Config', `AI output templates overlaid from: ${customPath}`);
  } catch (err) {
    logError(outputChannel, 'Config', `load custom AI templates from ${customPath}`, err);
  }

  return builtIn;
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

