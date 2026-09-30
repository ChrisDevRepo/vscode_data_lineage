/**
 * Pins connection error presentation: the original driver text behind the connection name, the
 * actions chosen per error class for each provider, what each action calls, and secret redaction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updates: [] as Array<{ key: string; value: unknown }>,
  executeCommand: vi.fn(),
  getSession: vi.fn(),
  writeText: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ConfigurationTarget: { Global: 1 },
    commands: { executeCommand: (...a: unknown[]) => host.executeCommand(...a) },
    authentication: { getSession: (...a: unknown[]) => host.getSession(...a) },
    env: { clipboard: { writeText: (...a: unknown[]) => host.writeText(...a) } },
    window: {
      showWarningMessage: (...a: unknown[]) => host.showWarningMessage(...a),
      showInformationMessage: (...a: unknown[]) => host.showInformationMessage(...a),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, d: unknown) => host.settings[key] ?? d,
        update: async (key: string, value: unknown) => { host.updates.push({ key, value }); host.settings[key] = value; },
      }),
    },
  };
});

const {
  describeConnectionError, reportConnectionError, redactSecrets, isDriverError, targetFromStored, CONNECTION_ERROR_LABELS,
} = await import('../../../../src/engine/db/connectionErrors');
const { MicrosoftSignInError } = await import('../../../../src/engine/db/dbSession');

const NAME = 'Local Docker AW';
const builtIn = {
  provider: 'builtIn' as const, name: NAME, server: 'localhost', port: 1433, database: 'Sales', user: 'dlv_reader',
  authenticationType: 'sqlLogin', connectionId: 'c1', tenantId: 'tenant-1',
};
const entra = { ...builtIn, authenticationType: 'entraId', user: undefined };
const viaMssql = { provider: 'mssqlExtension' as const, name: NAME, server: 'localhost', database: 'Sales', user: 'dlv_reader' };

const driver = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

const retry = vi.fn();
const showLog = vi.fn();
const chooseDatabase = vi.fn();
const hooks = { retry, showLog, chooseDatabase };

const ids = (err: unknown, target: Parameters<typeof describeConnectionError>[1], h: Parameters<typeof describeConnectionError>[2] = hooks) =>
  describeConnectionError(err, target, h).actions.map((a) => a.id);

const savedConnection = { id: 'c1', name: NAME, server: 'localhost', database: 'Sales', authenticationType: 'sqlLogin', user: 'dlv_reader' };

beforeEach(() => {
  host.settings = { connections: [savedConnection] };
  host.updates.length = 0;
  for (const fn of [host.executeCommand, host.getSession, host.writeText, host.showWarningMessage, host.showInformationMessage, retry, showLog, chooseDatabase]) fn.mockReset();
});

const cases: Array<{ row: string; err: Error; target?: typeof builtIn; expected: string[] }> = [
  {
    row: '40615 firewall falls into the generic row',
    err: driver("Cannot open server 'aw-srv' requested by the login. Client with IP address '203.0.113.7' is not allowed to access the server.  To enable access, use the Azure Management Portal or run sp_set_firewall_rule on the master database to create a firewall rule for this IP address or address range.", { code: 'ELOGIN', number: 40615 }),
    expected: ['showLog', 'editConnection'],
  },
  { row: '18456 SQL login (a wrong password or a database the login cannot open)', err: driver("Login failed for user 'dlv_reader'.", { code: 'ELOGIN', number: 18456 }), expected: ['updatePassword', 'chooseDatabase', 'editConnection'] },
  { row: '18456 Entra principal', err: driver("Login failed for user '<token-identified principal>'.", { code: 'ELOGIN' }), target: entra as never, expected: ['signInAnotherAccount', 'editConnection'] },
  { row: '4060 cannot open database', err: driver('Cannot open database "Sales" requested by the login. The login failed.', { code: 'ELOGIN', number: 4060 }), expected: ['chooseDatabase', 'editConnection'] },
  { row: '916 database access', err: driver('The server principal "dlv_reader" is not able to access the database "Sales" under the current security context.', { code: 'EREQUEST', number: 916 }), expected: ['chooseDatabase', 'editConnection'] },
  { row: '40613 unavailable', err: driver("Database 'Sales' on server 'aw-srv' is not currently available. Please retry the connection later.", { code: 'ELOGIN', number: 40613 }), expected: ['retry'] },
  { row: '40197 service error', err: driver('The service has encountered an error processing your request. Please try again. Error code 40613.', { number: 40197 }), expected: ['retry'] },
  { row: '40501 throttled', err: driver('The service is currently busy. Retry the request after 10 seconds. Incident ID: 1A2B. Code: 40501.', { number: 40501 }), expected: ['retry'] },
  { row: '40532 login failed for server', err: driver('Cannot open server "aw-srv" requested by the login. The login failed.', { number: 40532 }), expected: ['retry'] },
  { row: 'ETIMEOUT', err: driver('Failed to connect to localhost:1433 in 15000ms', { code: 'ETIMEOUT' }), expected: ['editConnection', 'retry'] },
  { row: 'ESOCKET', err: driver('Failed to connect to localhost:1433 - Could not connect (sequence)', { code: 'ESOCKET' }), expected: ['editConnection', 'retry'] },
  { row: 'ENOTFOUND', err: driver('Failed to connect to nosuchhost:1433 - getaddrinfo ENOTFOUND nosuchhost', { code: 'ESOCKET' }), expected: ['editConnection', 'retry'] },
  { row: 'ECONNREFUSED', err: driver('Failed to connect to localhost:1433 - connect ECONNREFUSED 127.0.0.1:1433', { code: 'ESOCKET' }), expected: ['editConnection', 'retry'] },
  { row: 'certificate not trusted', err: driver('Failed to connect to localhost:1433 - self-signed certificate', { code: 'ESOCKET' }), expected: ['trustServerCertificate', 'editConnection'] },
  { row: 'certificate chain', err: driver('unable to verify the first certificate', { code: 'ESOCKET' }), expected: ['trustServerCertificate', 'editConnection'] },
  { row: 'Entra sign-in cancelled', err: new MicrosoftSignInError('User did not consent to login.'), target: entra as never, expected: ['signIn'] },
  { row: '229 permission', err: driver("The SELECT permission was denied on the object 'sql_modules', database 'mssqlsystemresource', schema 'sys'.", { code: 'EREQUEST', number: 229 }), expected: ['copyGrantStatement'] },
  { row: '297 permission', err: driver('The user does not have permission to perform this action.', { code: 'EREQUEST', number: 297 }), expected: ['copyGrantStatement'] },
  { row: '300 permission', err: driver("VIEW SERVER STATE permission was denied on object 'server', database 'master'.", { code: 'EREQUEST', number: 300 }), expected: ['copyGrantStatement'] },
  { row: 'anything else', err: driver('Incorrect syntax near the keyword \'FROM\'.', { code: 'EREQUEST', number: 156 }), expected: ['showLog', 'editConnection'] },
];

describe('describeConnectionError — text', () => {
  it.each(cases)('$row: message is the connection name and the original text', ({ err, target }) => {
    expect(describeConnectionError(err, target ?? builtIn, hooks).message).toBe(`${NAME}: ${err.message}`);
  });

  it('never shows a driver error as a bare message without the connection name', () => {
    const { message } = describeConnectionError(driver("Login failed for user 'dlv_reader'."), builtIn, hooks);
    expect(message.startsWith(`${NAME}: `)).toBe(true);
  });

  it('removes password, connection-string and token text', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJodHRwczovL2RhdGFiYXNl.c2lnbmF0dXJlMTIzNDU2';
    const err = driver(`Login failed. Server=x;User Id=u;Password=hunter2;pwd=abc123 token ${jwt} Authorization: Bearer abcdefghijkl0123`);
    const { message } = describeConnectionError(err, builtIn, hooks);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('abc123');
    expect(message).not.toContain(jwt);
    expect(message).not.toContain('abcdefghijkl0123');
    expect(message.startsWith(`${NAME}: Login failed.`)).toBe(true);
  });

  it('redactSecrets removes JSON credential fields and "Password: value" text', () => {
    const text = redactSecrets('Config {"server":"x","password":"hun\\"ter2","accessToken":"tok-9876"} Password: s3cr3t, token: abcd');
    for (const secret of ['hun', 'ter2', 'tok-9876', 's3cr3t', 'abcd']) expect(text).not.toContain(secret);
    expect(text).toContain('"server":"x"');
  });

  it('redactSecrets leaves ordinary text alone', () => {
    expect(redactSecrets("Cannot open database \"Sales\" requested by the login.")).toBe("Cannot open database \"Sales\" requested by the login.");
  });
});

describe('describeConnectionError — actions', () => {
  it.each(cases)('$row → $expected', ({ err, target, expected }) => {
    expect(ids(err, target ?? builtIn)).toEqual(expected);
  });

  it('labels are the fixed button texts', () => {
    const labels = describeConnectionError(driver("Login failed for user 'x'.", { number: 18456 }), builtIn, hooks).actions.map((a) => a.label);
    expect(labels).toEqual([CONNECTION_ERROR_LABELS.updatePassword, CONNECTION_ERROR_LABELS.chooseDatabase, CONNECTION_ERROR_LABELS.editConnection]);
    expect(CONNECTION_ERROR_LABELS.copyGrantStatement).toBe('Copy GRANT Statement');
  });

  it('a SQL login failure without a database offers no Choose Database', () => {
    expect(ids(driver("Login failed for user 'x'.", { number: 18456 }), { ...builtIn, database: undefined })).toEqual(['updatePassword', 'editConnection']);
  });

  it('offers Retry only when the caller can retry, and Choose Database only when it can ask', () => {
    expect(ids(driver('x', { code: 'ETIMEOUT' }), builtIn, {})).toEqual(['editConnection']);
    expect(ids(driver('x', { number: 4060 }), builtIn, { retry })).toEqual(['editConnection']);
  });

  it('the mssql provider gets no built-in connection management actions', () => {
    expect(ids(driver("Login failed for user 'dlv_reader'."), viaMssql)).toEqual([]);
    expect(ids(driver('Database is not currently available.'), viaMssql)).toEqual(['retry']);
    expect(ids(driver('The SELECT permission was denied on the object x.'), viaMssql)).toEqual(['copyGrantStatement']);
    expect(ids(driver('boom'), viaMssql)).toEqual(['showLog']);
  });

  it('classifies mssql-extension errors by message text alone', () => {
    expect(ids(driver("Cannot open database \"Sales\" requested by the login. The login failed."), viaMssql, {})).toEqual([]);
    expect(ids(driver('Failed to connect to localhost:1433 in 15000ms'), viaMssql)).toEqual(['retry']);
  });
});

async function run(err: Error, target: typeof builtIn, id: string, h = hooks) {
  const action = describeConnectionError(err, target, h).actions.find((a) => a.id === id)!;
  await action.run();
}

describe('action handlers', () => {
  it('Update Password runs the command for the connection and retries once when a password was stored', async () => {
    host.executeCommand.mockResolvedValue(true);
    await run(driver("Login failed for user 'u'.", { number: 18456 }), builtIn, 'updatePassword');
    expect(host.executeCommand).toHaveBeenCalledWith('dataLineageViz.updateDatabasePassword', 'c1');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Update Password does not retry when the user cancelled', async () => {
    host.executeCommand.mockResolvedValue(false);
    await run(driver("Login failed for user 'u'.", { number: 18456 }), builtIn, 'updatePassword');
    expect(retry).not.toHaveBeenCalled();
  });

  it('Edit Connection runs the edit command for the connection id', async () => {
    host.executeCommand.mockResolvedValue('c1');
    await run(driver('x', { number: 156 }), builtIn, 'editConnection');
    expect(host.executeCommand).toHaveBeenCalledWith('dataLineageViz.editDatabaseConnection', 'c1');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Sign in with another account forces a new Microsoft session with the tenant scope, then retries', async () => {
    await run(driver("Login failed for user '<token-identified principal>'."), entra as never, 'signInAnotherAccount');
    expect(host.getSession).toHaveBeenCalledWith(
      'microsoft', ['https://database.windows.net//.default', 'VSCODE_TENANT:tenant-1'], { forceNewSession: true },
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Sign In creates a Microsoft session, then retries', async () => {
    await run(new MicrosoftSignInError('cancelled'), entra as never, 'signIn');
    expect(host.getSession.mock.calls[0][2]).toEqual({ createIfNone: true });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Choose Database saves the chosen database on the connection and retries with it', async () => {
    chooseDatabase.mockResolvedValue('Other');
    await run(driver('x', { number: 4060 }), builtIn, 'chooseDatabase');
    expect(host.updates).toHaveLength(1);
    expect((host.updates[0].value as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'c1', database: 'Other' });
    expect(retry).toHaveBeenCalledWith({ database: 'Other' });
  });

  it('Choose Database does nothing when the picker is dismissed', async () => {
    chooseDatabase.mockResolvedValue(undefined);
    await run(driver('x', { number: 4060 }), builtIn, 'chooseDatabase');
    expect(host.updates).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it('Trust Server Certificate asks a modal confirmation before it changes the connection', async () => {
    host.showWarningMessage.mockResolvedValue('Trust Certificate');
    await run(driver('self-signed certificate', { code: 'ESOCKET' }), builtIn, 'trustServerCertificate');
    expect(host.showWarningMessage.mock.calls[0][1]).toEqual({ modal: true });
    expect((host.updates[0].value as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'c1', trustServerCertificate: true });
    expect(retry).toHaveBeenCalledWith({ trustServerCertificate: true });
  });

  it('Trust Server Certificate changes nothing when the confirmation is declined', async () => {
    host.showWarningMessage.mockResolvedValue(undefined);
    await run(driver('self-signed certificate', { code: 'ESOCKET' }), builtIn, 'trustServerCertificate');
    expect(host.updates).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it('Copy GRANT Statement copies only VIEW DEFINITION for the login, bracket-quoted', async () => {
    await run(driver('x', { number: 229 }), { ...builtIn, user: 'we]ird' }, 'copyGrantStatement');
    expect(host.writeText).toHaveBeenCalledWith('GRANT VIEW DEFINITION TO [we]]ird];');
  });

  it('Copy GRANT Statement uses a placeholder principal for an Entra connection', async () => {
    await run(driver('x', { number: 229 }), entra as never, 'copyGrantStatement');
    expect(String(host.writeText.mock.calls[0][0])).toContain('[user_or_group]');
  });

  it('Retry calls the hook once with no patch; Show Log calls the hook', async () => {
    await run(driver('x', { code: 'ETIMEOUT' }), builtIn, 'retry');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]).toEqual([undefined]);
    await run(driver('boom'), builtIn, 'showLog');
    expect(showLog).toHaveBeenCalledTimes(1);
  });
});

describe('reportConnectionError', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('logs the raw error once at info level and shows the described message with the action labels', async () => {
    const log = logger();
    const present = vi.fn(async () => undefined);
    const err = driver("Login failed for user 'dlv_reader'.", { code: 'ELOGIN', number: 18456 });

    const { message, answered } = reportConnectionError(err, builtIn, log as never, hooks, present);
    await answered;

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(String(log.info.mock.calls[0][0])).toContain("Login failed for user 'dlv_reader'.");
    expect(String(log.info.mock.calls[0][0])).toContain('number=18456');
    expect(present).toHaveBeenCalledWith(message, 'Update Password', 'Choose Database', 'Edit Connection');
    expect(message).toBe(`${NAME}: Login failed for user 'dlv_reader'.`);
  });

  it('runs the action the user clicks and nothing when the toast is dismissed', async () => {
    const err = driver('Failed to connect to localhost:1433 in 15000ms', { code: 'ETIMEOUT' });
    await reportConnectionError(err, builtIn, logger() as never, hooks, async () => 'Retry').answered;
    expect(retry).toHaveBeenCalledTimes(1);

    retry.mockReset();
    await reportConnectionError(err, builtIn, logger() as never, hooks, async () => undefined).answered;
    expect(retry).not.toHaveBeenCalled();
  });

  it('logs a failing action instead of throwing', async () => {
    const log = logger();
    retry.mockRejectedValue(new Error('retry blew up'));
    const err = driver('x', { code: 'ETIMEOUT' });
    await reportConnectionError(err, builtIn, log as never, hooks, async () => 'Retry').answered;
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('retry blew up'));
  });

  it('never logs a secret from the raw error', () => {
    const log = logger();
    reportConnectionError(driver('bad Password=hunter2;'), builtIn, log as never, hooks, async () => undefined);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('hunter2');
  });
});

describe('helpers', () => {
  it('isDriverError recognises driver numbers and E-codes but not plain errors', () => {
    expect(isDriverError(driver('x', { number: 18456 }))).toBe(true);
    expect(isDriverError(driver('x', { code: 'ESOCKET' }))).toBe(true);
    expect(isDriverError(new Error('Missing schema-preview query'))).toBe(false);
  });

  it('targetFromStored names a built-in project connection by its saved name', () => {
    const target = targetFromStored({ server: 'localhost', database: 'Sales', provider: 'builtIn', connectionId: 'c1', user: 'dlv_reader' }, 'builtIn');
    expect(target).toMatchObject({ name: NAME, connectionId: 'c1', provider: 'builtIn' });
  });

  it('targetFromStored falls back to server / database when the saved connection is gone', () => {
    const target = targetFromStored({ server: 'srv', database: 'db', provider: 'builtIn', connectionId: 'gone' }, 'builtIn');
    expect(target.name).toBe('srv / db');
  });
});
