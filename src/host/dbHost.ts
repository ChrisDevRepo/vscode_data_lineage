/** The VS Code side of a database connection: DMV query loading and caching, session opening. */

import * as vscode from 'vscode';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { Logger, type LogChannel } from '../utils/log';
import { clearOnceToasts, notifyWarningOnce } from '../utils/notifications';
import { isDmvQuery, parseBuiltInDmvConfig, parseDmvQueriesYaml, type DmvQuery, type DmvQueriesConfig } from '../engine/connectionManager';
import type { StoredConnectionInfo } from '../engine/shared/bridgeContract';
import { DbConnectionError, type DbSession } from '../engine/db/dbSession';
import { MSSQL_RECONNECT_NOTICE, usesMssqlExtension } from '../engine/db/mssqlRetiring';
import { openBuiltInSession, type BuiltInEnv } from '../engine/db/builtInProvider';
import { describeConnection, findBuiltInMatch, type BuiltInConnection } from '../engine/db/connectionSettings';
import { runAddConnectionFlow } from './connectionCommands';
import { builtInTarget, type ConnectionErrorHooks } from './connectionErrors';
import { readBuiltInConnections } from './connectionStore';

/**
 * Loads DMV queries from the custom path in workspace configuration, falling back to the built-in
 * defaults.
 *
 * @param extensionUri - Base URI of the extension for resolving built-in assets.
 */
export async function loadDmvQueries(
  outputChannel: LogChannel,
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
        const parsed = parseDmvQueriesYaml(new TextDecoder().decode(data));

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

  const builtIn = await loadBuiltInDmvConfig(outputChannel, extensionUri);
  logger.info(`Applied DMV queries: ${builtIn.queries.length} loaded from built-in, 0 skipped`);
  return builtIn.queries;
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
 * Reads and validates the built-in `assets/dmvQueries.yaml` and returns the whole config: the
 * custom-file path needs the shipped `version` (the contract a custom file is validated against),
 * not only the queries.
 *
 * @throws If the built-in file is missing, has no `queries` array, or declares no `version`.
 */
async function loadBuiltInDmvConfig(
  outputChannel: LogChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQueriesConfig> {
  const logger = Logger.create(outputChannel, 'Config');
  const yamlUri = vscode.Uri.joinPath(extensionUri, 'assets', 'dmvQueries.yaml');
  logger.debug(`Reading DMV queries built-in: ${yamlUri.fsPath}`);
  const data = await vscode.workspace.fs.readFile(yamlUri);
  return parseBuiltInDmvConfig(new TextDecoder().decode(data));
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
  env: BuiltInEnv,
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
  env: BuiltInEnv,
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
  env: BuiltInEnv,
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

