/**
 * @module MssqlExtensionProvider
 * Connections through the SQL Server (`ms-mssql.mssql`) extension: its connection picker, its saved
 * profiles and its connection-sharing query API, wrapped as {@link DbSession}.
 */

import * as vscode from 'vscode';
import type { IExtension, IConnectionInfo, IConnectionSharingService } from '../../types/mssql';
import { Logger } from '../../utils/log';
import { redactSecrets } from '../../utils/redact';
import type { StoredConnectionInfo } from '../shared/bridgeContract';
import type { DbSession } from './dbSession';

/**
 * The unique identifier for the Microsoft MSSQL extension.
 */
export const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/** The mssql extension is missing, disabled, or too old for a call this extension makes. */
export class MssqlApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MssqlApiError';
  }
}

/**
 * Whether the mssql extension is installed and enabled.
 *
 * @remarks
 * `getExtension` returns `undefined` for a disabled extension exactly as for a missing one, so this
 * single answer covers both states.
 */
export function isMssqlExtensionAvailable(): boolean {
  return vscode.extensions.getExtension(MSSQL_EXTENSION_ID) !== undefined;
}

/**
 * Accesses the MSSQL extension API, ensuring the extension is installed and activated.
 *
 * @remarks
 * `getExtension` reports a disabled extension exactly as it reports a missing one, so the message
 * names both states and the repair for each.
 *
 * @returns A promise resolving to the `IExtension` exports.
 * @throws If the MSSQL extension is not installed or is disabled.
 */
async function getMssqlApi(): Promise<IExtension> {
  const ext = vscode.extensions.getExtension<IExtension>(MSSQL_EXTENSION_ID);
  if (!ext) {
    throw new MssqlApiError(
      `The SQL Server (mssql) extension is not installed or is disabled. Install or enable ${MSSQL_EXTENSION_ID} (v1.34 or later) to use database projects.`,
    );
  }

  const api = ext.isActive ? ext.exports : await ext.activate();
  return api;
}

/**
 * Retrieves the connection sharing service from the MSSQL extension.
 *
 * @returns A promise resolving to the `IConnectionSharingService`.
 * @throws If the MSSQL extension version does not support connection sharing.
 */
async function getConnectionSharingApi(): Promise<IConnectionSharingService> {
  const api = await getMssqlApi();
  if (typeof api.connectionSharing?.executeSimpleQuery !== 'function') {
    throw mssqlApiMissingError('connectionSharing.executeSimpleQuery');
  }
  return api.connectionSharing;
}

/** Plain-language names of the mssql API members this extension depends on. */
const MSSQL_CAPABILITY_NAMES: Record<string, string> = {
  'connectionSharing.connect': 'opening a connection for other extensions',
  'connectionSharing.executeSimpleQuery': 'running queries for other extensions',
};

/**
 * Builds the user-facing error for an mssql extension that lacks an API this extension calls.
 *
 * @remarks
 * Versions below v1.34 lack connection sharing; v1.46 dropped `promptForConnection` and `connect`
 * and marks connection sharing as retiring. The message states which mssql version lacks which
 * capability; each capability name maps to exactly one API member, so the log needs no raw name.
 *
 * @param missing - The API member that was not found.
 */
function mssqlApiMissingError(missing: string): Error {
  const version = vscode.extensions.getExtension(MSSQL_EXTENSION_ID)?.packageJSON?.version ?? 'unknown';
  return new MssqlApiError(
    `SQL Server (mssql) extension v${version} does not support ${MSSQL_CAPABILITY_NAMES[missing] ?? missing}, which Data Lineage needs to connect to a database.`,
  );
}

/** A connection opened through the mssql extension, before it is wrapped as a session. */
export interface MssqlConnection {
  /** Connection URI the extension's sharing API addresses. */
  connectionUri: string;
  /** Connection metadata, as the extension reported it. */
  connectionInfo: IConnectionInfo;
}

/**
 * Triggers the native MSSQL connection picker and initiates a connection.
 *
 * @param outputChannel - The VS Code output channel for logging.
 * @returns Connection URI and metadata, or `undefined` if the user cancels.
 */
export async function promptForMssqlConnection(
  outputChannel: vscode.LogOutputChannel,
): Promise<MssqlConnection | undefined> {
  const logger = Logger.create(outputChannel, 'DB');
  const ext = vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
  logger.debug(`MSSQL extension (${MSSQL_EXTENSION_ID}) v${ext?.packageJSON?.version ?? '?'} found`);
  const api = await getMssqlApi();

  if (!hasLegacyConnectApi(api, true)) {
    return promptForSavedProfile(api, logger);
  }

  const connectionInfo = await api.promptForConnection(true);
  if (!connectionInfo) {
    logger.info('User cancelled connection picker');
    return undefined;
  }

  logger.info('Connecting');
  logger.debug(`Connection target: ${connectionInfo.server}/${connectionInfo.database}`);
  const connectStart = Date.now();
  const connectionUri = await api.connect(connectionInfo, false);
  logger.info(`Connected (${Date.now() - connectStart}ms)`);

  return { connectionUri, connectionInfo };
}

/**
 * Attempts direct reconnection with existing credentials. Returns `undefined` on failure so the
 * caller can choose a recovery path.
 *
 * @remarks
 * The profile handed to `api.connect` is a clone, never the caller's object. The mssql extension
 * owns what it does with the profile it receives, and an Entra connection observably comes back
 * carrying acquired-token fields the persistence contract never declares. Callers pass the
 * connection info held inside a saved project, so handing that object over directly let a field
 * appear inside a persisted record — which then failed the strict webview contract and cost the
 * whole `projects-list` frame. Cloning keeps ownership of the record with this extension.
 *
 * @param connectionInfo - The existing connection credentials.
 * @param outputChannel - The VS Code output channel for logging.
 * @returns Connection details on success, or `undefined` on failure.
 */
export async function reconnectMssqlConnection(
  connectionInfo: IConnectionInfo,
  outputChannel: vscode.LogOutputChannel,
): Promise<MssqlConnection | undefined> {
  const logger = Logger.create(outputChannel, 'DB');
  const ext = vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
  logger.debug(`MSSQL extension (${MSSQL_EXTENSION_ID}) v${ext?.packageJSON?.version ?? '?'} found`);
  const api = await getMssqlApi();

  logger.debug(`>> Open: ${connectionInfo.server} / ${connectionInfo.database} (reconnect)`);
  const reconnectStart = Date.now();
  const profile = { ...connectionInfo };
  try {
    if (!hasLegacyConnectApi(api)) {
      const saved = readSavedProfiles().find((p) => profileMatches(p, connectionInfo));
      if (!saved) {
        logger.warn('Direct reconnect: no matching saved mssql profile — falling back to picker');
        logger.debug(`Unmatched reconnect server: ${connectionInfo.server}`);
        return undefined;
      }
      const result = await connectSavedProfile(api, saved, connectionInfo.database);
      logger.info(`Reconnected (${Date.now() - reconnectStart}ms)`);
      return result;
    }
    const connectionUri = await api.connect(profile, false);
    logger.info(`Reconnected (${Date.now() - reconnectStart}ms)`);
    return { connectionUri, connectionInfo: profile };
  } catch (err) {
    logger.warn('Direct reconnect failed — falling back to picker');
    logger.debug(`Direct reconnect error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return undefined;
  }
}

/** Identifier of this extension, as the mssql connection-sharing permission store keys it. */
const OWN_EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

/** A connection profile saved in the `mssql.connections` setting. */
interface SavedMssqlProfile extends Partial<IConnectionInfo> {
  id: string;
  server: string;
  profileName?: string;
}

/**
 * Whether the mssql exports still carry `connect` (and, when `withPicker`, `promptForConnection`).
 *
 * @remarks
 * mssql v1.46.0 dropped both from its public exports and kept them only on an internal API for its
 * own features; v1.45.1 and earlier export them. The saved-profile path replaces them on v1.46+.
 */
function hasLegacyConnectApi(api: IExtension, withPicker = false): boolean {
  return typeof api.connect === 'function'
    && (!withPicker || typeof api.promptForConnection === 'function');
}

/**
 * Reads the saved mssql connection profiles from user and workspace settings, in the same order
 * and from the same scopes the mssql extension reads them.
 *
 * @returns Profiles that carry the `id` and `server` a connection-sharing connect needs.
 */
function readSavedProfiles(): SavedMssqlProfile[] {
  const inspected = vscode.workspace.getConfiguration('mssql').inspect<unknown[]>('connections');
  const all = [...(inspected?.globalValue ?? []), ...(inspected?.workspaceValue ?? [])];
  return all.filter((p): p is SavedMssqlProfile =>
    !!p && typeof p === 'object'
    && typeof (p as SavedMssqlProfile).id === 'string'
    && typeof (p as SavedMssqlProfile).server === 'string');
}

/**
 * Whether a saved profile describes the same login as a stored project connection.
 * The database is not compared: the stored database is passed to the connect call instead.
 */
function profileMatches(profile: SavedMssqlProfile, info: IConnectionInfo): boolean {
  const same = (a?: string, b?: string) => !a || !b || a.toLowerCase() === b.toLowerCase();
  return profile.server.toLowerCase() === info.server.toLowerCase()
    && same(profile.authenticationType, info.authenticationType)
    && same(profile.user, info.user)
    && same(profile.email, info.email);
}

/**
 * Connects a saved profile through the mssql connection-sharing API.
 *
 * @param database - Database to open; defaults to the profile's own database.
 * @throws When connection sharing is denied for this extension or the connection fails.
 */
async function connectSavedProfile(
  api: IExtension,
  profile: SavedMssqlProfile,
  database: string | undefined,
): Promise<MssqlConnection> {
  if (typeof api.connectionSharing?.connect !== 'function') {
    throw mssqlApiMissingError('connectionSharing.connect');
  }
  const targetDb = database || profile.database || '';
  const connectionUri = await api.connectionSharing.connect(OWN_EXTENSION_ID, profile.id, targetDb || undefined);
  const connectionInfo: IConnectionInfo = {
    server: profile.server,
    database: targetDb,
    user: profile.user ?? '',
    authenticationType: profile.authenticationType ?? '',
    email: profile.email,
    accountId: profile.accountId,
    tenantId: profile.tenantId,
    port: profile.port as number,
    encrypt: profile.encrypt,
    trustServerCertificate: profile.trustServerCertificate,
  };
  return { connectionUri, connectionInfo };
}

/**
 * Shows a picker over the saved mssql connection profiles and connects the chosen one.
 * Replaces the native picker that mssql v1.46+ no longer exports.
 *
 * @returns Connection URI and metadata, or `undefined` if the user cancels or no profile exists.
 */
async function promptForSavedProfile(
  api: IExtension,
  logger: Logger,
): Promise<MssqlConnection | undefined> {
  const profiles = readSavedProfiles();
  if (profiles.length === 0) {
    const addConnection = 'Add Connection';
    const choice = await vscode.window.showWarningMessage(
      'No saved SQL Server connections found. Add one in the SQL Server view, then connect again.',
      addConnection,
    );
    if (choice === addConnection) void vscode.commands.executeCommand('mssql.addObjectExplorer');
    logger.info('No saved mssql connection profiles');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.profileName || `${p.server}${p.database ? ` / ${p.database}` : ''}`,
      description: p.profileName ? `${p.server}${p.database ? ` / ${p.database}` : ''}` : undefined,
      detail: p.authenticationType,
      profile: p,
    })),
    { placeHolder: 'Select a SQL Server connection', ignoreFocusOut: true, matchOnDescription: true },
  );
  if (!picked) {
    logger.info('User cancelled connection picker');
    return undefined;
  }

  let database = picked.profile.database;
  if (!database) {
    database = await vscode.window.showInputBox({
      prompt: `Database on ${picked.profile.server}`,
      placeHolder: 'Database name',
      ignoreFocusOut: true,
    });
    if (!database) {
      logger.info('User cancelled database selection');
      return undefined;
    }
  }

  logger.info('Connecting');
  logger.debug(`Connection target: ${picked.profile.server}/${database}`);
  const connectStart = Date.now();
  const result = await connectSavedProfile(api, picked.profile, database);
  logger.info(`Connected (${Date.now() - connectStart}ms)`);
  return result;
}

/**
 * Wraps a connection the mssql extension opened as a {@link DbSession}.
 *
 * @remarks
 * The persisted `connectionInfo` carries no `provider`, so records written for this provider stay
 * readable by builds that predate provider selection. `dispose` disconnects the URI; callers
 * dispose only connections they opened for the panel's lifetime.
 *
 * @param connection - The opened connection.
 * @param toStored - Narrows the live connection info to its persistable form.
 */
export function createMssqlSession(
  connection: MssqlConnection,
  toStored: (info: IConnectionInfo) => StoredConnectionInfo,
): DbSession {
  const { connectionUri } = connection;
  const connectionInfo = toStored({ ...connection.connectionInfo, database: connection.connectionInfo.database ?? '' });
  return {
    provider: 'mssqlExtension',
    connectionInfo,
    async executeSimpleQuery(sql) {
      return (await getConnectionSharingApi()).executeSimpleQuery(connectionUri, sql);
    },
    async getServerInfo() {
      return (await getConnectionSharingApi()).getServerInfo(connectionUri);
    },
    async dispose() {
      await (await getConnectionSharingApi()).disconnect(connectionUri);
    },
  };
}
