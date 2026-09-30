/**
 * @module BuiltInProvider
 * Built-in SQL Server connection provider on `tedious`: SQL login or Microsoft Entra ID, with
 * results rendered as the mssql extension renders them so the DMV consumers need no provider branch.
 */

import * as vscode from 'vscode';
import type { Connection } from 'tedious';
import type { DbCellValue, IDbColumn, IServerInfo, SimpleExecuteResult } from '../../types/mssql';
import { Logger } from '../../utils/log';
import { DEFAULT_CONFIG } from '../types';
import { StoredConnectionInfoSchema, type StoredConnectionInfo } from '../shared/bridgeContract';
import { readSavedPassword, savePassword, passwordTooLong, describeConnection, resolveServerAddress, type BuiltInConnection } from './connectionSettings';
import { redactSecrets } from './connectionErrors';
import { MicrosoftSignInError, type DbQueryOptions, type DbSession } from './dbSession';
import type { DmvQuery } from '../connectionManager';

/** Everything the provider needs from the extension host. */
export interface BuiltInEnv {
  /** Secret store that holds SQL login passwords. */
  secrets: vscode.SecretStorage;
  /** Output channel for debug and info logging. */
  outputChannel: vscode.LogOutputChannel;
  /** Loads the DMV queries YAML; every statement the built-in connection sends comes from it. */
  loadQueries: () => Promise<DmvQuery[]>;
}

/** Per-open overrides of a saved connection. */
export interface BuiltInOpenOptions {
  /** Password to use instead of the secret store; never persisted. */
  password?: string;
  /** Database to open instead of the saved one. */
  database?: string;
  /** Cancels a connect in progress; the socket is closed and the open resolves `undefined`. */
  token?: vscode.CancellationToken;
}

/** Scope that yields an access token for Azure SQL, Fabric and Synapse. */
const ENTRA_SQL_SCOPE = 'https://database.windows.net//.default';

/** Application name SQL Server reports for these connections. */
const APP_NAME = 'Data Lineage Viz';

const MS_PER_SECOND = 1000;
/**
 * Connect retries on the transient errors the driver recognises (the SqlClient list: 4060, 10928,
 * 10929, 40197, 40501, 40613). Microsoft recommends waiting at least five seconds before a retry.
 */
const CONNECT_RETRY_INTERVAL_MS = 5 * MS_PER_SECOND;
const CONNECT_MAX_RETRIES = 3;
/** Login budget of one connect attempt; Microsoft recommends 30 seconds for Azure SQL and Synapse. */
const CONNECT_TIMEOUT_MS = 30 * MS_PER_SECOND;

/** Engine editions that run in a Microsoft cloud service. */
const CLOUD_ENGINE_EDITIONS: ReadonlySet<number> = new Set([5, 6, 8, 11, 12]);

/** The part of `tedious` column metadata that decides how a value is rendered. */
interface CellMetadata {
  type: { name: string };
  scale?: number;
  precision?: number;
  dataLength?: number;
}

/** Column metadata as `tedious` reports it in the `columnMetadata` event. */
interface ColumnMetadata extends CellMetadata {
  colName: string;
  flags: number;
}

const NULL_CELL: DbCellValue = { displayValue: 'NULL', isNull: true };

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function isoDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

function clockTime(d: Date): string {
  return `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
}

/** Fractional-second digits of a temporal value, truncated to `digits` (0-7), millisecond precision plus tedious's sub-millisecond delta. */
function fraction(d: Date, digits: number): string {
  if (digits <= 0) return '';
  const delta = (d as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0;
  const full = `${pad(d.getUTCMilliseconds(), 3)}${pad(Math.round(delta * 1e7), 4)}`;
  return `.${full.slice(0, Math.min(digits, 7)).padEnd(digits, '0')}`;
}

function renderTemporal(d: Date, typeName: string, meta: CellMetadata): string {
  switch (typeName) {
    case 'Date':
      return isoDate(d);
    case 'Time':
      return `${clockTime(d)}${fraction(d, meta.scale ?? 7)}`;
    case 'SmallDateTime':
      return `${isoDate(d)} ${clockTime(d)}`;
    case 'DateTimeN':
      return `${isoDate(d)} ${clockTime(d)}${meta.dataLength === 4 ? '' : fraction(d, 3)}`;
    case 'DateTime2':
      return `${isoDate(d)} ${clockTime(d)}${fraction(d, meta.scale ?? 7)}`;
    case 'DateTimeOffset':
      return `${isoDate(d)} ${clockTime(d)}${fraction(d, meta.scale ?? 7)} +00:00`;
    default:
      return `${isoDate(d)} ${clockTime(d)}${fraction(d, 3)}`;
  }
}

/** Longest float32 decimal needed to round-trip any `real` value. */
const REAL_MAX_DIGITS = 9;
/** Fixed scale of `money` and `smallmoney`. */
const MONEY_SCALE = 4;

/** The shortest decimal text that reads back as the same 32-bit `real`. */
function renderReal(n: number): string {
  const single = Math.fround(n);
  for (let digits = 1; digits < REAL_MAX_DIGITS; digits++) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return String(candidate);
  }
  return String(Number(single.toPrecision(REAL_MAX_DIGITS)));
}

/**
 * Renders an exact numeric with its declared scale.
 *
 * @remarks
 * The driver delivers `decimal`, `numeric` and `money` as a double. Beyond the digits a double holds,
 * padding to the scale would print digits the server never sent, so such a value keeps the double's
 * shortest text instead.
 */
function renderScaled(n: number, scale: number): string {
  return Math.abs(n) * 10 ** scale <= Number.MAX_SAFE_INTEGER ? n.toFixed(scale) : String(n);
}

function renderNumber(n: number, typeName: string, meta: CellMetadata): string {
  switch (typeName) {
    case 'Decimal':
    case 'DecimalN':
    case 'Numeric':
    case 'NumericN':
      return meta.scale === undefined ? String(n) : renderScaled(n, meta.scale);
    case 'Money':
    case 'MoneyN':
    case 'SmallMoney':
      return renderScaled(n, MONEY_SCALE);
    case 'Real':
      return renderReal(n);
    case 'FloatN':
      return meta.dataLength === 4 ? renderReal(n) : String(n);
    default:
      return String(n);
  }
}

/**
 * Renders one `tedious` cell value as the mssql extension's `displayValue`.
 *
 * @remarks
 * `bit` renders `1`/`0`, binary as `0x` hex, decimals with their declared scale, temporal values in
 * UTC with the fraction their type carries, and `NULL` as `isNull` with the text `NULL`.
 *
 * @param value - Value from a `row` event.
 * @param meta - Metadata of the column the value came from.
 */
export function mapCell(value: unknown, meta: CellMetadata): DbCellValue {
  if (value === null || value === undefined) return NULL_CELL;
  const typeName = meta.type.name;
  if (value instanceof Date) return { displayValue: renderTemporal(value, typeName, meta), isNull: false };
  if (typeof value === 'boolean') return { displayValue: value ? '1' : '0', isNull: false };
  if (Buffer.isBuffer(value)) return { displayValue: `0x${value.toString('hex').toUpperCase()}`, isNull: false };
  if (typeof value === 'number') return { displayValue: renderNumber(value, typeName, meta), isNull: false };
  return { displayValue: String(value), isNull: false };
}

const NULLABLE_VARIANT = /^(Int|Bit|Float|Money|DateTime|Decimal|Numeric)N$/;

function toColumnInfo(meta: ColumnMetadata, ordinal: number): IDbColumn {
  const name = meta.type.name.replace(NULLABLE_VARIANT, '$1').toLowerCase();
  return { columnName: meta.colName, dataType: name, dataTypeName: name, allowDBNull: (meta.flags & 1) === 1, columnOrdinal: ordinal };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns the SQL of the named DMV query, or `undefined` when the YAML does not define it. */
async function yamlQuerySql(loadQueries: () => Promise<DmvQuery[]>, name: string): Promise<string | undefined> {
  return (await loadQueries()).find((q) => q.name === name)?.sql;
}

/** A `tedious` connection wrapped as a {@link DbSession}. */
class BuiltInSession implements DbSession {
  readonly provider = 'builtIn' as const;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failure: Error | undefined;
  private abortCurrent: ((err: Error) => void) | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly lib: typeof import('tedious'),
    readonly connectionInfo: StoredConnectionInfo,
    private readonly label: string,
    private readonly logger: Logger,
    private readonly loadQueries: () => Promise<DmvQuery[]>,
  ) {
    connection.on('error', (err: Error) => {
      this.failure = err;
      this.logger.debug(`Connection error on ${label}: ${redactSecrets(err.message)}`);
    });
    connection.on('end', () => { this.closed = true; });
  }

  executeSimpleQuery(sql: string, options?: DbQueryOptions): Promise<SimpleExecuteResult> {
    const run = () => this.run(sql, options);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private run(sql: string, options?: DbQueryOptions): Promise<SimpleExecuteResult> {
    if (this.closed) return Promise.reject(new Error(`The connection to ${this.label} is closed.`));
    if (this.failure) return Promise.reject(new Error(`The connection to ${this.label} was lost: ${this.failure.message}`));
    const timeoutMs = options?.timeoutMs ?? defaultRequestTimeoutMs();
    const timeoutMessage = options?.timeoutMessage
      ?? `Query timed out after ${timeoutMs / MS_PER_SECOND}s. Increase dataLineageViz.dmvQueryTimeout if needed.`;

    return new Promise<SimpleExecuteResult>((resolve, reject) => {
      let timedOut = false;
      let resultSets = 0;
      let columns: ColumnMetadata[] = [];
      const rows: DbCellValue[][] = [];
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.abortCurrent = undefined;
        settle();
      };
      const request = new this.lib.Request(sql, (err) => {
        if (err) finish(() => reject(timedOut ? new Error(timeoutMessage) : err));
        else finish(() => resolve({ rowCount: rows.length, columnInfo: columns.map(toColumnInfo), rows }));
      });
      request.on('columnMetadata', (meta) => {
        resultSets++;
        if (resultSets === 1) columns = Array.isArray(meta) ? meta : Object.values(meta);
      });
      request.on('row', (cells: Array<{ value: unknown }>) => {
        if (resultSets !== 1) return;
        rows.push(cells.map((cell, i) => mapCell(cell.value, columns[i])));
      });
      const timer = setTimeout(() => {
        timedOut = true;
        this.connection.cancel();
      }, timeoutMs);
      this.abortCurrent = (err) => finish(() => reject(err));
      this.connection.execSql(request);
    });
  }

  async getServerInfo(): Promise<IServerInfo> {
    const sql = await yamlQuerySql(this.loadQueries, 'platform-info');
    if (!sql) throw new Error("The DMV queries YAML defines no 'platform-info' query, so server details are unavailable.");
    const result = await this.executeSimpleQuery(sql);
    const row = result.rows[0];
    const cell = (name: string): string => {
      const at = result.columnInfo.findIndex((c) => c.columnName === name);
      return at >= 0 && row && !row[at].isNull ? row[at].displayValue : '';
    };
    const engineEditionId = Number.parseInt(cell('engine_edition'), 10) || 0;
    return {
      serverMajorVersion: Number.parseInt(cell('major_version'), 10) || 0,
      serverMinorVersion: 0,
      serverVersion: '',
      engineEditionId,
      isCloud: CLOUD_ENGINE_EDITIONS.has(engineEditionId),
      serverEdition: cell('edition'),
    };
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortCurrent?.(new Error(`The connection to ${this.label} was closed.`));
    this.connection.close();
    this.logger.debug(`Closed connection to ${this.label}`);
  }
}

function defaultRequestTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration('dataLineageViz').get<number>('dmvQueryTimeout', DEFAULT_CONFIG.dmvQueryTimeout);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CONFIG.dmvQueryTimeout) * MS_PER_SECOND;
}

/** Asks for a SQL login password once, and whether to keep it in the secret store. */
async function promptForPassword(connection: BuiltInConnection): Promise<{ password: string; save: boolean } | undefined> {
  const password = await vscode.window.showInputBox({
    title: `Password for ${connection.user} on ${connection.server}`,
    prompt: `No saved password for "${connection.name}".`,
    password: true,
    ignoreFocusOut: true,
    validateInput: passwordTooLong,
  });
  if (password === undefined) return undefined;
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Save password', description: 'Keep it in the VS Code secret store', save: true },
      { label: 'Use once', description: 'Ask again next time', save: false },
    ],
    { placeHolder: 'Save this password?', ignoreFocusOut: true },
  );
  return { password, save: choice?.save === true };
}

/** Builds the `tedious` authentication block, or `undefined` when the user cancels a prompt. */
async function resolveAuthentication(
  connection: BuiltInConnection,
  env: BuiltInEnv,
  passwordOverride: string | undefined,
  logger: Logger,
): Promise<{ type: 'default'; options: { userName: string; password: string } }
  | { type: 'azure-active-directory-access-token'; options: { token: string } } | undefined> {
  if (connection.authenticationType === 'entraId') {
    const scopes = [ENTRA_SQL_SCOPE, ...(connection.tenantId ? [`VSCODE_TENANT:${connection.tenantId}`] : [])];
    try {
      const session = await vscode.authentication.getSession('microsoft', scopes, { createIfNone: true });
      return { type: 'azure-active-directory-access-token', options: { token: session.accessToken } };
    } catch (err) {
      throw new MicrosoftSignInError(errorText(err));
    }
  }

  if (!connection.user) {
    throw new Error('The SQL login has no user name. Edit the connection to add one.');
  }
  let password = passwordOverride ?? await readSavedPassword(env.secrets, connection);
  if (password === undefined) {
    logger.debug(`No saved password for connection ${connection.id} — prompting`);
    const prompted = await promptForPassword(connection);
    if (!prompted) return undefined;
    password = prompted.password;
    if (prompted.save) await savePassword(env.secrets, connection, password);
  }
  return { type: 'default', options: { userName: connection.user, password } };
}

/**
 * Opens a built-in session for a saved connection.
 *
 * @remarks
 * SQL login reads the password from the secret store and prompts once when none is saved; Entra ID
 * requests a Microsoft account token from VS Code. Neither credential is logged or persisted in a
 * settings file. The connection declares read-only application intent (`ApplicationIntent=ReadOnly`),
 * so availability-group and read scale-out routing may serve it from a readable secondary. The server
 * may carry a `tcp:` prefix or a `host\instance` name; an explicit port takes precedence over the instance.
 *
 * @param connection - The saved connection.
 * @param env - Host services.
 * @param options - Per-open overrides.
 * @returns The open session, or `undefined` when the user cancelled a prompt or the connect.
 * @throws The driver's own error, unchanged, when login or the network fails; a
 *   `MicrosoftSignInError` when Entra sign-in does not complete.
 */
export async function openBuiltInSession(
  connection: BuiltInConnection,
  env: BuiltInEnv,
  options: BuiltInOpenOptions = {},
): Promise<DbSession | undefined> {
  const logger = Logger.create(env.outputChannel, 'DB');
  const label = describeConnection(connection);
  const database = options.database ?? connection.database;

  const authentication = await resolveAuthentication(connection, env, options.password, logger);
  if (!authentication) {
    logger.info(`Password prompt cancelled for ${label}`);
    return undefined;
  }
  if (options.token?.isCancellationRequested) return undefined;

  const lib = await import('tedious');
  const encrypt = connection.encrypt ?? true;
  const trustServerCertificate = connection.trustServerCertificate ?? false;
  const address = resolveServerAddress(connection.server);
  const raw = new lib.Connection({
    server: address.host,
    authentication,
    options: {
      ...(connection.port ? { port: connection.port } : address.instanceName ? { instanceName: address.instanceName } : {}),
      ...(database ? { database } : {}),
      encrypt,
      trustServerCertificate,
      useColumnNames: false,
      requestTimeout: 0,
      readOnlyIntent: true,
      connectionRetryInterval: CONNECT_RETRY_INTERVAL_MS,
      maxRetriesOnTransientErrors: CONNECT_MAX_RETRIES,
      connectTimeout: CONNECT_TIMEOUT_MS,
      appName: APP_NAME,
    },
  });

  const connectionInfo = StoredConnectionInfoSchema.parse({
    server: connection.server,
    database: database ?? '',
    ...(connection.authenticationType === 'sqlLogin' && connection.user ? { user: connection.user } : {}),
    authenticationType: connection.authenticationType,
    ...(connection.tenantId ? { tenantId: connection.tenantId } : {}),
    ...(connection.port ? { port: connection.port } : {}),
    encrypt,
    trustServerCertificate,
    provider: 'builtIn',
    connectionId: connection.id,
  });
  const session = new BuiltInSession(raw, lib, connectionInfo, label, logger, env.loadQueries);

  logger.info(`Connecting to ${label}${database ? ` / ${database}` : ''} (${connection.authenticationType})`);
  const started = Date.now();
  let cancelled: boolean;
  try {
    cancelled = await new Promise<boolean>((resolve, reject) => {
      const subscription = options.token?.onCancellationRequested(() => resolve(true));
      raw.connect((err?: Error) => {
        subscription?.dispose();
        if (err) reject(err);
        else resolve(false);
      });
    });
  } catch (err) {
    await session.dispose();
    throw err;
  }
  if (cancelled) {
    await session.dispose();
    logger.info(`Connect to ${label} cancelled`);
    return undefined;
  }
  logger.info(`Connected (${Date.now() - started}ms)`);
  return session;
}

/**
 * Lists the databases the connection's login can open, using the YAML `database-list` query.
 *
 * @param session - An open session, typically opened without a database.
 * @param env - Supplies the DMV queries YAML.
 * @returns The database names; empty when the YAML defines no `database-list` query.
 */
export async function listAccessibleDatabases(session: DbSession, env: Pick<BuiltInEnv, 'loadQueries'>): Promise<string[]> {
  const sql = await yamlQuerySql(env.loadQueries, 'database-list');
  if (!sql) return [];
  const result = await session.executeSimpleQuery(sql);
  return result.rows.map((row) => row[0]?.displayValue).filter((name): name is string => !!name);
}
