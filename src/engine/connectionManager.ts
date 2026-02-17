import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { IExtension, IConnectionInfo, SimpleExecuteResult } from '../types/mssql';
import { resolveWorkspacePath, persistAbsolutePath } from '../utils/paths';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

// ─── DMV Query Loading ──────────────────────────────────────────────────────

export interface DmvQuery {
  name: string;
  description: string;
  sql: string;
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
            await persistAbsolutePath('dmvQueriesFile', customPath, resolved);
            outputChannel.info(`[DB] Loaded ${valid.length} DMV queries from ${path.basename(customPath)}`);
            return valid;
          }
        }
        outputChannel.warn(`[DB] Invalid custom DMV queries in ${customPath} — falling back to built-in`);
      } catch (err) {
        outputChannel.warn(`[DB] Failed to load custom DMV queries: ${err instanceof Error ? err.message : String(err)} — falling back to built-in`);
      }
    } else {
      outputChannel.warn(`[DB] Cannot resolve DMV queries path "${customPath}" — falling back to built-in`);
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

  outputChannel.info(`[DB] Connecting to ${connectionInfo.server} / ${connectionInfo.database}...`);
  const connectionUri = await api.connect(connectionInfo, false);
  outputChannel.info(`[DB] Connected`);

  return { connectionUri, connectionInfo };
}

/** Strip password and connectionString before persisting to workspaceState */
export function stripSensitiveFields(info: IConnectionInfo): Omit<IConnectionInfo, 'password' | 'connectionString'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, connectionString, ...safe } = info;
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

  outputChannel.info(`[DB] Reconnecting to ${connectionInfo.server} / ${connectionInfo.database}...`);
  try {
    const connectionUri = await api.connect(connectionInfo, false);
    outputChannel.info(`[DB] Reconnected`);
    return { connectionUri, connectionInfo };
  } catch (err) {
    outputChannel.warn(`[DB] Direct reconnect failed: ${err instanceof Error ? err.message : String(err)} — falling back to picker`);
    return undefined;
  }
}

/**
 * Execute DMV queries against a connected database.
 */
export async function executeDmvQueries(
  connectionUri: string,
  queries: DmvQuery[],
  outputChannel: vscode.LogOutputChannel,
  onProgress?: (step: number, total: number, label: string) => void,
): Promise<Map<string, SimpleExecuteResult>> {
  const api = await getMssqlApi(outputChannel);

  if (!api.connectionSharing) {
    throw new Error('MSSQL extension does not expose connectionSharing API. Please update to v1.34+.');
  }

  const results = new Map<string, SimpleExecuteResult>();
  const total = queries.length;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const step = i + 1;

    onProgress?.(step, total, query.name);
    outputChannel.info(`[DB] Executing query: ${query.name} (${step}/${total})...`);

    const start = Date.now();
    const result = await api.connectionSharing.executeSimpleQuery(connectionUri, query.sql);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    outputChannel.info(`[DB] Query '${query.name}' returned ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Disconnect from a database.
 */
export async function disconnectDatabase(
  connectionUri: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const api = await getMssqlApi(outputChannel);
  if (api.connectionSharing) {
    await api.connectionSharing.disconnect(connectionUri);
    outputChannel.info('[DB] Disconnected');
  }
}
