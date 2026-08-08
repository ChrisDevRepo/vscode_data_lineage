import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';

type ExtensionRuntime = typeof import('./extensionRuntime').default;

let runtime: ExtensionRuntime | undefined;

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dataLineageViz.quickActions', new SidebarProvider()),
  );

  runtime = (await import('./extensionRuntime.js')).default;
  return runtime.activateRuntime(context);
}

export async function deactivate(): Promise<void> {
  await runtime?.deactivate();
}
