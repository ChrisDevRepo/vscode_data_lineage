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
import { errorMessage } from './errorMessage';

/** Migrates legacy workspace-state connection metadata into the project store. */
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
        logger.warn(`Legacy connection "${sourceName}" failed validation and was not migrated: ${errorMessage(err)}`);
      }
    }
  }

  const clearLegacyKeys = () => Promise.all(LEGACY_KEYS.map(key => context.workspaceState.update(key, undefined)));
  if (!connection) {
    logger.warn(`Removed unmigratable legacy ${sourceType} state.`);
    await clearLegacyKeys();
    return;
  }
  const name = generateProjectName(connection);
  const project = createProject(name, connection);
  const rawStore = context.globalState.get(PROJECT_STORE_KEY);
  const store = migrateProjectStore(rawStore, (report) => {
    logger.warn(
      `Legacy migration skipped ${report.dropped} unreadable project(s) and ${report.droppedViews ?? 0} unreadable view(s) — fields: ${report.issuePaths.join(', ') || 'unknown'}`,
    );
    onProjectsDropped?.(report);
  });
  const updated = updateProject(store, project);
  await context.globalState.update(PROJECT_STORE_KEY, updated);
  logger.info(`Migrated legacy connection to project "${name}"`);

  await clearLegacyKeys();
}

/** Workspace-state keys written by builds before the project store. */
const LEGACY_KEYS = ['lastSourceType', 'lastDacpacPath', 'lastDacpacName', 'lastDeselectedSchemas', 'lastDbConnectionInfo', 'lastDbSourceName'] as const;
