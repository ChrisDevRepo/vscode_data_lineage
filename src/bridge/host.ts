import * as vscode from 'vscode';
import { z } from 'zod';
import { Logger, type LogCategory } from '../utils/log';
import { ExtensionToWebviewMsgSchema, type ExtensionToWebviewMsg } from '../engine/shared/bridgeContract';

/** 
 * BridgeHost abstracts the VS Code specific parts of the bridge
 * allowing the logic to be unit tested in a pure Node.js environment.
 */
export interface BridgeHost {
  postMessage(msg: ExtensionToWebviewMsg): Thenable<boolean>;
  log(level: 'info' | 'debug' | 'warn' | 'error' | 'trace', cat: LogCategory, text: string, err?: any): void;
  showErrorMessage(msg: string): void;
  executeCommand(command: string, ...args: any[]): Thenable<any>;
  openExternal(url: string): Thenable<boolean>;
  showOpenDialog(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  withProgress<R>(options: vscode.ProgressOptions, task: (progress: vscode.Progress<any>, token: vscode.CancellationToken) => Thenable<R>): Thenable<R>;
  getConfiguration(): vscode.WorkspaceConfiguration;
  getExtensionUri(): vscode.Uri;
  getGlobalState(): vscode.Memento;
  getWorkspaceState(): vscode.Memento;
}

/**
 * Creates a BridgeHost implementation for a specific WebviewPanel.
 * Encapsulates logging, progress, and VS Code API access.
 */
export function createBridgeHost(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, outputChannel: vscode.LogOutputChannel): BridgeHost {
  const bridgeLogger = Logger.create(outputChannel, 'Bridge');
  return {
    postMessage: (msg) => {
      try {
        const validated = ExtensionToWebviewMsgSchema.parse(msg);
        return panel.webview.postMessage(validated);
      } catch (err) {
        if (err instanceof z.ZodError) {
          bridgeLogger.error(`Outgoing validation failed for ${msg.type}`, summarizeZodError(err));
          return panel.webview.postMessage(msg);
        }
        throw err;
      }
    },
    log: (level, cat, text, err) => {
      const logger = Logger.create(outputChannel, cat);
      if (level === 'info') logger.info(text);
      else if (level === 'warn') logger.warn(text);
      else if (level === 'error') logger.error(text, err);
      else if (level === 'trace') logger.trace(text);
      else logger.debug(text);
    },
    showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
    executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    showOpenDialog: (opts) => vscode.window.showOpenDialog(opts),
    showSaveDialog: (opts) => vscode.window.showSaveDialog(opts),
    readFile: (uri) => vscode.workspace.fs.readFile(uri),
    writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
    withProgress: (opts, task) => vscode.window.withProgress(opts, task),
    getConfiguration: () => vscode.workspace.getConfiguration('dataLineageViz'),
    getExtensionUri: () => context.extensionUri,
    getGlobalState: () => context.globalState,
    getWorkspaceState: () => context.workspaceState,
  };
}

/** Summarize Zod errors to a single line to prevent log flooding. */
export function summarizeZodError(err: z.ZodError): string {
  const issues = err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return `${issues.length} validation issues: ${issues.slice(0, 3).join(', ')}${issues.length > 3 ? '...' : ''}`;
}
