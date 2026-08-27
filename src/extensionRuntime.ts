import * as vscode from 'vscode';
import * as path from 'path';
import { getSession } from './ai/session/session';
import { registerCommands } from './commands';
import { openPanel, getActivePanel, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { postToWebview } from './bridge/host';
import { Logger } from './utils/log';
import { notifyError, notifyWarning } from './utils/notifications';
import { migrateProjectStore, type ProjectStore, type ProjectStoreDropReport } from './engine/projectStore';
import { type AiOutputTemplates, EMPTY_AI_TEMPLATES, AI_TEMPLATE_SCHEMA_VERSION } from './ai/session/types';
import { buildAiToolRegistry, registerAiTools } from './ai/tools/toolProvider';
import { readStoredRun } from './ai/session/runStore';
import { LineageParticipant } from './ai/participant/lineageParticipant';
import { LineageRuntime } from './ai/runtime/lineageRuntime';
import { DEFAULT_MAX_ROUNDS } from './ai/core/agentCore';
import { AiTraceWriter } from './ai/observability/aiTraceWriter';
import { migrateFromWorkspaceState } from './utils/migration';
import { loadRules } from './engine/sqlBodyParser';
import { parseAiOutputTemplatesYaml, parseParseRulesYaml, REQUIRED_AI_TEMPLATE_KEYS } from './configCore';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import { buildExtensionConfig } from './bridge/messageHandlers';

declare const __BUILD_TIMESTAMP__: string;

/**
 * Fallback for `dataLineageViz.ai.enabled` when the setting is absent.
 *
 * @remarks
 * Mirrors the manifest default (`package.json` → `contributes.configuration` →
 * `dataLineageViz.ai.enabled`). Kept here rather than in `src/ai/**` so reading the
 * kill switch never pulls a module from the AI tree onto the activation path.
 */
const DEFAULT_AI_ENABLED = true;

let outputChannel: vscode.LogOutputChannel;
let activeTraceWriter: AiTraceWriter | undefined;

/**
 * Activates extension services in dependency order.
 *
 * @param context - VS Code extension context.
 * @returns An API object for testing and internal integration.
 */
export async function activateRuntime(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Data Lineage Viz', { log: true });
  context.subscriptions.push(outputChannel);
  const logger = Logger.create(outputChannel, 'Config');

  const buildStamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';
  logger.info(`Extension activated — built ${buildStamp}`);

  // Load SQL parsing rules for DDL extraction.
  await loadParseRules(outputChannel, context.extensionUri).catch(err => {
    logger.error('load parse rules at activation', err);
  });

  // Validation discards persisted projects it cannot read. That is data loss the user must hear
  // about once — every later load logs at debug so a repeated read cannot turn into toast spam.
  const projectLogger = Logger.create(outputChannel, 'Project');
  let droppedProjectsReported = false;
  const reportDroppedProjects = ({ dropped, issuePaths }: ProjectStoreDropReport): void => {
    if (dropped <= 0) return;
    if (droppedProjectsReported) {
      projectLogger.debug(
        `Project store validation — dropped=${dropped} fields=${issuePaths.join(', ') || 'unknown'} (already reported this session)`,
      );
      return;
    }
    droppedProjectsReported = true;
    const noun = dropped === 1 ? 'project' : 'projects';
    notifyWarning(
      projectLogger,
      'Project store validation',
      `Data Lineage: ${dropped} saved ${noun} could not be read and ${dropped === 1 ? 'was' : 'were'} skipped. See the Data Lineage Viz output channel for details.`,
      { droppedProjects: dropped, invalidFields: issuePaths.length > 0 ? issuePaths : 'unknown' },
    );
  };

  const loadStore = (c: vscode.ExtensionContext): ProjectStore =>
    migrateProjectStore(c.globalState.get(PROJECT_STORE_KEY), reportDroppedProjects);
  const saveStore = async (c: vscode.ExtensionContext, s: ProjectStore) => { await c.globalState.update(PROJECT_STORE_KEY, s); };
  const traceWriter = new AiTraceWriter((error, firstFailure) => {
    const message = `[AI] trace writer failed: ${error instanceof Error ? error.name : 'Error'}`;
    if (firstFailure) logger.warn(message);
    else logger.debug(message);
  });
  activeTraceWriter = traceWriter;
  context.subscriptions.push({
    dispose: () => {
      void traceWriter.close();
    },
  });

  // Register all user-facing commands.
  context.subscriptions.push(...registerCommands(
    context,
    getSession,
    outputChannel,
    (ctx, title, demo) => {
      Logger.create(outputChannel, 'Bridge').debug(`Command executed: openPanel (demo=${demo})`);
      return openPanel(
        ctx,
        title,
        getSession,
        outputChannel,
        loadStore,
        saveStore,
        async (c) => { await migrateFromWorkspaceState(c, PROJECT_STORE_KEY, outputChannel, reportDroppedProjects); },
        demo
      );
    },
    (ctx) => buildDebugDump(ctx, getSession),
    traceWriter,
  ));

  // Loaded after commands: only the AI turn path reads it, so a stall here cannot cost every command.
  const templates = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
    logger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
    return { ...EMPTY_AI_TEMPLATES };
  });
  getSession().outputTemplates = templates;

  // The kill switch prevents AI registration and turn execution. Imports remain static because the
  // extension is emitted as a single CommonJS bundle without a code-splitting boundary.
  const aiEnabled = vscode.workspace
    .getConfiguration('dataLineageViz.ai')
    .get<boolean>('enabled', DEFAULT_AI_ENABLED);

  // Feature-detect both namespaces and members because editor builds or policy may omit them.
  const missingAiApis = [
    typeof vscode.chat?.createChatParticipant === 'function' ? '' : 'chat participants (vscode.chat)',
    typeof vscode.lm?.registerTool === 'function' ? '' : 'language-model tools (vscode.lm)',
  ].filter(Boolean);

  let lineageRuntime: LineageRuntime | undefined;
  let participant: LineageParticipant | undefined;

  // Contain optional AI initialization so a failure cannot disable parsing and visualization.
  try {
    if (aiEnabled && missingAiApis.length > 0) {
      // Output channel only, never a notification: a host without these namespaces is an editor
      // fork or a policy that switched AI off, so its user chose this state and would meet the
      // same popup on every window start. The absence is a diagnostic, not an incident.
      logger.info(
        `AI surface unavailable — this editor does not provide ${missingAiApis.join(' or ')}. `
        + 'Lineage visualisation, parsing and the graph are unaffected.',
      );
    } else if (aiEnabled) {
    // Retain contributed language-model tools for external VS Code compatibility.
    // Their invocations route through the same canonical strict registry builder;
    // the @lineage runtime dispatches its graph calls directly.
    const aiToolHost = {
      getStoredRun: (bookmarkId: string) => readStoredRun(context.globalState, bookmarkId),
    };
    context.subscriptions.push(
      ...registerAiTools(getSession, outputChannel, getActivePanel, aiToolHost),
    );

    // One native runtime. Every turn receives its exact ChatRequest.model and a
    // lease-bound strict registry for direct dispatch.
    lineageRuntime = new LineageRuntime({
      getSession,
      createRegistry: (lease) =>
        buildAiToolRegistry(getSession, outputChannel, getActivePanel, lease, aiToolHost),
      logger: Logger.create(outputChannel, 'AI'),
      maxRounds: vscode.workspace
        .getConfiguration('dataLineageViz')
        .get<number>('ai.maxRounds', DEFAULT_MAX_ROUNDS),
      traceWriter,
    });

    // Register the thin native Chat Participant.
    participant = new LineageParticipant(
      context,
      getSession,
      outputChannel,
      lineageRuntime,
      traceWriter,
    );
    participant.register();
    } else {
      logger.info(
        'AI surface disabled — dataLineageViz.ai.enabled is false; the @lineage participant, ' +
        'the language-model tools and the AI runtime were not loaded.',
      );
    }
  } catch (err) {
    // Degrade visibly, never silently: the core product continues, and the user is told the
    // AI half is unavailable and why.
    lineageRuntime = undefined;
    participant = undefined;
    const detail = err instanceof Error ? err.message : String(err);
    notifyWarning(
      logger,
      'Initialise AI surface',
      `Data Lineage: the AI assistant could not start (${detail}). `
      + 'Lineage visualisation, parsing and the graph are unaffected.',
      { aiEnabled: String(aiEnabled) },
    );
  }

  // Watch for configuration changes and trigger reloads where necessary.
  const configLogger = Logger.create(outputChannel, 'Config');
  const RELOAD_KEYS: Array<{ key: string; label: string }> = [
    { key: 'dataLineageViz.parseRulesFile', label: 'Parse rules file' },
    { key: 'dataLineageViz.dmvQueriesFile', label: 'DMV queries file' },
    { key: 'dataLineageViz.maxNodes', label: 'Max nodes' },
    { key: 'dataLineageViz.excludePatterns', label: 'Exclusion patterns' },
    { key: 'dataLineageViz.externalRefs.enabled', label: 'External reference detection' },
  ];

  // Display-only settings that can be applied to an open panel without reloading data.
  const DISPLAY_KEYS = [
    'dataLineageViz.layout.direction',          'dataLineageViz.layout.rankSeparation',
    'dataLineageViz.layout.nodeSeparation',     'dataLineageViz.layout.edgeAnimation',
    'dataLineageViz.layout.highlightAnimation', 'dataLineageViz.layout.minimapEnabled',
    'dataLineageViz.layout.edgeStyle',          'dataLineageViz.renderLimit',
    'dataLineageViz.overview.enabled',
    'dataLineageViz.overview.threshold',        'dataLineageViz.overview.schemaDoubleClickBehavior',
    'dataLineageViz.trace.defaultUpstreamLevels', 'dataLineageViz.trace.defaultDownstreamLevels',
    'dataLineageViz.analysis.hubMinDegree',     'dataLineageViz.analysis.islandMaxSize',
    'dataLineageViz.analysis.longestPathMinNodes',
  ];

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('dataLineageViz')) return;
      configLogger.debug('Settings changed — dataLineageViz.*');

      // The kill switch decides what gets imported at activation, so it can only be
      // applied by a window reload — no hot re-registration.
      if (e.affectsConfiguration('dataLineageViz.ai.enabled')) {
        const nowEnabled = vscode.workspace
          .getConfiguration('dataLineageViz.ai')
          .get<boolean>('enabled', DEFAULT_AI_ENABLED);
        const msg = `AI features ${nowEnabled ? 'enabled' : 'disabled'}. Reload the window to apply.`;
        configLogger.info(`Config changed — dataLineageViz.ai.enabled=${nowEnabled}; notification="${msg}"`);
        const pick = await vscode.window.showInformationMessage(msg, 'Reload Window');
        if (pick === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }

      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
          configLogger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
          return { ...EMPTY_AI_TEMPLATES };
        });
        getSession().outputTemplates = t;
      }

      if (e.affectsConfiguration('dataLineageViz.parseRulesFile')) {
        await loadParseRules(outputChannel, context.extensionUri).catch(err => {
          configLogger.error('reload parse rules on setting change', err);
        });
      }

      for (const { key, label } of RELOAD_KEYS) {
        if (e.affectsConfiguration(key)) {
          const msg = `${label} changed. Reload your data source to apply.`;
          configLogger.info(`Config changed — notification="${msg}"`);
          const pick = await vscode.window.showInformationMessage(msg, 'Reload');
          if (pick === 'Reload') void vscode.commands.executeCommand('dataLineageViz.open');
          break;
        }
      }

      if (DISPLAY_KEYS.some(k => e.affectsConfiguration(k))) {
        const panel = getActivePanel();
        if (panel) {
          const config = buildExtensionConfig(vscode.workspace.getConfiguration('dataLineageViz'));
          void postToWebview(panel, { type: 'rebuild-config', config }, configLogger);
          configLogger.debug('Display settings changed — pushed rebuild-config to panel');
        }
      }
    })
  );

  return {
    getSession,
    getActivePanel,
    participant,
    lineageRuntime,
  };
}

/**
 * Extension Deactivation Lifecycle.
 *
 * @remarks
 * No explicit cleanup is required — every disposable from {@link activateRuntime}
 * (output channel, command registrations, tree provider, chat participant,
 * config-change listener, AI tools) is pushed onto `context.subscriptions`
 * and torn down by VS Code automatically. Panel-specific resources such as
 * database connections are released through each panel's own `onDidDispose`
 * handler, again outside this function's responsibility.
 */
export async function deactivate(): Promise<void> {
  const traceWriter = activeTraceWriter;
  activeTraceWriter = undefined;
  await traceWriter?.close();
}

export default { activateRuntime, deactivate };

/**
 * Loads AI Output Templates from built-in assets and optional user overrides.
 *
 * These templates provide the structural instructions used by the AI to generate
 * summaries, section titles, and highlighted badges in the UI.
 *
 * @param outputChannel - The log channel for reporting load status.
 * @param extensionUri - The root URI of the extension.
 * @returns A promise resolving to the validated and merged `AiOutputTemplates`.
 */
async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplates> {
  const logger = Logger.create(outputChannel, 'Config');
  const builtIn: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
  const builtInKeys: string[] = [];

  const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'aiOutputTemplates.yaml');
  logger.debug(`Reading AI templates built-in: ${builtInUri.fsPath}`);
  try {
    const data = await vscode.workspace.fs.readFile(builtInUri);
    const parsed = parseAiOutputTemplatesYaml(new TextDecoder().decode(data));
    for (const key of REQUIRED_AI_TEMPLATE_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
        builtInKeys.push(key);
      } else {
        logger.debug(`Skipped AI template '${key}': built-in missing or non-string 'instruction' field`);
      }
    }
  } catch (err) {
    notifyError(
      logger,
      'Load built-in AI templates',
      'Data Lineage: failed to load built-in AI output templates — AI descriptions may be degraded. Check the Output channel for details.',
      err,
      { path: builtInUri.fsPath },
    );
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
  const customPath = cfg.get<string>('outputTemplateFile', '');
  if (!customPath) {
    logger.info(`Applied AI templates: ${builtInKeys.length} loaded from built-in, 0 overlaid`);
    return builtIn;
  }

  const resolved = resolveWorkspacePath(customPath);
  if (!resolved) {
    notifyWarning(
      logger,
      'Load custom AI output templates',
      `Data Lineage: Failed to load custom AI output templates from "${customPath}" — using built-in defaults.`,
      { reason: 'cannot resolve path', path: customPath, setting: 'ai.outputTemplateFile', fallback: 'built-in defaults' },
    );
    return builtIn;
  }

  logger.debug(`Reading AI templates custom: ${resolved}`);
  const overlaid: string[] = [];
  try {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
    const parsed = parseAiOutputTemplatesYaml(new TextDecoder().decode(data));
    // Apply custom templates only when their schema version matches the current contract.
    const customVersion = parsed.schemaVersion;
    if (customVersion !== AI_TEMPLATE_SCHEMA_VERSION) {
      notifyWarning(
        logger,
        'Load custom AI output templates',
        `Data Lineage: Custom AI output templates declare schemaVersion ${String(customVersion ?? 'missing')} but this ` +
        `release expects ${AI_TEMPLATE_SCHEMA_VERSION} — the template structure changed. Re-scaffold via ` +
        `"Data Lineage: Create AI Output Templates" and re-apply your edits; using built-in defaults until then.`,
        {
          customVersion: customVersion ?? null,
          expectedVersion: AI_TEMPLATE_SCHEMA_VERSION,
          path: resolved,
          setting: 'ai.outputTemplateFile',
          fallback: 'built-in defaults',
        },
      );
      return builtIn;
    }
    if (parsed && typeof parsed === 'object') {
      const required = new Set<string>(REQUIRED_AI_TEMPLATE_KEYS);
      for (const key of Object.keys(parsed)) {
        if (key === 'schemaVersion') continue; // structural metadata, not a template key
        if (!required.has(key)) {
          logger.warn(`Skipped AI template '${key}': unknown key — must be one of ${REQUIRED_AI_TEMPLATE_KEYS.join(', ')}`);
        }
      }
    }
    for (const key of REQUIRED_AI_TEMPLATE_KEYS) {
      const entry = parsed?.[key];
      if (entry?.instruction && typeof entry.instruction === 'string') {
        builtIn[key] = entry.instruction.trim();
        overlaid.push(key);
      } else if (entry !== undefined) {
        logger.debug(`Skipped AI template '${key}': missing or non-string 'instruction' field in custom YAML`);
      }
    }
    await persistAbsolutePath('ai.outputTemplateFile', customPath, resolved);
    logger.info(`Applied AI templates: ${builtInKeys.length} loaded from built-in, ${overlaid.length} overlaid from custom (${overlaid.join(', ') || 'none'})`);
  } catch (err) {
    notifyWarning(
      logger,
      'Load custom AI output templates',
      `Data Lineage: Failed to load custom AI output templates from "${customPath}" — using built-in defaults.`,
      { reason: err instanceof Error ? err.message : String(err), path: resolved, setting: 'ai.outputTemplateFile', fallback: 'built-in defaults' },
    );
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
  let config: ReturnType<typeof parseParseRulesYaml> | null = null;
  let source: 'built-in' | 'custom' = 'built-in';

  const builtInUri = vscode.Uri.joinPath(extensionUri, 'assets', 'defaultParseRules.yaml');
  logger.debug(`Reading parse rules built-in: ${builtInUri.fsPath}`);
  try {
    const data = await vscode.workspace.fs.readFile(builtInUri);
    config = parseParseRulesYaml(new TextDecoder().decode(data));
  } catch (err) {
    notifyError(
      logger,
      'Load built-in parse rules',
      'Data Lineage: failed to load built-in parse rules — SQL lineage parsing may be degraded. Check the Output channel for details.',
      err,
      { path: builtInUri.fsPath },
    );
  }

  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const customPath = cfg.get<string>('parseRulesFile', '');
  if (customPath) {
    const resolved = resolveWorkspacePath(customPath);
    if (resolved) {
      logger.debug(`Reading parse rules custom: ${resolved}`);
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        const parsed = parseParseRulesYaml(new TextDecoder().decode(data));
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          config = parsed;
          source = 'custom';
          await persistAbsolutePath('parseRulesFile', customPath, resolved);
        } else {
          notifyWarning(
            logger,
            'Load custom parse rules',
            `Custom parse rules invalid at "${resolved}" — using built-in defaults.`,
            { reason: 'missing or invalid rules array', path: resolved, setting: 'parseRulesFile', fallback: 'built-in defaults' },
          );
        }
      } catch (err) {
        notifyWarning(
          logger,
          'Load custom parse rules',
          `Failed to load custom parse rules from "${resolved}" — using built-in defaults. Check Output channel for details.`,
          { reason: err instanceof Error ? err.message : String(err), path: resolved, setting: 'parseRulesFile', fallback: 'built-in defaults' },
        );
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
  logger.info(`Applied parse rules: ${result.loaded} loaded from ${source}, ${result.skipped.length} skipped`);
  // Any skipped rule silently narrows extraction, so it is notified — not only the
  // total-failure case. The named per-rule reasons are on the `info` lines above.
  if (result.skipped.length > 0) {
    const allSkipped = result.loaded === 0;
    notifyWarning(
      logger,
      'Apply parse rules',
      allSkipped
        ? 'Data Lineage: Parse rules config invalid — check Output channel.'
        : `Data Lineage: ${result.skipped.length} parse rule(s) skipped as invalid — extraction runs with the remaining ${result.loaded}. Check Output channel.`,
      {
        source,
        reason: allSkipped ? 'no valid rules in config' : 'invalid rules skipped',
        skipped: result.skipped.length,
        loaded: result.loaded,
      },
    );
  }
}
