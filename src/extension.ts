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
  const builtInKeys: string[] = [];

  const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'aiOutputTemplates.yaml');
  logger.info(`Reading AI templates built-in: ${builtInUri.fsPath}`);
  try {
    const data = await vscode.workspace.fs.readFile(builtInUri);
    const parsed = yaml.load(new TextDecoder().decode(data)) as Record<string, { instruction?: string }>;
    for (const key of REQUIRED_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
        builtInKeys.push(key);
      } else {
        logger.info(`Skipped AI template '${key}': built-in missing or non-string 'instruction' field`);
      }
    }
  } catch (err) {
    logger.error('load built-in AI templates', err);
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
  const customPath = cfg.get<string>('outputTemplateFile', '');
  if (!customPath) {
    logger.info(`Applied AI templates: ${builtInKeys.length} loaded from built-in, 0 overlaid`);
    return builtIn;
  }

  logger.info(`Reading AI templates custom: ${customPath}`);
  const overlaid: string[] = [];
  try {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(customPath));
    const parsed = yaml.load(new TextDecoder().decode(data)) as Record<string, { instruction?: string }>;
    if (parsed && typeof parsed === 'object') {
      const required = new Set<string>(REQUIRED_KEYS);
      for (const key of Object.keys(parsed)) {
        if (!required.has(key)) {
          logger.warn(`Skipped AI template '${key}': unknown key — must be one of ${REQUIRED_KEYS.join(', ')}`);
        }
      }
    }
    for (const key of REQUIRED_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
        overlaid.push(key);
      } else if (entry !== undefined) {
        logger.info(`Skipped AI template '${key}': missing or non-string 'instruction' field in custom YAML`);
      }
    }
    logger.info(`Applied AI templates: ${builtInKeys.length} loaded from built-in, ${overlaid.length} overlaid from custom (${overlaid.join(', ') || 'none'})`);
  } catch (err) {
    logger.warn(`Fallback AI templates custom → built-in: reason=${err instanceof Error ? err.message : String(err)} at ${customPath}`);
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
  let source: 'built-in' | 'custom' = 'built-in';

  const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'defaultParseRules.yaml');
  logger.info(`Reading parse rules built-in: ${builtInUri.fsPath}`);
  try {
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
      logger.info(`Reading parse rules custom: ${resolved}`);
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        const parsed = yaml.load(new TextDecoder().decode(data)) as ParseRulesConfig;
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          config = parsed;
          source = 'custom';
          await persistAbsolutePath('parseRulesFile', customPath, resolved);
        } else {
          logger.warn(`Fallback parse rules custom → built-in: reason=missing or invalid "rules" array at ${resolved}`);
          vscode.window.showWarningMessage('Custom parse rules invalid — using built-in defaults.');
        }
      } catch (err) {
        logger.warn(`Fallback parse rules custom → built-in: reason=${err instanceof Error ? err.message : String(err)} at ${resolved}`);
        vscode.window.showWarningMessage('Failed to load custom parse rules — using built-in defaults. Check Output channel.');
      }
    } else {
      logger.warn(`Fallback parse rules custom → built-in: reason=cannot resolve path "${customPath}"`);
    }
  }

  if (!config) {
    logger.error('parse rule load', new Error('no config loaded — regex extraction disabled'));
    return;
  }

  const result = loadRules(config);
  for (const err of result.errors) logger.info(`Skipped parse rule: ${err}`);
  if (result.usedDefaults) {
    logger.warn(`Fallback parse rules ${source} → empty: reason=no valid rules in config`);
    vscode.window.showWarningMessage('Data Lineage: Parse rules config invalid — check Output channel.');
  } else {
    logger.info(`Applied parse rules: ${result.loaded} loaded from ${source}, ${result.skipped.length} skipped`);
  }
}
