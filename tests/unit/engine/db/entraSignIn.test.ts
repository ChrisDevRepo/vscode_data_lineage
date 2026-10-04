/**
 * Pins the Entra directory choice: a saved directory is used as is; otherwise the account's home
 * directory when listed, else the first listed one, as the mssql extension preselects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  getSession: vi.fn(),
  accounts: [] as Array<{ id: string; label: string }>,
  tenants: [] as Array<{ tenantId?: string; displayName?: string; defaultDomain?: string }>,
  azureEnv: (): { sqlServerHostnameSuffix?: string } => ({ sqlServerHostnameSuffix: '.database.windows.net' }),
}));

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authentication: { getSession: (...a: unknown[]) => host.getSession(...a), getAccounts: async () => host.accounts },
}));

vi.mock('@microsoft/vscode-azext-azureauth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  VSCodeAzureSubscriptionProvider: class { async getTenants() { return host.tenants; } },
  getConfiguredAzureEnv: () => host.azureEnv(),
}));

const { acquireSqlToken, defaultTenantId, listTenants, pickAccount, signInForSql, sqlResource } = await import('../../../../src/engine/db/entraSignIn');
const { MicrosoftSignInError } = await import('../../../../src/engine/db/dbSession');

const account = { id: 'object-1.home-tenant', label: 'user@example.com' };
const logger = { info: vi.fn(), debug: vi.fn() };
const publicCloud = () => ({ sqlServerHostnameSuffix: '.database.windows.net' });

beforeEach(() => {
  host.getSession.mockReset();
  host.getSession.mockImplementation(async (_p: string, scopes: string[]) => ({ accessToken: `token for ${scopes.join(' ')}`, account }));
  host.tenants = [];
  host.accounts = [];
  host.azureEnv = publicCloud;
  logger.info.mockReset();
  logger.debug.mockReset();
});

describe('sqlResource', () => {
  it.each([
    ['public cloud', '.database.windows.net', 'https://database.windows.net/'],
    ['US Government', '.database.usgovcloudapi.net', 'https://database.usgovcloudapi.net/'],
    ['China', '.database.chinacloudapi.cn', 'https://database.chinacloudapi.cn/'],
    ['a custom cloud without a SQL suffix', undefined, 'https://database.windows.net/'],
  ])('%s', (_cloud, sqlServerHostnameSuffix, expected) => {
    host.azureEnv = () => ({ sqlServerHostnameSuffix });
    expect(sqlResource()).toBe(expected);
  });

  it('sign-in requests the scope of the configured cloud', async () => {
    host.azureEnv = () => ({ sqlServerHostnameSuffix: '.database.usgovcloudapi.net' });
    await signInForSql('dir', { createIfNone: true });
    expect(host.getSession.mock.calls[0][1]).toEqual(['https://database.usgovcloudapi.net/.default', 'VSCODE_TENANT:dir']);
  });

  it('an unconfigured custom cloud raises MicrosoftSignInError without signing in', async () => {
    host.azureEnv = () => { throw new Error('The custom cloud choice is not configured.'); };
    await expect(signInForSql(undefined, { createIfNone: true })).rejects.toBeInstanceOf(MicrosoftSignInError);
    expect(host.getSession).not.toHaveBeenCalled();
  });
});

describe('defaultTenantId', () => {
  it('prefers the home directory when the account can use it', () => {
    expect(defaultTenantId(account, [{ tenantId: 'other', displayName: 'A' }, { tenantId: 'home-tenant', displayName: 'B' }])).toBe('home-tenant');
  });

  it('falls back to the first listed directory, as for a personal Microsoft account', () => {
    expect(defaultTenantId(account, [{ tenantId: 'azure-dir', displayName: 'Default Directory' }])).toBe('azure-dir');
  });

  it('is undefined when no directory is listed', () => {
    expect(defaultTenantId(account, [])).toBeUndefined();
  });
});

describe('acquireSqlToken', () => {
  it('uses a saved directory without listing directories', async () => {
    host.tenants = [{ tenantId: 'other' }];
    const token = await acquireSqlToken({ tenantId: 'saved-dir' }, logger);
    expect(token).toBe('token for https://database.windows.net/.default VSCODE_TENANT:saved-dir');
    expect(host.getSession).toHaveBeenCalledTimes(1);
  });

  it('signs in to the chosen directory with the same account', async () => {
    host.tenants = [{ tenantId: 'azure-dir', displayName: 'Default Directory' }];
    const token = await acquireSqlToken({}, logger);
    expect(token).toBe('token for https://database.windows.net/.default VSCODE_TENANT:azure-dir');
    expect(host.getSession.mock.calls[1][2]).toEqual({ createIfNone: true, account });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/tenant=azure-dir/));
  });

  it('logs the account and directory at debug level only', async () => {
    await acquireSqlToken({ tenantId: 'saved-dir' }, logger);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('user@example.com');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('saved-dir');
    expect(JSON.stringify(logger.debug.mock.calls)).toContain('user@example.com');
    expect(JSON.stringify(logger.debug.mock.calls)).toContain('saved-dir');
  });

  it('keeps the account default directory when none is listed', async () => {
    const token = await acquireSqlToken({}, logger);
    expect(token).toBe('token for https://database.windows.net/.default');
    expect(host.getSession).toHaveBeenCalledTimes(1);
  });

  it('never logs the token', async () => {
    await acquireSqlToken({ tenantId: 'saved-dir' }, logger);
    expect(JSON.stringify([logger.info.mock.calls, logger.debug.mock.calls])).not.toContain('token for');
  });

  it('asks for the saved account and directory', async () => {
    const other = { id: 'object-2.other-tenant', label: 'other@example.com' };
    host.accounts = [account, other];
    await acquireSqlToken({ accountId: other.id, tenantId: 'saved-dir' }, logger);
    expect(host.getSession.mock.calls[0][2]).toEqual({ createIfNone: true, account: other });
  });

  it('a saved account that is not signed in to VS Code raises MicrosoftSignInError without signing in', async () => {
    await expect(acquireSqlToken({ accountId: 'gone.tenant' }, logger)).rejects.toBeInstanceOf(MicrosoftSignInError);
    expect(host.getSession).not.toHaveBeenCalled();
  });
});

describe('pickAccount', () => {
  it("opens VS Code's account picker and returns the chosen account", async () => {
    expect(await pickAccount()).toEqual(account);
    expect(host.getSession).toHaveBeenCalledWith('microsoft', ['https://database.windows.net/.default'], { createIfNone: true, clearSessionPreference: true });
  });
});

describe('signInForSql and listTenants', () => {
  it('a cancelled or empty sign-in raises MicrosoftSignInError', async () => {
    host.getSession.mockRejectedValueOnce(new Error('User did not consent to login.'));
    await expect(signInForSql(undefined, { createIfNone: true })).rejects.toBeInstanceOf(MicrosoftSignInError);
    host.getSession.mockResolvedValueOnce(undefined);
    await expect(signInForSql(undefined, { createIfNone: true })).rejects.toBeInstanceOf(MicrosoftSignInError);
  });

  it('lists directories by name and drops entries without an id', async () => {
    host.tenants = [{ tenantId: 'b', displayName: 'Beta', defaultDomain: 'beta.onmicrosoft.com' }, { displayName: 'No id' }, { tenantId: 'a', displayName: 'Alpha' }];
    expect(await listTenants(account)).toEqual([
      { tenantId: 'a', displayName: 'Alpha' },
      { tenantId: 'b', displayName: 'Beta', defaultDomain: 'beta.onmicrosoft.com' },
    ]);
  });
});
