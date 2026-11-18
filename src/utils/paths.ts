import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolves a file path against the active workspace: an absolute path is returned as-is, a relative
 * one is resolved against the first workspace folder. Returns `undefined` when it is relative and
 * no workspace folder is open.
 */
export function resolveWorkspacePath(filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return filePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, filePath) : undefined;
}

/**
 * Writes a resolved absolute path back to the setting it came from when that setting was relative,
 * to the same configuration target (Global, Workspace or Workspace Folder), so the setting stays
 * valid if the workspace context changes or goes away.
 *
 * @param originalValue - The raw configured value.
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
