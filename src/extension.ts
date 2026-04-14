import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { AiSession, getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, deactivatePanels, getActivePanel, SidebarProvider, PROJECT_STORE_KEY, buildDebugDump } from './panelProvider';
import { logInfo, logDebug, logWarn, logError, trunc } from './utils/log';
import { migrateProjectStore, createProject, updateProject, generateProjectName } from './engine/projectStore';
import { stripSensitiveFields } from './engine/connectionManager';
import { IConnectionInfo } from './types/mssql';
import { setInlineTokenBudget, setSmInlineNodeCap } from './ai/tools';
import { 
  buildPlatformContext, buildSchemaContext, buildSystemPromptBase, 
  buildTracePrompt, buildSearchPrompt, buildActionRequiredGate, 
  ACTION_REQUIRED_PENDING_HINT 
} from './ai/prompts';
import { buildCtPrompt, buildCtDepPrompt, buildBbPrompt, buildSynthesisPrompt, buildSynthesisReminder } from './ai/smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './ai/historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './ai/tokenBudget';
import { type AiOutputTemplates, EMPTY_AI_TEMPLATES } from './ai/types';
import { ColumnTraceState } from './ai/columnTraceState';
import { BlackboardState } from './ai/blackboardState';

declare const __BUILD_TIMESTAMP__: string;

let outputChannel: vscode.LogOutputChannel;

/** Helper to extract callId, name, and input from various tool call part types */
function extractToolCallFields(tc: vscode.LanguageModelToolCallPart | { callId: string; name: string; input: any }): { callId: string; name: string; input: any } {
  return {
    callId: tc.callId,
    name: tc.name,
    input: tc.input,
  };
}

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
  registerChatParticipant(context, getSession, outputChannel);

  // ─── AI Config Watcher ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('dataLineageViz.ai.outputTemplateFile')) {
        const t = await loadAiOutputTemplates(outputChannel, context.extensionUri);
        getSession().outputTemplates = t;
      }
    })
  );

  // ─── AI Support Commands ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('dataLineageViz.createAiOutputTemplates', () =>
      createYamlScaffold(context, 'aiOutputTemplates.yaml', 'aiOutputTemplates.yaml', 'ai.outputTemplateFile')
    ),
    vscode.commands.registerCommand('dataLineageViz.aiCreateView', (originalPrompt: string) => {
      const viewPrompt = `Create an AI view from the trace above. Use the BFS results you already have — add badges, notes, and highlight groups. Name it based on the original question: "${trunc(originalPrompt || '', 60)}"`;
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@lineage ${viewPrompt}`,
      });
    })
  );
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
    await vscode.workspace.fs.stat(targetUri);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc);
    return;
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      const sourceUri = vscode.Uri.joinPath(context.extensionUri, 'assets', sourceAsset);
      await vscode.workspace.fs.copy(sourceUri, targetUri);
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Created ${fileName} in workspace root. Set "dataLineageViz.${settingName}" to "${fileName}" to use it.`);
    } else {
      throw err;
    }
  }
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
      const MAX_ROUNDS = aiConfig.get<number>('ai.maxRounds', 50);
      setInlineTokenBudget(aiConfig.get<number>('ai.inlineTokenBudget', 10_000));
      setSmInlineNodeCap(aiConfig.get<number>('ai.inlineNodeCap', 10));

      if (!sess.model) {
        stream.markdown('No lineage data loaded. Open a `.dacpac` file or connect to a database first.');
        return {};
      }

      logInfo(outputChannel, 'AI', `[${sess.id}] Session start — model=${request.model.id}, prompt="${trunc(request.prompt, 200)}"`);

      let activePhase: 'discover' | 'ct_active' | 'ct_done' | 'bb_active' | 'bb_done' = 'discover';
      const smDoneTools = () => vscode.lm.tools.filter(t => t.tags.includes('lineage') && t.name !== 'lineage_run_bfs_trace');
      let lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage'));

      let effectivePrompt = request.prompt;
      if (request.command === 'trace') {
        const traceTools = new Set(['lineage_search_objects', 'lineage_get_object_detail', 'lineage_get_ddl_batch', 'lineage_start_column_trace', 'lineage_submit_hop_analysis', 'lineage_enrich_view']);
        lineageTools = lineageTools.filter(t => traceTools.has(t.name));
        effectivePrompt = buildTracePrompt(request.prompt);
      } else if (request.command === 'search') {
        effectivePrompt = buildSearchPrompt(request.prompt);
      }

      const historyMessages: vscode.LanguageModelChatMessage[] = [];
      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          historyMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const meta = (turn.result.metadata as any)?.toolCallsMetadata as any;
          if (meta?.toolCallRounds?.length) {
            for (const round of meta.toolCallRounds) {
              const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
              if (round.response) assistantParts.push(new vscode.LanguageModelTextPart(round.response));
              for (const tc of round.toolCalls) {
                const f = extractToolCallFields(tc);
                if (meta.toolCallResults[f.callId]) {
                  assistantParts.push(new vscode.LanguageModelToolCallPart(f.callId, f.name, f.input));
                }
              }
              if (assistantParts.length) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));

              const resultParts: vscode.LanguageModelToolResultPart[] = [];
              for (const tc of round.toolCalls) {
                const f = extractToolCallFields(tc);
                const r = meta.toolCallResults[f.callId];
                if (r) {
                  let contentStr = (r.content as any[]).map(c => typeof c.value === 'string' ? c.value : JSON.stringify(c)).join('');
                  const compact = compactNoiseResult(f.name, contentStr) || compactStaleHopResult(f.name, contentStr, sess.stateMachine?.status === 'complete', false);
                  resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(compact || contentStr)]));
                }
              }
              if (resultParts.length) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
            }
          } else {
            const text = turn.response.filter(p => p instanceof vscode.ChatResponseMarkdownPart).map(p => (p as vscode.ChatResponseMarkdownPart).value.value).join('');
            if (text) historyMessages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, text));
          }
        }
      }

      const platformCtx = sess.model.dbPlatform ? buildPlatformContext(sess.model.dbPlatform) : '';
      const schemaCtx = (sess.filter?.schemas?.length ?? 0) > 0 ? buildSchemaContext(sess.filter!.schemas) : '';
      const systemPrompt = platformCtx + schemaCtx + buildSystemPromptBase(MAX_ROUNDS) +
        `   summary: ${sess.outputTemplates.summary}\n` +
        `   sections: ${sess.outputTemplates.sections}\n` +
        `   notes: ${sess.outputTemplates.notes}\n` +
        `   highlights: ${sess.outputTemplates.highlights}\n` +
        `   description (fallback): ${sess.outputTemplates.description}`;

      const serializeMessages = (msgs: vscode.LanguageModelChatMessage[]): string => {
        const parts: string[] = [];
        for (const m of msgs) {
          if (typeof m.content === 'string') { parts.push(m.content); continue; }
          if (!Array.isArray(m.content)) continue;
          for (const p of m.content as unknown[]) {
            if (p instanceof vscode.LanguageModelTextPart) parts.push(p.value);
            else if (p instanceof vscode.LanguageModelToolCallPart) parts.push(JSON.stringify(p.input));
            else if (p instanceof vscode.LanguageModelToolResultPart) {
              for (const c of (p as { content: unknown[] }).content) {
                if (c instanceof vscode.LanguageModelTextPart) parts.push(c.value);
              }
            }
          }
        }
        return parts.join('\n');
      };

      const budgetTokens = Math.floor(sess.maxInputTokens * CONTEXT_PRESSURE_THRESHOLD);
      if (historyMessages.length > MIN_HISTORY_MESSAGES) {
        try {
          const fullText = `${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`;
          let totalTokens = await request.model.countTokens(fullText);
          if (totalTokens > budgetTokens) {
            let evicted = 0;
            while (historyMessages.length > MIN_HISTORY_MESSAGES && totalTokens > budgetTokens) {
              historyMessages.shift(); evicted++;
              totalTokens = await request.model.countTokens(`${systemPrompt}\n${serializeMessages(historyMessages)}\n${effectivePrompt}`);
            }
            historyMessages.unshift(vscode.LanguageModelChatMessage.User(buildEvictionStub(evicted)));
          }
        } catch {}
      }

      const messages = [vscode.LanguageModelChatMessage.User(systemPrompt), ...historyMessages, vscode.LanguageModelChatMessage.User(effectivePrompt)];
      const toolCallRounds: any[] = [];
      const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
      const toolCallCache = new Map<string, vscode.LanguageModelToolResult>();
      let roundCount = 0;
      let totalToolCallsMade = 0;
      let lastInputTokenEstimate = 0;
      let totalOutputTokens = 0;
      let totalToolResultChars = 0;

      const runWithTools = async () => {
        let actionRequiredPending = false;
        const SEARCH_TOOLS = new Set(['lineage_search_objects', 'lineage_search_ddl', 'lineage_get_context']);
        let modePromptMsg: vscode.LanguageModelChatMessage | null = null;

        const cleanHopContext = (label: string) => {
          const lastAssistant = messages[messages.length - 2];
          const lastResult = messages[messages.length - 1];
          messages.length = 0;
          messages.push(vscode.LanguageModelChatMessage.User(systemPrompt), vscode.LanguageModelChatMessage.User(effectivePrompt));
          if (modePromptMsg) messages.push(modePromptMsg);
          messages.push(lastAssistant, lastResult);
          logDebug(outputChannel, 'AI', `[${label}] Clean hop context`);
        };

        while (roundCount < MAX_ROUNDS) {
          roundCount++;
          try { lastInputTokenEstimate = await request.model.countTokens(serializeMessages(messages)); } catch {}
          
          const response = await request.model.sendRequest(messages, { tools: lineageTools }, token);
          const assistantParts: any[] = [];
          const toolCalls: vscode.LanguageModelToolCallPart[] = [];
          let responseText = '';

          for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) { assistantParts.push(part); responseText += part.value; stream.markdown(part.value); }
            else if (part instanceof vscode.LanguageModelToolCallPart) { assistantParts.push(part); toolCalls.push(part); }
          }

          try { totalOutputTokens += await request.model.countTokens(responseText); } catch {}
          if (!toolCalls.length) return;

          if (actionRequiredPending && responseText.length > 0) actionRequiredPending = false;
          messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, assistantParts));

          const resultParts: vscode.LanguageModelToolResultPart[] = [];
          for (const call of toolCalls) {
            const f = extractToolCallFields(call);
            const cacheKey = `${f.name}::${JSON.stringify(f.input)}`;
            const cached = toolCallCache.get(cacheKey);
            if (cached) {
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ _dedup: true }))]));
              continue;
            }

            if (actionRequiredPending && !SEARCH_TOOLS.has(f.name)) {
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'action_required_pending', hint: ACTION_REQUIRED_PENDING_HINT }))]));
              continue;
            }

            stream.progress(`Invoking ${f.name.replace('lineage_', '')}...`);
            totalToolCallsMade++;
            try {
              const result = await vscode.lm.invokeTool(f.name, { input: f.input, toolInvocationToken: request.toolInvocationToken }, token);
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, result.content));
              accumulatedToolResults[f.callId] = result;
              toolCallCache.set(cacheKey, result);
              totalToolResultChars += JSON.stringify(result.content).length;
            } catch (err) {
              const errContent = [new vscode.LanguageModelTextPart(JSON.stringify({ error: 'tool_error', message: String(err) }))];
              resultParts.push(new vscode.LanguageModelToolResultPart(f.callId, errContent));
              accumulatedToolResults[f.callId] = new vscode.LanguageModelToolResult(errContent);
            }
          }

          messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, resultParts));
          
          for (const call of toolCalls) {
            const f = extractToolCallFields(call);
            const res = accumulatedToolResults[f.callId];
            if (res) {
              for (const p of res.content) {
                if (p instanceof vscode.LanguageModelTextPart) {
                  try { if (JSON.parse(p.value).action_required === 'analyze_and_respond') actionRequiredPending = true; } catch {}
                }
              }
            }
          }
          if (actionRequiredPending) messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, buildActionRequiredGate(['analyze_and_respond'])));

          toolCallRounds.push({ response: responseText, toolCalls });

          // Phase transitions
          const hasCtStart = toolCalls.some(tc => tc.name === 'lineage_start_column_trace');
          const hasCtSubmit = toolCalls.some(tc => tc.name === 'lineage_submit_hop_analysis');
          const hasExplStart = toolCalls.some(tc => tc.name === 'lineage_start_exploration');
          const hasSubFindings = toolCalls.some(tc => tc.name === 'lineage_submit_findings');

          if (hasCtStart && sess.stateMachine instanceof ColumnTraceState && activePhase === 'discover') {
            activePhase = 'ct_active';
            lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-ct'));
            modePromptMsg = vscode.LanguageModelChatMessage.User(sess.stateMachine.columns.length > 0 ? buildCtPrompt() : buildCtDepPrompt());
            messages.push(modePromptMsg);
          }
          if (sess.stateMachine?.status === 'complete' && activePhase === 'ct_active') {
            activePhase = 'ct_done';
            lineageTools = smDoneTools();
            if (!(sess.stateMachine as any).inlineMode) { modePromptMsg = vscode.LanguageModelChatMessage.User(buildSynthesisPrompt()); cleanHopContext('CT'); }
          }
          if (hasExplStart && sess.stateMachine instanceof BlackboardState && activePhase === 'discover') {
            activePhase = 'bb_active';
            lineageTools = vscode.lm.tools.filter(t => t.tags.includes('lineage-bb') || t.tags.includes('lineage-research'));
            modePromptMsg = vscode.LanguageModelChatMessage.User(buildBbPrompt());
            messages.push(modePromptMsg);
          }
          if (sess.stateMachine?.status === 'complete' && activePhase === 'bb_active') {
            activePhase = 'bb_done';
            lineageTools = smDoneTools();
            if (!(sess.stateMachine as any).inlineMode) { modePromptMsg = vscode.LanguageModelChatMessage.User(buildSynthesisPrompt()); cleanHopContext('BB'); }
          }

          if ((hasSubFindings || hasCtSubmit) && (activePhase === 'bb_active' || activePhase === 'ct_active') && sess.stateMachine?.status !== 'complete' && !(sess.stateMachine as any).inlineMode) {
            cleanHopContext(activePhase === 'bb_active' ? 'BB' : 'CT');
          }
        }
      };

      try {
        await runWithTools();
        const totalTokenEst = lastInputTokenEstimate + totalOutputTokens + Math.round(totalToolResultChars / 4);
        logInfo(outputChannel, 'AI', `Summary — rounds: ${roundCount}, tools: ${totalToolCallsMade}, tokens: ~${totalTokenEst}`);
        
        if (sess.stateMachine?.status === 'complete') {
          stream.markdown('\n\n' + buildSynthesisReminder(request.prompt));
        }

        const smComplete = sess.stateMachine?.status === 'complete';
        const hasBfs = toolCallRounds.some(r => r.toolCalls.some(tc => tc.name === 'lineage_run_bfs_trace'));
        if (getActivePanel() && (hasBfs || smComplete)) {
          stream.button({ command: 'dataLineageViz.aiCreateView', title: '$(type-hierarchy-sub) Show in Graph', arguments: [request.prompt] });
        }
      } catch (err) {
        logError(outputChannel, 'AI', 'Chat handler', err);
        stream.markdown(`\n\n*Error: ${err instanceof Error ? err.message : String(err)}*`);
      }

      return { metadata: { toolCallsMetadata: { toolCallRounds, toolCallResults: accumulatedToolResults }, lastTools: toolCallRounds.length > 0 ? toolCallRounds[toolCallRounds.length - 1].toolCalls.map(tc => tc.name) : [] } };
    }
  );

  participant.followupProvider = {
    provideFollowups(result) {
      const lastTools = (result.metadata as any)?.lastTools ?? [];
      const followups: vscode.ChatFollowup[] = [];
      if (lastTools.some(t => t.includes('bfs_trace'))) followups.push({ prompt: 'Create a view from this trace', label: 'Create AI view' });
      if (lastTools.some(t => t.includes('search'))) followups.push({ prompt: 'Trace the lineage from the top result', label: 'Trace lineage' });
      if (lastTools.some(t => t.includes('submit_hop') || t.includes('submit_findings'))) followups.push({ prompt: 'Show the trace result in the graph', label: 'Show in Graph' });
      return followups;
    }
  };

  participant.onDidReceiveFeedback((feedback) => {
    const kind = feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    logInfo(outputChannel, 'AI', `Feedback: ${kind}`);
  });

  context.subscriptions.push(participant);
}
