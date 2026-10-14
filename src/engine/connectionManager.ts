/**
 * @module ConnectionManager
 * Database connectivity entry point and DMV query management.
 *
 * This module provides the infrastructure for:
 * - Loading and validating DMV (Dynamic Management View) queries from built-in or custom sources.
 * - Opening a {@link DbSession} through the built-in provider.
 * - Executing queries with automated timeout handling and placeholder expansion.
 */

import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { SimpleExecuteResult } from '../types/database';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { notifyWarning } from '../utils/notifications';
import { StoredConnectionInfoSchema, type StoredConnectionInfo } from './shared/bridgeContract';
import { DbConnectionError, type DbSession } from './db/dbSession';
import { openBuiltInSession, type BuiltInEnv } from './db/builtInProvider';
import { describeConnection, dropTcpPrefix, readBuiltInConnections, type BuiltInConnection } from './db/connectionSettings';
import { parseServerInput, runAddConnectionFlow } from './db/connectionCommands';
import { builtInTarget, type ConnectionErrorHooks } from './db/connectionErrors';

const DmvQueriesConfigSchema = z.object({
  version: z.coerce.number().optional(),
  queries: z.array(z.record(z.string(), z.any())).optional()
}).passthrough();

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
   * unclassified, omitting 'platform-info' records an unknown platform, and
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

/** Validates the fields required by the import path; other {@link DmvQuery} fields degrade gracefully. */
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

/** Setting that names a custom DMV queries YAML. */
const DMV_QUERIES_FILE_SETTING = 'dataLineageViz.dmvQueriesFile';

/** The file `dataLineageViz.dmvQueriesFile` currently resolves to, or `''` for the built-in queries. */
function configuredDmvQueriesFile(): string {
  const value = vscode.workspace.getConfiguration('dataLineageViz').get<string>('dmvQueriesFile', '');
  return value ? resolveWorkspacePath(value) ?? value : '';
}

/** DMV queries kept between reads until the configured YAML file changes. */
export interface DmvQueryCache extends vscode.Disposable {
  /** The kept queries, loading them on first use or after the setting changed. A failed load is not kept. */
  get(): Promise<DmvQuery[]>;
  /** Loads the queries again and keeps the result; an import uses it so an edit to the file applies to the next import. */
  reload(): Promise<DmvQuery[]>;
}

/**
 * Creates a DMV queries cache that reloads when `dataLineageViz.dmvQueriesFile` names another file.
 *
 * @remarks
 * Each load reads the YAML, logs and may show a warning toast for an unusable custom file, so callers
 * that need the queries repeatedly — the built-in provider's server-info lookup on every table-statistics
 * request — read the cached result instead. A setting change that keeps the resolved file (a relative
 * path rewritten to its absolute form) keeps the cache. Listening for setting changes starts with the
 * first load; dispose to stop it.
 *
 * @param load - Reads and validates the queries, normally {@link loadDmvQueries}.
 */
export function createDmvQueryCache(load: () => Promise<DmvQuery[]>): DmvQueryCache {
  let cached: Promise<DmvQuery[]> | undefined;
  let loadedFile: string | undefined;
  let subscription: vscode.Disposable | undefined;
  const reload = (): Promise<DmvQuery[]> => {
    subscription ??= vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(DMV_QUERIES_FILE_SETTING) && configuredDmvQueriesFile() !== loadedFile) cached = undefined;
    });
    loadedFile = configuredDmvQueriesFile();
    const loading = load();
    cached = loading;
    loading.catch(() => { if (cached === loading) cached = undefined; });
    return loading;
  };
  return {
    get: () => cached ?? reload(),
    reload,
    dispose: () => {
      subscription?.dispose();
      subscription = undefined;
      cached = undefined;
    },
  };
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

/** Selects credential-free, schema-declared fields for legacy connection migration. */
export function stripSensitiveFields(source: Record<string, unknown>): StoredConnectionInfo {
  const persistable: Record<string, unknown> = {};
  for (const key of Object.keys(StoredConnectionInfoSchema.shape)) {
    if (source[key] !== undefined) persistable[key] = source[key];
  }
  return StoredConnectionInfoSchema.parse(persistable);
}

/** Host services a connection needs: the secret store for built-in passwords and the log channel. */
export type DbConnectEnv = BuiltInEnv;

/** Built-in sign-in type a stored record's `authenticationType` names; legacy and built-in spellings both read. */
function storedAuthKind(authenticationType: string | undefined): BuiltInConnection['authenticationType'] | undefined {
  if (!authenticationType) return undefined;
  const value = authenticationType.toLowerCase();
  if (value === 'sqllogin') return 'sqlLogin';
  if (value === 'entraid' || value.startsWith('azure') || value.startsWith('activedirectory')) return 'entraId';
  return undefined;
}

/**
 * Finds the saved built-in connection that reopens a stored project.
 *
 * @remarks
 * A saved `connectionId` wins. Otherwise the match follows the saved connection identity:
 * same server and port (a `host,port` server string is split first), and the same sign-in type and user where both sides name one. Among several
 * matches the one saved for the project's database is preferred, then the first; the project's own
 * database is opened either way.
 */
function findBuiltInMatch(connections: BuiltInConnection[], stored: StoredConnectionInfo): BuiltInConnection | undefined {
  const byId = stored.connectionId ? connections.find((c) => c.id === stored.connectionId) : undefined;
  if (byId) return byId;
  const same = (a?: string, b?: string) => !a || !b || a.toLowerCase() === b.toLowerCase();
  const kind = storedAuthKind(stored.authenticationType);
  const host = parseServerInput(stored.server) ?? { server: stored.server };
  const defaultPort = host.server.includes('\\') ? undefined : 1433;
  const port = stored.port ?? host.port ?? defaultPort;
  const matches = connections.filter((c) => dropTcpPrefix(c.server).toLowerCase() === host.server.toLowerCase()
    && (c.port ?? defaultPort) === port
    && (!kind || c.authenticationType === kind)
    && same(c.user, stored.user));
  return matches.find((c) => same(c.database, stored.database) && !!c.database) ?? matches[0];
}

function authDetail(connection: BuiltInConnection): string {
  return connection.authenticationType === 'entraId' ? 'Microsoft Entra ID' : `SQL Login (${connection.user ?? 'no user'})`;
}

const MANAGE_ITEMS = [
  { label: '$(edit) Edit Connection…', command: 'dataLineageViz.editDatabaseConnection' },
  { label: '$(key) Update Password…', command: 'dataLineageViz.updateDatabasePassword' },
  { label: '$(trash) Remove Connection…', command: 'dataLineageViz.removeDatabaseConnection' },
] as const;

/**
 * Shows the saved built-in connections, an add item and the manage commands; returns the chosen or
 * newly added connection. A manage item runs its command and shows the list again. The add flow
 * starts from the server, port, user and database of `stored` when there is one.
 */
async function pickBuiltInConnection(
  env: DbConnectEnv,
  connections: BuiltInConnection[],
  stored?: StoredConnectionInfo,
): Promise<BuiltInConnection | undefined> {
  let current = connections;
  for (;;) {
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { connection?: BuiltInConnection; command?: string }>(
      [
        ...current.map((connection) => ({
          label: connection.name, description: describeConnection(connection), detail: authDetail(connection), connection,
        })),
        { label: '$(add) Add Connection…', description: 'Save a new SQL login or Microsoft Entra ID connection' },
        ...(current.length > 0
          ? [{ label: 'Manage', kind: vscode.QuickPickItemKind.Separator }, ...MANAGE_ITEMS.map((item) => ({ ...item }))]
          : []),
      ],
      {
        placeHolder: 'Select a database connection',
        ignoreFocusOut: true, matchOnDescription: true,
      },
    );
    if (!picked) return undefined;
    if (picked.connection) return picked.connection;
    if (!picked.command) {
      return runAddConnectionFlow(env, undefined, stored
        ? { server: stored.server, port: stored.port, user: stored.user, database: stored.database }
        : undefined);
    }
    await vscode.commands.executeCommand(picked.command);
    current = readBuiltInConnections();
  }
}

/**
 * Asks for the database of a connection saved without one.
 *
 * @remarks
 * The name is typed: a login that exists only inside one database (a contained or Microsoft Entra
 * user on Azure SQL, a Fabric or Synapse workspace) cannot list the server's databases. The
 * connection made with that name reports a database that cannot be opened.
 */
async function pickDatabase(connection: BuiltInConnection): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({ prompt: `Database on ${connection.server}`, placeHolder: 'Database name', ignoreFocusOut: true });
  return typed?.trim() || undefined;
}

/**
 * Opens a built-in connection for one operation.
 *
 * @remarks
 * A stored record reconnects the matching saved connection silently; without a match, or without a
 * record, the connection picker opens. The caller disposes the returned session.
 *
 * @param env - Host services.
 * @param stored - Connection record of the project being reopened.
 * @param token - Cancels an in-progress connect.
 * @returns The open session, or `undefined` when the user cancels a prompt.
 * @throws {DbConnectionError} When the connection cannot be opened.
 */
export async function connectDatabase(env: DbConnectEnv, stored?: StoredConnectionInfo, token?: vscode.CancellationToken): Promise<DbSession | undefined> {
  const logger = Logger.create(env.outputChannel, 'DB');
  const connections = readBuiltInConnections(logger);
  let connection: BuiltInConnection | undefined;
  if (stored) {
    connection = findBuiltInMatch(connections, stored);
    if (!connection) {
      logger.warn('Direct reconnect: no matching saved built-in connection — falling back to picker');
      logger.debug(`Unmatched reconnect server: ${stored.server}`);
    }
  }
  connection ??= await pickBuiltInConnection(env, connections, stored);
  if (!connection) {
    logger.info('User cancelled connection picker');
    return undefined;
  }
  const database = stored?.database || connection.database || await pickDatabase(connection);
  if (!database) {
    logger.info('User cancelled database selection');
    return undefined;
  }
  try {
    return await openBuiltInSession(connection, env, { database, token });
  } catch (err) {
    throw new DbConnectionError(builtInTarget(connection, database), err);
  }
}

/**
 * Builds the capabilities the connection-error actions use.
 *
 * @param env - Host services.
 * @param connectionId - Saved built-in connection an error belongs to, when there is one.
 * @param retry - Repeats the failed operation once.
 */
export function connectionErrorHooks(
  env: DbConnectEnv,
  connectionId: string | undefined,
  retry: ConnectionErrorHooks['retry'],
): ConnectionErrorHooks {
  return {
    retry,
    showLog: () => env.outputChannel.show(true),
    chooseDatabase: async () => {
      const connection = readBuiltInConnections().find((c) => c.id === connectionId);
      return connection ? pickDatabase(connection) : undefined;
    },
  };
}

/** Error text when a DMV query outlives `dataLineageViz.dmvQueryTimeout`. */
function dmvTimeoutMessage(name: string, queryTimeoutMs: number): string {
  return `DMV query "${name}" timed out after ${queryTimeoutMs / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`;
}

/**
 * Runs one query on a session, bounded by an optional timeout.
 *
 * @remarks
 * The session owns the budget: it starts the timer when the request reaches the wire, cancels the
 * request when it is spent and only then rejects. No second timer runs here, so a reported timeout
 * always means the request was cancelled.
 */
async function runTimed(
  session: DbSession,
  sql: string,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): Promise<SimpleExecuteResult> {
  return timeoutMs ? session.executeSimpleQuery(sql, { timeoutMs, timeoutMessage }) : session.executeSimpleQuery(sql);
}

/**
 * Executes a batch of DMV queries sequentially.
 *
 * @param session - The open database session.
 * @param queries - List of queries to execute.
 * @param outputChannel - Logger output channel.
 * @param onProgress - Optional callback for tracking execution progress.
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 * @returns A map of query names to their execution results.
 */
export async function executeDmvQueries(
  session: DbSession,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');

  const results = new Map<string, SimpleExecuteResult>();
  const total = queries.length;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const step = i + 1;

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(query.sql), 300)}`);

    const start = Date.now();
    const result = await runTimed(session, query.sql, queryTimeoutMs, dmvTimeoutMessage(query.name, queryTimeoutMs ?? 0));
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
 * @param session - The open database session.
 * @param queries - Candidate queries to filter and execute.
 * @param schemas - Schema names for placeholder replacement.
 * @param outputChannel - Logger output channel.
 * @param onProgress - Progress tracking callback.
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 * @returns Results for the executed Phase 2 queries.
 */
export async function executeDmvQueriesFiltered(
  session: DbSession,
  queries: DmvQuery[],
  schemas: string[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');

  const phase2Queries = queries.filter(isPhase2Query);

  for (const q of phase2Queries) {
    const warning = validateSchemaPlaceholder(q.name, q.sql, q.phase ?? 2);
    if (warning) logger.warn(warning);
  }

  const expanded = phase2Queries.map(query => ({ ...query, sql: expandSchemaPlaceholder(query.sql, schemas) }));
  return executeDmvQueries(session, expanded, outputChannel, onProgress, queryTimeoutMs);
}

/**
 * Executes a single SQL command without batching or placeholders.
 *
 * @param session - The open database session.
 * @param sql - The SQL script to execute.
 * @param outputChannel - Logger output channel.
 * @param timeout - Optional budget; the session cancels the request when it is spent.
 * @returns The query execution result.
 */
export async function executeSimpleQuery(
  session: DbSession,
  sql: string,
  outputChannel: vscode.LogOutputChannel,
  timeout?: { ms: number; message: string },
): Promise<SimpleExecuteResult> {
  const logger = Logger.create(outputChannel, 'DB');
  logger.debug(`Executing simple query — SQL: ${trunc(sanitizeForLog(sql), 300)}`);
  const start = Date.now();
  const result = await runTimed(session, sql, timeout?.ms, timeout?.message ?? '');
  logger.debug(`Simple query — ${result.rowCount} rows (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  return result;
}
