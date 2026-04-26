import * as vscode from 'vscode';
import { z } from 'zod';
import { Logger, type LogCategory } from '../utils/log';
import { ExtensionToWebviewMsgSchema, type ExtensionToWebviewMsg } from '../engine/shared/bridgeContract';

/** 
 * Defines the abstract interface for the extension-webview communication bridge.
 *
 * This host abstraction decouples the bridge logic from the concrete VS Code API,
 * enabling unit testing in pure Node.js environments and providing a unified
 * interface for logging, state management, and file system operations.
 */
export interface BridgeHost {
  /** Sends a type-safe message from the extension host to the webview. */
  postMessage(msg: ExtensionToWebviewMsg): Thenable<boolean>;
  /** Records a log entry with a specific severity level and category. */
  log(level: 'info' | 'debug' | 'warn' | 'error', cat: LogCategory, text: string, err?: any): void;
  /** Displays a VS Code error notification to the user. */
  showErrorMessage(msg: string): void;
  /** Executes a VS Code command with optional arguments. */
  executeCommand(command: string, ...args: any[]): Thenable<any>;
  /** Opens a URL in the user's default external browser. */
  openExternal(url: string): Thenable<boolean>;
  /** Displays the standard VS Code file open dialog. */
  showOpenDialog(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
  /** Displays the standard VS Code file save dialog. */
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  /** Reads the contents of a file from the local file system. */
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  /** Writes data to a file in the local file system. */
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  /** Displays a progress notification while executing an asynchronous task. */
  withProgress<R>(options: vscode.ProgressOptions, task: (progress: vscode.Progress<any>, token: vscode.CancellationToken) => Thenable<R>): Thenable<R>;
  /** Retrieves the extension's workspace configuration. */
  getConfiguration(): vscode.WorkspaceConfiguration;
  /** Returns the base URI where the extension is installed. */
  getExtensionUri(): vscode.Uri;
  /** Accesses the extension's global persistent state storage. */
  getGlobalState(): vscode.Memento;
  /** Accesses the extension's workspace-specific persistent state storage. */
  getWorkspaceState(): vscode.Memento;
}

/**
 * Creates a concrete {@link BridgeHost} implementation tied to a specific WebviewPanel.
 *
 * This factory function initializes the bridge with the necessary VS Code context,
 * providing the required implementations for communication, logging, and OS-level interactions.
 *
 * @param panel - The VS Code webview panel to host the bridge.
 * @param context - The extension context for persistent state access.
 * @param outputChannel - The logger output channel for debug information.
 * @returns A fully initialized BridgeHost instance.
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
          return Promise.resolve(false);
        }
        throw err;
      }
    },
    log: (level, cat, text, err) => {
      const logger = Logger.create(outputChannel, cat);
      if (level === 'info') logger.info(text);
      else if (level === 'warn') logger.warn(text);
      else if (level === 'error') logger.error(text, err);
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

/**
 * Transforms a detailed ZodError into a concise, human-readable summary.
 *
 * This is primarily used for logging validation failures in IPC messages
 * without overwhelming the output log with deeply nested object structures.
 *
 * @param err - The Zod validation error to summarize.
 * @returns A single-line summary string of the validation issues.
 */
export function summarizeZodError(err: z.ZodError): string {
  const issues = err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return `${issues.length} validation issues: ${issues.slice(0, 3).join(', ')}${issues.length > 3 ? '...' : ''}`;
}
