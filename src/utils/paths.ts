import * as vscode from 'vscode';
import * as path from 'path';

/** Resolve a relative path against the first workspace folder, or return absolute paths as-is */
export function resolveWorkspacePath(filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return filePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, filePath) : undefined;
}

/**
 * If the setting was a relative path that resolved successfully, write the
 * absolute path back to the same config target level so it works without a workspace.
 */
export async function persistAbsolutePath(
  settingKey: string,
  originalValue: string,
  resolvedAbsolute: string,
): Promise<void> {
  if (path.isAbsolute(originalValue)) return;

  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const inspection = cfg.inspect<string>(settingKey);
  if (!inspection) return;

  if (inspection.workspaceFolderValue !== undefined) {
    await cfg.update(settingKey, resolvedAbsolute, vscode.ConfigurationTarget.WorkspaceFolder);
  } else if (inspection.workspaceValue !== undefined) {
    await cfg.update(settingKey, resolvedAbsolute, vscode.ConfigurationTarget.Workspace);
  } else if (inspection.globalValue !== undefined) {
    await cfg.update(settingKey, resolvedAbsolute, vscode.ConfigurationTarget.Global);
  }
}
