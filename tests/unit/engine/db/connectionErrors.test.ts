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
  describeConnectionError, reportConnectionError, isDriverError, targetFromStored,
} = await import('../../../../src/engine/db/connectionErrors');
const { redactSecrets } = await import('../../../../src/utils/redact');
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
  { row: 'Entra sign-in cancelled', err: new MicrosoftSignInError('User did not consent to login.'), target: entra as never, expected: ['signIn', 'signInAnotherAccount'] },
  { row: '229 permission', err: driver("The SELECT permission was denied on the object 'sql_modules', database 'mssqlsystemresource', schema 'sys'.", { code: 'EREQUEST', number: 229 }), expected: ['copyGrantStatement'] },
  { row: '297 permission', err: driver('The user does not have permission to perform this action.', { code: 'EREQUEST', number: 297 }), expected: ['copyGrantStatement'] },
  { row: '300 permission', err: driver("VIEW SERVER STATE permission was denied on object 'server', database 'master'.", { code: 'EREQUEST', number: 300 }), expected: ['copyGrantStatement'] },
  { row: 'anything else', err: driver('Incorrect syntax near the keyword \'FROM\'.', { code: 'EREQUEST', number: 156 }), expected: ['showLog', 'editConnection'] },
];

describe('describeConnectionError — text', () => {
  it.each(cases)('$row: message is the connection name and the original text', ({ err, target }) => {
    expect(describeConnectionError(err, target ?? builtIn, hooks).message).toBe(`${NAME}: ${err.message}`);
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

  it.each([
    ['client_secret pair', 'Request failed client_secret=Zq8~abcDEF123 grant=x', ['Zq8~abcDEF123']],
    ['access_token pair', 'Refused access_token=abc.def-123_xyz tail', ['abc.def-123_xyz']],
    ['AccountKey pair', 'DefaultEndpointsProtocol=https;AccountKey=a1B2c3+/d4E5==;EndpointSuffix=core', ['a1B2c3']],
    ['URL userinfo', 'Cannot reach https://svc_user:p4ss%21word@host.example.net:1433/db now', ['svc_user', 'p4ss%21word']],
    ['Authorization Basic', 'Header Authorization: Basic dXNlcjpwYXNzd29yZA== rejected', ['dXNlcjpwYXNzd29yZA']],
    ['quoted value with space and semicolon', 'Server=x;Password="a b;c d";Database=y', ['a b', 'c d', '"a']],
    ['single-quoted value with semicolon', "Server=x;Password='a b;c d';Database=y", ['a b', 'c d']],
    ['braced value with semicolon', 'Server=x;Password={a;b c};Database=y', ['a;b', 'b c']],
  ])('redactSecrets removes %s', (_name, input, secrets) => {
    const out = redactSecrets(input);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });

  it.each([
    ['api_key pair', 'Request rejected api_key=Zk93mQpL71xv tail', ['Zk93mQpL71xv']],
    ['apikey colon', 'Header apikey: Zk93mQpL71xv rejected', ['Zk93mQpL71xv']],
    ['x-api-key header', 'Sent x-api-key: Zk93mQpL71xv to host', ['Zk93mQpL71xv']],
    ['SharedAccessKey pair', 'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=Zk93mQpL71xv+/=;EntityPath=q', ['Zk93mQpL71xv']],
    ['access_key pair', 'Refused access_key=Zk93mQpL71xv tail', ['Zk93mQpL71xv']],
    ['SAS signature in URL query', 'GET https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=Zk93mQpL71xv%2Bq%3D&se=2030-01-01 failed', ['Zk93mQpL71xv']],
    ['single-quoted JSON-like field', "Config {'server': 'x', 'password': 'hun\\'ter2', 'accessToken': 'tok-9876'}", ['hun', 'ter2', 'tok-9876']],
    ['unterminated double-quoted tail', 'Server=x;Password="abc def ghi', ['abc', 'def', 'ghi']],
    ['unterminated single-quoted tail', "Server=x;Password='abc def ghi", ['abc', 'def', 'ghi']],
    ['unterminated braced tail', 'Server=x;Password={abc def ghi', ['abc', 'def', 'ghi']],
    ['quoted value after a colon', 'Sent x-api-key: "Zk93 mQpL71xv" and client_secret: \'Zk93 mQpL71xv\' to host', ['Zk93', 'mQpL71xv']],
    ['SAS signature leading a connection-string value', 'BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=sig=Zk93mQpL71xv&sv=2022-11-02', ['Zk93mQpL71xv']],
    ['account_key pair', 'Refused account_key=Zk93mQpL71xv tail', ['Zk93mQpL71xv']],
    ['JWT glued to a preceding word', 'Rejected id-eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJkYXRhYmFzZSJ9.c2lnbmF0dXJlMTIz tail', ['eyJhbGciOiJSUzI1NiJ9', 'eyJhdWQiOiJkYXRhYmFzZSJ9', 'c2lnbmF0dXJlMTIz']],
  ])('redactSecrets removes %s', (_name, input, secrets) => {
    const out = redactSecrets(input);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });

  it.each([
    ['private_key pair', 'Refused private_key=Zk93mQpL71xv tail', ['Zk93mQpL71xv']],
    ['private-key colon', 'Sent private-key: Zk93mQpL71xv to host', ['Zk93mQpL71xv']],
    ['JSON private_key with a PEM body and \\n escapes', 'Config {"type":"service_account","private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nKcwggSjAgEAAoIBAQC7\\n-----END PRIVATE KEY-----\\n","client_email":"a@b.c"}', ['MIIEvQIBADANBgkq', 'KcwggSjAgEAAoIBAQC7']],
    ['passphrase pair', 'Cannot load key passphrase=Zk93mQpL71xv now', ['Zk93mQpL71xv']],
    ['quoted passphrase colon', 'Config {"passphrase": "Zk93 mQpL71xv"}', ['Zk93', 'mQpL71xv']],
    ['subscription-key colon', 'Sent subscription-key: Zk93mQpL71xv to host', ['Zk93mQpL71xv']],
    ['Ocp-Apim-Subscription-Key header', 'Header Ocp-Apim-Subscription-Key: Zk93mQpL71xv rejected', ['Zk93mQpL71xv']],
    ['subscription_key pair', 'Refused subscription_key=Zk93mQpL71xv tail', ['Zk93mQpL71xv']],
  ])('redactSecrets removes %s', (_name, input, secrets) => {
    const out = redactSecrets(input);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });

  it('redactSecrets keeps a prose colon value that is only closing punctuation, and never doubles a marker', () => {
    expect(redactSecrets('Unexpected token: } in JSON')).toBe('Unexpected token: } in JSON');
    expect(redactSecrets('Unexpected token: ) at 4')).toBe('Unexpected token: ) at 4');
    expect(redactSecrets('Invalid token=eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJkYXRhYmFzZSJ9.c2lnbmF0dXJlMTIz tail')).toBe('Invalid token=[token removed] tail');
    expect(redactSecrets('Invalid access_token: eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJkYXRhYmFzZSJ9.c2lnbmF0dXJlMTIz tail')).toBe('Invalid access_token: [token removed] tail');
    expect(redactSecrets('token: abc')).toBe('token: [removed]');
  });

  it('redactSecrets keeps the text before and after a terminated or unterminated tail readable', () => {
    expect(redactSecrets('Server=x;Password="abc def\nnext line')).toContain('Server=x');
    expect(redactSecrets('Server=x;Password="abc def\nnext line')).toContain('next line');
    expect(redactSecrets('Password="abc def;Database=y')).toContain('Database=y');
    expect(redactSecrets('GET /b?sv=1&sig=abc123&se=2030')).toContain('se=2030');
    expect(redactSecrets('Endpoint=sb://ns/;SharedAccessKey=abc;EntityPath=q')).toContain('EntityPath=q');
    expect(redactSecrets('Sent x-api-key: "ab cd" to host')).toBe('Sent x-api-key: [removed] to host');
    expect(redactSecrets(`Password={${'a'.repeat(2000)};Database=y`)).toBe('Password=[removed];Database=y');
  });

  it('redactSecrets keeps the surrounding connection-string keys readable after a quoted value', () => {
    const out = redactSecrets('Server=x;Password="a b;c";Database=y');
    expect(out).toContain('Server=x');
    expect(out).toContain('Database=y');
  });

  it.each([
    'The server name is sql-prod-01.contoso.database.windows.net and the port is 1433.',
    'Cannot reach https://host.example.net:1433/path?db=Sales&mode=read (timeout).',
    'Login failed for user dlv_reader at 10:42; retry later, see https://learn.microsoft.com/sql/errors/18456.',
    'The token endpoint returned 400; the secret store was unavailable; password policy requires 12 characters.',
    'Contact admin@contoso.com about Basic authentication being disabled.',
    'Cannot reach https://host.example.net?notify=admin@contoso.com (timeout).',
    'Cannot reach https://host.example.net#admin@contoso.com (timeout).',
    'The signature of the function does not match the call.',
    'Contact the sig team; sig and design review follow.',
    'Cannot apply design=modern to the layout.',
    'Cannot reach https://host.example.net/items?id=5&page=2 (timeout).',
    'The keyboard shortcut was ignored.',
    'Cannot set monkey=1 for this session.',
    'Cannot read key=1 or keys=2 or primary_key=3 from the table.',
    'Violation of foreign key: x on table Orders; partition_key=4 and api_key_id=5 were kept.',
    'Cannot open database "Sales" requested by the login.',
    'Invalid object name [dbo].[ApiKeys] in SELECT * FROM [dbo].[ApiKeys] WHERE [Key] = \'x\'.',
  ])('redactSecrets leaves ordinary text unchanged: %s', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    ['dotted identifier run', 'ab.'.repeat(70_000)],
    ['scheme-shaped run', `a${'+.-x'.repeat(50_000)}://`],
    ['unterminated quoted value', `Password="${'a""'.repeat(70_000)}`],
    ['unterminated braced value', `Password={${'}}'.repeat(100_000)}`],
    ['key followed by whitespace', `token${' '.repeat(200_000)}`],
    ['hyphenated key run', 'x-api-'.repeat(35_000)],
    ['api key run without value', 'api_key '.repeat(25_000)],
    ['equals-heavy key run', 'api_key='.repeat(25_000)],
    ['equals-heavy sig run', '&sig='.repeat(40_000)],
    ['quote-heavy single-quoted JSON-like run', `'password': '${"a''".repeat(70_000)}`],
    ['repeated unterminated braced values', 'Password={ '.repeat(20_000)],
    ['repeated unterminated quoted tails', `${'SharedAccessKey=" '.repeat(1)}${'password=\' '.repeat(18_000)}`],
    ['quote-heavy key run', `${'apikey:"'.repeat(25_000)}`],
    ['JWT prefix run', 'eyJ'.repeat(67_000)],
    ['hyphenated JWT prefix run', 'eyJ-'.repeat(50_000)],
    ['unterminated braced values each ended by a semicolon', 'Password={;'.repeat(18_000)],
    ['unterminated braced values each ended by a newline', 'Password={\n'.repeat(18_000)],
    ['unterminated quoted values after a colon', 'token:"\n'.repeat(25_000)],
    ['private key run without value', 'private_key '.repeat(17_000)],
    ['equals-heavy private key run', 'private-key='.repeat(17_000)],
    ['passphrase colon run', 'passphrase:'.repeat(18_000)],
    ['subscription key hyphen run', 'subscription-'.repeat(15_000)],
    ['punctuation-only colon values', 'token: }'.repeat(25_000)],
    ['colon values followed by a long closing run', `token: ${'}'.repeat(200_000)}`],
    ['JWT behind a key', 'token=eyJabcdefgh.abcdefgh.'.repeat(7_500)],
  ])('redactSecrets stays linear on a 200 kB %s', (_name, input) => {
    const started = performance.now();
    redactSecrets(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('describeConnectionError — rejected Microsoft token', () => {
  const rejected = driver("Login failed for user '<token-identified principal>'. The server is not currently configured to accept this token.", { code: 'ELOGIN', number: 18456 });

  it('keeps the original text and adds one hint on what to check', () => {
    const { message } = describeConnectionError(rejected, entra as never, hooks);
    expect(message.startsWith(`${NAME}: ${rejected.message} `)).toBe(true);
    expect(message).toMatch(/Microsoft Entra admin/);
  });

  it('offers another account and editing for a built-in connection, nothing for the mssql extension', () => {
    expect(ids(rejected, entra as never)).toEqual(['signInAnotherAccount', 'editConnection']);
    expect(ids(rejected, viaMssql)).toEqual([]);
  });
});

describe('describeConnectionError — actions', () => {
  it.each(cases)('$row → $expected', ({ err, target, expected }) => {
    expect(ids(err, target ?? builtIn)).toEqual(expected);
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

  it("Sign in with another account opens VS Code's account picker, saves the account without a directory, then retries", async () => {
    host.settings = { connections: [{ id: 'c1', name: NAME, server: 'localhost', authenticationType: 'entraId', accountId: 'old.h', tenantId: 'tenant-1' }] };
    host.getSession.mockResolvedValue({ accessToken: 't', account: { id: 'o.h', label: 'a@x' } });
    await run(driver("Login failed for user '<token-identified principal>'."), entra as never, 'signInAnotherAccount');
    expect(host.getSession).toHaveBeenCalledWith(
      'microsoft', ['https://database.windows.net/.default'], { createIfNone: true, clearSessionPreference: true },
    );
    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved.accountId).toBe('o.h');
    expect(saved.tenantId).toBeUndefined();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Sign In creates a Microsoft session, then retries', async () => {
    host.getSession.mockResolvedValue({ accessToken: 't', account: { id: 'o.h', label: 'a@x' } });
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
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

  it('keeps identifying driver detail at debug level and preserves the actionable dialog', async () => {
    const log = logger();
    const present = vi.fn(async () => undefined);
    const err = driver("Login failed for user 'dlv_reader'.", { code: 'ELOGIN', number: 18456 });

    const { message, answered } = reportConnectionError(err, builtIn, log as never, hooks, present);
    await answered;

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('Database connection failed');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(NAME);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('dlv_reader');
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(String(log.debug.mock.calls[0][0])).toContain("Login failed for user 'dlv_reader'.");
    expect(String(log.debug.mock.calls[0][0])).toContain('number=18456');
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
    expect(log.warn).toHaveBeenCalledWith('Action "Retry" failed');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('retry blew up');
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('retry blew up'));
  });

  it('never logs a secret from the raw error', () => {
    const log = logger();
    reportConnectionError(driver('bad Password=hunter2;'), builtIn, log as never, hooks, async () => undefined);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('hunter2');
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
