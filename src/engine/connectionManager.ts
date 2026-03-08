import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { IExtension, IConnectionInfo, IConnectionSharingService, SimpleExecuteResult } from '../types/mssql';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

// ─── DMV Query Loading ──────────────────────────────────────────────────────

export interface DmvQuery {
  name: string;
  description: string;
  sql: string;
  phase?: number;  // 1 = Phase 1 (unfiltered), 2 = Phase 2 ({{SCHEMAS}} expanded)
}

export interface DmvQueriesConfig {
  version: number;
  queries: DmvQuery[];
}

export async function loadDmvQueries(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQuery[]> {
  const cfg = vscode.workspace.getConfiguration('dataLineageViz');
  const customPath = cfg.get<string>('dmvQueriesFile', '');

  if (customPath) {
    const resolved = resolveWorkspacePath(customPath);
    if (resolved) {
      try {
        const fileUri = vscode.Uri.file(resolved);
        const data = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder().decode(data);
        const parsed = yaml.load(content) as DmvQueriesConfig;

        if (parsed?.queries && Array.isArray(parsed.queries)) {
          const valid = parsed.queries.filter(q => q.name && q.sql);
          if (valid.length > 0) {
            const KNOWN_NAMES = ['schema-preview', 'all-objects', 'nodes', 'columns', 'dependencies'];
            const loadedNames = new Set(valid.map(q => q.name));
            const missingNames = KNOWN_NAMES.filter(n => !loadedNames.has(n));
            if (missingNames.length > 0) {
              outputChannel.warn(`[DB] Custom DMV queries missing: ${missingNames.join(', ')} — DB import may fail`);
              vscode.window.showWarningMessage(`Custom DMV queries missing: ${missingNames.join(', ')}. DB import may fail.`);
            }
            await persistAbsolutePath('dmvQueriesFile', customPath, resolved);
            outputChannel.info(`[DB] Loaded ${valid.length} DMV queries from ${path.basename(customPath)}`);
            return valid;
          }
        }
        outputChannel.warn(`[DB] Invalid custom DMV queries in ${customPath} — falling back to built-in`);
        vscode.window.showWarningMessage('Custom DMV queries invalid — using built-in defaults.');
      } catch (err) {
        outputChannel.warn(`[DB] Failed to load custom DMV queries: ${err instanceof Error ? err.message : String(err)} — falling back to built-in`);
        vscode.window.showWarningMessage('Failed to load custom DMV queries — using built-in defaults. Check Output channel.');
      }
    } else {
      outputChannel.warn(`[DB] Cannot resolve DMV queries path "${customPath}" — falling back to built-in`);
      vscode.window.showWarningMessage(`Cannot resolve DMV queries path "${customPath}" — using built-in defaults.`);
    }
  }

  return loadBuiltInDmvQueries(outputChannel, extensionUri);
}

async function loadBuiltInDmvQueries(
  outputChannel: vscode.LogOutputChannel,
  extensionUri: vscode.Uri,
): Promise<DmvQuery[]> {
  const yamlUri = vscode.Uri.joinPath(extensionUri, 'assets', 'dmvQueries.yaml');
  const data = await vscode.workspace.fs.readFile(yamlUri);
  const content = new TextDecoder().decode(data);
  const parsed = yaml.load(content) as DmvQueriesConfig;

  if (!parsed?.queries || !Array.isArray(parsed.queries)) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "queries" array');
  }

  outputChannel.info(`[DB] Using built-in DMV queries (${parsed.queries.length} queries)`);
  return parsed.queries;
}

// ─── MSSQL Extension Access ─────────────────────────────────────────────────

export function isMssqlAvailable(): boolean {
  return vscode.extensions.getExtension(MSSQL_EXTENSION_ID) !== undefined;
}

async function getMssqlApi(outputChannel: vscode.LogOutputChannel): Promise<IExtension> {
  const ext = vscode.extensions.getExtension<IExtension>(MSSQL_EXTENSION_ID);
  if (!ext) {
    throw new Error(`MSSQL extension (${MSSQL_EXTENSION_ID}) is not installed.`);
  }

  const api = ext.isActive ? ext.exports : await ext.activate();
  outputChannel.info(`[DB] MSSQL extension (${MSSQL_EXTENSION_ID}) v${ext.packageJSON?.version ?? '?'} found`);

  return api;
}

async function getConnectionSharingApi(
  outputChannel: vscode.LogOutputChannel,
): Promise<IConnectionSharingService> {
  const api = await getMssqlApi(outputChannel);
  if (!api.connectionSharing) {
    throw new Error('MSSQL extension does not expose connectionSharing API. Please update to v1.34+.');
  }
  return api.connectionSharing;
}

// ─── Prompt-Based Connection Flow ────────────────────────────────────────────

/**
 * Shows the MSSQL extension's native connection picker, connects, and
 * returns a connectionUri that can be used with executeSimpleQuery().
 * Returns undefined if the user cancels the picker.
 */
export async function promptForConnection(
  outputChannel: vscode.LogOutputChannel,
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo } | undefined> {
  const api = await getMssqlApi(outputChannel);

  const connectionInfo = await api.promptForConnection(true);
  if (!connectionInfo) {
    outputChannel.info('[DB] User cancelled connection picker');
    return undefined;
  }

  outputChannel.info(`[DB] >> Open: ${connectionInfo.server} / ${connectionInfo.database}`);
  const connectionUri = await api.connect(connectionInfo, false);
  outputChannel.info(`[DB] Connected`);

  return { connectionUri, connectionInfo };
}

/** Strip password and connectionString before persisting to workspaceState */
export function stripSensitiveFields(info: IConnectionInfo): Omit<IConnectionInfo, 'password' | 'connectionString'> {
  const { password: _pw, connectionString: _cs, ...safe } = info;
  return safe;
}

/**
 * Connect directly using stored IConnectionInfo (bypasses the picker).
 * Returns undefined on failure so the caller can fall back to promptForConnection.
 */
export async function connectDirect(
  connectionInfo: IConnectionInfo,
  outputChannel: vscode.LogOutputChannel,
): Promise<{ connectionUri: string; connectionInfo: IConnectionInfo } | undefined> {
  const api = await getMssqlApi(outputChannel);

  outputChannel.info(`[DB] >> Open: ${connectionInfo.server} / ${connectionInfo.database} (reconnect)`);
  try {
    const connectionUri = await api.connect(connectionInfo, false);
    outputChannel.info(`[DB] Connected`);
    return { connectionUri, connectionInfo };
  } catch (err) {
    outputChannel.warn(`[DB] Direct reconnect failed: ${err instanceof Error ? err.message : String(err)} — falling back to picker`);
    return undefined;
  }
}

function dmvTimeout<T>(promise: Promise<T>, ms: number, queryName: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(`DMV query "${queryName}" timed out after ${ms / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`)), ms);
    }),
  ]);
}

/**
 * Execute DMV queries against a connected database.
 */
export async function executeDmvQueries(
  connectionUri: string,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const sharing = await getConnectionSharingApi(outputChannel);

  const results = new Map<string, SimpleExecuteResult>();
  const total = queries.length;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const step = i + 1;

    onProgress?.(step, total, query.name);
    outputChannel.info(`[DB] Executing query: ${query.name} (${step}/${total})...`);

    const start = Date.now();
    const queryPromise = sharing.executeSimpleQuery(connectionUri, query.sql);
    const result = queryTimeoutMs ? await dmvTimeout(queryPromise, queryTimeoutMs, query.name) : await queryPromise;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    outputChannel.info(`[DB] Query '${query.name}' returned ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

// ─── Schema-Filtered Query Execution (Phase 2) ─────────────────────────────

/**
 * Execute Phase 2 DMV queries with {{SCHEMAS}} placeholder expansion.
 * Skips Phase 1 queries (phase === 1). Expands {{SCHEMAS}} in remaining queries.
 */
export async function executeDmvQueriesFiltered(
  connectionUri: string,
  queries: DmvQuery[],
  schemas: string[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const sharing = await getConnectionSharingApi(outputChannel);

  const phase2Queries = queries.filter(q => (q.phase ?? 2) !== 1);

  // Validate: warn if any Phase 2 query is missing {{SCHEMAS}}
  for (const q of phase2Queries) {
    const warning = validateSchemaPlaceholder(q.name, q.sql, q.phase ?? 2);
    if (warning) outputChannel.warn(`[DB] ${warning}`);
  }

  const results = new Map<string, SimpleExecuteResult>();
  const total = phase2Queries.length;

  for (let i = 0; i < phase2Queries.length; i++) {
    const query = phase2Queries[i];
    const step = i + 1;
    const sql = expandSchemaPlaceholder(query.sql, schemas);

    onProgress?.(step, total, query.name);
    outputChannel.info(`[DB] Executing filtered query: ${query.name} (${step}/${total})...`);
    outputChannel.debug(`[DB] SQL:\n${sql}`);

    const start = Date.now();
    const queryPromise = sharing.executeSimpleQuery(connectionUri, sql);
    const result = queryTimeoutMs ? await dmvTimeout(queryPromise, queryTimeoutMs, query.name) : await queryPromise;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    outputChannel.info(`[DB] Query '${query.name}' returned ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/** Get server info (version, edition) for a connected database. */
export async function getServerInfo(
  connectionUri: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<import('../types/mssql').IServerInfo> {
  const sharing = await getConnectionSharingApi(outputChannel);
  return sharing.getServerInfo(connectionUri);
}

/** Execute a single SQL query against a connected database. */
export async function executeSimpleQuery(
  connectionUri: string,
  sql: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<SimpleExecuteResult> {
  const sharing = await getConnectionSharingApi(outputChannel);
  return sharing.executeSimpleQuery(connectionUri, sql);
}

export async function disconnectDatabase(
  connectionUri: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const sharing = await getConnectionSharingApi(outputChannel);
  await sharing.disconnect(connectionUri);
  outputChannel.info('[DB] << Closed');
}
