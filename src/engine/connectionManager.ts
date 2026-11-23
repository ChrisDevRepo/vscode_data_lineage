/**
 * Database connectivity entry point and DMV query management: loading and validating DMV queries
 * from built-in or custom sources, opening a {@link DbSession} through the built-in connection, and
 * executing queries with timeout handling and placeholder expansion.
 */

import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { SimpleExecuteResult } from '../types/database';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import { clearOnceToasts, notifyWarningOnce } from '../utils/notifications';
import { StoredConnectionInfoSchema, type StoredConnectionInfo } from './shared/bridgeContract';
import { DbConnectionError, type DbSession } from './db/dbSession';
import { MSSQL_RECONNECT_NOTICE, usesMssqlExtension } from './db/mssqlRetiring';
import { openBuiltInSession, type BuiltInEnv } from './db/builtInProvider';
import { describeConnection, dropTcpPrefix, readBuiltInConnections, type BuiltInConnection } from './db/connectionSettings';
import { parseServerInput, runAddConnectionFlow } from './db/connectionCommands';
import { builtInTarget, type ConnectionErrorHooks } from './db/connectionErrors';

const DmvQueriesConfigSchema = z.object({
  version: z.coerce.number().optional(),
  queries: z.array(z.unknown()).optional()
}).passthrough();

/** A Dynamic Management View (DMV) query used to extract metadata from SQL Server. */
export interface DmvQuery {
  /**
   * The unique name/key of the query.
   *
   * Two classes, because they fail differently. Required ('schema-preview', 'nodes', 'columns',
   * 'dependencies') are in the loader's `KNOWN_NAMES` and warn when a custom YAML omits them, since
   * the import cannot complete without them. Optional ('all-objects', 'platform-info',
   * 'constraints') are absent from that list and degrade silently by design: omitting 'all-objects'
   * leaves cross-schema references unclassified, 'platform-info' leaves the platform unknown,
   * 'constraints' drops constraint enrichment.
   */
  name: string;
  /** A human-readable description of the query's purpose. Never consumed by the import path. */
  description?: string;
  sql: string;
  /**
   * Execution phase: `1` preliminary (unfiltered), `2` main extraction (typically schema-filtered).
   * @defaultValue 2
   */
  phase?: number;
}

/** The fields the import path requires; every other {@link DmvQuery} field degrades gracefully. */
const DmvQuerySchema = z.object({ name: z.string().min(1), sql: z.string().min(1) });
const isDmvQuery = (q: unknown): q is DmvQuery => DmvQuerySchema.safeParse(q).success;

/** Root configuration structure for DMV query definition files. */
interface DmvQueriesConfig {
  version: number;
  queries: DmvQuery[];
}

/**
 * Loads DMV queries from the custom path in workspace configuration, falling back to the built-in
 * defaults.
 *
 * @param extensionUri - Base URI of the extension for resolving built-in assets.
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
          notifyWarningOnce(
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
          let skipped = 0;
          const valid = parsed.queries.filter((q, i): q is DmvQuery => {
            if (isDmvQuery(q)) return true;
            logger.debug(`Skipped DMV query[${i}]: 'name' and 'sql' must be non-empty strings`);
            skipped++;
            return false;
          });
          if (valid.length > 0) {
            const KNOWN_NAMES = ['schema-preview', 'nodes', 'columns', 'dependencies'];
            const loadedNames = new Set(valid.map(q => q.name));
            const missingNames = KNOWN_NAMES.filter(n => !loadedNames.has(n));
            if (missingNames.length > 0) {
              notifyWarningOnce(
                logger,
                'Load custom DMV queries',
                `Custom DMV queries missing: ${missingNames.join(', ')}. DB import may fail.`,
                { missingNames, path: resolved, setting: 'dmvQueriesFile' },
              );
            }
            await persistAbsolutePath('dmvQueriesFile', customPath, resolved);
            logger[skipped > 0 ? 'warn' : 'info'](`Applied DMV queries: ${valid.length} loaded from custom, ${skipped} skipped`);
            return valid;
          }
        }
        notifyWarningOnce(
          logger,
          'Load custom DMV queries',
          'Custom DMV queries invalid — using built-in defaults.',
          { reason: 'missing or invalid queries array', path: resolved, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
        );
      } catch (err) {
        notifyWarningOnce(
          logger,
          'Load custom DMV queries',
          'Failed to load custom DMV queries — using built-in defaults. Check Output channel.',
          { reason: err instanceof Error ? err.message : String(err), path: resolved, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
        );
      }
    } else {
      notifyWarningOnce(
        logger,
        'Load custom DMV queries',
        `Cannot resolve DMV queries path "${customPath}" — using built-in defaults.`,
        { reason: 'cannot resolve path', path: customPath, setting: 'dmvQueriesFile', fallback: 'built-in defaults' },
      );
    }
  }

  return loadBuiltInDmvQueries(outputChannel, extensionUri);
}

const DMV_QUERIES_FILE_SETTING = 'dataLineageViz.dmvQueriesFile';

/** The file `dataLineageViz.dmvQueriesFile` resolves to, or `''` for the built-in queries. */
function configuredDmvQueriesFile(): string {
  const value = vscode.workspace.getConfiguration('dataLineageViz').get<string>('dmvQueriesFile', '');
  return value ? resolveWorkspacePath(value) ?? value : '';
}

/** DMV queries kept between reads until the configured YAML file changes. */
export interface DmvQueryCache extends vscode.Disposable {
  /** Kept queries, loaded on first use or after a setting change; a failed load is not kept. */
  get(): Promise<DmvQuery[]>;
  /** Loads the queries again and keeps the result, so an import applies an edit to the file. */
  reload(): Promise<DmvQuery[]>;
}

/**
 * Creates a DMV queries cache that reloads when `dataLineageViz.dmvQueriesFile` names another file.
 * Each load reads the YAML, logs and may show a warning toast for an unusable custom file, so
 * repeated callers (the built-in provider's server-info lookup on every table-statistics request)
 * read the cached result. A setting change that keeps the resolved file (a relative path rewritten
 * to absolute) keeps the cache. Listening starts with the first load; dispose to stop it.
 *
 * @param load - Reads and validates the queries, normally {@link loadDmvQueries}.
 */
export function createDmvQueryCache(load: () => Promise<DmvQuery[]>): DmvQueryCache {
  let cached: Promise<DmvQuery[]> | undefined;
  let loadedFile: string | undefined;
  let subscription: vscode.Disposable | undefined;
  const reload = (): Promise<DmvQuery[]> => {
    subscription ??= vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(DMV_QUERIES_FILE_SETTING) && configuredDmvQueriesFile() !== loadedFile) {
        cached = undefined;
        clearOnceToasts();
      }
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
 * Reads and validates the built-in `assets/dmvQueries.yaml` and returns the whole config. Split
 * from {@link loadBuiltInDmvQueries} because the custom-file path needs the shipped `version` (the
 * contract a custom file is validated against), not only the queries.
 *
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
  const validQueries = queries.filter(isDmvQuery);
  if (validQueries.length !== queries.length) {
    throw new Error('Built-in dmvQueries.yaml is invalid — a query is missing "name" or "sql"');
  }

  return { version, queries: validQueries };
}

/**
 * Reduces connection info to exactly the fields that may be persisted. An allow-list read from
 * {@link StoredConnectionInfoSchema}, so the two cannot drift.
 *
 * A deny-list is unsafe because the object can be wider than the stored shape (a legacy
 * workspace-state record carries `applicationName`, `connectTimeout`, ...). Spreading the rest
 * wrote those keys into the project store; the strict read side then rejected the record and
 * `migrateProjectStore` discarded the saved project on the next load. `.strict()` on the read side
 * stays on purpose: it keeps a future leaked credential out of the store. This is the only write
 * path, so it narrows here and parses what it built, failing at save time rather than dropping the
 * project on the next load.
 *
 * @returns A persistable clone with only schema-declared fields; secrets are never among them.
 * @throws When the narrowed record still violates {@link StoredConnectionInfoSchema}, e.g. a
 *   server-scoped profile with no `database`.
 */
export function stripSensitiveFields(source: Record<string, unknown>): StoredConnectionInfo {
  const persistable: Record<string, unknown> = {};
  for (const key of Object.keys(StoredConnectionInfoSchema.shape)) {
    if (source[key] !== undefined) persistable[key] = source[key];
  }
  return StoredConnectionInfoSchema.parse(persistable);
}

/** Host services a connection needs: the secret store (built-in passwords) and the log channel. */
export type DbConnectEnv = BuiltInEnv;

/** Built-in sign-in type a stored record names; the mssql extension's spellings read too. */
function storedAuthKind(authenticationType: string | undefined): BuiltInConnection['authenticationType'] | undefined {
  const value = authenticationType?.toLowerCase() ?? '';
  if (value === 'sqllogin') return 'sqlLogin';
  return value === 'entraid' || value.startsWith('azure') || value.startsWith('activedirectory') ? 'entraId' : undefined;
}

/** Port SQL Server listens on when none is given; a named instance has none. */
const DEFAULT_SQL_PORT = 1433;

/**
 * Finds the saved built-in connection that reopens a stored project. A saved `connectionId` wins.
 * Otherwise: same server (`tcp:` prefix ignored) and effective port (a `host,port` string is split
 * first, an absent port is the default one; a named instance has a dynamic port, so an absent port
 * matches any) and the same sign-in type and user where both sides name one. Among several matches
 * the one saved for the project's database is preferred, then the first; the project's own database
 * is opened either way.
 */
function findBuiltInMatch(connections: BuiltInConnection[], stored: StoredConnectionInfo): BuiltInConnection | undefined {
  const byId = stored.connectionId ? connections.find((c) => c.id === stored.connectionId) : undefined;
  if (byId) return byId;
  const same = (a?: string, b?: string) => !a || !b || a.toLowerCase() === b.toLowerCase();
  const kind = storedAuthKind(stored.authenticationType);
  const host = parseServerInput(stored.server) ?? { server: stored.server };
  const defaultPort = host.server.includes('\\') ? undefined : DEFAULT_SQL_PORT;
  const port = stored.port ?? host.port ?? defaultPort;
  const matches = connections.filter((c) => dropTcpPrefix(c.server).toLowerCase() === host.server.toLowerCase()
    && (defaultPort === undefined ? !c.port || !port || c.port === port : (c.port ?? defaultPort) === port)
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
 * Asks for the database of a connection saved without one. The name is typed because a login that
 * exists only inside one database (a contained or Entra user on Azure SQL, a Fabric or Synapse
 * workspace) cannot list the server's databases; the connection reports a database that cannot be
 * opened.
 */
async function pickDatabase(connection: BuiltInConnection): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({ prompt: `Database on ${connection.server}`, placeHolder: 'Database name', ignoreFocusOut: true });
  return typed?.trim() || undefined;
}

/**
 * Opens a database session through the built-in connection. A stored connection reconnects silently
 * by its saved `connectionId`, else by the matching saved connection, else through the picker. A
 * record written for the retired mssql extension never reconnects silently: it shows one non-modal
 * warning and opens Add Database Connection prefilled with the stored server, port, user and
 * database, so the project is stored with the new connection only after the user made it.
 *
 * @param stored - Connection saved with a project, when reconnecting.
 * @param token - Cancels a connect in progress.
 * @returns The open session, or `undefined` when the user cancelled.
 * @throws {@link DbConnectionError} when the connection cannot be opened.
 */
export async function connectDatabase(
  env: DbConnectEnv,
  stored?: StoredConnectionInfo,
  token?: vscode.CancellationToken,
  onConnecting?: (label: string) => void,
): Promise<DbSession | undefined> {
  const logger = Logger.create(env.outputChannel, 'DB');
  let connection: BuiltInConnection | undefined;
  if (stored && usesMssqlExtension(stored)) {
    logger.info('Project saved with the retired mssql extension connection — opening Add Database Connection');
    logger.debug(`Retired mssql connection server: ${stored.server}`);
    void vscode.window.showWarningMessage(MSSQL_RECONNECT_NOTICE);
    connection = await runAddConnectionFlow(env, undefined, { server: stored.server, port: stored.port, user: stored.user, database: stored.database });
  } else {
    const connections = readBuiltInConnections(logger);
    if (stored) {
      connection = findBuiltInMatch(connections, stored);
      if (!connection) {
        logger.warn('Direct reconnect: no matching saved built-in connection — falling back to picker');
        logger.debug(`Unmatched reconnect server: ${stored.server}`);
      }
    }
    connection ??= await pickBuiltInConnection(env, connections, stored);
  }
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
    return await openBuiltInSession(connection, env, { database, token, onConnecting });
  } catch (err) {
    throw new DbConnectionError(builtInTarget(connection, database), err);
  }
}

/**
 * Builds the capabilities the connection-error actions use.
 *
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

/** Releases a session opened for one operation: its socket is closed. */
export async function releaseSession(session: DbSession): Promise<void> {
  await session.dispose();
}

/** Wraps an async operation with a timeout; rejects with `timeoutMessage` after `ms`. */
function withQueryTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    }),
  ]);
}

/** Error text when a DMV query outlives `dataLineageViz.dmvQueryTimeout`. */
function dmvTimeoutMessage(name: string, queryTimeoutMs: number): string {
  return `DMV query "${name}" timed out after ${queryTimeoutMs / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`;
}

/**
 * Runs one query on a session, bounded by an optional timeout. The session receives the same budget
 * so a provider that owns the wire cancels the request instead of leaving it running behind the
 * timeout.
 */
async function runTimed(
  session: DbSession,
  sql: string,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): Promise<SimpleExecuteResult> {
  if (!timeoutMs) return session.executeSimpleQuery(sql);
  return withQueryTimeout(session.executeSimpleQuery(sql, { timeoutMs, timeoutMessage }), timeoutMs, timeoutMessage);
}

/**
 * Executes a batch of DMV queries sequentially; returns a map of query name to result.
 *
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
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
 * Whether a query belongs to the schema-filtered Phase 2 sweep. Exported so callers size progress
 * from the same predicate the sweep uses: `phase: 1` means "not schema-filtered", not "runs during
 * Phase 1" (the platform probe carries that tag while running at Phase 2 time), so a
 * re-implementation would miscount the steps.
 */
export const isPhase2Query = (q: DmvQuery): boolean => (q.phase ?? 2) !== 1;

/**
 * Executes the Phase 2 queries among `queries` with `{{SCHEMAS}}` substitution from `schemas`.
 *
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
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

  const results = new Map<string, SimpleExecuteResult>();
  const total = phase2Queries.length;

  for (let i = 0; i < phase2Queries.length; i++) {
    const query = phase2Queries[i];
    const step = i + 1;
    const sql = expandSchemaPlaceholder(query.sql, schemas);

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(sql), 300)}`);

    const start = Date.now();
    const result = await runTimed(session, sql, queryTimeoutMs, dmvTimeoutMessage(query.name, queryTimeoutMs ?? 0));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.debug(`Query '${query.name}' — ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Executes a single SQL command without batching or placeholders.
 *
 * @param timeout - Optional budget; the session cancels the request when it is spent.
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
