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
import { redactSecrets } from '../utils/redact';

/**
 * Defines the abstract interface for the extension-webview communication bridge.
 *
 * @remarks
 * Decouples bridge logic from the concrete VS Code API, enabling unit testing in pure Node.js environments.
 */
export interface BridgeHost {
  /** Sends a type-safe message from the extension host to the webview. */
  postMessage(msg: ExtensionToWebviewMsg): Thenable<boolean>;
  /**
   * Records a log entry with a specific severity level and category.
   *
   * @remarks
   * The text is redacted at every level, and at `error` level the error message and the stack too, before they
   * reach the output channel: warn, info and debug lines also carry caught driver messages.
   * Pass a message string, not a synthetic `Error`, when there is no thrown error: its stack names only the logging site.
   */
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

/** The minimum a send target must expose, so a panel and a bare view share one send path. */
interface WebviewPostTarget {
  readonly webview: vscode.Webview;
}

/**
 * The single sanctioned host→webview send primitive.
 *
 * @remarks
 * Validates `msg` against `schema` and **drops** a malformed frame (returning `false`) rather than
 * shipping it — a drop is a send-side bug. The webview is left waiting on data that will never
 * arrive, so the drop is notified as well as logged rather than being visible only to a developer
 * with the Output channel open. A caller that already tells the user about its `false` result passes
 * `notifyDrop = false`; the drop is then logged only, so one cause raises one notice. Raw `panel.webview.postMessage` bypasses the contract; go through
 * {@link postToWebview} / {@link postToDetail} (or {@link BridgeHost.postMessage}, which delegates).
 *
 * Being the one send path, this is also where {@link BRIDGE_PROTOCOL_VERSION} is stamped. The stamp
 * is applied to the *parsed* payload, after validation — Zod strips unknown keys, so stamping first
 * would silently drop it, and adding it to the unions would be schema churn every handler pays for.
 */
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

/**
 * Sends a validated message to the main lineage webview.
 *
 * @param notifyDrop - Raise the error toast when a malformed frame is dropped (default). A caller whose
 * `false` result already reaches the user through its own notice passes `false`; the drop is then a log line only.
 */
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

/** Validated send to the **detail-panel** webview ({@link ExtensionToDetailMsgSchema}). Same contract as {@link postToWebview}. */
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

/** Redacts credential-shaped text from a caught value's message and stack before it is logged. */
function redactErrorDetail(err: unknown): unknown {
  if (err instanceof Error) {
    const safe = new Error(redactSecrets(err.message));
    safe.name = err.name;
    safe.stack = err.stack === undefined ? undefined : redactSecrets(err.stack);
    return safe;
  }
  return err === undefined ? undefined : redactSecrets(String(err));
}

/** Creates a concrete {@link BridgeHost} implementation tied to a specific WebviewPanel. */
export function createBridgeHost(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, outputChannel: vscode.LogOutputChannel): BridgeHost {
  const bridgeLogger = Logger.create(outputChannel, 'Bridge');
  return {
    postMessage: (msg) => postToWebview(panel, msg, bridgeLogger),
    log: (level, cat, text, err) => {
      const logger = Logger.create(outputChannel, cat);
      const safeText = redactSecrets(text);
      if (level === 'info') logger.info(safeText);
      else if (level === 'warn') logger.warn(safeText);
      else if (level === 'error') logger.error(safeText, redactErrorDetail(err));
      else logger.debug(safeText);
    },
    showErrorMessage: (msg) => { void vscode.window.showErrorMessage(msg); },
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

/** Transforms a detailed ZodError into a concise, human-readable summary. */
export function summarizeZodError(err: z.ZodError): string {
  const issues = err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return `${issues.length} validation issues: ${issues.join(', ')}`;
}
