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
 * Extension Activation Lifecycle.
 * 
 * Orchestrates the bootstrapping of the Data Lineage Viz extension.
 * Adheres to a strict registration order mandated by stability requirements:
 * 1.  **Sidebar/Quick Actions**: Registered first to prevent "no provider" UI errors during early activation.
 * 2.  **Commands & Project Store**: Core functionality and state management.
 * 3.  **AI Bridge & Language Model Tools**: Integration with VS Code's AI ecosystem.
 * 4.  **Chat Participant**: The autonomous lineage explorer.
 * 
 * @param context - The extension context provided by VS Code.
 * @returns An API object for testing and internal integration.
 */
export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);
  const logger = Logger.create(outputChannel, 'Config');

  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logger.info(`Extension activated — built ${buildStamp}`);

  // Register the sidebar provider for quick actions.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider())
  );

  // Load AI output templates for summary and narrative generation.
  const templates = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
    logger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
    return { ...EMPTY_AI_TEMPLATES };
  });
  const sess = getSession();
  sess.outputTemplates = templates;

  // Load SQL parsing rules for DDL extraction.
  await loadParseRules(outputChannel, context.extensionUri).catch(err => {
    logger.error('load parse rules at activation', err);
  });

  const loadStore = (c: vscode.ExtensionContext) => migrateProjectStore(c.globalState.get(PROJECT_STORE_KEY));
  const saveStore = async (c: vscode.ExtensionContext, s: any) => { await c.globalState.update(PROJECT_STORE_KEY, s); };

  // Register all user-facing commands.
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

  // Register AI tools for Copilot Chat integration.
  context.subscriptions.push(...registerAiTools(getSession, outputChannel, getActivePanel));

  // Register the Chat Participant.
  const participant = new LineageParticipant(context, getSession, outputChannel, getActivePanel);
  participant.register();

  // Watch for configuration changes and trigger reloads where necessary.
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
 * Extension Deactivation Lifecycle.
 *
 * @remarks
 * No explicit cleanup is required — every disposable from {@link activate}
 * (output channel, command registrations, tree provider, chat participant,
 * config-change listener, AI tools) is pushed onto `context.subscriptions`
 * and torn down by VS Code automatically. Panel-specific resources such as
 * database connections are released through each panel's own `onDidDispose`
 * handler, again outside this function's responsibility.
 */
export function deactivate() {
  // no-op
}

/**
 * Loads AI Output Templates from built-in assets and optional user overrides.
 * 
 * These templates provide the structural instructions used by the AI to generate
 * summaries, section titles, and highlighted badges in the UI.
 * 
 * @param outputChannel - The log channel for reporting load status.
 * @param extensionUri - The root URI of the extension.
 * @returns A promise resolving to the compiled `AiOutputTemplates`.
 */
async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplates> {
  const logger = Logger.create(outputChannel, 'Config');
  const REQUIRED_KEYS: (keyof AiOutputTemplates)[] = ['summary', 'title', 'intro', 'closing', 'highlights', 'notes', 'business_capture', 'technical_capture', 'structural_summary'];
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
    vscode.window.showWarningMessage(`Data Lineage: Failed to load custom AI output templates from "${customPath}" — using built-in defaults.`);
  }

  return builtIn;
}

/**
 * Loads and installs SQL parsing rules for DDL analysis.
 * 
 * Rules are loaded from the built-in `defaultParseRules.yaml` and can be
 * overridden by a custom file specified in settings.
 * 
 * @param outputChannel - The log channel.
 * @param extensionUri - The root URI of the extension.
 * @returns A promise that resolves when the rules are loaded and applied to the engine.
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
          vscode.window.showWarningMessage(`Custom parse rules invalid at "${resolved}" — using built-in defaults.`);
        }
      } catch (err) {
        logger.warn(`Fallback parse rules custom → built-in: reason=${err instanceof Error ? err.message : String(err)} at ${resolved}`);
        vscode.window.showWarningMessage(`Failed to load custom parse rules from "${resolved}" — using built-in defaults. Check Output channel for details.`);
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
  const sess = getSession();
  if (result.usedDefaults) {
    sess.parseRulesLabel = 'built-in rules (fallback)';
  } else {
    sess.parseRulesLabel = source === 'custom' ? `custom (${path.basename(customPath)})` : 'built-in rules';
  }

  for (const err of result.errors) logger.info(`Skipped parse rule: ${err}`);
  if (result.loaded === 0 && result.skipped.length > 0) {
    logger.warn(`Fallback parse rules ${source} → empty: reason=no valid rules in config`);
    vscode.window.showWarningMessage('Data Lineage: Parse rules config invalid — check Output channel.');
  } else {
    logger.info(`Applied parse rules: ${result.loaded} loaded from ${source}, ${result.skipped.length} skipped`);
  }
}
