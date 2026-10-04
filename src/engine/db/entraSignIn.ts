/**
 * @module EntraSignIn
 * Microsoft Entra sign-in for built-in connections through VS Code's Microsoft account, with
 * Microsoft's `@microsoft/vscode-azext-azureauth` library, as the SQL Server (mssql) extension signs in.
 */

import * as vscode from 'vscode';
import { getConfiguredAuthProviderId, getConfiguredAzureEnv, getSessionFromVSCode, VSCodeAzureSubscriptionProvider, type AzureTenant } from '@microsoft/vscode-azext-azureauth';
import type { Logger } from '../../utils/log';
import { MicrosoftSignInError } from './dbSession';

/** Azure SQL resource of the public cloud. */
const PUBLIC_SQL_RESOURCE = 'https://database.windows.net/';

/**
 * Azure SQL resource of the Microsoft cloud VS Code signs in to; the library requests its `.default` scope.
 *
 * @remarks
 * Built from the cloud's SQL server host name suffix, which gives the resources the mssql extension
 * uses: `database.windows.net`, `database.usgovcloudapi.net`, `database.chinacloudapi.cn`. A custom
 * cloud that names no suffix uses the public resource.
 *
 * @throws When VS Code selects a custom cloud that is not configured.
 */
export function sqlResource(): string {
  const suffix = getConfiguredAzureEnv().sqlServerHostnameSuffix?.replace(/^\./, '');
  return suffix ? `https://${suffix}/` : PUBLIC_SQL_RESOURCE;
}

/** A directory the signed-in account can use. */
export interface EntraTenant {
  /** Directory (tenant) id. */
  tenantId: string;
  /** Display name, or the id when the directory has none. */
  displayName: string;
  /** Default domain, when known. */
  defaultDomain?: string;
}

let provider: VSCodeAzureSubscriptionProvider | undefined;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Signs in for Azure SQL with VS Code's Microsoft account.
 *
 * @param tenantId - Directory to sign in to; the account's default directory when omitted.
 * @param options - VS Code session options, for example `createIfNone` or `forceNewSession`.
 * @throws {@link MicrosoftSignInError} when the user cancels or the sign-in fails.
 */
export async function signInForSql(
  tenantId: string | undefined,
  options: vscode.AuthenticationGetSessionOptions,
): Promise<vscode.AuthenticationSession> {
  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await getSessionFromVSCode(sqlResource(), tenantId, options);
  } catch (err) {
    throw new MicrosoftSignInError(errorMessage(err));
  }
  if (!session) throw new MicrosoftSignInError('no Microsoft account was signed in');
  return session;
}

/**
 * Lets the user choose the Microsoft account in VS Code's own account picker, which also offers
 * signing in to another account.
 *
 * @throws {@link MicrosoftSignInError} when the user cancels or the sign-in fails.
 */
export async function pickAccount(): Promise<vscode.AuthenticationSessionAccountInformation> {
  return (await signInForSql(undefined, { createIfNone: true, clearSessionPreference: true })).account;
}

async function savedAccount(accountId: string): Promise<vscode.AuthenticationSessionAccountInformation> {
  const accounts = await vscode.authentication.getAccounts(getConfiguredAuthProviderId());
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new MicrosoftSignInError('the Microsoft account saved with this connection is not signed in to VS Code');
  return account;
}

/**
 * Lists the directories an account can use, sorted by name.
 *
 * @returns The directories; empty when they cannot be listed.
 */
export async function listTenants(account: vscode.AuthenticationSessionAccountInformation): Promise<EntraTenant[]> {
  try {
    provider ??= new VSCodeAzureSubscriptionProvider();
    const tenants: AzureTenant[] = await provider.getTenants(account);
    return tenants
      .filter((t): t is AzureTenant & { tenantId: string } => !!t.tenantId)
      .map((t) => ({ tenantId: t.tenantId, displayName: t.displayName || t.tenantId, ...(t.defaultDomain ? { defaultDomain: t.defaultDomain } : {}) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch {
    return [];
  }
}

/**
 * Picks the directory the mssql extension preselects: the account's home directory when it is
 * listed, otherwise the first listed one.
 *
 * @remarks
 * VS Code account ids have the form `<objectId>.<homeTenantId>`. A personal Microsoft account's home
 * directory is often not one it can use for Azure resources, hence the fallback.
 *
 * @returns The directory id, or `undefined` when none is listed.
 */
export function defaultTenantId(account: vscode.AuthenticationSessionAccountInformation, tenants: readonly EntraTenant[]): string | undefined {
  const home = account.id.includes('.') ? account.id.split('.')[1] : undefined;
  return tenants.find((t) => t.tenantId === home)?.tenantId ?? tenants[0]?.tenantId;
}

/**
 * Gets an Azure SQL access token for a connection.
 *
 * @remarks
 * A saved account and directory are used as is. Without an account, the one VS Code remembers signs
 * in. Without a directory, the account's directories are listed and {@link defaultTenantId} chooses;
 * when nothing is listed the account's default directory is used.
 *
 * @param connection - Account id and directory saved with the connection.
 * @param logger - Receives a sign-in milestone at info level and directory/account diagnostics at debug level, never the token.
 * @throws {@link MicrosoftSignInError} when the user cancels, the sign-in fails or the saved account
 *   is no longer signed in to VS Code.
 */
export async function acquireSqlToken(
  connection: { accountId?: string; tenantId?: string },
  logger: Pick<Logger, 'info' | 'debug'>,
): Promise<string> {
  const { tenantId } = connection;
  const account = connection.accountId ? await savedAccount(connection.accountId) : undefined;
  let session = await signInForSql(tenantId, { createIfNone: true, ...(account ? { account } : {}) });
  let used = tenantId;
  if (!tenantId) {
    used = defaultTenantId(session.account, await listTenants(session.account));
    if (used) session = await signInForSql(used, { createIfNone: true, account: session.account });
  }
  logger.info('Entra sign-in completed');
  logger.debug(`Entra sign-in: tenant=${used ?? 'account default'}`);
  logger.debug(`Entra sign-in: account=${session.account.label}`);
  return session.accessToken;
}
