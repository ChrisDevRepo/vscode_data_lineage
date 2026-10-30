import * as vscode from 'vscode';
import * as path from 'path';

/** Resolves a file path against the active VS Code workspace. */
export function resolveWorkspacePath(filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return filePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, filePath) : undefined;
}

/** Persists a resolved absolute path back into the VS Code configuration. */
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
    await cfg.update(
      settingKey,
      resolvedAbsolute,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  } else if (inspection.workspaceValue !== undefined) {
    await cfg.update(
      settingKey,
      resolvedAbsolute,
      vscode.ConfigurationTarget.Workspace,
    );
  } else if (inspection.globalValue !== undefined) {
    await cfg.update(
      settingKey,
      resolvedAbsolute,
      vscode.ConfigurationTarget.Global,
    );
  }
}
