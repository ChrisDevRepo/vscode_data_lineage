import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, getActivePanel, SidebarProvider, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { Logger, testLogCapture } from './utils/log';
import { migrateProjectStore } from './engine/projectStore';
import { type AiOutputTemplates, EMPTY_AI_TEMPLATES } from './ai/types';
import { LineageParticipant } from './ai/lineageParticipant';
import { migrateFromWorkspaceState } from './utils/migration';

declare const __BUILD_TIMESTAMP__: string;

let outputChannel: vscode.LogOutputChannel;

/**
 * Extension Entry Point.
 * 
 * Orchestrates the lifecycle of the Data Lineage Viz extension.
 * Adheres to a strict registration order mandated by stability requirements:
 * 1. Sidebar/Quick Actions (Prevents "no provider" UI errors)
 * 2. Commands & Project Store
 * 3. AI Bridge & Language Model Tools
 * 4. Chat Participant
 */
export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);
  const logger = Logger.create(outputChannel, 'Config');

  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logger.info(`Extension activated — built ${buildStamp}`);

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
      Logger.create(outputChannel, 'Bridge').info(`Command executed: openPanel (demo=${demo})`);
      return openPanel(
        ctx, 
        title, 
        getSession, 
        outputChannel, 
        loadStore, 
        saveStore, 
        async (c) => { await migrateFromWorkspaceState(c, PROJECT_STORE_KEY, outputChannel); }, 
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

/**
 * Extension Cleanup.
 *
 * Panel-scoped state (stats connection, caches) is cleaned up via
 * panel.onDidDispose in panelProvider.ts. VS Code disposes the output channel
 * and command registrations automatically via context.subscriptions.
 */
export function deactivate() {
  // no-op
}

/**
 * Loads AI Output Templates from built-in assets and optional user overrides.
 * These templates define how the AI structures its summaries and descriptions.
 */
async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplates> {
  const logger = Logger.create(outputChannel, 'Config');
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
    logger.debug('AI output templates loaded from built-in defaults');
  } catch (err) {
    logger.error('load built-in AI templates', err);
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
    logger.info(`AI output templates overlaid from: ${customPath}`);
  } catch (err) {
    logger.error(`load custom AI templates from ${customPath}`, err);
  }

  return builtIn;
}
