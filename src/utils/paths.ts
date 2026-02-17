import * as vscode from 'vscode';
import * as path from 'path';

/** Resolve a relative path against the first workspace folder, or return absolute paths as-is */
export function resolveWorkspacePath(filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return filePath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, filePath) : undefined;
}
