/**
 * Pins the built-in tedious session: cell rendering per SQL type, credential sources, unchanged
 * driver errors, timeout cancellation, request serialization, disposal, and that the mssql extension is never touched.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { rootPath } from '../../helpers/testUtils';
import type { DmvQuery } from '../../../../src/engine/connectionManager';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  connections: [] as Array<Record<string, any>>,
  connectError: undefined as Error | undefined,
  connectHangs: false,
  executed: [] as string[],
  active: 0,
  maxActive: 0,
  cancelled: 0,
  respond: undefined as undefined | ((sql: string, request: any, connection: any) => 'manual' | void),
}));

vi.mock('tedious', async () => {
  const { EventEmitter } = await import('node:events');
  class Request extends EventEmitter {
    constructor(public sql: string, public callback: (err?: Error | null, rowCount?: number) => void) { super(); }
  }
  class Connection extends EventEmitter {
    closed = false;
    pending: Request | undefined;
    constructor(public config: Record<string, any>) { super(); fake.connections.push(this); }
    connect(cb: (err?: Error) => void) { if (!fake.connectHangs) queueMicrotask(() => cb(fake.connectError)); }
    execSql(request: Request) {
      fake.executed.push(request.sql);
      fake.active++;
      fake.maxActive = Math.max(fake.maxActive, fake.active);
      this.pending = request;
      setTimeout(() => {
        const outcome = fake.respond?.(request.sql, request, this);
        if (outcome !== 'manual') { fake.active--; this.pending = undefined; }
      }, 0);
    }
    cancel() {
      fake.cancelled++;
      const request = this.pending;
      this.pending = undefined;
      fake.active--;
      request?.callback(new Error('Canceled.'));
      return true;
    }
    close() { this.closed = true; this.emit('end'); }
  }
  return { Connection, Request, default: { Connection, Request } };
});

const ui = vi.hoisted(() => ({
  getSession: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  getExtension: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    extensions: { ...actual.extensions, getExtension: (...a: unknown[]) => ui.getExtension(...a) },
    authentication: { getSession: (...a: unknown[]) => ui.getSession(...a) },
    window: { showInputBox: (...a: unknown[]) => ui.showInputBox(...a), showQuickPick: (...a: unknown[]) => ui.showQuickPick(...a) },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => ui.config[k] ?? d }) },
  };
});

const { openBuiltInSession, mapCell, listAccessibleDatabases } = await import('../../../../src/engine/db/builtInProvider');

const yamlQueries = (yaml.load(readFileSync(rootPath('assets', 'dmvQueries.yaml'), 'utf8')) as { queries: DmvQuery[] }).queries;
const yamlSql = (name: string): string => yamlQueries.find((q) => q.name === name)!.sql;
const { MicrosoftSignInError } = await import('../../../../src/engine/db/dbSession');
const { CancellationTokenSource } = await import('vscode');

const outputChannel = { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as never;

function makeEnv(stored: Record<string, string> = {}) {
  const secrets = {
    get: vi.fn(async (k: string) => stored[k]),
    store: vi.fn(async (k: string, v: string) => { stored[k] = v; }),
    delete: vi.fn(),
  };
  return { env: { secrets: secrets as never, outputChannel, loadQueries: async () => yamlQueries }, secrets };
}

const sqlLogin = {
  id: 'c1', name: 'Local', server: 'sql.example.com', port: 1444, database: 'AdventureWorks',
  authenticationType: 'sqlLogin' as const, user: 'sa',
};
const entra = {
  id: 'c2', name: 'Cloud', server: 'x.database.windows.net', database: 'db1', authenticationType: 'entraId' as const,
};

function col(colName: string, name: string, extra: Record<string, unknown> = {}) {
  return { colName, type: { name }, flags: 1, ...extra };
}

/** Scripts the next result set: metadata, then one row event per row, then request completion. */
function script(columns: ReturnType<typeof col>[], rows: unknown[][]) {
  fake.respond = (_sql, request) => {
    request.emit('columnMetadata', columns);
    for (const row of rows) request.emit('row', row.map((value, i) => ({ value, metadata: columns[i] })));
    request.callback(null, rows.length);
  };
}

beforeEach(() => {
  fake.connections.length = 0;
  fake.connectError = undefined;
  fake.connectHangs = false;
  fake.executed.length = 0;
  fake.active = 0; fake.maxActive = 0; fake.cancelled = 0;
  fake.respond = undefined;
  ui.getSession.mockReset(); ui.showInputBox.mockReset(); ui.showQuickPick.mockReset(); ui.getExtension.mockReset();
  ui.config = {};
});

describe('cell rendering', () => {
  const cases: Array<[string, unknown, Record<string, unknown>, string]> = [
    ['NVarChar', 'dbo', {}, 'dbo'],
    ['Int', 42, {}, '42'],
    ['IntN', 7, { dataLength: 4 }, '7'],
    ['BigInt', '9007199254740993', {}, '9007199254740993'],
    ['Bit', true, {}, '1'],
    ['BitN', false, {}, '0'],
    ['Float', 3.5, {}, '3.5'],
    ['Real', 3.140000104904175, {}, '3.14'],
    ['DecimalN', 12.3, { scale: 2, precision: 10 }, '12.30'],
    ['Numeric', 5, { scale: 0, precision: 9 }, '5'],
    ['Money', 1234.5, {}, '1234.5000'],
    ['UniqueIdentifier', '6F9619FF-8B86-D011-B42D-00C04FC964FF', {}, '6F9619FF-8B86-D011-B42D-00C04FC964FF'],
    ['VarBinary', Buffer.from([0xde, 0xad, 0x01]), {}, '0xDEAD01'],
    ['Date', new Date(Date.UTC(2024, 0, 5)), {}, '2024-01-05'],
    ['DateTime', new Date(Date.UTC(2024, 0, 5, 13, 4, 9, 123)), {}, '2024-01-05 13:04:09.123'],
    ['DateTimeN', new Date(Date.UTC(2024, 0, 5, 13, 4, 9, 0)), { dataLength: 4 }, '2024-01-05 13:04:09'],
    ['SmallDateTime', new Date(Date.UTC(2024, 0, 5, 13, 5, 0, 0)), {}, '2024-01-05 13:05:00'],
    ['Time', new Date(Date.UTC(1970, 0, 1, 1, 2, 3, 450)), { scale: 3 }, '01:02:03.450'],
  ];

  it.each(cases)('%s renders like the mssql extension', (typeName, value, extra, expected) => {
    expect(mapCell(value, { colName: 'c', type: { name: typeName }, ...extra } as never))
      .toEqual({ displayValue: expected, isNull: false });
  });

  it('DateTime2 keeps the sub-millisecond digits up to its scale', () => {
    const date = new Date(Date.UTC(2024, 0, 5, 13, 4, 9, 123));
    Object.defineProperty(date, 'nanosecondsDelta', { value: 0.0000456 });
    expect(mapCell(date, { colName: 'c', type: { name: 'DateTime2' }, scale: 7 } as never).displayValue)
      .toBe('2024-01-05 13:04:09.1230456');
    expect(mapCell(date, { colName: 'c', type: { name: 'DateTime2' }, scale: 3 } as never).displayValue)
      .toBe('2024-01-05 13:04:09.123');
  });

  it('DateTimeOffset renders in UTC with an explicit offset', () => {
    expect(mapCell(new Date(Date.UTC(2024, 0, 5, 13, 4, 9, 0)), { colName: 'c', type: { name: 'DateTimeOffset' }, scale: 0 } as never).displayValue)
      .toBe('2024-01-05 13:04:09 +00:00');
  });

  it('NULL renders as the mssql NULL marker', () => {
    expect(mapCell(null, col('c', 'Int') as never)).toEqual({ displayValue: 'NULL', isNull: true });
  });
});

describe('openBuiltInSession — results', () => {
  it('returns column names and display values the DMV consumers read by name', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    script([col('schema_name', 'NVarChar'), col('object_count', 'Int'), col('is_nullable', 'Bit')], [['Sales', 12, true], [null, 0, false]]);

    const result = await session.executeSimpleQuery('SELECT 1');

    expect(result.rowCount).toBe(2);
    expect(result.columnInfo.map((c) => c.columnName)).toEqual(['schema_name', 'object_count', 'is_nullable']);
    expect(result.rows[0].map((c) => c.displayValue)).toEqual(['Sales', '12', '1']);
    expect(result.rows[1][0]).toEqual({ displayValue: 'NULL', isNull: true });
    expect(session.provider).toBe('builtIn');
    expect(session.connectionInfo).toMatchObject({
      server: 'sql.example.com', database: 'AdventureWorks', provider: 'builtIn', connectionId: 'c1', authenticationType: 'sqlLogin', user: 'sa',
    });
    expect(JSON.stringify(session.connectionInfo)).not.toContain('pw');
  });

  it('keeps only the first result set of a batch', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    fake.respond = (_sql, request) => {
      const a = [col('a', 'Int')];
      request.emit('columnMetadata', a);
      request.emit('row', [{ value: 1, metadata: a[0] }]);
      const b = [col('b', 'Int')];
      request.emit('columnMetadata', b);
      request.emit('row', [{ value: 2, metadata: b[0] }]);
      request.callback(null, 2);
    };
    const result = await session.executeSimpleQuery('SELECT 1; SELECT 2');
    expect(result.columnInfo.map((c) => c.columnName)).toEqual(['a']);
    expect(result.rows).toHaveLength(1);
  });

  it('reads server info with the YAML platform-info query, sent verbatim', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    script(
      [col('engine_edition', 'Int'), col('major_version', 'Int'), col('edition', 'NVarChar')],
      [[5, 12, 'SQL Azure']],
    );
    await expect(session.getServerInfo()).resolves.toEqual({
      serverMajorVersion: 12, serverMinorVersion: 0, serverVersion: '', engineEditionId: 5, isCloud: true, serverEdition: 'SQL Azure',
    });
    expect(fake.executed.at(-1)).toBe(yamlSql('platform-info'));
  });

  it('refuses server info when the YAML has no platform-info query, sending nothing', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, { ...env, loadQueries: async () => [] }))!;
    const before = fake.executed.length;
    await expect(session.getServerInfo()).rejects.toThrow(/platform-info/);
    expect(fake.executed.length).toBe(before);
  });

  it('lists databases with the YAML database-list query, sent verbatim', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    script([col('database_name', 'NVarChar')], [['AdventureWorks2022'], ['AdventureWorksDW2022']]);
    await expect(listAccessibleDatabases(session, env)).resolves.toEqual(['AdventureWorks2022', 'AdventureWorksDW2022']);
    expect(fake.executed.at(-1)).toBe(yamlSql('database-list'));
  });

  it('returns no databases and sends nothing when the YAML has no database-list query', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    const before = fake.executed.length;
    await expect(listAccessibleDatabases(session, { loadQueries: async () => [] })).resolves.toEqual([]);
    expect(fake.executed.length).toBe(before);
  });
});

describe('openBuiltInSession — credentials', () => {
  it('SQL login reads the password from the secret store and applies connection defaults', async () => {
    const { env, secrets } = makeEnv({ 'dataLineageViz.database.password.c1': 'from-secret' });
    await openBuiltInSession(sqlLogin, env);

    expect(secrets.get).toHaveBeenCalledWith('dataLineageViz.database.password.c1');
    const config = fake.connections[0].config;
    expect(config.server).toBe('sql.example.com');
    expect(config.authentication).toEqual({ type: 'default', options: { userName: 'sa', password: 'from-secret' } });
    expect(config.options).toMatchObject({
      port: 1444, database: 'AdventureWorks', encrypt: true, trustServerCertificate: false, useColumnNames: false, requestTimeout: 0, readOnlyIntent: true, connectionRetryInterval: 5000, maxRetriesOnTransientErrors: 3, connectTimeout: 30000,
    });
    expect(ui.showInputBox).not.toHaveBeenCalled();
  });

  it('drops a tcp: prefix from the server, as SqlClient and the mssql extension accept it', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    await openBuiltInSession({ ...sqlLogin, server: 'TCP:sql.example.com' }, env);
    expect(fake.connections[0].config.server).toBe('sql.example.com');
  });

  it('splits host\\instance into server and instanceName and leaves the port to the SQL Browser lookup', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    await openBuiltInSession({ ...sqlLogin, server: 'dbhost\\SQLEXPRESS', port: undefined }, env);
    const config = fake.connections[0].config;
    expect(config.server).toBe('dbhost');
    expect(config.options.instanceName).toBe('SQLEXPRESS');
    expect(config.options.port).toBeUndefined();
  });

  it('an explicit port wins over an instance name, which the driver would otherwise refuse', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    await openBuiltInSession({ ...sqlLogin, server: 'dbhost\\SQLEXPRESS', port: 1444 }, env);
    const config = fake.connections[0].config;
    expect(config.server).toBe('dbhost');
    expect(config.options.port).toBe(1444);
    expect(config.options.instanceName).toBeUndefined();
  });

  it('honours explicit encrypt and trustServerCertificate', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    await openBuiltInSession({ ...sqlLogin, encrypt: false, trustServerCertificate: true }, env);
    expect(fake.connections[0].config.options).toMatchObject({ encrypt: false, trustServerCertificate: true });
  });

  it('Entra requests the exact scope and the tenant scope, and passes the token', async () => {
    ui.getSession.mockResolvedValue({ accessToken: 'tok-1' });
    const { env } = makeEnv();
    await openBuiltInSession({ ...entra, tenantId: 'tenant-9' }, env);

    expect(ui.getSession).toHaveBeenCalledWith(
      'microsoft',
      ['https://database.windows.net//.default', 'VSCODE_TENANT:tenant-9'],
      { createIfNone: true },
    );
    expect(fake.connections[0].config.authentication).toEqual({
      type: 'azure-active-directory-access-token', options: { token: 'tok-1' },
    });
  });

  it('Entra without a tenant requests only the database scope', async () => {
    ui.getSession.mockResolvedValue({ accessToken: 'tok-2' });
    const { env } = makeEnv();
    await openBuiltInSession(entra, env);
    expect(ui.getSession.mock.calls[0][1]).toEqual(['https://database.windows.net//.default']);
  });

  it('a missing secret prompts once and stores the password when the user chooses to save it', async () => {
    ui.showInputBox.mockResolvedValue('typed-pw');
    ui.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((i) => i.label.includes('Save password')));
    const { env, secrets } = makeEnv();

    await openBuiltInSession(sqlLogin, env);

    expect(ui.showInputBox).toHaveBeenCalledTimes(1);
    expect(ui.showInputBox.mock.calls[0][0]).toMatchObject({ password: true });
    expect(fake.connections[0].config.authentication.options.password).toBe('typed-pw');
    expect(secrets.store).toHaveBeenCalledWith('dataLineageViz.database.password.c1', 'typed-pw');
  });

  it('a prompted password is not stored when the user declines to save it', async () => {
    ui.showInputBox.mockResolvedValue('typed-pw');
    ui.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((i) => !i.label.includes('Save password')));
    const { env, secrets } = makeEnv();
    await openBuiltInSession(sqlLogin, env);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('cancelling the password prompt cancels the connection without opening a socket', async () => {
    ui.showInputBox.mockResolvedValue(undefined);
    const { env } = makeEnv();
    await expect(openBuiltInSession(sqlLogin, env)).resolves.toBeUndefined();
    expect(fake.connections).toHaveLength(0);
  });

  it('an explicit password option overrides the secret store and is never prompted for', async () => {
    const { env, secrets } = makeEnv();
    await openBuiltInSession(sqlLogin, env, { password: 'given' });
    expect(secrets.get).not.toHaveBeenCalled();
    expect(fake.connections[0].config.authentication.options.password).toBe('given');
  });

  it('a database override replaces the saved database', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = await openBuiltInSession(sqlLogin, env, { database: 'Other' });
    expect(fake.connections[0].config.options.database).toBe('Other');
    expect(session?.connectionInfo.database).toBe('Other');
  });
});

describe('openBuiltInSession — failures', () => {
  it('a login failure rethrows the driver error unchanged and closes the socket', async () => {
    fake.connectError = Object.assign(new Error("Login failed for user 'sa'."), { code: 'ELOGIN' });
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });

    await expect(openBuiltInSession(sqlLogin, env)).rejects.toBe(fake.connectError);
    expect(fake.connections[0].closed).toBe(true);
  });

  it('cancelling a connect in progress closes the socket and resolves undefined without waiting for connectTimeout', async () => {
    fake.connectHangs = true;
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const source = new CancellationTokenSource();
    const opening = openBuiltInSession(sqlLogin, env, { token: source.token });
    await vi.waitFor(() => expect(fake.connections).toHaveLength(1));
    source.cancel();

    await expect(opening).resolves.toBeUndefined();
    expect(fake.connections[0].closed).toBe(true);
  });

  it('a token cancelled before the connect opens no socket', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const source = new CancellationTokenSource();
    source.cancel();

    await expect(openBuiltInSession(sqlLogin, env, { token: source.token })).resolves.toBeUndefined();
    expect(fake.connections).toHaveLength(0);
  });

  it('a Microsoft sign-in that does not complete raises a MicrosoftSignInError carrying the reason', async () => {
    ui.getSession.mockRejectedValue(new Error('User did not consent to login.'));
    const { env } = makeEnv();
    const err = await openBuiltInSession(entra, env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicrosoftSignInError);
    expect((err as Error).message).toMatch(/Microsoft sign-in did not complete.*did not consent/i);
  });

  it('a SQL login without a user name is refused with a readable message', async () => {
    const { env } = makeEnv();
    await expect(openBuiltInSession({ ...sqlLogin, user: undefined }, env, { password: 'p' })).rejects.toThrow(/user name/i);
  });
});

describe('DbSession behaviour', () => {
  it('serializes concurrent requests on the one connection, in call order', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    script([col('n', 'Int')], [[1]]);

    await Promise.all([session.executeSimpleQuery('Q1'), session.executeSimpleQuery('Q2'), session.executeSimpleQuery('Q3')]);

    expect(fake.executed).toEqual(['Q1', 'Q2', 'Q3']);
    expect(fake.maxActive).toBe(1);
  });

  it('a request past its timeout is cancelled on the wire and rejects with the caller message', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    fake.respond = () => 'manual';

    await expect(session.executeSimpleQuery('SLOW', { timeoutMs: 20, timeoutMessage: 'slow query timed out' }))
      .rejects.toThrow('slow query timed out');
    expect(fake.cancelled).toBe(1);
  });

  it('the default request budget comes from dataLineageViz.dmvQueryTimeout', async () => {
    ui.config = { dmvQueryTimeout: 0.02 };
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    fake.respond = () => 'manual';
    await expect(session.executeSimpleQuery('SLOW')).rejects.toThrow(/timed out/i);
    expect(fake.cancelled).toBe(1);
  });

  it('dispose closes the connection, is idempotent, and later requests are refused', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;

    await session.dispose();
    await session.dispose();

    expect(fake.connections[0].closed).toBe(true);
    await expect(session.executeSimpleQuery('SELECT 1')).rejects.toThrow(/closed/i);
  });

  it('a connection error after login fails later requests with a readable message', async () => {
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const session = (await openBuiltInSession(sqlLogin, env))!;
    fake.connections[0].emit('error', new Error('read ECONNRESET'));
    await expect(session.executeSimpleQuery('SELECT 1')).rejects.toThrow(/sql\.example\.com.*ECONNRESET/);
  });

  it('never touches the mssql extension', async () => {
    ui.getSession.mockResolvedValue({ accessToken: 't' });
    const { env } = makeEnv({ 'dataLineageViz.database.password.c1': 'pw' });
    const a = await openBuiltInSession(sqlLogin, env);
    const b = await openBuiltInSession(entra, env);
    script([col('n', 'Int')], [[1]]);
    await a!.executeSimpleQuery('SELECT 1');
    await b!.dispose();
    expect(ui.getExtension).not.toHaveBeenCalled();
  });
});

describe('SQL comes only from the DMV queries YAML', () => {
  it('no source file of the connection layer carries a SQL statement', () => {
    const dir = rootPath('src', 'engine', 'db');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(dir, file), 'utf8');
      expect(code, `${file} must read SQL from dmvQueries.yaml`).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|MERGE)\b|SERVERPROPERTY|sys\.\w+/);
    }
  });
});
