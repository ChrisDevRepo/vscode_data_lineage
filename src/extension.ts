import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';

type ExtensionRuntime = typeof import('./extensionRuntime').default;

let runtime: ExtensionRuntime | undefined;

/**
 * VS Code extension entry point.
 *
 * @param context - Extension context provided by the host.
 * @returns Whatever {@link activateRuntime} returns, per the VS Code activation contract.
 */
export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider()),
  );

  try {
    runtime = (await import('./extensionRuntime.js')).default;
  } catch (err) {
    void vscode.window.showErrorMessage(
      'Data Lineage could not load its runtime bundle. Reinstall the extension; if the problem persists, report it.',
    );
    throw err;
  }
  return runtime.activateRuntime(context);
}

/** VS Code extension teardown hook. */
export async function deactivate(): Promise<void> {
  await runtime?.deactivate();
}
