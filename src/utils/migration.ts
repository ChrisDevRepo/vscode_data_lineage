import * as vscode from 'vscode';
import { IConnectionInfo } from '../types/mssql';
import { stripSensitiveFields } from '../engine/connectionManager';
import { migrateProjectStore, createProject, updateProject, generateProjectName } from '../engine/projectStore';
import { Logger } from './log';

/**
 * Migrates legacy workspaceState keys (from pre-ProjectStore versions) into the new Project Store.
 * 
 * This logic is preserved for backward compatibility to ensure users don't lose their 
 * last-opened connections when upgrading. It should be considered for removal in v1.0.0.
 */
export async function migrateFromWorkspaceState(
  context: vscode.ExtensionContext, 
  PROJECT_STORE_KEY: string,
  outputChannel: vscode.LogOutputChannel
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Project');
  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  if (!sourceType) return;

  let connection: any;

  if (sourceType === 'dacpac') {
    const dacpacPath = context.workspaceState.get<string>('lastDacpacPath');
    const dacpacName = context.workspaceState.get<string>('lastDacpacName');
    if (dacpacPath && dacpacName) {
      connection = { type: 'dacpac', path: dacpacPath, displayName: dacpacName, schemas: [] };
    }
  } else if (sourceType === 'database') {
    const sourceName = context.workspaceState.get<string>('lastDbSourceName');
    const connectionInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
    if (sourceName && connectionInfo) {
      connection = { type: 'database', connectionInfo: stripSensitiveFields(connectionInfo), sourceName, schemas: [] };    
    }
  }

  if (connection) {
    const name = generateProjectName(connection);
    const project = createProject(name, connection);
    const rawStore = context.globalState.get(PROJECT_STORE_KEY);
    const store = migrateProjectStore(rawStore);
    const updated = updateProject(store, project);
    await context.globalState.update(PROJECT_STORE_KEY, updated);
    logger.info(`Migrated legacy connection to project "${name}"`);
  }

  // Clear old workspaceState keys regardless
  await Promise.all([
    context.workspaceState.update('lastSourceType', undefined),
    context.workspaceState.update('lastDacpacPath', undefined),
    context.workspaceState.update('lastDacpacName', undefined),
    context.workspaceState.update('lastDeselectedSchemas', undefined),
    context.workspaceState.update('lastDbConnectionInfo', undefined),
    context.workspaceState.update('lastDbSourceName', undefined)
  ]);
}
