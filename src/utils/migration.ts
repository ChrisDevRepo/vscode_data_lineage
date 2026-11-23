import * as vscode from 'vscode';
import { stripSensitiveFields } from '../engine/connectionManager';
import {
  migrateProjectStore,
  createProject,
  updateProject,
  generateProjectName,
  type ProjectStoreDropReport,
} from '../engine/projectStore';
import { Logger } from './log';

/**
 * Migrates legacy workspace-state connection metadata (DACPAC and database) into the project store,
 * removing the legacy keys; safe when no legacy state exists.
 *
 * @param onProjectsDropped - Receives the drop report when persisted records fail validation. This
 *   rewrites global state, so what validation discards is lost; the host reports it through the
 *   single-notification channel of a normal load.
 */
export async function migrateFromWorkspaceState(
  context: vscode.ExtensionContext,
  PROJECT_STORE_KEY: string,
  outputChannel: vscode.LogOutputChannel,
  onProjectsDropped?: (report: ProjectStoreDropReport) => void,
): Promise<void> {
  const logger = Logger.create(outputChannel, 'Project');
  const sourceType = context.workspaceState.get<'dacpac' | 'database'>('lastSourceType');
  if (!sourceType) return;

  type LegacyConnection =
    | { type: 'dacpac'; path: string; displayName: string; schemas: string[] }
    | { type: 'database'; connectionInfo: ReturnType<typeof stripSensitiveFields>; sourceName: string; schemas: string[] };
  let connection: LegacyConnection | undefined;

  if (sourceType === 'dacpac') {
    const dacpacPath = context.workspaceState.get<string>('lastDacpacPath');
    const dacpacName = context.workspaceState.get<string>('lastDacpacName');
    if (dacpacPath && dacpacName) {
      connection = { type: 'dacpac', path: dacpacPath, displayName: dacpacName, schemas: [] };
    }
  } else if (sourceType === 'database') {
    const sourceName = context.workspaceState.get<string>('lastDbSourceName');
    const connectionInfo = context.workspaceState.get<Record<string, unknown>>('lastDbConnectionInfo');
    if (sourceName && connectionInfo) {
      try {
        connection = { type: 'database', connectionInfo: stripSensitiveFields(connectionInfo), sourceName, schemas: [] };
      } catch (err) {
        logger.error('Legacy connection validation', err);
      }
    }
  }

  if (connection) {
    const name = generateProjectName(connection);
    const project = createProject(name, connection);
    const rawStore = context.globalState.get(PROJECT_STORE_KEY);
    const store = migrateProjectStore(rawStore, (report) => {
      logger.error('Legacy migration dropped records', { code: 'dropped' });
      logger.debug(`Legacy migration dropped records — projects=${report.dropped} views=${report.droppedViews ?? 0}; fields: ${report.issuePaths.join(', ') || 'unknown'}`);
      onProjectsDropped?.(report);
    });
    const updated = updateProject(store, project);
    await context.globalState.update(PROJECT_STORE_KEY, updated);
    logger.info('Migrated legacy connection to a project');
    logger.debug(`Migrated legacy connection to project "${name}"`);
  } else {
    logger.warn('Legacy connection state could not be migrated and was cleared');
  }

  await Promise.all([
    context.workspaceState.update('lastSourceType', undefined),
    context.workspaceState.update('lastDacpacPath', undefined),
    context.workspaceState.update('lastDacpacName', undefined),
    context.workspaceState.update('lastDeselectedSchemas', undefined),
    context.workspaceState.update('lastDbConnectionInfo', undefined),
    context.workspaceState.update('lastDbSourceName', undefined)
  ]);
}
