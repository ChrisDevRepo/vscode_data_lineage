import * as vscode from 'vscode';
import * as path from 'path';
import { getSession } from './ai/session/session';
import { registerCommands } from './commands';
import { openPanel, getActivePanel, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { postToWebview } from './bridge/host';
import { Logger } from './utils/log';
import { notifyError, notifyWarning } from './utils/notifications';
import { migrateProjectStore, type ProjectStore, type ProjectStoreDropReport } from './engine/projectStore';
import { type AiOutputSections, type AiOutputTemplates, type AiOutputTemplateSet, EMPTY_AI_TEMPLATES, EMPTY_AI_SECTIONS, AI_TEMPLATE_SCHEMA_VERSION } from './ai/session/types';
import { buildAiToolRegistry, createEffectSerializer, createExternalToolSource, registerAiTools } from './ai/tools/toolProvider';
import { readStoredRun } from './ai/session/runStore';
import { LineageParticipant } from './ai/participant/lineageParticipant';
import { LineageRuntime } from './ai/runtime/lineageRuntime';
import { AiTraceWriter } from './ai/observability/aiTraceWriter';
import { migrateFromWorkspaceState } from './utils/migration';
import { loadRules } from './engine/sqlBodyParser';
import { DEFAULT_AI_ENABLED, DEFAULT_MCP_ENABLED, parseAiOutputTemplatesYaml, parseParseRulesYaml, readAiOutputSections, REQUIRED_AI_TEMPLATE_KEYS } from './configCore';
import { turnTokenBudgetFromSettings } from './ai/support/tokenBudget';
import { resolveWorkspacePath, persistAbsolutePath } from './utils/paths';
import { buildExtensionConfig } from './bridge/messageHandlers';

declare const __BUILD_TIMESTAMP__: string;

/** Settings that load or drop a whole feature bundle at activation; a change applies on reload. */
const KILL_SWITCHES = [
  { key: 'dataLineageViz.ai.enabled', label: 'AI features', fallback: DEFAULT_AI_ENABLED },
  { key: 'dataLineageViz.mcp.enabled', label: 'MCP server', fallback: DEFAULT_MCP_ENABLED },
] as const;

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

  await loadParseRules(outputChannel, context.extensionUri).catch(err => {
    logger.error('load parse rules at activation', err);
  });

  const projectLogger = Logger.create(outputChannel, 'Project');
  let droppedProjectsReported = false;
  const reportDroppedProjects = ({ dropped, droppedViews = 0, issuePaths }: ProjectStoreDropReport): void => {
    if (dropped <= 0 && droppedViews <= 0) return;
    if (droppedProjectsReported) {
      projectLogger.debug(
        `Project store validation — dropped=${dropped} views=${droppedViews} fields=${issuePaths.join(', ') || 'unknown'} (already reported this session)`,
      );
      return;
    }
    droppedProjectsReported = true;
    const skipped = [
      dropped > 0 ? `${dropped} saved ${dropped === 1 ? 'project' : 'projects'}` : '',
      droppedViews > 0 ? `${droppedViews} saved ${droppedViews === 1 ? 'view' : 'views'}` : '',
    ].filter(Boolean).join(' and ');
    notifyWarning(
      projectLogger,
      'Project store validation',
      `Data Lineage: ${skipped} could not be read. Those entries were skipped. See the Data Lineage Viz output channel for details.`,
      { droppedProjects: dropped, droppedViews, invalidFields: issuePaths.length > 0 ? issuePaths : 'unknown' },
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

  const templateSet = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
    logger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
    return { templates: { ...EMPTY_AI_TEMPLATES }, sections: EMPTY_AI_SECTIONS };
  });
  getSession().outputTemplates = templateSet.templates;
  getSession().outputSections = templateSet.sections;

  const aiEnabled = vscode.workspace
    .getConfiguration('dataLineageViz.ai')
    .get<boolean>('enabled', DEFAULT_AI_ENABLED);

  const missingAiApis = [
    typeof vscode.chat?.createChatParticipant === 'function' ? '' : 'chat participants (vscode.chat)',
    typeof vscode.lm?.registerTool === 'function' ? '' : 'language-model tools (vscode.lm)',
  ].filter(Boolean);

  let lineageRuntime: LineageRuntime | undefined;
  let participant: LineageParticipant | undefined;
  const runStoreLogger = Logger.create(outputChannel, 'AI');
  const aiToolHost = {
    getStoredRun: (bookmarkId: string) => readStoredRun(context.globalState, bookmarkId, runStoreLogger),
    // One queue orders the state-changing tool calls of chat turns, `vscode.lm` and MCP alike.
    serialize: createEffectSerializer(),
  };
  const externalTools = createExternalToolSource(getSession, outputChannel, getActivePanel, {
    ...aiToolHost,
    readBudget: () => turnTokenBudgetFromSettings(vscode.workspace.getConfiguration('dataLineageViz')),
  });

  // Kill switch: the MCP bundle and its SDK load only while the setting is on at activation.
  const mcpLoaded = vscode.workspace.getConfiguration('dataLineageViz.mcp').get<boolean>('enabled', DEFAULT_MCP_ENABLED);
  if (mcpLoaded) {
    const { registerMcpServer } = await import('./mcpRuntime.js');
    context.subscriptions.push(registerMcpServer(context, outputChannel, externalTools));
  }

  try {
    if (aiEnabled && missingAiApis.length > 0) {
      logger.info(
        `AI surface unavailable — this editor does not provide ${missingAiApis.join(' or ')}. `
        + 'Lineage visualisation, parsing and the graph are unaffected.',
      );
    } else if (aiEnabled) {
    context.subscriptions.push(...registerAiTools(externalTools));

    lineageRuntime = new LineageRuntime({
      getSession,
      createRegistry: (lease, model) =>
        buildAiToolRegistry(getSession, outputChannel, getActivePanel, lease, { ...aiToolHost, model, signal: lease.signal, budget: model.budget }),
      logger: Logger.create(outputChannel, 'AI'),
      traceWriter,
    });

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

  const configLogger = Logger.create(outputChannel, 'Config');
  const RELOAD_KEYS: Array<{ key: string; label: string }> = [
    { key: 'dataLineageViz.parseRulesFile', label: 'Parse rules file' },
    { key: 'dataLineageViz.dmvQueriesFile', label: 'DMV queries file' },
    { key: 'dataLineageViz.maxNodes', label: 'Max nodes' },
    { key: 'dataLineageViz.excludePatterns', label: 'Exclusion patterns' },
    { key: 'dataLineageViz.externalRefs.enabled', label: 'External reference detection' },
  ];

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

      // Kill switches load or drop whole bundles at activation, so a change applies on reload.
      for (const { key, label, fallback } of KILL_SWITCHES) {
        if (!e.affectsConfiguration(key)) continue;
        const nowEnabled = vscode.workspace.getConfiguration().get<boolean>(key, fallback);
        // A loaded MCP controller applies both directions at once; with none loaded, off has nothing to stop.
        if (key === 'dataLineageViz.mcp.enabled' && (mcpLoaded || !nowEnabled)) continue;
        const msg = `${label} ${nowEnabled ? 'enabled' : 'disabled'}. Reload the window to apply.`;
        configLogger.info(`Config changed — ${key}=${nowEnabled}; notification="${msg}"`);
        const pick = await vscode.window.showInformationMessage(msg, 'Reload Window');
        if (pick === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }

      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri).catch(err => {
          configLogger.warn(`Failed to load AI output templates: ${err instanceof Error ? err.message : String(err)} — using empty defaults`);
          return { templates: { ...EMPTY_AI_TEMPLATES }, sections: EMPTY_AI_SECTIONS };
        });
        getSession().outputTemplates = t.templates;
        getSession().outputSections = t.sections;
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
          if (pick === 'Reload') {
            const panel = getActivePanel();
            if (panel) {
              panel.reveal();
              void postToWebview(panel, { type: 'reload-source' }, configLogger);
            } else {
              void vscode.commands.executeCommand('dataLineageViz.open');
            }
          }
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
 * Extension deactivation: closes the AI trace writer so buffered trace records are flushed.
 *
 * @remarks
 * Every other disposable from {@link activateRuntime} is on `context.subscriptions` and torn down
 * by VS Code; panel resources such as database connections are released by each panel's
 * `onDidDispose` handler.
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
 * @returns A promise resolving to the validated and merged `AiOutputTemplates` and the section labels
 *   declared by the capture recipes (a custom file's list replaces the built-in list of the same recipe).
 */
async function loadAiOutputTemplates(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<AiOutputTemplateSet> {
  const logger = Logger.create(outputChannel, 'Config');
  const builtIn: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
  const builtInKeys: string[] = [];
  let sections: AiOutputSections = EMPTY_AI_SECTIONS;
  const result = (): AiOutputTemplateSet => ({ templates: builtIn, sections });

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
    sections = readAiOutputSections(parsed).sections;
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
    return result();
  }

  const resolved = resolveWorkspacePath(customPath);
  if (!resolved) {
    notifyWarning(
      logger,
      'Load custom AI output templates',
      `Data Lineage: Failed to load custom AI output templates from "${customPath}" — using built-in defaults.`,
      { reason: 'cannot resolve path', path: customPath, setting: 'ai.outputTemplateFile', fallback: 'built-in defaults' },
    );
    return result();
  }

  logger.debug(`Reading AI templates custom: ${resolved}`);
  const overlaid: string[] = [];
  try {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
    const parsed = parseAiOutputTemplatesYaml(new TextDecoder().decode(data));
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
      return result();
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
    const custom = readAiOutputSections(parsed);
    for (const key of custom.rejected) {
      logger.warn(`Skipped AI template '${key}' sections: must be a non-empty list of section labels — keeping the built-in labels`);
    }
    sections = { ...sections, ...custom.sections };
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

  return result();
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

  const builtIn = config;
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

  const result = loadRules(config, source === 'custom' ? builtIn ?? undefined : undefined);
  const appliedFrom = result.usedFallback ? 'built-in (fallback)' : source;
  const sess = getSession();
  if (result.usedFallback) {
    sess.parseRulesLabel = 'built-in rules (fallback)';
  } else if (result.loaded === 0) {
    sess.parseRulesLabel = 'none (no valid rules)';
  } else {
    sess.parseRulesLabel = source === 'custom' ? `custom (${path.basename(customPath)})` : 'built-in rules';
  }

  for (const err of result.errors) logger.info(`Skipped parse rule: ${err}`);
  logger.info(`Applied parse rules: ${result.loaded} loaded from ${appliedFrom}, ${result.skipped.length} skipped`);
  if (result.skipped.length > 0 || result.loaded === 0 || result.usedFallback) {
    const userMessage = result.loaded === 0
      ? 'Data Lineage: Parse rules config invalid — check Output channel.'
      : result.usedFallback
        ? 'Data Lineage: the custom parse rules file has no valid rule — extraction uses the built-in rules. Check Output channel.'
        : `Data Lineage: ${result.skipped.length} parse rule(s) skipped as invalid — extraction runs with the remaining ${result.loaded}. Check Output channel.`;
    notifyWarning(
      logger,
      'Apply parse rules',
      userMessage,
      {
        source: appliedFrom,
        reason: result.loaded === 0 || result.usedFallback ? 'no valid rules in config' : 'invalid rules skipped',
        skipped: result.skipped.length,
        loaded: result.loaded,
      },
    );
  }
}
