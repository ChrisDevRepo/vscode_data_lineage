/**
 * @module ConnectionManager
 * Handles database connectivity, DMV query management, and integration with the `ms-mssql.mssql` extension.
 *
 * This module provides the infrastructure for:
 * - Loading and validating DMV (Dynamic Management View) queries from built-in or custom sources.
 * - Orchestrating connections via the MSSQL extension's connection picker.
 * - Executing queries with automated timeout handling and placeholder expansion.
 * - Retrieving server metadata and managing connection lifecycles.
 */

import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { z } from 'zod';

const DmvQueriesConfigSchema = z.object({
  version: z.coerce.number().optional(),
  queries: z.array(z.record(z.string(), z.any())).optional()
}).passthrough();
import type { IExtension, IConnectionInfo, IConnectionSharingService, SimpleExecuteResult, IServerInfo } from '../types/mssql';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { notifyWarning } from '../utils/notifications';
import { StoredConnectionInfoSchema, type StoredConnectionInfo } from './shared/bridgeContract';

/**
 * The unique identifier for the Microsoft MSSQL extension.
 */
export const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/**
 * Represents a Dynamic Management View (DMV) query used to extract metadata from SQL Server.
 */
export interface DmvQuery {
  /**
   * The unique name/key of the query.
   *
   * @remarks
   * Two classes of name, because they fail differently. Required — 'schema-preview',
   * 'nodes', 'columns', 'dependencies' — are listed in the loader's `KNOWN_NAMES` and
   * warn when a custom YAML omits them, since the import path cannot complete without
   * them. Optional — 'all-objects', 'platform-info', 'constraints' — are deliberately
   * absent from that list: omitting 'all-objects' leaves cross-schema references
   * unclassified, omitting 'platform-info' falls back to MSSQL server metadata, and
   * omitting 'constraints' drops constraint enrichment. All degrade silently by design,
   * so a warning would be noise.
   */
  name: string;
  /** A human-readable description of the query's purpose. Never consumed by the import path. */
  description?: string;
  /** The raw SQL statement to execute. */
  sql: string;
  /**
   * The execution phase of the query.
   * `1`: Preliminary phase (unfiltered).
   * `2`: Main extraction phase (typically filters by schema).
   * @default 2
   */
  phase?: number;
}

/** The fields the import path actually requires; every other {@link DmvQuery} field degrades gracefully. */
function hasRequiredQueryFields(q: Record<string, any>): q is DmvQuery {
  return Boolean(q.name) && Boolean(q.sql);
}

/**
 * Root configuration structure for DMV query definition files.
 */
export interface DmvQueriesConfig {
  /** Schema version of the configuration file. */
  version: number;
  /** The collection of queries defined in the file. */
  queries: DmvQuery[];
}

/**
 * Loads DMV queries by checking the workspace configuration for a custom path,
 * falling back to built-in defaults if necessary.
 *
 * @param outputChannel - The VS Code output channel for logging.
 * @param extensionUri - The base URI of the extension for resolving built-in assets.
 * @returns A promise resolving to an array of validated DMV queries.
 */
export async function loadDmvQueries(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQuery[]> {
  const logger = Logger.create(outputChannel, 'Config');
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const customPath = cfg.get<string>('dmvQueriesFile', '');

  if (customPath) {
    const resolved = resolveWorkspacePath(customPath);
    if (resolved) {
      logger.debug(`Reading DMV queries custom: ${resolved}`);
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        const rawParsed = yaml.load(new TextDecoder().decode(data));
        const parsed = DmvQueriesConfigSchema.parse(rawParsed);

        const builtInConfig = await loadBuiltInDmvConfig(outputChannel, extensionUri);
        if (parsed.version !== builtInConfig.version) {
          notifyWarning(
            logger,
            'Load custom DMV queries',
            `Custom DMV queries declare version ${String(parsed.version ?? 'missing')} but this release ships ` +
            `version ${builtInConfig.version} — the query contract changed. Re-scaffold via ` +
            `"Data Lineage: Create DMV Queries" and re-apply your edits; using built-in defaults until then.`,
            {
              customVersion: parsed.version ?? null,
              expectedVersion: builtInConfig.version,
              path: resolved,
              setting: 'dmvQueriesFile',
              fallback: 'built-in defaults',
            },
          );
          return builtInConfig.queries;
        }

        if (parsed?.queries && Array.isArray(parsed.queries)) {
          const skipped: string[] = [];
          const valid = parsed.queries.filter((q, i): q is DmvQuery => {
            if (!hasRequiredQueryFields(q)) {
              const label = q?.name || `query[${i}]`;
              logger.debug(`Skipped DMV query '${label}': missing ${!q?.name ? "'name'" : "'sql'"} field`);
              skipped.push(label);
              return false;
            }
            return true;
          });
          if (valid.length > 0) {
            const KNOWN_NAMES = ['schema-preview', 'nodes', 'columns', 'dependencies'];
            const loadedNames = new Set(valid.map(q => q.name));
            const missingNames = KNOWN_NAMES.filter(n => !loadedNames.has(n));
            if (missingNames.length > 0) {
              notifyWarning(
                logger,
                'Load custom DMV queries',
                `Custom DMV queries missing: ${missingNames.join(', ')}. DB import may fail.`,
                { missingNames, path: resolved, setting: 'dmvQueriesFile' },
              );
            }
            await persistAbsolutePath('dmvQueriesFile', customPath, resolved);
            logger.info(`Applied DMV queries: ${valid.length} loaded from custom, ${skipped.length} skipped`);
            return valid;
          }
        }
        notifyWarning(
          logger,
          'Load custom DMV queries',
          'Custom DMV queries invalid — using built-in defaults.',
          { reason: 'missing or invalid queries array', path: resolved, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
        );
      } catch (err) {
        notifyWarning(
          logger,
          'Load custom DMV queries',
          'Failed to load custom DMV queries — using built-in defaults. Check Output channel.',
          { reason: err instanceof Error ? err.message : String(err), path: resolved, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
        );
      }
    } else {
      notifyWarning(
        logger,
        'Load custom DMV queries',
        `Cannot resolve DMV queries path "${customPath}" — using built-in defaults.`,
        { reason: 'cannot resolve path', path: customPath, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
      );
    }
  }

  return loadBuiltInDmvQueries(outputChannel, extensionUri);
}

/**
 * Loads the built-in DMV queries from the extension's `assets` directory.
 *
 * @param outputChannel - The VS Code output channel for logging.
 * @param extensionUri - The base URI of the extension.
 * @returns A promise resolving to the built-in DMV queries.
 * @throws If the built-in configuration file is missing or corrupted.
 */
async function loadBuiltInDmvQueries(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQuery[]> {
  const parsed = await loadBuiltInDmvConfig(outputChannel, extensionUri);
  Logger.create(outputChannel, 'Config')
    .info(`Applied DMV queries: ${parsed.queries.length} loaded from built-in, 0 skipped`);
  return parsed.queries;
}

/**
 * Reads and validates the built-in `assets/dmvQueries.yaml`, returning the whole config.
 *
 * @remarks
 * Split from {@link loadBuiltInDmvQueries} because the custom-file path needs the shipped
 * `version` — the contract a custom file is validated against — and not only the queries.
 * @throws If the built-in file is missing, has no `queries` array, or declares no `version`.
 */
async function loadBuiltInDmvConfig(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQueriesConfig> {
  const logger = Logger.create(outputChannel, 'Config');
  const yamlUri = vscode.Uri.joinPath(extensionUri, 'assets', 'dmvQueries.yaml');
  logger.debug(`Reading DMV queries built-in: ${yamlUri.fsPath}`);
  const data = await vscode.workspace.fs.readFile(yamlUri);
  const rawParsed = yaml.load(new TextDecoder().decode(data));
  const parsed = DmvQueriesConfigSchema.parse(rawParsed);

  const { version, queries } = parsed;
  if (!queries || !Array.isArray(queries)) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "queries" array');
  }
  if (version === undefined) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "version"');
  }
  const validQueries = queries.filter(hasRequiredQueryFields);
  if (validQueries.length !== queries.length) {
    throw new Error('Built-in dmvQueries.yaml is invalid — a query is missing "name" or "sql"');
  }

  return { version, queries: validQueries };
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
    throw new Error(
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
  return new Error(
    `SQL Server (mssql) extension v${version} does not support ${MSSQL_CAPABILITY_NAMES[missing] ?? missing}, which Data Lineage needs to connect to a database.`,
  );
}

/**
 * Triggers the native MSSQL connection picker and initiates a connection.
 *
 * @param outputChannel - The VS Code output channel for logging.
 * @returns Connection URI and metadata, or `undefined` if the user cancels.
 */
export async function promptForConnection(
  outputChannel: vscode.LogOutputChannel,
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo } | undefined> {
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

  logger.info(`Connecting to ${connectionInfo.server}/${connectionInfo.database}`);
  const connectStart = Date.now();
  const connectionUri = await api.connect(connectionInfo, false);
  logger.info(`Connected (${Date.now() - connectStart}ms)`);

  return { connectionUri, connectionInfo };
}

/**
 * Reduces connection info to exactly the fields that may be persisted.
 *
 * @remarks
 * Allow-list, not a deny-list, and the allowed set is read from
 * {@link StoredConnectionInfoSchema} so the two can never drift.
 *
 * A deny-list is unsafe here because the two sides of persistence are asymmetric: the object
 * comes from the mssql extension, whose runtime shape is wider than the partial
 * {@link IConnectionInfo} declaration in this repo (`applicationName`, `connectTimeout`, and
 * others). Spreading the rest wrote those extra keys into the project store, and the read side
 * (`StoredConnectionInfoSchema` is `.strict()`) then rejected the record — so `migrateProjectStore`
 * discarded a saved database project on the next load. Selecting known keys makes what is written
 * readable by construction.
 *
 * `.strict()` on the read side stays deliberately: it is what keeps a future leaked credential out
 * of the store. This function is the correct place to narrow, because it is the only write path,
 * and it parses what it built for the same reason: a record the read side would reject must fail
 * here, at save time, rather than silently drop the saved project on the next load.
 *
 * @param info - The raw connection information from the mssql extension.
 * @returns A persistable clone carrying only schema-declared fields; secrets are never among them.
 * @throws When the narrowed record still violates {@link StoredConnectionInfoSchema} — for
 *   example a server-scoped profile with no `database`.
 */
export function stripSensitiveFields(info: IConnectionInfo): StoredConnectionInfo {
  const source = info as unknown as Record<string, unknown>;
  const persistable: Record<string, unknown> = {};
  for (const key of Object.keys(StoredConnectionInfoSchema.shape)) {
    if (source[key] !== undefined) persistable[key] = source[key];
  }
  return StoredConnectionInfoSchema.parse(persistable);
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
export async function connectDirect(
  connectionInfo: IConnectionInfo,
  outputChannel: vscode.LogOutputChannel,
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo } | undefined> {
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
        logger.warn(`Direct reconnect: no saved mssql profile matches ${connectionInfo.server} — falling back to picker`);
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
    logger.warn(`Direct reconnect failed: ${err instanceof Error ? err.message : String(err)} — falling back to picker`);
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
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo }> {
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
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo } | undefined> {
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

  logger.info(`Connecting to ${picked.profile.server}/${database}`);
  const connectStart = Date.now();
  const result = await connectSavedProfile(api, picked.profile, database);
  logger.info(`Connected (${Date.now() - connectStart}ms)`);
  return result;
}

/**
 * Utility to wrap an asynchronous operation with a timeout constraint.
 *
 * @typeParam T - The resolved value type.
 * @param promise - The promise to monitor.
 * @param ms - Timeout duration in milliseconds.
 * @param timeoutMessage - Message for the thrown error upon timeout.
 * @returns A promise that resolves with the original value or rejects on timeout.
 */
export function withQueryTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    }),
  ]);
}

/**
 * Executes a batch of DMV queries sequentially.
 *
 * @param connectionUri - The active connection URI.
 * @param queries - List of queries to execute.
 * @param outputChannel - Logger output channel.
 * @param onProgress - Optional callback for tracking execution progress.
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 * @returns A map of query names to their execution results.
 */
export async function executeDmvQueries(
  connectionUri: string,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');
  const sharing = await getConnectionSharingApi();

  const results = new Map<string, SimpleExecuteResult>();
  const total = queries.length;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const step = i + 1;

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(query.sql), 300)}`);

    const start = Date.now();
    const queryPromise = sharing.executeSimpleQuery(connectionUri, query.sql);
    const result = queryTimeoutMs
      ? await withQueryTimeout(queryPromise, queryTimeoutMs, `DMV query "${query.name}" timed out after ${queryTimeoutMs / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`)
      : await queryPromise;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.debug(`Query '${query.name}' — ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Whether a query belongs to the schema-filtered Phase 2 sweep.
 *
 * @remarks
 * Exported so callers can size progress reporting from the same predicate the sweep itself
 * uses. `phase: 1` means "not schema-filtered" rather than "runs during Phase 1" — the
 * platform probe carries that tag while running at Phase 2 time — so an independent
 * re-implementation of this test would silently miscount the steps.
 */
export const isPhase2Query = (q: DmvQuery): boolean => (q.phase ?? 2) !== 1;

/**
 * Executes Phase 2 queries with `{{SCHEMAS}}` substitution.
 *
 * @param connectionUri - The active connection URI.
 * @param queries - Candidate queries to filter and execute.
 * @param schemas - Schema names for placeholder replacement.
 * @param outputChannel - Logger output channel.
 * @param onProgress - Progress tracking callback.
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 * @returns Results for the executed Phase 2 queries.
 */
export async function executeDmvQueriesFiltered(
  connectionUri: string,
  queries: DmvQuery[],
  schemas: string[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');
  const sharing = await getConnectionSharingApi();

  const phase2Queries = queries.filter(isPhase2Query);

  for (const q of phase2Queries) {
    const warning = validateSchemaPlaceholder(q.name, q.sql, q.phase ?? 2);
    if (warning) logger.warn(warning);
  }

  const results = new Map<string, SimpleExecuteResult>();
  const total = phase2Queries.length;

  for (let i = 0; i < phase2Queries.length; i++) {
    const query = phase2Queries[i];
    const step = i + 1;
    const sql = expandSchemaPlaceholder(query.sql, schemas);

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(sql), 300)}`);

    const start = Date.now();
    const queryPromise = sharing.executeSimpleQuery(connectionUri, sql);
    const result = queryTimeoutMs
      ? await withQueryTimeout(queryPromise, queryTimeoutMs, `DMV query "${query.name}" timed out after ${queryTimeoutMs / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`)
      : await queryPromise;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.debug(`Query '${query.name}' — ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Retrieves server-level metadata (version, edition, etc.) from the connection.
 *
 * @param connectionUri - The active connection URI.
 * @returns Server info metadata.
 */
export async function getServerInfo(
  connectionUri: string,
): Promise<IServerInfo> {
  const sharing = await getConnectionSharingApi();
  return sharing.getServerInfo(connectionUri);
}

/**
 * Executes a single SQL command without batching or placeholders.
 *
 * @param connectionUri - The active connection URI.
 * @param sql - The SQL script to execute.
 * @param outputChannel - Logger output channel.
 * @returns The query execution result.
 */
export async function executeSimpleQuery(
  connectionUri: string,
  sql: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<SimpleExecuteResult> {
  const logger = Logger.create(outputChannel, 'DB');
  const sharing = await getConnectionSharingApi();
  logger.debug(`Executing simple query — SQL: ${trunc(sanitizeForLog(sql), 300)}`);
  const start = Date.now();
  const result = await sharing.executeSimpleQuery(connectionUri, sql);
  logger.debug(`Simple query — ${result.rowCount} rows (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  return result;
}

/**
 * Gracefully terminates the database connection.
 *
 * @param connectionUri - The connection URI to close.
 * @param outputChannel - Logger output channel.
 */
export async function disconnectDatabase(
  connectionUri: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const logger = Logger.create(outputChannel, 'DB');
  const sharing = await getConnectionSharingApi();
  await sharing.disconnect(connectionUri);
  logger.info('Disconnected');
}
