/** Stand-in for `@microsoft/vscode-azext-azureauth` under unit tests: its CommonJS build requires
 * `vscode`, which only exists in the extension host. Sessions go through the (mockable)
 * `vscode.authentication.getSession` with the scopes the library builds; no directory is listed.
 */

import * as vscode from 'vscode';

/** Provider id the stubbed auth library reports, fixed to Microsoft. */
export const getConfiguredAuthProviderId = (): string => 'microsoft';

/** Azure SQL hostname suffix tests use to recognize an Azure server. */
export const getConfiguredAzureEnv = (): {
  sqlServerHostnameSuffix?: string;
} => ({ sqlServerHostnameSuffix: '.database.windows.net' });

/** Resolves a session via mockable vscode authentication and the library scope shape. */
export async function getSessionFromVSCode(
  resource: string,
  tenantId?: string,
  options?: vscode.AuthenticationGetSessionOptions,
): Promise<vscode.AuthenticationSession | undefined> {
  const scope = resource.endsWith('.default')
    ? resource
    : `${resource}.default`;
  return vscode.authentication.getSession(
    'microsoft',
    [scope, ...(tenantId ? [`VSCODE_TENANT:${tenantId}`] : [])],
    options,
  );
}

/** Subscription provider that lists no directory, as this stub does not sign in. */
export class VSCodeAzureSubscriptionProvider {
  async getTenants(): Promise<
    Array<{ tenantId?: string; displayName?: string; defaultDomain?: string }>
  > {
    return [];
  }
}

/** Tenant fields callers read from the real azure-auth library. */
export type AzureTenant = {
  tenantId?: string;
  displayName?: string;
  defaultDomain?: string;
  account: vscode.AuthenticationSessionAccountInformation;
};
