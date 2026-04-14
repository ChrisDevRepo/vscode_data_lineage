import * as vscode from 'vscode';
import { AiSession, getSession } from './ai/session';
import { registerAiTools } from './ai/toolProvider';
import { registerCommands } from './commands';
import { openPanel, deactivatePanels, getActivePanel, SidebarProvider } from './panelProvider';
import { logInfo, logDebug, logWarn, logError, trunc } from './utils/log';
import { buildPlatformContext, buildSchemaContext, buildSystemPromptBase, buildTracePrompt, buildSearchPrompt, buildActionRequiredGate, ACTION_REQUIRED_PENDING_HINT } from './ai/prompts';
import { buildCtPrompt, buildCtDepPrompt, buildBbPrompt, buildSynthesisPrompt, buildSynthesisReminder } from './ai/smPrompts';
import { compactNoiseResult, compactStaleHopResult, MIN_HISTORY_MESSAGES, buildEvictionStub } from './ai/historyManager';
import { CONTEXT_PRESSURE_THRESHOLD } from './ai/tokenBudget';
import { setInlineTokenBudget, setSmInlineNodeCap, shouldSmInline } from './ai/tools';
import { ColumnTraceState } from './ai/columnTraceState';
import { BlackboardState } from './ai/blackboardState';

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

  // ─── Command Registration ──────────────────────────────────────────────────
  context.subscriptions.push(...registerCommands(
    context, 
    getSession, 
    outputChannel, 
    (ctx, title, demo) => openPanel(ctx, title, getSession, outputChannel, (c) => ({ projects: [] }), async (c, s) => {}, async (c) => {}, demo),
    buildDebugDump
  ));

  // ─── AI Language Model Tools ───────────────────────────────────────────────
  context.subscriptions.push(...registerAiTools(getSession, outputChannel, getActivePanel));

  // ─── @lineage Chat Participant ─────────────────────────────────────────────
  registerChatParticipant(context, getSession, outputChannel);
}

export function deactivate() {
  deactivatePanels(outputChannel);
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

function buildDebugDump(context: vscode.ExtensionContext): string {
  return "Debug Info Placeholder";
}
