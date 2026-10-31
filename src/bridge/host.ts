import * as vscode from 'vscode';
import { z } from 'zod';
import { Logger, type LogCategory } from '../utils/log';
import { notifyError } from '../utils/notifications';
import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToWebviewMsgSchema,
  type ExtensionToWebviewMsg,
  ExtensionToDetailMsgSchema,
  type ExtensionToDetailMsg,
} from '../engine/shared/bridgeContract';

/** Defines the abstract interface for the extension-webview communication bridge. */
export interface BridgeHost {
  postMessage(msg: ExtensionToWebviewMsg): Thenable<boolean>;
  log(
    level: 'info' | 'debug' | 'warn' | 'error',
    cat: LogCategory,
    text: string,
    err?: unknown,
  ): void;
  showErrorMessage(msg: string): void;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  openExternal(url: string): Thenable<boolean>;
  showOpenDialog(
    options: vscode.OpenDialogOptions,
  ): Thenable<vscode.Uri[] | undefined>;
  showSaveDialog(
    options: vscode.SaveDialogOptions,
  ): Thenable<vscode.Uri | undefined>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  withProgress<R>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ) => Thenable<R>,
  ): Thenable<R>;
  getConfiguration(): vscode.WorkspaceConfiguration;
  getExtensionUri(): vscode.Uri;
  getGlobalState(): vscode.Memento;
}

/** The minimum a send target must expose, so a panel and a bare view share one send path. */
interface WebviewPostTarget {
  readonly webview: vscode.Webview;
}

/** Validates a message against the bridge schema before posting it. */
function postValidated<S extends z.ZodTypeAny>(
  target: WebviewPostTarget,
  schema: S,
  msg: z.infer<S>,
  label: string,
  logger: Logger,
  notifyDrop: boolean,
): Thenable<boolean> {
  const parsed = schema.safeParse(msg);
  if (!parsed.success) {
    const type = (msg as { type?: string }).type ?? '?';
    if (!notifyDrop) {
      logger.error(
        `${label}(${type}) — dropped, failed validation`,
        new Error(`issues=${summarizeZodError(parsed.error)}`),
      );
      return Promise.resolve(false);
    }
    notifyError(
      logger,
      `${label}(${type})`,
      `Data Lineage dropped an internal "${type}" message that failed validation — the view may be incomplete. See the Data Lineage output channel for detail.`,
      undefined,
      { issues: summarizeZodError(parsed.error) },
    );
    return Promise.resolve(false);
  }
  return target.webview.postMessage({
    ...(parsed.data as Record<string, unknown>),
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
  });
}

/** Sends a validated message to the main lineage webview. */
export function postToWebview(
  panel: vscode.WebviewPanel,
  msg: ExtensionToWebviewMsg,
  logger: Logger,
  notifyDrop = true,
): Thenable<boolean> {
  return postValidated(
    panel,
    ExtensionToWebviewMsgSchema,
    msg,
    'postToWebview',
    logger,
    notifyDrop,
  );
}

/**
 * Validated send to the **detail-panel** webview ({@link ExtensionToDetailMsgSchema}). Same
 * contract as {@link postToWebview}.
 */
export function postToDetail(
  panel: vscode.WebviewPanel,
  msg: ExtensionToDetailMsg,
  logger: Logger,
): Thenable<boolean> {
  return postValidated(
    panel,
    ExtensionToDetailMsgSchema,
    msg,
    'postToDetail',
    logger,
    true,
  );
}

/** Creates a concrete {@link BridgeHost} implementation tied to a specific WebviewPanel. */
export function createBridgeHost(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): BridgeHost {
  const bridgeLogger = Logger.create(outputChannel, 'Bridge');
  return {
    postMessage: (msg) => postToWebview(panel, msg, bridgeLogger),
    log: (level, cat, text, err) => {
      const logger = Logger.create(outputChannel, cat);
      if (level === 'info') logger.info(text);
      else if (level === 'warn') logger.warn(text);
      else if (level === 'error') logger.error(text, err);
      else logger.debug(text);
    },
    showErrorMessage: (msg) => {
      void vscode.window.showErrorMessage(msg);
    },
    executeCommand: (cmd, ...args) =>
      vscode.commands.executeCommand(cmd, ...args),
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    showOpenDialog: (opts) => vscode.window.showOpenDialog(opts),
    showSaveDialog: (opts) => vscode.window.showSaveDialog(opts),
    readFile: (uri) => vscode.workspace.fs.readFile(uri),
    writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
    withProgress: (opts, task) => vscode.window.withProgress(opts, task),
    getConfiguration: () => vscode.workspace.getConfiguration('dataLineageViz'),
    getExtensionUri: () => context.extensionUri,
    getGlobalState: () => context.globalState,
  };
}

/** Transforms a detailed ZodError into a concise, human-readable summary. */
export function summarizeZodError(err: z.ZodError): string {
  const issues = err.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  return `${issues.length} validation issues: ${issues.join(', ')}`;
}
