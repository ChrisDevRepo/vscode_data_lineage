import * as vscode from 'vscode';
import { IConnectionInfo } from '../types/mssql';
import { stripSensitiveFields } from '../engine/connectionManager';
import { migrateProjectStore, createProject, updateProject, generateProjectName } from '../engine/projectStore';
import { Logger } from './log';

/**
 * Orchestrates the migration of legacy workspaceState keys into the new unified Project Store.
 *
 * This function preserves backward compatibility for users upgrading from versions
 * pre-dating the `ProjectStore` architecture. it recovers the "last-opened"
 * connection metadata and encapsulates it into a persistent project entity.
 *
 * @param context - The VS Code extension context for state access.
 * @param PROJECT_STORE_KEY - The unique key used for the global state project store.
 * @param outputChannel - The log channel for reporting migration progress.
 *
 * @remarks
 * Architectural Remark:
 * This logic handles both 'dacpac' and 'database' source types. Once migrated,
 * the legacy keys are purged to prevent redundant migrations on subsequent activations.
 * This should be deprecated and removed in a future major version (v1.0.0).
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
