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
import type { IExtension, IConnectionInfo, IConnectionSharingService, SimpleExecuteResult, IServerInfo } from '../types/mssql';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';
import { Logger, trunc, sanitizeForLog } from '../utils/log';

/**
 * The unique identifier for the Microsoft MSSQL extension.
 */
const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/**
 * Represents a Dynamic Management View (DMV) query used to extract metadata from SQL Server.
 */
export interface DmvQuery {
  /** 
   * The unique name/key of the query. 
   * Known keys: 'schema-preview', 'all-objects', 'nodes', 'columns', 'dependencies'.
   */
  name: string;
  /** A human-readable description of the query's purpose. */
  description: string;
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
      logger.info(`Reading DMV queries custom: ${resolved}`);
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        const parsed = yaml.load(new TextDecoder().decode(data)) as DmvQueriesConfig;

        if (parsed?.queries && Array.isArray(parsed.queries)) {
          const skipped: string[] = [];
          const valid = parsed.queries.filter((q, i) => {
            if (!q.name || !q.sql) {
              const label = q?.name || `query[${i}]`;
              logger.info(`Skipped DMV query '${label}': missing ${!q?.name ? "'name'" : "'sql'"} field`);
              skipped.push(label);
              return false;
            }
            return true;
          });
          if (valid.length > 0) {
            const KNOWN_NAMES = ['schema-preview', 'all-objects', 'nodes', 'columns', 'dependencies'];
            const loadedNames = new Set(valid.map(q => q.name));
            const missingNames = KNOWN_NAMES.filter(n => !loadedNames.has(n));
            if (missingNames.length > 0) {
              logger.warn(`Custom DMV queries missing known names: ${missingNames.join(', ')} — DB import may fail`);
              vscode.window.showWarningMessage(`Custom DMV queries missing: ${missingNames.join(', ')}. DB import may fail.`);
            }
            await persistAbsolutePath('dmvQueriesFile', customPath, resolved);
            logger.info(`Applied DMV queries: ${valid.length} loaded from custom, ${skipped.length} skipped`);
            return valid;
          }
        }
        logger.warn(`Fallback DMV queries custom → built-in: reason=missing or invalid "queries" array at ${resolved}`);
        vscode.window.showWarningMessage('Custom DMV queries invalid — using built-in defaults.');
      } catch (err) {
        logger.warn(`Fallback DMV queries custom → built-in: reason=${err instanceof Error ? err.message : String(err)} at ${resolved}`);
        vscode.window.showWarningMessage('Failed to load custom DMV queries — using built-in defaults. Check Output channel.');
      }
    } else {
      logger.warn(`Fallback DMV queries custom → built-in: reason=cannot resolve path "${customPath}"`);
      vscode.window.showWarningMessage(`Cannot resolve DMV queries path "${customPath}" — using built-in defaults.`);
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
  const logger = Logger.create(outputChannel, 'Config');
  const yamlUri = vscode.Uri.joinPath(extensionUri, 'assets', 'dmvQueries.yaml');
  logger.info(`Reading DMV queries built-in: ${yamlUri.fsPath}`);
  const data = await vscode.workspace.fs.readFile(yamlUri);
  const parsed = yaml.load(new TextDecoder().decode(data)) as DmvQueriesConfig;

  if (!parsed?.queries || !Array.isArray(parsed.queries)) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "queries" array');
  }

  logger.info(`Applied DMV queries: ${parsed.queries.length} loaded from built-in, 0 skipped`);
  return parsed.queries;
}

/**
 * Accesses the MSSQL extension API, ensuring the extension is installed and activated.
 * 
 * @param outputChannel - The VS Code output channel for logging.
 * @returns A promise resolving to the `IExtension` exports.
 * @throws If the MSSQL extension is not installed.
 */
async function getMssqlApi(outputChannel: vscode.LogOutputChannel): Promise<IExtension> {
  const logger = Logger.create(outputChannel, 'DB');
  const ext = vscode.extensions.getExtension<IExtension>(MSSQL_EXTENSION_ID);
  if (!ext) {
    throw new Error(`MSSQL extension (${MSSQL_EXTENSION_ID}) is not installed.`);
  }

  const api = ext.isActive ? ext.exports : await ext.activate();
  logger.debug(`MSSQL extension (${MSSQL_EXTENSION_ID}) v${ext.packageJSON?.version ?? '?'} found`);

  return api;
}

/**
 * Retrieves the connection sharing service from the MSSQL extension.
 * 
 * @param outputChannel - The VS Code output channel for logging.
 * @returns A promise resolving to the `IConnectionSharingService`.
 * @throws If the MSSQL extension version does not support connection sharing.
 */
async function getConnectionSharingApi(
  outputChannel: vscode.LogOutputChannel,
): Promise<IConnectionSharingService> {
  const api = await getMssqlApi(outputChannel);
  if (!api.connectionSharing) {
    throw new Error('MSSQL extension does not expose connectionSharing API. Please update to v1.34+.');
  }
  return api.connectionSharing;
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
  const api = await getMssqlApi(outputChannel);

  const connectionInfo = await api.promptForConnection(true);
  if (!connectionInfo) {
    logger.info('User cancelled connection picker');
    return undefined;
  }

  logger.info(`Connecting to ${connectionInfo.server}/${connectionInfo.database}`);
  const connectionUri = await api.connect(connectionInfo, false);
  logger.info('Connected');

  return { connectionUri, connectionInfo };
}

/**
 * Sanitizes connection info by removing secrets (passwords and raw connection strings).
 * 
 * @param info - The raw connection information.
 * @returns A sanitized clone of the connection information.
 */
export function stripSensitiveFields(info: IConnectionInfo): Omit<IConnectionInfo, 'password' | 'connectionString'> {
  const { password: _pw, connectionString: _cs, ...safe } = info;
  return safe;
}

/**
 * Attempts a direct reconnection using existing credentials. 
 * Falls back to the picker if direct connection fails.
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
  const api = await getMssqlApi(outputChannel);

  logger.debug(`>> Open: ${connectionInfo.server} / ${connectionInfo.database} (reconnect)`);
  try {
    const connectionUri = await api.connect(connectionInfo, false);
    logger.debug('Reconnected');
    return { connectionUri, connectionInfo };
  } catch (err) {
    logger.warn(`Direct reconnect failed: ${err instanceof Error ? err.message : String(err)} — falling back to picker`);
    return undefined;
  }
}

/**
 * Utility to wrap an asynchronous operation with a timeout constraint.
 * 
 * @template T - The return type of the promise.
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
  const sharing = await getConnectionSharingApi(outputChannel);

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
  const sharing = await getConnectionSharingApi(outputChannel);

  const phase2Queries = queries.filter(q => (q.phase ?? 2) !== 1);

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
 * @param outputChannel - The VS Code output channel for logging.
 * @returns Server info metadata.
 */
export async function getServerInfo(
  connectionUri: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<IServerInfo> {
  const sharing = await getConnectionSharingApi(outputChannel);
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
  const sharing = await getConnectionSharingApi(outputChannel);
  return sharing.executeSimpleQuery(connectionUri, sql);
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
  const sharing = await getConnectionSharingApi(outputChannel);
  await sharing.disconnect(connectionUri);
  logger.info('Disconnected');
}
