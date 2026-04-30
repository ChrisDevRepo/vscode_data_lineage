import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolves a file path against the active VS Code workspace.
 * 
 * If the provided `filePath` is already absolute, it is returned as-is.
 * If the path is relative, it is resolved against the root of the first 
 * available workspace folder.
 * 
 * @param filePath - The path to resolve (absolute or relative to workspace).
 * @returns The absolute file path, or `undefined` if the path is relative and no workspace folder is open.
 */
export function resolveWorkspacePath(filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return filePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, filePath) : undefined;
}

/**
 * Persists a resolved absolute path back into the VS Code configuration.
 * 
 * This function detects if a setting was originally provided as a relative path.
 * If so, it writes the resolved absolute path back to the same configuration target
 * (Global, Workspace, or Workspace Folder) to ensure the setting remains valid
 * even if the workspace context changes or is removed.
 * 
 * @param settingKey - The configuration key under the 'dataLineageViz' section.
 * @param originalValue - The original raw value retrieved from configuration.
 * @param resolvedAbsolute - The absolute path that was successfully resolved from the original value.
 * @returns A promise that resolves when the configuration update is complete.
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
