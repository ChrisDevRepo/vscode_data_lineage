import * as vscode from 'vscode';
import { IConnectionInfo } from '../types/mssql';
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
 * Migrates legacy workspace-state connection metadata into the project store.
 *
 * The migration supports DACPAC and database connections, removes the legacy keys after
 * processing, and is safe to call when no legacy state exists.
 *
 * @param context - The VS Code extension context for state access.
 * @param PROJECT_STORE_KEY - Global-state key for the project store.
 * @param outputChannel - The log channel for reporting migration progress.
 * @param onProjectsDropped - Receives the drop report when persisted records fail validation.
 *   This path rewrites global state, so anything validation discards here is lost permanently —
 *   the host reports it through the same single-notification channel as a normal load.
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
    const connectionInfo = context.workspaceState.get<IConnectionInfo>('lastDbConnectionInfo');
    if (sourceName && connectionInfo) {
      try {
        connection = { type: 'database', connectionInfo: stripSensitiveFields(connectionInfo), sourceName, schemas: [] };
      } catch (err) {
        // A record the strict read schema would drop anyway — skip it here, where it can be logged.
        logger.warn(`Legacy connection "${sourceName}" failed validation and was not migrated: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (connection) {
    const name = generateProjectName(connection);
    const project = createProject(name, connection);
    const rawStore = context.globalState.get(PROJECT_STORE_KEY);
    const store = migrateProjectStore(rawStore, (report) => {
      logger.warn(
        `Legacy migration rewrote the project store without ${report.dropped} unreadable record(s) — fields: ${report.issuePaths.join(', ') || 'unknown'}`,
      );
      onProjectsDropped?.(report);
    });
    const updated = updateProject(store, project);
    await context.globalState.update(PROJECT_STORE_KEY, updated);
    logger.info(`Migrated legacy connection to project "${name}"`);
  }

  // Clear legacy keys even when their payload is incomplete to avoid repeated migration attempts.
  await Promise.all([
    context.workspaceState.update('lastSourceType', undefined),
    context.workspaceState.update('lastDacpacPath', undefined),
    context.workspaceState.update('lastDacpacName', undefined),
    context.workspaceState.update('lastDeselectedSchemas', undefined),
    context.workspaceState.update('lastDbConnectionInfo', undefined),
    context.workspaceState.update('lastDbSourceName', undefined)
  ]);
}
