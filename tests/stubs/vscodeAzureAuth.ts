/**
 * Stand-in for `@microsoft/vscode-azext-azureauth` under unit tests: its CommonJS build requires
 * `vscode`, which only exists in the extension host. Sessions go through the (mockable)
 * `vscode.authentication.getSession` with the scopes the library builds; no directory is listed.
 */

import * as vscode from 'vscode';

export const getConfiguredAuthProviderId = (): string => 'microsoft';

export const getConfiguredAzureEnv = (): { sqlServerHostnameSuffix?: string } => ({ sqlServerHostnameSuffix: '.database.windows.net' });

export async function getSessionFromVSCode(
  resource: string,
  tenantId?: string,
  options?: vscode.AuthenticationGetSessionOptions,
): Promise<vscode.AuthenticationSession | undefined> {
  const scope = resource.endsWith('.default') ? resource : `${resource}.default`;
  return vscode.authentication.getSession('microsoft', [scope, ...(tenantId ? [`VSCODE_TENANT:${tenantId}`] : [])], options);
}

export class VSCodeAzureSubscriptionProvider {
  async getTenants(): Promise<Array<{ tenantId?: string; displayName?: string; defaultDomain?: string }>> {
    return [];
  }
}

export type AzureTenant = { tenantId?: string; displayName?: string; defaultDomain?: string; account: vscode.AuthenticationSessionAccountInformation };
