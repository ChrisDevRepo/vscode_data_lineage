/**
 * @module MssqlRetiring
 * Wording and detection for a project saved with the SQL Server (mssql) extension connection, which
 * Microsoft deprecated and this extension no longer opens.
 */

import type { StoredConnectionInfo } from '../shared/bridgeContract';

/** Notice shown when a project saved with the mssql extension connection opens. */
export const MSSQL_RECONNECT_NOTICE =
  'Microsoft deprecated the mssql extension connection API. Reconnect to keep using this project.';

/** Notice action that opens Add Database Connection prefilled from the stored connection. */
export const MSSQL_RECONNECT_ACTION = 'Reconnect';

/** Whether a stored connection was written for the mssql extension; no `provider` predates it. */
export function usesMssqlExtension(stored: StoredConnectionInfo): boolean {
  return (stored.provider ?? 'mssqlExtension') === 'mssqlExtension';
}
