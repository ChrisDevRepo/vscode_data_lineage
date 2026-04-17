import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, getActivePanel, SidebarProvider, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { Logger, testLogCapture } from './utils/log';
import { migrateProjectStore } from './engine/projectStore';
import { type AiOutputTemplates, EMPTY_AI_TEMPLATES } from './ai/types';
import { LineageParticipant } from './ai/lineageParticipant';
import { migrateFromWorkspaceState } from './utils/migration';
import { loadRules, type ParseRulesConfig } from './engine/sqlBodyParser';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';

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

    context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  const templates = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
    logger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
    return { ...EMPTY_AI_TEMPLATES };
  });
  const sess = getSession();
  sess.outputTemplates = templates;

  await loadParseRules(outputChannel, context.extensionUri).catch(err => {
    logger.error('load parse rules at activation', err);
  });

  const loadStore = (c: vscode.ExtensionContext) => migrateProjectStore(c.globalState.get(PROJECT_STORE_KEY));
  const saveStore = async (c: vscode.ExtensionContext, s: any) => { await c.globalState.update(PROJECT_STORE_KEY, s); };

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

    context.subscriptions.push(...registerAiTools(getSession, outputChannel, getActivePanel));

    const participant = new LineageParticipant(context, getSession, outputChannel, getActivePanel);
  participant.register();

    const configLogger = Logger.create(outputChannel, 'Config');
    const RELOAD_KEYS: Array<{ key: string; label: string }> = [
      { key: 'dataLineageViz.parseRulesFile', label: 'Parse rules file' },
      { key: 'dataLineageViz.dmvQueriesFile', label: 'DMV queries file' },
      { key: 'dataLineageViz.maxNodes', label: 'Max nodes' },
      { key: 'dataLineageViz.renderLimit', label: 'Render limit' },
    ];

    context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('dataLineageViz')) return;
      configLogger.debug('Settings changed — dataLineageViz.*');

      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri);
        getSession().outputTemplates = t;
      }

      if (e.affectsConfiguration('dataLineageViz.parseRulesFile')) {
        await loadParseRules(outputChannel, context.extensionUri).catch(err => {
          configLogger.error('reload parse rules on setting change', err);
        });
      }

      for (const { key, label } of RELOAD_KEYS) {
        if (e.affectsConfiguration(key)) {
          const pick = await vscode.window.showInformationMessage(
            `${label} changed. Reload your data source to apply.`,
            'Reload'
          );
          if (pick === 'Reload') vscode.commands.executeCommand('dataLineageViz.open');
          break;
        }
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
    vscode.window.showWarningMessage('Data Lineage: Failed to load custom AI output templates — using built-in defaults.');
  }

  return builtIn;
}

/**
 * Loads parse rules from built-in defaults, overlays a custom YAML if the
 * `dataLineageViz.parseRulesFile` setting is set, then installs them via
 * `loadRules()` so `parseSqlBody()` can reach them.
 */
async function loadParseRules(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Config');
  let config: ParseRulesConfig | null = null;

  try {
    const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'defaultParseRules.yaml');
    const data = await vscode.workspace.fs.readFile(builtInUri);
    config = yaml.load(new TextDecoder().decode(data)) as ParseRulesConfig;
  } catch (err) {
    logger.error('load built-in parse rules', err);
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const customPath = cfg.get<string>('parseRulesFile', '');
  if (customPath) {
    const resolved = resolveWorkspacePath(customPath);
    if (resolved) {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        const parsed = yaml.load(new TextDecoder().decode(data)) as ParseRulesConfig;
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          config = parsed;
          await persistAbsolutePath('parseRulesFile', customPath, resolved);
          logger.info(`Custom parse rules loaded from ${path.basename(customPath)}`);
        } else {
          logger.warn(`Invalid custom parse rules at ${customPath} — using built-in defaults`);
          vscode.window.showWarningMessage('Custom parse rules invalid — using built-in defaults.');
        }
      } catch (err) {
        logger.warn(`Failed to load custom parse rules: ${err instanceof Error ? err.message : String(err)} — using built-in defaults`);
        vscode.window.showWarningMessage('Failed to load custom parse rules — using built-in defaults. Check Output channel.');
      }
    } else {
      logger.warn(`Cannot resolve parse rules path "${customPath}" — using built-in defaults`);
    }
  }

  if (!config) {
    logger.error('parse rule load', new Error('no config loaded — regex extraction disabled'));
    return;
  }

  const result = loadRules(config);
  for (const err of result.errors) logger.debug(err);
  if (result.usedDefaults) {
    logger.warn('Parse rules config invalid — rule list empty');
    vscode.window.showWarningMessage('Data Lineage: Parse rules config invalid — check Output channel.');
  } else if (result.skipped.length > 0) {
    logger.warn(`${result.loaded} parse rules loaded, ${result.skipped.length} skipped: ${result.skipped.join(', ')}`);
  } else {
    logger.info(`${result.loaded} parse rules loaded`);
  }
}
